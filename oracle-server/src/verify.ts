// verify.ts — SPEC §3.2 sign-score verification pipeline, §3.3 verdict
// derivation, §3.4 continue receipts, §5 input-log structural validation.
// All handlers are dependency-injected (chain/store/signer/cfg) so tests run
// against stubs. Every failure is a 4xx/409 {error: reason}; never a stack.
import algosdk from 'algosdk';
import { ChainClient, JOIN_CUTOFF_SEC, STATUS_CLOSED, STATUS_OPEN } from './chain.js';
import { OracleConfig, capFor } from './config.js';
import {
  MODE_FULL,
  MODE_RANDOM_RESOLVED,
  MODE_STAGE_IDX,
  OracleSigner,
  scoreMsg,
  verdictDigest,
  verdictExtraFull,
  verdictExtraStage,
  verdictMsg,
  DigestEntry,
} from './sign.js';
import { SigRow, StoreLike } from './store.js';
import { b64decode, b64encode } from './util.js';
import { ReplayVerifier } from './replay/replayer.js';

export interface Deps {
  cfg: OracleConfig;
  chain: ChainClient;
  /** v3 flip: per-app chain clients (multi-app serving). Absent in tests. */
  chains?: Map<number, ChainClient>;
  store: StoreLike;
  signer: OracleSigner;
  /** M2 replay verifier (SPEC-m2 §5). Required when cfg.replayEnforce. */
  replay?: ReplayVerifier;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
  retryAfter?: number;
}

const ok = (body: Record<string, unknown>): Reply => ({ status: 200, body });
const bad = (reason: string, status = 400): Reply => ({ status, body: { error: reason } });

// ---------------------------------------------------------------------------
// input log v1/v2 (SPEC §5 + SPEC-m2 §2) — wire format owned by the client
// codec (src/game/arena/inputLog.ts); this is the server-side mirror. Layout
// (big-endian, no padding):
//   'G' 'I' 'L'        magic
//   u8                 version (1 = records from startArenaRun incl. intro;
//                              2 = frame 0 is the first scene==='play' frame)
//   u8                 flags (bit0 = truncated)
//   u16 buildLen + utf8 build
//   u16 seedLen  + utf8 seedLabel
//   u32 frames         (<= 300000)
//   v1/v2: frames x u8     per-frame button LEVEL bitmask
//   v3:    frames x u8 pairs  per-frame [levelMask, edgeMask]
// M1: structural validation ONLY. M2: v2/v3 logs are replay-verified (below).
// v3 (v17.0.10): the edge stream makes fast sub-frame mobile taps replayable
// (levels-only v2 tapes silently lost down+up-inside-one-frame presses).
// ---------------------------------------------------------------------------
export const INPUT_LOG_CAP = 300_000;

export interface InputLogHeader {
  v: number;
  build: string;
  seedLabel: string;
  frames: number;
  truncated: boolean;
}

export function encodeInputLog(
  header: { build: string; seedLabel: string; frames: number; truncated?: boolean; v?: number },
  masks: Uint8Array,
): Uint8Array {
  const enc = new TextEncoder();
  const build = enc.encode(header.build);
  const seed = enc.encode(header.seedLabel);
  const frames = Math.min(header.frames, INPUT_LOG_CAP);
  const out = new Uint8Array(3 + 1 + 1 + 2 + build.length + 2 + seed.length + 4 + frames);
  const dv = new DataView(out.buffer);
  out.set([0x47, 0x49, 0x4c, header.v ?? 1, header.truncated ? 1 : 0], 0); // 'GIL', v, flags
  dv.setUint16(5, build.length, false);
  out.set(build, 7);
  const p2 = 7 + build.length;
  dv.setUint16(p2, seed.length, false);
  out.set(seed, p2 + 2);
  const p3 = p2 + 2 + seed.length;
  dv.setUint32(p3, frames, false);
  out.set(masks.subarray(0, frames), p3 + 4);
  return out;
}

export function decodeInputLog(raw: Uint8Array): { header: InputLogHeader; bitmask: Uint8Array; edges: Uint8Array | null } | null {
  if (raw.length < 3 + 1 + 1 + 2 + 2 + 4) return null;
  if (raw[0] !== 0x47 || raw[1] !== 0x49 || raw[2] !== 0x4c) return null; // 'GIL'
  if (raw[3] !== 1 && raw[3] !== 2 && raw[3] !== 3) return null; // v1 legacy / v2 levels / v3 levels+edges
  const flags = raw[4]!;
  if (flags & ~1) return null; // unknown flag bits
  const dv = new DataView(raw.buffer, raw.byteOffset);
  const buildLen = dv.getUint16(5, false);
  if (raw.length < 7 + buildLen + 2 + 4) return null;
  const build = new TextDecoder().decode(raw.subarray(7, 7 + buildLen));
  const p2 = 7 + buildLen;
  const seedLen = dv.getUint16(p2, false);
  const p3 = p2 + 2 + seedLen;
  if (raw.length < p3 + 4) return null;
  const seedLabel = new TextDecoder().decode(raw.subarray(p2 + 2, p3));
  const frames = dv.getUint32(p3, false);
  if (frames > INPUT_LOG_CAP) return null;
  if (raw[3] === 3) {
    if (raw.length !== p3 + 4 + frames * 2) return null; // exactly 2 bytes per frame
    const bitmask = new Uint8Array(frames);
    const edges = new Uint8Array(frames);
    for (let i = 0; i < frames; i++) {
      bitmask[i] = raw[p3 + 4 + i * 2]!;
      edges[i] = raw[p3 + 4 + i * 2 + 1]!;
    }
    return { header: { v: 3, build, seedLabel, frames, truncated: (flags & 1) !== 0 }, bitmask, edges };
  }
  const bitmask = raw.subarray(p3 + 4);
  if (bitmask.length !== frames) return null; // exactly 1 byte per frame, no trailing data
  return { header: { v: raw[3]!, build, seedLabel, frames, truncated: (flags & 1) !== 0 }, bitmask, edges: null };
}

// ---------------------------------------------------------------------------
// request body shapes
// ---------------------------------------------------------------------------
export interface RunInfo {
  seedLabel: string;
  frames: number;
  durationSec: number;
  inputLogB64?: string;
}

export interface SignScoreBody {
  cid: number;
  seat: number;
  addr: string;
  score: number;
  stageMode: 'full' | 'stage';
  stageIdx?: number;
  build: string;
  run: RunInfo;
  continueRef?: string;
}

const MAX_SEAT = 12; // contract.py: seats <= 12

function isStr(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

export function parseSignScoreBody(raw: unknown): SignScoreBody | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (!Number.isInteger(b['cid']) || (b['cid'] as number) < 0) return null;
  if (!Number.isInteger(b['seat']) || (b['seat'] as number) < 0 || (b['seat'] as number) > MAX_SEAT) return null;
  if (!isStr(b['addr'], 58)) return null;
  try {
    algosdk.decodeAddress(b['addr']);
  } catch {
    return null;
  }
  if (!Number.isInteger(b['score']) || (b['score'] as number) < 0 || !Number.isSafeInteger(b['score'])) return null;
  if (b['stageMode'] !== 'full' && b['stageMode'] !== 'stage') return null;
  if (b['stageMode'] === 'stage') {
    if (!Number.isInteger(b['stageIdx']) || (b['stageIdx'] as number) < 0 || (b['stageIdx'] as number) > 6) return null;
  } else if (b['stageIdx'] != null) {
    return null; // full runs carry no stage index
  }
  if (!isStr(b['build'], 64)) return null;
  const run = b['run'];
  if (typeof run !== 'object' || run === null) return null;
  const r = run as Record<string, unknown>;
  if (!isStr(r['seedLabel'], 64)) return null;
  if (!Number.isInteger(r['frames']) || (r['frames'] as number) < 0) return null;
  if (typeof r['durationSec'] !== 'number' || !Number.isFinite(r['durationSec']) || (r['durationSec'] as number) < 0) return null;
  // v17.0.10: GIL v3 doubles the frame bytes (levels+edges) -> b64 ceiling 1.2MB
  if (r['inputLogB64'] != null && !isStr(r['inputLogB64'], 1_200_000)) return null;
  if (b['continueRef'] != null && !isStr(b['continueRef'], 64)) return null;
  return {
    cid: b['cid'] as number,
    seat: b['seat'] as number,
    addr: b['addr'],
    score: b['score'] as number,
    stageMode: b['stageMode'],
    stageIdx: b['stageIdx'] as number | undefined,
    build: b['build'],
    run: {
      seedLabel: r['seedLabel'],
      frames: r['frames'] as number,
      durationSec: r['durationSec'] as number,
      inputLogB64: r['inputLogB64'] as string | undefined,
    },
    continueRef: b['continueRef'] as string | undefined,
  };
}

/**
 * M2 reject telemetry (SEV follow-up 2026-08-27): ONE structured line per
 * refused run so the ops logs carry the debuggable context (a live REPLAY
 * MISMATCH previously left zero server-side trace). SAFE BY CONSTRUCTION:
 * addr truncated to 8 chars, the GIL body is never logged, no mnemonics/keys.
 * 'First divergent frame' is not loggable: the replay contract only has the
 * input masks + claimed final score — no client-side per-frame trace exists
 * to diff against; we log the replayed final score / abort state instead.
 */
function logSignScoreReject(reason: string, body: SignScoreBody, extra: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({
    ev: 'sign-score-reject',
    reason,
    cid: body.cid,
    seat: body.seat,
    addr: body.addr.slice(0, 8),
    build: body.build,
    stageMode: body.stageMode,
    stageIdx: body.stageIdx ?? null,
    seedLabel: body.run.seedLabel,
    frames: body.run.frames,
    claimedScore: body.score,
    ...extra,
  }));
}

// ---------------------------------------------------------------------------
// §3.2 POST /v1/sign-score — ALL checks, in SPEC order
// ---------------------------------------------------------------------------
export async function handleSignScore(deps: Deps, rawBody: unknown, ip: string): Promise<Reply> {
  const { cfg, store, signer } = deps;
  // v3 flip: the request MAY pin an app (legacy v2.1 cards keep settling).
  const wantApp = Number((rawBody as Record<string, unknown>)?.['appId'] ?? cfg.appId);
  const chain = deps.chains?.get(wantApp) ?? (wantApp === cfg.appId ? deps.chain : undefined);
  if (!chain) return bad('unknown appId', 400);

  // 0. body shape
  const body = parseSignScoreBody(rawBody);
  if (!body) return bad('malformed request body');

  // 1. chain truth (algod/indexer)
  const gs = await chain.getGlobalState();
  let stageCommit: { stage: number; source: string } | null = null;
  if (body.seat === 0) {
    // create flow: anti CID-drift — the sig is only useful for the NEXT card
    if (body.cid !== gs.nextChallengeId) return bad('cid drift: not the on-chain next_challenge_id', 409);
  } else {
    const meta = await chain.getMeta(body.cid);
    if (!meta) return bad('challenge not found on-chain', 404);
    // contract.py submit_score accepts OPEN or CLOSED (full table still
    // submits); terminal states have their boxes deleted -> meta null above.
    if (meta.status !== STATUS_OPEN && meta.status !== STATUS_CLOSED) return bad('challenge not active', 409);
    if (meta.stageMode === MODE_RANDOM_RESOLVED) return bad('random mode not supported by oracle v1', 400);
    const wantMode = body.stageMode === 'full' ? MODE_FULL : MODE_STAGE_IDX;
    if (meta.stageMode !== wantMode) return bad('stageMode does not match on-chain meta');
    if (chain.now() >= Number(meta.deadline) - JOIN_CUTOFF_SEC) return bad('join/submit cutoff passed (deadline-600s)', 409);
    const roster = await chain.getPlayers(body.cid);
    const entry = roster[body.seat];
    if (!entry) return bad('seat out of roster range');
    if (algosdk.encodeAddress(entry.addr) !== body.addr) return bad('addr does not occupy this seat');
    // 2. stage binding (joiners only; the create note rides the create txn
    //    itself, which for seat 0 is not on-chain yet)
    if (body.stageMode === 'stage') {
      stageCommit = await chain.getStageForCid(body.cid);
      if (!stageCommit) return bad('stage commitment unavailable (indexer scan failed)', 503);
      // v18.1.1: LOG this reject — Prince's mobile joiners hit it invisibly
      // (the client fell back to a cid%7 stage guess when the note scan
      // failed, then signed the guess against the real commitment)
      if (stageCommit.stage !== body.stageIdx) {
        logSignScoreReject('STAGEIDX MISMATCH', body, { committed: stageCommit.stage, source: stageCommit.source });
        return bad('stageIdx does not match the create-note commitment');
      }
    }
  }

  // 3. score cap
  const cap = capFor(cfg.scoreCaps, body.stageMode, body.stageIdx ?? (body.stageMode === 'stage' ? stageCommit?.stage ?? null : null));
  // v17.0.5: log cap rejections too — the 500k stage cap silently refused a
  // REAL 507,950 run on day 1 (Friedbean report); invisible in ops logs.
  if (body.score > cap) {
    logSignScoreReject('SCORE ABOVE CAP', body, { cap });
    return bad('score above cap');
  }

  // 4. run sanity (SPEC §3.2 rule 4)
  if (body.run.frames < 60 * 10) return bad('run sanity: frames below 600');
  if (body.run.frames > 300_000) return bad('run sanity: frames above 300000');
  if (body.run.durationSec < (body.run.frames / 60) * 0.5) return bad('run sanity: duration too short for frames');
  if (body.run.inputLogB64 != null) {
    const raw = b64decode(body.run.inputLogB64);
    if (!raw) return bad('input log: invalid base64');
    const log = decodeInputLog(raw);
    if (!log) return bad('input log: invalid structure');
    if (log.header.frames !== body.run.frames) return bad('input log: frames mismatch');
    if (log.header.build !== body.build) return bad('input log: build mismatch');
    if (log.header.seedLabel !== body.run.seedLabel) return bad('input log: seedLabel mismatch');
  }

  // 5. replay verification (SPEC-m2 §5) — AFTER the M1 read-only checks above,
  //    BEFORE the continue/anti-replay DB writes and BEFORE signing: a refused
  //    run must never consume a receipt nor leave a sig row. Pipeline order:
  //    v1 legacy gate -> truncated -> build bundle -> seedLabel -> replay ->
  //    exact score equality (wall-clock guarded by the verifier).
  if (cfg.replayEnforce) {
    if (!deps.replay) return bad('replay verifier not configured', 500);
    if (body.run.inputLogB64 == null) {
      logSignScoreReject('RUN LOG REQUIRED', body);
      return bad('RUN LOG REQUIRED'); // no log, no signature under enforcement
    }
    const raw = b64decode(body.run.inputLogB64); // validated above
    const log = raw ? decodeInputLog(raw) : null;
    if (!log) return bad('input log: invalid structure'); // unreachable (rule 4), kept for exhaustiveness
    if (log.header.v === 1) {
      // legacy semantics (records the intro): not replayable — M1 path only,
      // and only where explicitly allowed (testnet default on, mainnet off)
      if (!cfg.allowLegacyGil) {
        logSignScoreReject('LEGACY LOG REFUSED', body, { gilVersion: 1, gilSeed: log.header.seedLabel, gilFrames: log.header.frames });
        return bad('LEGACY LOG REFUSED');
      }
    } else {
      if (log.header.truncated) {
        logSignScoreReject('RUN LOG TRUNCATED', body, { gilSeed: log.header.seedLabel, gilFrames: log.header.frames });
        return bad('RUN LOG TRUNCATED');
      }
      const expectedSeed = body.stageMode === 'stage' ? `PIT-${body.cid}` : `RUN-${body.cid}`;
      if (log.header.seedLabel !== expectedSeed) {
        logSignScoreReject('SEED MISMATCH', body, { gilSeed: log.header.seedLabel, expectedSeed });
        return bad('SEED MISMATCH');
      }
      const r = await deps.replay.verifyRun({
        build: log.header.build,
        stageMode: body.stageMode,
        stageIdx: body.stageMode === 'stage' ? (body.stageIdx ?? stageCommit?.stage ?? null) : null,
        seedLabel: log.header.seedLabel,
        masks: log.bitmask,
        edges: log.edges ?? undefined,
        score: body.score,
      });
      if (!r.ok) {
        logSignScoreReject(r.reason, body, {
          gilSeed: log.header.seedLabel,
          expectedSeed,
          replayedScore: r.diag?.replayedScore
            ?? (r.reason === 'REPLAY TIMEOUT - RETRY'
              ? (r.diag?.partialScore !== undefined ? `timeout@<${r.diag.partialScore}>` : 'timeout')
              : r.diag?.partialScore !== undefined ? `stuck@<${r.diag.partialScore}>` : '-'),
          playFrames: r.diag?.playFrames ?? null,
          endScene: r.diag?.endScene ?? null,
          elapsedMs: r.diag?.elapsedMs ?? null,
        });
        return bad(r.reason, r.status);
      }
    }
  }

  // sign (byte-exact SPEC §1)
  const addrBytes = algosdk.decodeAddress(body.addr).publicKey;
  const sig = signer.sign(scoreMsg(wantApp, body.cid, body.seat, addrBytes, body.score));
  const sigRow: SigRow = {
    cid: body.cid,
    seat: body.seat,
    addr: body.addr,
    score: body.score,
    build: body.build,
    frames: body.run.frames,
    ts: chain.now(),
    sigB64: b64encode(sig),
    ip,
  };

  // 5. continue receipt: consumed ATOMICALLY with the sig persist (one SQLite tx)
  if (body.continueRef != null) {
    const res = await store.consumeReceiptAndStoreSig(body.continueRef, body.addr, sigRow);
    if (res === 'missing') return bad('continue receipt not found', 404);
    if (res === 'consumed') return bad('continue receipt already consumed', 409);
    if (res === 'addr-mismatch') return bad('continue receipt addr mismatch', 409);
  } else {
    // 6. anti-replay: one active sig per (cid,seat); a different score
    //    overwrites the previous row (legit re-submit)
    await store.upsertSig(sigRow);
  }

  return ok({ sigB64: sigRow.sigB64, oracleAddr: signer.addr });
}

// ---------------------------------------------------------------------------
// §3.3 POST /v1/verdict — everything derived from chain
// ---------------------------------------------------------------------------
export async function handleVerdict(deps: Deps, rawBody: unknown): Promise<Reply> {
  const { cfg, signer } = deps;
  const wantApp = Number((rawBody as Record<string, unknown>)?.['appId'] ?? cfg.appId);
  const chain = deps.chains?.get(wantApp) ?? (wantApp === cfg.appId ? deps.chain : undefined);
  if (!chain) return bad('unknown appId', 400);
  if (typeof rawBody !== 'object' || rawBody === null) return bad('malformed request body');
  const cid = (rawBody as Record<string, unknown>)['cid'];
  if (!Number.isInteger(cid) || (cid as number) < 0) return bad('malformed request body');

  const meta = await chain.getMeta(cid as number);
  if (!meta) return bad('challenge not active (not found or already resolved)', 409);
  if (meta.status !== STATUS_OPEN && meta.status !== STATUS_CLOSED) return bad('challenge not active', 409);
  if (meta.stageMode === MODE_RANDOM_RESOLVED) return bad('random mode needs a seed reveal: unsupported by oracle v1', 409);

  const roster = await chain.getPlayers(cid as number);
  if (roster.length === 0) return bad('roster missing', 409);

  // resolvability = contract.py:661-672 exactly
  const filled = meta.seatsTaken === meta.seatsTotal;
  let allSigned = true;
  let signedJoiners = 0;
  roster.forEach((p, i) => {
    if (p.signed) {
      if (i > 0) signedJoiners++;
    } else allSigned = false;
  });
  const allowed = (filled && allSigned) || (chain.now() >= Number(meta.deadline) && signedJoiners >= 1);
  if (!allowed) return bad('not resolvable yet (table not fully signed, deadline not passed)', 409);

  const entries: DigestEntry[] = [];
  roster.forEach((p, i) => {
    if (p.signed) entries.push({ seat: i, addr: p.addr, score: p.score });
  });
  const digest = verdictDigest(entries); // signed only, seat order

  let extra: Uint8Array;
  let stageIdx: number | null = null;
  let stageMode: 'full' | 'stage';
  if (meta.stageMode === MODE_FULL) {
    extra = verdictExtraFull();
    stageMode = 'full';
  } else {
    const commit = await chain.getStageForCid(cid as number);
    if (!commit) return bad('stage commitment unavailable (indexer scan failed)', 503);
    stageIdx = commit.stage;
    extra = verdictExtraStage(stageIdx);
    stageMode = 'stage';
  }

  const msg = verdictMsg(wantApp, cid as number, meta.stageMode, extra, digest);
  const sig = signer.sign(msg);
  return ok({
    verdictSigB64: b64encode(sig),
    digestB64: b64encode(digest),
    extraB64: b64encode(extra),
    stageMode,
    stageIdx,
    playerCount: entries.length,
  });
}

// ---------------------------------------------------------------------------
// §3.4 POST /v1/continue/receipt
// ---------------------------------------------------------------------------
export async function handleContinueReceipt(deps: Deps, rawBody: unknown): Promise<Reply> {
  const { chain, store } = deps;
  if (typeof rawBody !== 'object' || rawBody === null) return bad('malformed request body');
  const b = rawBody as Record<string, unknown>;
  if (!isStr(b['refId'], 64) || !isStr(b['addr'], 58) || !isStr(b['txid'], 64)) return bad('malformed request body');
  try {
    algosdk.decodeAddress(b['addr'] as string);
  } catch {
    return bad('malformed request body');
  }
  const verified = await chain.verifyContinuePayment(b['txid'] as string, b['refId'] as string, b['addr'] as string);
  if (!verified) return bad('continue payment not verified on-chain');
  const inserted = await store.insertReceipt(b['refId'] as string, b['addr'] as string, b['txid'] as string, chain.now());
  if (!inserted) return bad('receipt already registered', 409);
  return ok({ ok: true });
}
