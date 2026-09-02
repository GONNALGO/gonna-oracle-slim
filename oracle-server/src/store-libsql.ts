// store-libsql.ts — Turso/libsql store backend (SEV-2b, M-1). Same semantics
// as the local SQLite Store (store.ts) but backed by @libsql/client so the
// receipts table survives an ephemeral-disk redeploy on the free tier.
// Activated only when TURSO_URL is set (see openStore in store.ts); the
// dependency is imported dynamically so local/test runs never load it.
import type { Client, InStatement } from '@libsql/client';
import type { ConsumeResult, ReceiptRow, SigRow, StoreLike } from './store.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sigs (
    cid     INTEGER NOT NULL,
    seat    INTEGER NOT NULL,
    addr    TEXT    NOT NULL,
    score   INTEGER NOT NULL,
    build   TEXT    NOT NULL,
    frames  INTEGER NOT NULL,
    ts      INTEGER NOT NULL,
    sigB64  TEXT    NOT NULL,
    ip      TEXT    NOT NULL,
    PRIMARY KEY (cid, seat)
  );
  CREATE TABLE IF NOT EXISTS receipts (
    ref_id      TEXT PRIMARY KEY,
    addr        TEXT NOT NULL,
    txid        TEXT NOT NULL UNIQUE,
    consumed    INTEGER NOT NULL DEFAULT 0,
    created_ts  INTEGER NOT NULL,
    consumed_ts INTEGER
  );
  CREATE TABLE IF NOT EXISTS rate_buckets (
    key          TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count        INTEGER NOT NULL
  );
`;

export class LibsqlStore implements StoreLike {
  private constructor(private db: Client) {}

  /** Connect + apply schema. Throws on failure — the caller (openStore)
   *  treats a configured-but-unreachable Turso as fatal. */
  static async connect(url: string, authToken?: string): Promise<LibsqlStore> {
    const { createClient } = await import('@libsql/client');
    const db = createClient({ url, authToken });
    await db.execute('SELECT 1'); // fail fast on bad url/token
    for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
      await db.execute(stmt);
    }
    return new LibsqlStore(db);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async upsertSig(row: SigRow): Promise<void> {
    await this.db.execute({
      sql: `INSERT INTO sigs (cid, seat, addr, score, build, frames, ts, sigB64, ip)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (cid, seat) DO UPDATE SET
              addr=excluded.addr, score=excluded.score, build=excluded.build,
              frames=excluded.frames, ts=excluded.ts, sigB64=excluded.sigB64, ip=excluded.ip`,
      args: [row.cid, row.seat, row.addr, row.score, row.build, row.frames, row.ts, row.sigB64, row.ip],
    });
  }

  async getSig(cid: number, seat: number): Promise<SigRow | null> {
    const r = await this.db.execute({ sql: 'SELECT * FROM sigs WHERE cid = ? AND seat = ?', args: [cid, seat] });
    const row = r.rows[0] as unknown as SigRow | undefined;
    return row ?? null;
  }

  async insertReceipt(refId: string, addr: string, txid: string, ts: number): Promise<boolean> {
    try {
      await this.db.execute({
        sql: 'INSERT INTO receipts (ref_id, addr, txid, consumed, created_ts) VALUES (?, ?, ?, 0, ?)',
        args: [refId, addr, txid, ts],
      });
      return true;
    } catch {
      return false; // PRIMARY KEY / UNIQUE violation
    }
  }

  async getReceipt(refId: string): Promise<ReceiptRow | null> {
    const r = await this.db.execute({
      sql: 'SELECT ref_id AS refId, addr, txid, consumed, created_ts AS createdTs, consumed_ts AS consumedTs FROM receipts WHERE ref_id = ?',
      args: [refId],
    });
    const row = r.rows[0] as unknown as (Omit<ReceiptRow, 'consumed'> & { consumed: number }) | undefined;
    if (!row) return null;
    return { ...row, consumed: Number(row.consumed) !== 0 };
  }

  /** SPEC §3.2 rule 5: receipt consumed ATOMICALLY with the sig write, in a
   *  single libsql write transaction (same guarantee as the SQLite driver). */
  async consumeReceiptAndStoreSig(refId: string, addr: string, sig: SigRow): Promise<ConsumeResult> {
    const tx = await this.db.transaction('write');
    try {
      const r = await tx.execute({ sql: 'SELECT addr, consumed FROM receipts WHERE ref_id = ?', args: [refId] });
      const row = r.rows[0] as unknown as { addr: string; consumed: number } | undefined;
      if (!row) { await tx.rollback(); return 'missing'; }
      if (Number(row.consumed) !== 0) { await tx.rollback(); return 'consumed'; }
      if (row.addr !== addr) { await tx.rollback(); return 'addr-mismatch'; }
      const stmts: InStatement[] = [
        { sql: 'UPDATE receipts SET consumed = 1, consumed_ts = ? WHERE ref_id = ?', args: [sig.ts, refId] },
        {
          sql: `INSERT INTO sigs (cid, seat, addr, score, build, frames, ts, sigB64, ip)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (cid, seat) DO UPDATE SET
                  addr=excluded.addr, score=excluded.score, build=excluded.build,
                  frames=excluded.frames, ts=excluded.ts, sigB64=excluded.sigB64, ip=excluded.ip`,
          args: [sig.cid, sig.seat, sig.addr, sig.score, sig.build, sig.frames, sig.ts, sig.sigB64, sig.ip],
        },
      ];
      await tx.batch(stmts);
      await tx.commit();
      return 'ok';
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    }
  }

  async rateHit(key: string, limit: number, nowSec: number): Promise<{ allowed: boolean; retryAfter: number }> {
    const window = Math.floor(nowSec / 60);
    const r = await this.db.execute({ sql: 'SELECT window_start, count FROM rate_buckets WHERE key = ?', args: [key] });
    const row = r.rows[0] as unknown as { window_start: number; count: number } | undefined;
    if (!row || Number(row.window_start) !== window) {
      await this.db.execute({
        sql: 'INSERT INTO rate_buckets (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET window_start = excluded.window_start, count = 1',
        args: [key, window],
      });
      return { allowed: true, retryAfter: 0 };
    }
    if (Number(row.count) >= limit) {
      return { allowed: false, retryAfter: (window + 1) * 60 - nowSec };
    }
    await this.db.execute({ sql: 'UPDATE rate_buckets SET count = count + 1 WHERE key = ?', args: [key] });
    return { allowed: true, retryAfter: 0 };
  }

  async knownSigCids(): Promise<number[]> {
    const r = await this.db.execute('SELECT DISTINCT cid FROM sigs ORDER BY cid');
    return r.rows.map((row) => Number((row as unknown as { cid: number }).cid));
  }

  async receiptCount(): Promise<number> {
    const r = await this.db.execute('SELECT COUNT(*) AS n FROM receipts');
    return Number((r.rows[0] as unknown as { n: number }).n);
  }
}
