# GONNA ARENA — Server Oracle (M1 + M2 replay verification)

HTTPS service that custodies the arena oracle key **server-side** and signs
score / verdict messages **only after verifying against the on-chain state**
(SPEC-oracle §1–§5, contract v2 FROZEN). Never trusts the client.

## Layout

```
src/index.ts   boot + Hono routes, rate limit, CORS, boot asserts
src/config.ts  env config (mnemonic ONLY via ORACLE_MNEMONIC_FILE)
src/chain.ts   algod/indexer reads: global state, meta box, players box,
               create-note stage scan (port of testnetKit.fetchArenaCreateStages),
               continue-payment verification
src/sign.ts    byte-exact messages (score 66B, verdict 92B) + ed25519 detached
               (seed = first 32B of the algosdk sk, PyNaCl-equivalent)
src/verify.ts  §3.2 sign-score rules, §3.3 verdict derivation, §3.4 receipts,
               §5 input-log structural validation
src/store.ts   SQLite (better-sqlite3, WAL): sigs, receipts, rate buckets
test/          vitest: byte-exact vectors vs contract.py (Python-generated),
               every §3.2 rule positive+negative (chain stubbed via DI),
               receipts single-use, rate limit 429+Retry-After, boot asserts
scripts/smoke-testnet.mjs  live testnet smoke (see below)
```

## Crypto truths (verified byte-exact in test/vectors.test.ts)

- score msg: `QA-SCORE|` ‖ u64be(app) ‖ u64be(cid) ‖ u8(seat) ‖ 32B addr ‖ u64be(score) — **66 B**
- verdict msg: `QA-VERDICT|` ‖ u64be(app) ‖ u64be(cid) ‖ u8(mode) ‖ 32B extra ‖ 32B digest — **92 B**
  (SPEC-oracle §1 says "90 byte": a typo — `len("QA-VERDICT|")=11`, 11+8+8+1+32+32=92.
  contract.py and testnetKit.ts both produce 92 B; the FROZEN contract wins.)
- digest: SHA-256 of `u8(seat)‖32B addr‖u64be(score)` per **signed** player, seat order
- extra: 32×0 (FULL) or 24×0‖u64be(stage_idx) (STAGE_IDX)
- signature: ed25519 bare detached, seed = first 32 B of the algosdk secret key

## Input log v1/v2 wire format (SPEC §5 + SPEC-m2 §2)

`inputLogB64` = base64 of (big-endian, no padding — mirrors the client codec
`src/game/arena/inputLog.ts`):

```
'G' 'I' 'L'         magic
u8                  version (1 = recorded from run start, intro included — legacy;
                             2 = frame 0 is the first scene==='play' frame)
u8                  flags (bit0 = truncated)
u16 buildLen + utf8 build
u16 seedLen  + utf8 seedLabel
u32 frames          (<= 300000)
frames x u8         per-frame button bitmask (bit0 up ... bit7 special)
```

- exactly 1 bitmask byte per frame, no trailing data
- header `frames`/`build`/`seedLabel` must equal the sibling request fields
- M1: structural validation only. M2 (REPLAY_ENFORCE=1): v2 logs are
  **replayed bit-exact** before signing (below); v1 logs follow the legacy
  gate (`ALLOW_LEGACY_GIL`). Cap: 300k frames (enforced in decode).

## M2 replay verification (SPEC-m2 §5/§6)

With `REPLAY_ENFORCE=1` (default), after the M1 checks and **before** any DB
write or signature, `/v1/sign-score` replays the submitted v2 log headless:

1. missing log → 400 `RUN LOG REQUIRED`
2. v1 log → M1 structural path only if `ALLOW_LEGACY_GIL=1` (testnet default
   on, mainnet default off), else 400 `LEGACY LOG REFUSED`
3. `truncated` → 400 `RUN LOG TRUNCATED`
4. no bundle `replay-bundles/engine-<build>.mjs` → 400 `BUILD UNKNOWN TO THE ORACLE`
5. header `seedLabel` != chain-derived `PIT-<cid>` (stage) / `RUN-<cid>` (full)
   → 400 `SEED MISMATCH`
6. headless replay (fresh Game per request, bundle cached per build) →
   **exact integer score equality**, else 400 `REPLAY MISMATCH`
7. wall-clock guard `REPLAY_TIMEOUT_MS` (default 30000) → 500 `REPLAY TIMEOUT - RETRY`

M2-4: the replay boots through the EXACT client entries —
`startArenaRun('stage', idx, {seedTag: 'PIT-<cid>'})` / `debugFullRun('RUN-<cid>')`
(v16.1 engine self-installs the seeded streams) — and drives the log with the
scene-aware contract promoted from `scripts/test-v1610.mjs`: mask consumed per
**play-scene frame only**, intro force-skipped, clear/victory scenes stepped
with an auto START (player-mashing-START semantics), driver stuck in non-play
scenes → 400 `REPLAY MISMATCH`. `globalThis.__GONNA_VER` is pinned per request
so the bundle's sealed-log build stamp matches `<VER>`. RNG parity:
`makeRngFromLabel(label) === makeRng(hashSeed(label))` (src/game/rng.ts).

Bundles are built per released client build and committed:

```bash
node scripts/build-replay-bundle.mjs <VER>     # or --from-dist after vite build
```

Boot assert: with enforcement on, at least one bundle must exist or the
server exits 1. FULL mode campaign boot mirrors SPEC-m2 §4 (single
`mulberry32(hashSeed('RUN-<cid>'))` stream over the whole arena run);
DESCENT uses the engine-seeded `PIT-<cid>`. Determinism proof: M2-0
(`M2-0-REPORT.md`) — bit-exact Node↔Chromium. Client parity is proven by the
GATE suite (`test/replayIntegration.test.ts`): real GIL v2 logs recorded by
the client path (recorder + sealed artifacts) replay bit-exact, stageIdx
0..3 + full campaign + death-sealed runs.

**Frozen-contract tie bug (found by M2-4 E2E, cid 56)**: a perfect tie at the
top score BRICKS a full+signed card — `resolve` deletes both boxes, then the
tie branch lazily `box_extract`s the deleted players box
(QuantumArena.approval.teal:3036-3090) → "no such box" forever. The contract
is FROZEN; callers MUST avoid top-score ties (the E2E sim re-rolls honest
runs until the top is unique).

**Hardening M3**: the replay runs in-process (justified: 300k frame cap +
rate limits + wall-clock guard). For mainnet, isolate it in a
`worker_threads` pool (one worker per replay, hard kill on timeout, memory
cap) so a hostile log cannot block the event loop.

## Endpoints (base `/v1`)

| method | path | notes |
|---|---|---|
| GET | `/v1/health` | `{ok, network, appId, oracleAddr, uptimeSec}` |
| POST | `/v1/sign-score` | all 6 SPEC §3.2 checks in order → `{sigB64, oracleAddr}` |
| POST | `/v1/verdict` | `{cid}` → everything derived from chain → `{verdictSigB64, digestB64, extraB64, stageMode, stageIdx, playerCount}` (`playerCount` = signed players in the digest); 409 when not resolvable |
| POST | `/v1/continue/receipt` | `{refId, addr, txid}` → verifies the 5-ALGO treasury payment on-chain, registers single-use receipt; 409 on replay |

Errors: `{error: reason}`, never a stack. 429 carries `Retry-After`.
Rate limit: fixed 60s windows per IP **and** per addr (`MAX_SIG_PER_MIN=30,6`),
counted at endpoint entry to protect upstream algod/indexer.

### sign-score rules (in order)

0. body shape (types, valid Algorand address, safe integers)
1. **chain truth**: seat 0 → `cid == next_challenge_id` (anti CID-drift);
   seat>0 → meta exists, status OPEN **or CLOSED** (a full table still submits —
   contract.py `submit_score` accepts both; SPEC §3.2 says "OPEN", see
   DEVIATIONS), addr occupies the seat (players box), now < deadline−600s,
   stageMode matches meta; MODE_RANDOM rejected (v1)
2. **stage binding**: `stageIdx` == the create-note `gonna:v2:stage:<K>`
   (indexer scan, cross-checked count; pre-note cards → documented fallback
   `cid % 7`). Skipped for seat 0 (the note rides the create txn itself,
   not on-chain yet)
3. **score cap** (`SCORE_CAPS_JSON`, defaults full 2 000 000 / stage 500 000)
4. **run sanity**: frames ≥ 600, frames ≤ 300 000, durationSec ≥ frames/60 × 0.5,
   optional input-log v1/v2 structural validation
5. **replay verification (M2)**: when `REPLAY_ENFORCE=1` — see the M2 section;
   placed after the read-only checks and BEFORE any DB write so a refused run
   never consumes a continue receipt nor leaves a sig row
6. **continue**: receipt exists, unconsumed, addr match — consumed ATOMICALLY
   with the sig insert (same SQLite tx)
7. **anti-replay**: one active sig per (cid,seat), new score overwrites

## Local dev

```bash
npm install
npm test                    # vitest (choice documented: vitest)
npm run build && npm start  # needs the env from .env.example
```

The oracle mnemonic file (local dev, throwaway keys only):

```bash
umask 077 && echo "word1 word2 ... word25" > ./oracle_mnemonic && chmod 600 ./oracle_mnemonic
```

Boot asserts (exit 1 on mismatch): derived oracle address == `oracle_pub_key`
on-chain, `TREASURY_ADDR` == on-chain treasury, app version == 2.

## Docker / deploy

```bash
docker build -t gonna-oracle .
docker run --rm -p 8787:8787 \
  -v gonna-oracle-data:/data \
  -v /secure/path/oracle_mnemonic:/run/secrets/oracle_mnemonic:ro \
  --env-file .env \
  gonna-oracle
```

- non-root user, port 8787, `/data` volume (SQLite WAL — must be a real fs)
- mainnet flip = env only (`ARENA_NETWORK=mainnet`, mainnet URLs/ids), same image
- put a TLS-terminating proxy in front; it must forward `X-Forwarded-For`
  (rate limiting keys on it)

## Live testnet smoke

```bash
npm run smoke:testnet
```

Reads the ORACLE key from `../contracts/quantum-arena/deploy/testnet.secrets.json`
(never printed), boots the server locally, checks `/v1/health`, `/v1/verdict`
on an already-resolved card (expects 409) and `/v1/sign-score` with a fake cid
(expects chain-truth rejection). Cleans up the temp key file on exit.

## Sandbox note (this repo's mount)

The repo mount disallows executing binaries from the tree. If `npm test`
fails with `esbuild EACCES`, stage the binary once:

```bash
mkdir -p /tmp/esbin && cp node_modules/@esbuild/linux-x64/bin/esbuild /tmp/esbin/ && chmod +x /tmp/esbin/esbuild
ESBUILD_BINARY_PATH=/tmp/esbin/esbuild npm test
```

## DEVIATIONS from SPEC-oracle (motivated)

1. **verdict msg 92 B, not "90"** — SPEC §1 typo; contract.py (`"QA-VERDICT|"` 11 B
   domain) and testnetKit.ts both build 92 B. The FROZEN contract is truth.
2. **sign-score accepts status CLOSED** for seat>0 — contract.py `submit_score`
   accepts OPEN *or* CLOSED; a full table (CLOSED) still needs score signatures.
   SPEC §3.2 rule 1 says "status OPEN", which would brick every full card.
3. **rate limit counted at endpoint entry** (before rule-1 chain reads) — a
   later placement would let a flood hammer upstream algod/indexer; SPEC lists
   it under rule 6 but does not mandate placement. Error surface unchanged.
