// config.ts — env-driven configuration (SPEC §2). The mnemonic is read from
// ORACLE_MNEMONIC_FILE (0600, mounted secret) when set — PREFERRED — or from
// the ORACLE_MNEMONIC env var as a fallback (Render-style secret env, where
// secret FILES can only be created from the dashboard but env vars can be
// automated via API). It is never logged and never returned by the API.
import { readFileSync } from 'node:fs';

export interface ScoreCaps {
  full: number;
  stage: number[]; // indexed by stageIdx 0..6
}

export interface OracleConfig {
  network: 'testnet' | 'mainnet';
  appId: number;
  /** v3 flip: every app this oracle signs for (appId = appIds[0], primary). */
  appIds: number[];
  gonnaAsaId: number;
  treasuryAddr: string;
  algodUrl: string;
  indexerUrl: string;
  oracleMnemonicFile?: string; // ORACLE_MNEMONIC_FILE — preferred source
  oracleMnemonic?: string; // ORACLE_MNEMONIC — fallback source (never logged)
  port: number;
  corsOrigins: string[];
  ratePerMinIp: number;
  ratePerMinAddr: number;
  scoreCaps: ScoreCaps;
  dbPath: string;
  // M2 replay verification (SPEC-m2 §5)
  replayEnforce: boolean; // REPLAY_ENFORCE (default 1); 0 = recovery mode (M1 structural only)
  allowLegacyGil: boolean; // ALLOW_LEGACY_GIL (default 1 testnet / 0 mainnet)
  replayBundlesDir: string; // REPLAY_BUNDLES_DIR (default <pkg>/replay-bundles)
  replayTimeoutMs: number; // REPLAY_TIMEOUT_MS (default 30000; 0 = abort at first checkpoint)
  // SEV-2b receipt persistence (M-1): when TURSO_URL is set the store uses
  // libsql (Turso free tier) so receipts survive an ephemeral-disk redeploy;
  // absent -> local SQLite (boot warns that receipts are at risk on wipe).
  tursoUrl?: string; // TURSO_URL (optional, e.g. libsql://<db>-<org>.turso.io)
  tursoAuthToken?: string; // TURSO_AUTH_TOKEN (optional; never logged)
}

/**
 * v17.0.5: caps raised after live evidence — a legit LV1 run sealed 507,950
 * and the 500k pre-filter refused a REAL score. The cap is ONLY a cheap
 * pre-filter that saves replay CPU on absurd claims; the deterministic
 * replay + exact-score equality behind it is the actual anti-cheat, so a
 * generous cap is safe (frames stay bounded at 300k by the sanity gate).
 */
export const DEFAULT_SCORE_CAPS: ScoreCaps = {
  full: 5_000_000,
  stage: [2_000_000, 2_000_000, 2_000_000, 2_000_000, 2_000_000, 2_000_000, 2_000_000],
};

const DEFAULT_ALGOD: Record<string, string> = {
  testnet: 'https://testnet-api.algonode.cloud',
  mainnet: 'https://mainnet-api.algonode.cloud',
};
const DEFAULT_INDEXER: Record<string, string> = {
  testnet: 'https://testnet-idx.algonode.cloud',
  mainnet: 'https://mainnet-idx.algonode.cloud',
};

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v || !v.trim()) throw new Error(`config: missing required env ${key}`);
  return v.trim();
}

function intEnv(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const v = env[key];
  if (v == null || v.trim() === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`config: ${key} must be a non-negative integer`);
  return n;
}

function reqInt(env: NodeJS.ProcessEnv, key: string): number {
  const v = req(env, key);
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`config: ${key} must be a non-negative integer`);
  return n;
}

function parseRate(v: string | undefined): { ip: number; addr: number } {
  // SPEC §2: MAX_SIG_PER_MIN default 30/IP, 6/addr. Accept "30" (ip only,
  // addr defaults to 6) or "30,6" (explicit pair).
  if (!v || !v.trim()) return { ip: 30, addr: 6 };
  const parts = v.split(',').map((s) => Number(s.trim()));
  if (parts.some((n) => !Number.isInteger(n) || n <= 0) || parts.length > 2) {
    throw new Error('config: MAX_SIG_PER_MIN must be "N" or "N,M" (positive integers)');
  }
  return { ip: parts[0] as number, addr: parts.length === 2 ? (parts[1] as number) : 6 };
}

function parseScoreCaps(v: string | undefined): ScoreCaps {
  if (!v || !v.trim()) return DEFAULT_SCORE_CAPS;
  let j: unknown;
  try {
    j = JSON.parse(v);
  } catch {
    throw new Error('config: SCORE_CAPS_JSON is not valid JSON');
  }
  const o = j as Partial<ScoreCaps>;
  const full = typeof o.full === 'number' && Number.isInteger(o.full) && o.full > 0 ? o.full : DEFAULT_SCORE_CAPS.full;
  const stage = Array.isArray(o.stage) && o.stage.every((n) => Number.isInteger(n) && n > 0) ? o.stage : DEFAULT_SCORE_CAPS.stage;
  return { full, stage };
}

export function capFor(caps: ScoreCaps, stageMode: 'full' | 'stage', stageIdx: number | null): number {
  if (stageMode === 'full') return caps.full;
  const i = stageIdx ?? -1;
  return caps.stage[i] ?? DEFAULT_SCORE_CAPS.stage[i] ?? 500_000;
}

/** Pick the mnemonic source: FILE if present (preferred), ENV as fallback. */
function mnemonicSource(env: NodeJS.ProcessEnv): { oracleMnemonicFile?: string; oracleMnemonic?: string } {
  const file = (env['ORACLE_MNEMONIC_FILE'] ?? '').trim();
  const inline = (env['ORACLE_MNEMONIC'] ?? '').trim();
  if (file) return { oracleMnemonicFile: file };
  if (inline) return { oracleMnemonic: inline };
  throw new Error('config: missing required env ORACLE_MNEMONIC_FILE (preferred, 0600 secret file) or ORACLE_MNEMONIC (fallback)');
}

/**
 * Resolve the oracle mnemonic at boot. The FILE source always wins when
 * configured; the env var is only a fallback. The VALUE is never logged —
 * callers may only log which source was used (see keySource()).
 */
export function resolveMnemonic(
  cfg: Pick<OracleConfig, 'oracleMnemonicFile' | 'oracleMnemonic'>,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): string {
  if (cfg.oracleMnemonicFile) return readFile(cfg.oracleMnemonicFile);
  if (cfg.oracleMnemonic) return cfg.oracleMnemonic;
  throw new Error('config: no oracle key source configured');
}

/** 'file' | 'env' — safe to log (the source, never the value). */
export function keySource(cfg: Pick<OracleConfig, 'oracleMnemonicFile' | 'oracleMnemonic'>): string {
  return cfg.oracleMnemonicFile ? 'file' : 'env';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OracleConfig {
  // NETWORK (canonical, M-1) wins over the legacy ARENA_NETWORK name; one of
  // the two is required.
  const networkRaw = (env['NETWORK'] ?? '').trim() || req(env, 'ARENA_NETWORK');
  if (networkRaw !== 'testnet' && networkRaw !== 'mainnet') {
    throw new Error(`config: NETWORK|ARENA_NETWORK must be testnet|mainnet (got ${JSON.stringify(networkRaw)})`);
  }
  const rate = parseRate(env['MAX_SIG_PER_MIN']);
  // CORS: ALLOWED_ORIGINS (canonical, M-1) wins over the legacy CORS_ORIGIN;
  // defaults are network-scoped — mainnet serves ONLY the production origins
  // (never localhost), testnet keeps the production origin only by default
  // (localhost entries are added explicitly via env when dogfooding).
  const corsRaw = (env['ALLOWED_ORIGINS'] ?? '').trim() || (env['CORS_ORIGIN'] ?? '').trim();
  const corsDefault = networkRaw === 'mainnet' ? 'https://gonna.bond,https://www.gonna.bond' : 'https://gonna.bond';
  const cors = (corsRaw || corsDefault)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // SEV-1 guard (M-1): the legacy GIL v1 branch bypasses the full replay and
  // would sign arbitrary scores. On mainnet it is FORBIDDEN — refuse to boot.
  const allowLegacyGil = (env['ALLOW_LEGACY_GIL'] ?? '0').trim() !== '0';
  if (networkRaw === 'mainnet' && allowLegacyGil) {
    throw new Error(
      'config: ALLOW_LEGACY_GIL must be 0 on mainnet (SEV-1: legacy GIL v1 bypasses the replay and signs arbitrary scores) — refusing to start',
    );
  }
  return {
    network: networkRaw,
    appId: reqInt(env, 'ARENA_APP_ID'),
    // ARENA_APP_IDS: comma list, first = primary (default: ARENA_APP_ID only).
    appIds: ((env['ARENA_APP_IDS'] ?? '').trim()
      ? (env['ARENA_APP_IDS'] ?? '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0)
      : [reqInt(env, 'ARENA_APP_ID')]),
    gonnaAsaId: intEnv(env, 'GONNA_ASA_ID', 0),
    treasuryAddr: req(env, 'TREASURY_ADDR'),
    algodUrl: (env['ALGOD_URL'] ?? DEFAULT_ALGOD[networkRaw] ?? '').trim(),
    indexerUrl: (env['INDEXER_URL'] ?? DEFAULT_INDEXER[networkRaw] ?? '').trim(),
    ...mnemonicSource(env),
    port: intEnv(env, 'PORT', 8787),
    corsOrigins: cors,
    ratePerMinIp: rate.ip,
    ratePerMinAddr: rate.addr,
    scoreCaps: parseScoreCaps(env['SCORE_CAPS_JSON']),
    dbPath: (env['DB_PATH'] ?? '/data/oracle.db').trim(),
    replayEnforce: (env['REPLAY_ENFORCE'] ?? '1').trim() !== '0',
    allowLegacyGil,
    replayBundlesDir: (env['REPLAY_BUNDLES_DIR'] ?? new URL('../replay-bundles/', import.meta.url).pathname).trim(),
    replayTimeoutMs: intEnv(env, 'REPLAY_TIMEOUT_MS', 30_000),
    tursoUrl: (env['TURSO_URL'] ?? '').trim() || undefined,
    tursoAuthToken: (env['TURSO_AUTH_TOKEN'] ?? '').trim() || undefined,
  };
}

/** One-line boot log: public data only, never the mnemonic. */
export function configLogLine(cfg: OracleConfig): string {
  return `network=${cfg.network} appId=${cfg.appId} algod=${cfg.algodUrl} indexer=${cfg.indexerUrl} ` +
    `port=${cfg.port} keysrc=${keySource(cfg)} cors=[${cfg.corsOrigins.join(' ')}] rate=${cfg.ratePerMinIp}/ip,${cfg.ratePerMinAddr}/addr db=${cfg.dbPath} store=${cfg.tursoUrl ? 'turso(libsql)' : 'sqlite-local'} ` +
    `replay=${cfg.replayEnforce ? `enforce(legacyGil=${cfg.allowLegacyGil ? 'on' : 'off'},bundles=${cfg.replayBundlesDir})` : 'OFF'}`;
}
