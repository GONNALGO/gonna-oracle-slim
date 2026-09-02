// chain.ts — on-chain truth. The server NEVER trusts the client: every fact
// (global state, challenge meta, players box, create-note stage commitment,
// continue payment) is read from algod/indexer here. Dependency-injected so
// tests stub this interface.
//
// Stage-note scan is a server port of testnetKit.fetchArenaCreateStages:
// create-ish app calls (create_challenge / spawn_rumble selectors) are
// paginated OLDEST-FIRST from the indexer and map SEQUENTIALLY to cids
// 0,1,2,... — the cross-check (scanned count == next_challenge_id) guards
// against a lagging/truncated indexer dressing wrong stages as truth.
// Cards predating the note convention carry no note -> documented fallback
// stage = cid % 7 (marked via source 'fallback-cid7').
import algosdk from 'algosdk';
import { bytesEqual, u64be } from './util.js';

export const STATUS_OPEN = 0;
export const STATUS_CLOSED = 1; // table full, no more joins (still submittable)
export const STATUS_RESOLVED = 2;
export const STATUS_REFUNDED = 3;
export const STATUS_FORFEIT = 4;

export const JOIN_CUTOFF_SEC = 600; // contract.py JOIN_CUTOFF
export const CONTINUE_FEE_MICRO = 5_000_000; // 5 ALGO flat (testnetKit.ts)

export interface GlobalState {
  nextChallengeId: number;
  oraclePubKey: Uint8Array; // 32B
  treasury: Uint8Array; // 32B
  gonnaAssetId: number;
  version: number;
}

export interface ChallengeMeta {
  creator: Uint8Array;
  stake: bigint;
  seatsTotal: bigint;
  seatsTaken: bigint;
  deadline: bigint; // unix secs
  stageMode: number; // 0 FULL, 1 STAGE_IDX, 2 RANDOM (v2 FROZEN)
  status: number;
}

export interface PlayerEntry {
  addr: Uint8Array; // 32B pk
  score: bigint;
  signed: boolean;
  seatedAt: bigint;
}

export interface StageCommitment {
  stage: number;
  source: 'note' | 'fallback-cid7';
}

export interface ChainClient {
  /** Current unix seconds (wall clock; injectable for tests). */
  now(): number;
  getGlobalState(): Promise<GlobalState>;
  getMeta(cid: number): Promise<ChallengeMeta | null>;
  getPlayers(cid: number): Promise<PlayerEntry[]>;
  /** Stage commitment for a cid, or null when the indexer scan failed. */
  getStageForCid(cid: number): Promise<StageCommitment | null>;
  /** On-chain proof of the 5-ALGO continue payment (exact amount, treasury
   *  receiver, exact note QA-CONTINUE|<refId>|<addr>, confirmed). */
  verifyContinuePayment(txid: string, refId: string, addr: string): Promise<boolean>;
  /** SEV-2b boot reconciliation (M-1): count of confirmed continue payments
   *  (note prefix QA-CONTINUE|) received by the treasury, or null when the
   *  indexer scan failed — callers must treat null as "unknown", not zero. */
  countContinuePayments(): Promise<number | null>;
}

const CREATE_SIG = 'create_challenge(pay,axfer,uint64,uint64,uint64,uint64,byte[],uint64,byte[])uint64';
const SPAWN_SIG = 'spawn_rumble(pay,axfer,pay,uint64,uint64,uint64,byte[])uint64';
const STAGE_NOTE_RE = /^gonna:v2:stage:(\d)$/;
const STAGE_MEMO_MS = 30_000;
const STAGE_MAX_PAGES = 50;

export function parseStageNote(note: Uint8Array): number | null {
  const m = STAGE_NOTE_RE.exec(new TextDecoder().decode(note));
  if (!m) return null;
  const k = Number(m[1]);
  return k >= 0 && k <= 6 ? k : null; // 7 stages, idx 0-6
}

export function continueNote(refId: string, addr: string): string {
  return 'QA-CONTINUE|' + refId + '|' + addr;
}

interface CreateCallHit {
  round: number;
  offset: number;
  stage: number | null;
}

interface StageCache {
  fromCid: number; // watermark: cids [0, fromCid) are mapped
  stages: Record<string, number>;
  at: number;
  total: number; // next_challenge_id the mapping was cross-checked against
}

function methodSelector(sig: string): Uint8Array {
  const parts = sig.split(')');
  const argTypes = parts[0]!.slice(parts[0]!.indexOf('(') + 1).split(',').filter(Boolean);
  const m = new algosdk.ABIMethod({
    name: sig.slice(0, sig.indexOf('(')),
    args: argTypes.map((t, i) => ({ type: t, name: 'a' + i })),
    returns: { type: parts[1] || 'void' },
  });
  return m.getSelector();
}

export class HttpChainClient implements ChainClient {
  private algod: algosdk.Algodv2;
  private indexerUrl: string;
  private appId: number;
  private treasuryAddr: string;
  private selCreate: Uint8Array;
  private selSpawn: Uint8Array;
  private stageCache: StageCache | null = null;

  constructor(opts: { algodUrl: string; indexerUrl: string; appId: number; treasuryAddr: string }) {
    this.algod = new algosdk.Algodv2('', opts.algodUrl, '');
    this.indexerUrl = opts.indexerUrl.replace(/\/+$/, '');
    this.appId = opts.appId;
    this.treasuryAddr = opts.treasuryAddr;
    this.selCreate = methodSelector(CREATE_SIG);
    this.selSpawn = methodSelector(SPAWN_SIG);
  }

  now(): number {
    return Math.floor(Date.now() / 1000);
  }

  async getGlobalState(): Promise<GlobalState> {
    const app = (await this.algod.getApplicationByID(this.appId).do()) as {
      params: { globalState?: { key: Uint8Array; value: { type: number; bytes?: Uint8Array | string; uint?: number | bigint } }[] };
    };
    const out: Partial<GlobalState> = {};
    for (const kv of app.params.globalState ?? []) {
      const key = new TextDecoder().decode(kv.key);
      const v = kv.value;
      if (v.type === 2) {
        const n = Number(v.uint ?? 0);
        if (key === 'next_challenge_id') out.nextChallengeId = n;
        else if (key === 'gonna_asset_id') out.gonnaAssetId = n;
        else if (key === 'version') out.version = n;
      } else if (v.type === 1) {
        const bytes = typeof v.bytes === 'string' ? new Uint8Array(Buffer.from(v.bytes, 'base64')) : (v.bytes ?? new Uint8Array());
        if (key === 'oracle_pub_key') out.oraclePubKey = bytes;
        else if (key === 'treasury') out.treasury = bytes;
      }
    }
    if (out.nextChallengeId == null || !out.oraclePubKey?.length || !out.treasury?.length || out.version == null) {
      throw new Error('chain: incomplete global state for app ' + this.appId);
    }
    return out as GlobalState;
  }

  async getMeta(cid: number): Promise<ChallengeMeta | null> {
    try {
      const name = new Uint8Array([0x6d, ...u64be(cid)]); // 'm' + cid8
      const box = await this.algod.getApplicationBoxByName(this.appId, name).do();
      // v3 meta (+claimed_count,+refund_reason): 14 fields; v2.1: 12 fields
      let v: [Uint8Array, bigint, bigint, bigint, bigint, bigint, Uint8Array, bigint, bigint, Uint8Array, bigint, bigint];
      try {
        v = algosdk.ABIType.from('(byte[],uint64,uint64,uint64,uint64,uint64,byte[],uint64,uint64,byte[],uint64,uint64,uint64,uint64)').decode(box.value) as typeof v;
      } catch {
        v = algosdk.ABIType.from('(byte[],uint64,uint64,uint64,uint64,uint64,byte[],uint64,uint64,byte[],uint64,uint64)').decode(box.value) as typeof v;
      }
      return {
        // algosdk decodes ABI byte[] to a plain Array — coerce to Uint8Array
        // (algosdk.encodeAddress / nacl demand a real Uint8Array; live-E2E v16)
        creator: Uint8Array.from(v[0]),
        stake: v[1],
        seatsTotal: v[2],
        seatsTaken: v[3],
        deadline: v[4],
        stageMode: Number(v[5]),
        status: Number(v[8]),
      };
    } catch {
      return null; // box gone (resolved/claimed/forfeited) or node hiccup
    }
  }

  async getPlayers(cid: number): Promise<PlayerEntry[]> {
    try {
      const name = new Uint8Array([0x70, ...u64be(cid)]); // 'p' + cid8
      const box = await this.algod.getApplicationBoxByName(this.appId, name).do();
      // v3 roster (+claimed): 5-tuple entries; v2.1: 4-tuple
      try {
        const w = algosdk.ABIType.from('(byte[],uint64,bool,uint64,bool)[]').decode(box.value) as [Uint8Array, bigint, boolean, bigint, boolean][];
        return w.map((p) => ({ addr: Uint8Array.from(p[0]), score: p[1], signed: p[2], seatedAt: p[3] }));
      } catch {
        const v = algosdk.ABIType.from('(byte[],uint64,bool,uint64)[]').decode(box.value) as [Uint8Array, bigint, boolean, bigint][];
        return v.map((p) => ({ addr: Uint8Array.from(p[0]), score: p[1], signed: p[2], seatedAt: p[3] }));
      }
    } catch {
      return [];
    }
  }

  private async nextChallengeId(): Promise<number> {
    return (await this.getGlobalState()).nextChallengeId;
  }

  /** Port of fetchArenaCreateStages: oldest-first indexer pagination of
   *  create-ish app calls, sequential cid mapping, count cross-check. */
  private async scanStages(force: boolean): Promise<StageCache | null> {
    if (!force && this.stageCache && Date.now() - this.stageCache.at < STAGE_MEMO_MS) return this.stageCache;
    let total: number;
    try {
      total = await this.nextChallengeId();
    } catch {
      return this.stageCache; // algod hiccup: serve stale if we have it
    }
    let cache = this.stageCache ?? { fromCid: 0, stages: {}, at: 0, total };
    const need = Math.max(0, total - cache.fromCid);
    if (need > 0) {
      const hits: CreateCallHit[] = [];
      let skipped = cache.fromCid;
      let token: string | null = null;
      let failed = false;
      for (let page = 0; page < STAGE_MAX_PAGES && hits.length < need; page++) {
        const url =
          this.indexerUrl + '/v2/transactions?application-id=' + this.appId + '&tx-type=appl&limit=100' +
          (token ? '&next=' + encodeURIComponent(token) : '');
        let j: {
          transactions?: {
            id: string;
            'confirmed-round'?: number;
            'intra-round-offset'?: number;
            note?: string;
            'application-transaction'?: { 'application-args'?: string[] };
          }[];
          'next-token'?: string;
        };
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error('indexer http ' + r.status);
          j = (await r.json()) as typeof j;
        } catch {
          failed = true;
          break;
        }
        for (const t of j.transactions ?? []) {
          if (typeof t['confirmed-round'] !== 'number') continue;
          const args = t['application-transaction']?.['application-args'];
          if (!args || args.length === 0) continue;
          const first = new Uint8Array(Buffer.from(args[0]!, 'base64'));
          if (!bytesEqual(first, this.selCreate) && !bytesEqual(first, this.selSpawn)) continue;
          if (skipped > 0) {
            skipped--;
            continue;
          }
          hits.push({
            round: t['confirmed-round'],
            offset: t['intra-round-offset'] ?? 0,
            stage: typeof t.note === 'string' ? parseStageNote(new Uint8Array(Buffer.from(t.note, 'base64'))) : null,
          });
          if (hits.length >= need) break;
        }
        token = j['next-token'] ?? null;
        if (!token) break;
      }
      if (!failed) {
        // MAPPING SANITY CROSS-CHECK (testnetKit v15.2.8b): the sequential
        // mapping is exact ONLY when watermark + scanned == next_challenge_id.
        if (cache.fromCid + hits.length === total) {
          const sorted = [...hits].sort((x, y) => x.round - y.round || x.offset - y.offset);
          const stages = { ...cache.stages };
          let cid = cache.fromCid;
          for (const h of sorted) {
            if (h.stage !== null) stages[String(cid)] = h.stage;
            cid++;
          }
          cache = { fromCid: cid, stages, at: Date.now(), total };
          this.stageCache = cache;
        }
        // mismatch: bank NOTHING, keep the old watermark (unmapped cids fall
        // through to the fallback tier only if we never had a good scan)
      } else if (!this.stageCache) {
        return null; // cold start and indexer down: cannot verify any stage
      }
    } else {
      cache = { ...cache, at: Date.now(), total };
      this.stageCache = cache;
    }
    return this.stageCache;
  }

  async getStageForCid(cid: number): Promise<StageCommitment | null> {
    // force a refresh when the cid is newer than the memoized mapping total
    const force = !this.stageCache || cid >= this.stageCache.total || Date.now() - this.stageCache.at >= STAGE_MEMO_MS;
    const scan = await this.scanStages(force);
    if (!scan) return null;
    const noted = scan.stages[String(cid)];
    if (noted != null) return { stage: noted, source: 'note' };
    if (cid < scan.total) return { stage: cid % 7, source: 'fallback-cid7' }; // pre-note card, documented fallback
    return null; // cid beyond the cross-checked mapping: unverifiable
  }

  async countContinuePayments(): Promise<number | null> {
    let token = '';
    let count = 0;
    for (let page = 0; page < 20; page++) {
      const url =
        this.indexerUrl + '/v2/transactions?address=' + encodeURIComponent(this.treasuryAddr) +
        '&address-role=receiver&tx-type=pay&limit=100' +
        (token ? '&next=' + encodeURIComponent(token) : '');
      let j: {
        transactions?: { note?: string }[];
        'next-token'?: string;
      };
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error('indexer http ' + r.status);
        j = (await r.json()) as typeof j;
      } catch {
        return null; // unknown — never report as zero
      }
      for (const t of j.transactions ?? []) {
        if (!t.note) continue;
        try {
          if (Buffer.from(t.note, 'base64').toString('utf8').startsWith('QA-CONTINUE|')) count++;
        } catch { /* non-utf8 note — skip */ }
      }
      token = j['next-token'] ?? '';
      if (!token) return count;
    }
    return count; // page cap reached — best effort
  }

  async verifyContinuePayment(txid: string, refId: string, addr: string): Promise<boolean> {
    const want = continueNote(refId, addr);
    const check = (t: { type?: string; amount?: number | bigint; receiver?: string; note?: string } | null): boolean => {
      if (!t || t.type !== 'pay') return false;
      if (Number(t.amount) !== CONTINUE_FEE_MICRO) return false;
      if (t.receiver !== this.treasuryAddr) return false;
      return t.note === want;
    };
    // algod pending-txn first (just-confirmed; indexer lags a few seconds)
    try {
      const r = (await this.algod.pendingTransactionInformation(txid).do()) as unknown as Record<string, unknown>;
      const confirmedRound = Number((r['confirmed-round'] ?? r['confirmedRound'] ?? 0) as number);
      const outer = (r['txn'] ?? r['transaction']) as Record<string, unknown> | undefined;
      const inner = (outer?.['txn'] ?? outer) as Record<string, unknown> | undefined;
      if (confirmedRound > 0 && inner) {
        const rcv = inner['rcv'] ?? inner['receiver'];
        const note = inner['note'];
        const view = {
          type: (inner['type'] as string | undefined) ?? 'pay',
          amount: (inner['amt'] ?? inner['amount']) as number | bigint | undefined,
          receiver:
            typeof rcv === 'string' ? rcv : rcv instanceof Uint8Array ? algosdk.encodeAddress(rcv) : undefined,
          note: typeof note === 'string' ? note : note instanceof Uint8Array ? new TextDecoder().decode(note) : undefined,
        };
        if (check(view)) return true;
      }
    } catch {
      /* fall back to indexer */
    }
    try {
      const r = await fetch(`${this.indexerUrl}/v2/transactions/${encodeURIComponent(txid)}`);
      if (r.ok) {
        const j = (await r.json()) as {
          transaction?: { 'payment-transaction'?: { amount: number; receiver: string }; note?: string; 'tx-type'?: string };
        };
        const t = j.transaction;
        if (t && t['tx-type'] === 'pay' && t['payment-transaction']) {
          return check({
            type: 'pay',
            amount: t['payment-transaction'].amount,
            receiver: t['payment-transaction'].receiver,
            note: t.note ? Buffer.from(t.note, 'base64').toString('utf8') : undefined,
          });
        }
      }
    } catch {
      /* indexer down/lagging */
    }
    return false;
  }
}
