// store.ts — SQLite persistence (better-sqlite3, WAL on file DBs; SPEC §2).
// Tables: sigs (one active sig per (cid,seat)), receipts (continue 5-ALGO
// proofs, single-use), rate_buckets (fixed 60s windows per key).
import Database from 'better-sqlite3';

export interface SigRow {
  cid: number;
  seat: number;
  addr: string;
  score: number;
  build: string;
  frames: number;
  ts: number;
  sigB64: string;
  ip: string;
}

export interface ReceiptRow {
  refId: string;
  addr: string;
  txid: string;
  consumed: boolean;
  createdTs: number;
  consumedTs: number | null;
}

export type ConsumeResult = 'ok' | 'missing' | 'consumed' | 'addr-mismatch';

export type MaybePromise<T> = T | Promise<T>;

/**
 * Store backend contract (SEV-2b, M-1). Implementations: `Store` (local
 * SQLite via better-sqlite3, synchronous) and `LibsqlStore` (Turso/libsql,
 * async — see store-libsql.ts). Call sites `await` every method so both
 * drivers work interchangeably.
 */
export interface StoreLike {
  upsertSig(row: SigRow): MaybePromise<void>;
  getSig(cid: number, seat: number): MaybePromise<SigRow | null>;
  insertReceipt(refId: string, addr: string, txid: string, ts: number): MaybePromise<boolean>;
  getReceipt(refId: string): MaybePromise<ReceiptRow | null>;
  consumeReceiptAndStoreSig(refId: string, addr: string, sig: SigRow): MaybePromise<ConsumeResult>;
  rateHit(key: string, limit: number, nowSec: number): MaybePromise<{ allowed: boolean; retryAfter: number }>;
  knownSigCids(): MaybePromise<number[]>;
  receiptCount(): MaybePromise<number>;
  close(): MaybePromise<void>;
}

export class Store implements StoreLike {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
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
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Anti-replay (SPEC §3.2 rule 6): one active sig per (cid,seat); a new
   *  score legitimately overwrites the previous row. */
  upsertSig(row: SigRow): void {
    this.db
      .prepare(
        `INSERT INTO sigs (cid, seat, addr, score, build, frames, ts, sigB64, ip)
         VALUES (@cid, @seat, @addr, @score, @build, @frames, @ts, @sigB64, @ip)
         ON CONFLICT (cid, seat) DO UPDATE SET
           addr=excluded.addr, score=excluded.score, build=excluded.build,
           frames=excluded.frames, ts=excluded.ts, sigB64=excluded.sigB64, ip=excluded.ip`,
      )
      .run(row);
  }

  getSig(cid: number, seat: number): SigRow | null {
    const r = this.db.prepare('SELECT * FROM sigs WHERE cid = ? AND seat = ?').get(cid, seat) as SigRow | undefined;
    return r ?? null;
  }

  /** Register a verified continue receipt. Returns false if the refId or the
   *  txid is already known (caller maps to 409). */
  insertReceipt(refId: string, addr: string, txid: string, ts: number): boolean {
    try {
      this.db
        .prepare('INSERT INTO receipts (ref_id, addr, txid, consumed, created_ts) VALUES (?, ?, ?, 0, ?)')
        .run(refId, addr, txid, ts);
      return true;
    } catch {
      return false; // PRIMARY KEY / UNIQUE violation
    }
  }

  getReceipt(refId: string): ReceiptRow | null {
    const r = this.db
      .prepare('SELECT ref_id AS refId, addr, txid, consumed, created_ts AS createdTs, consumed_ts AS consumedTs FROM receipts WHERE ref_id = ?')
      .get(refId) as (Omit<ReceiptRow, 'consumed'> & { consumed: number }) | undefined;
    if (!r) return null;
    return { ...r, consumed: r.consumed !== 0 };
  }

  /** SPEC §3.2 rule 5: the receipt is marked consumed ATOMICALLY in the same
   *  SQLite transaction that persists the emitted signature. */
  consumeReceiptAndStoreSig(refId: string, addr: string, sig: SigRow): ConsumeResult {
    const tx = this.db.transaction((): ConsumeResult => {
      const r = this.db.prepare('SELECT addr, consumed FROM receipts WHERE ref_id = ?').get(refId) as
        | { addr: string; consumed: number }
        | undefined;
      if (!r) return 'missing';
      if (r.consumed !== 0) return 'consumed';
      if (r.addr !== addr) return 'addr-mismatch';
      this.db.prepare('UPDATE receipts SET consumed = 1, consumed_ts = ? WHERE ref_id = ?').run(sig.ts, refId);
      this.upsertSig(sig);
      return 'ok';
    });
    return tx();
  }

  /** Fixed-window (60s) rate bucket. Returns allowed + retryAfter seconds. */
  rateHit(key: string, limit: number, nowSec: number): { allowed: boolean; retryAfter: number } {
    const window = Math.floor(nowSec / 60);
    const row = this.db.prepare('SELECT window_start, count FROM rate_buckets WHERE key = ?').get(key) as
      | { window_start: number; count: number }
      | undefined;
    if (!row || row.window_start !== window) {
      this.db
        .prepare('INSERT INTO rate_buckets (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET window_start = excluded.window_start, count = 1')
        .run(key, window);
      return { allowed: true, retryAfter: 0 };
    }
    if (row.count >= limit) {
      return { allowed: false, retryAfter: (window + 1) * 60 - nowSec };
    }
    this.db.prepare('UPDATE rate_buckets SET count = count + 1 WHERE key = ?').run(key);
    return { allowed: true, retryAfter: 0 };
  }

  /** Monitoring hook (RUNBOOK): sigs we emitted, for verdict reconciliation. */
  knownSigCids(): number[] {
    const rows = this.db.prepare('SELECT DISTINCT cid FROM sigs ORDER BY cid').all() as { cid: number }[];
    return rows.map((r) => r.cid);
  }

  /** Receipt rows known to this store (boot reconciliation, SEV-2b). */
  receiptCount(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number };
    return r.n;
  }
}

/**
 * Store factory (SEV-2b, M-1): when cfg.tursoUrl is set, open the libsql
 * (Turso) backend so receipts survive an ephemeral-disk redeploy; otherwise
 * local SQLite. A configured-but-unreachable Turso is FATAL (refuse to boot)
 * — silently falling back to ephemeral local storage would recreate SEV-2b.
 */
export async function openStore(cfg: { dbPath: string; tursoUrl?: string; tursoAuthToken?: string }): Promise<StoreLike> {
  if (cfg.tursoUrl) {
    const { LibsqlStore } = await import('./store-libsql.js');
    const s = await LibsqlStore.connect(cfg.tursoUrl, cfg.tursoAuthToken);
    return s;
  }
  return new Store(cfg.dbPath);
}
