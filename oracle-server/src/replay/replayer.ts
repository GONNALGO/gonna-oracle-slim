// replay/replayer.ts — M2 replay verification core (SPEC-m2 §5/§6).
// Loads a PINNED engine bundle (oracle-server/replay-bundles/engine-<VER>.mjs,
// built by scripts/build-replay-bundle.mjs from src/game/ at release time),
// boots it headless against browser stubs, and replays the GIL mask stream
// frame by frame to recompute the score. Bit-exactness Node<->browser proven
// in M2-0 (commit 3386f41): Node V8 11.3 <-> Chromium V8 14.1 identical.
//
// Determinism contract:
//   - fresh Game per replay (no shared state between requests);
//   - bundle module cached per build (import() once);
//   - intro STEPPED THROUGH (fixed 151-frame title card; GIL v2 frame 0 =
//     first frame of scene==='play'; START is not in the mask, M2-0 finding);
//   - DESCENT stage mode seeds 'PIT-<cid>' (already seeded in the engine);
//   - FULL mode mirrors SPEC-m2 §4: a single mulberry32(hashSeed('RUN-<cid>'))
//     stream replaces the campaign rng for the WHOLE run (patched over every
//     loadStage). Cross-agent contract with m2-client: identical semantics.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installBrowserStubs, makeCanvas } from './stubs.js';

export interface ReplayEngine {
  Game: any;
  buildArt: () => any;
  hashSeed: (label: string) => number;
  makeRng: (seed: number) => any;
}

const BTNS = ['up', 'down', 'left', 'right', 'punch', 'kick', 'jump', 'special'] as const;

export class ReplayTimeoutError extends Error {
  constructor() {
    super('replay wall-clock budget exceeded');
    this.name = 'ReplayTimeoutError';
  }
}

export class ReplayStuckError extends Error {
  constructor() {
    super('driver stuck in non-play scene');
    this.name = 'ReplayStuckError';
  }
}

/** Scan replay-bundles/ for engine-<build>.mjs artifacts. */
export function scanReplayBundles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // missing dir == no bundles
  }
  for (const n of names) {
    const m = /^engine-(.+)\.mjs$/.exec(n);
    if (m && m[1]) out.set(m[1], path.join(dir, n));
  }
  return out;
}

/** Boot a fresh Game on stub canvas + stub art + no skin frames. */
export function bootGame(eng: ReplayEngine): any {
  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d');
  const art = eng.buildArt();
  // TS-private constructor — compile-time only, plain JS at runtime
  return new eng.Game(ctx, art, new Map());
}

/** Seeded DESCENT run (same public QA entry the client harness uses). */
export function startDescent(game: any, stageIdx: number, seedLabel: string): void {
  game.debugDescent(stageIdx, seedLabel);
}

/** Stage run boot — the EXACT arena stage-mode client entry (v16.1). */
export function startStageRun(game: any, stageIdx: number, seedLabel: string): void {
  game.startArenaRun('stage', stageIdx, { seedTag: seedLabel });
}

/**
 * FULL RUN (campaign) seeded boot — the EXACT arena full-mode client entry
 * (SPEC-m2 §4, m2-client): the engine self-installs ONE
 * makeRngFromLabel(seedLabel) campaign stream for the whole run
 * (startArenaRun -> loadStage -> this.rng = arenaRunRng ?? mathRng).
 * RNG parity: makeRngFromLabel(label) === makeRng(hashSeed(label)) (rng.ts).
 */
export function startFullRunSeeded(eng: ReplayEngine, game: any, seedLabel: string): void {
  game.debugFullRun(seedLabel); // scene 'intro'; the replay driver force-skips
}

export interface ReplayResult {
  score: number;
  playFrames: number;
  steps: number;
  stageIdx: number;
  scene: string;
  elapsedMs: number;
}

/**
 * Scene-aware replay driver — the M2 replay CONTRACT, promoted verbatim from
 * the client reference (scripts/test-v1610.mjs replayCampaign). GIL v2 log
 * frames are PLAY-scene frames ONLY:
 *   - intro: stepped through (fixed 151 frames, unskippable), consumes no mask;
 *   - clear tally / victory: auto START (player mashing START — the bonus
 *     lands the instant the press registers), consumes no mask;
 *   - play: consume one mask (levels + rising-edge pressed), step.
 * Cooperative wall-clock guard every 1024 steps (budget 0 = abort at the
 * first checkpoint — deterministic in tests). In-process by design for M2
 * (frame cap 300k + rate limits); worker_threads isolation = M3 hardening.
 */
const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

// v18.1.5 (Prince PIT-8, 60028 frames, REPLAY TIMEOUT + Render 502): the
// replay is ASYNC now — every 1024 steps it yields to the event loop, so a
// long legit replay (a 15-wave pro run can need minutes on the free-tier
// CPU) can NEVER starve /v1/health and get the service killed mid-sign.
export async function replayCampaign(game: any, masks: Uint8Array, timeoutMs: number, edges?: Uint8Array): Promise<ReplayResult> {
  const down = game.input.down;
  const pressed = game.input.pressed;
  const t0 = Date.now();
  let i = 0;
  let steps = 0;
  while (i < masks.length) {
    if (++steps > masks.length * 4 + 20000) throw new ReplayStuckError();
    if ((steps & 0x3ff) === 0) {
      if (Date.now() - t0 >= timeoutMs) throw new ReplayTimeoutError();
      await yieldLoop(); // let health checks and other requests breathe
    }
    const sc = game.scene;
    if (sc !== 'play') {
      // v17.0.7 (Friedbean REPLAY MISMATCH): the fixed client mutes gameplay
      // buttons outside play and force-releases levels at every scene cut, so
      // each play segment starts from an all-up baseline. The driver mirrors
      // it: no gameplay level may leak across a non-play scene, or the first
      // mask of the next segment would regenerate a phantom rising edge.
      for (const b of BTNS) { down[b] = false; pressed[b] = false; }
      if (sc === 'clear' || sc === 'victory') game.input.pressed.start = true;
      game.step();
      continue;
    }
    const m = masks[i]!;
    if (edges) {
      // GIL v3 (v17.0.10): apply the RECORDED edges verbatim — a fast mobile
      // tap that went down+up inside one frame left no level trace but its
      // edge DID land in the tape, so the replay stays pixel-perfect.
      const e = edges[i]!;
      for (let b = 0; b < 8; b++) {
        down[BTNS[b]!] = ((m >> b) & 1) === 1;
        pressed[BTNS[b]!] = ((e >> b) & 1) === 1;
      }
    } else {
      // GIL v1/v2 legacy: regenerate rising edges from level transitions.
      for (let b = 0; b < 8; b++) {
        const v = ((m >> b) & 1) === 1;
        if (v && !down[BTNS[b]!]) pressed[BTNS[b]!] = true;
        down[BTNS[b]!] = v;
      }
    }
    i++;
    game.step();
  }
  return {
    score: game.score,
    playFrames: i,
    steps,
    stageIdx: game.stageIdx,
    scene: game.scene,
    elapsedMs: Date.now() - t0,
  };
}

/** Diagnostics attached to a refused replay — safe to log (no GIL body). */
export type ReplayDiag = {
  replayedScore?: number; // final score recomputed by the oracle (score-equality mismatch)
  partialScore?: number; // score at the moment a stuck/timeout abort fired
  playFrames?: number;
  steps?: number;
  endScene?: string;
  elapsedMs?: number;
};

export type ReplayCheck = { ok: true; result: ReplayResult } | { ok: false; reason: string; status: number; diag?: ReplayDiag };

export class ReplayVerifier {
  readonly bundlesDir: string;
  readonly timeoutMs: number;
  private bundles: Map<string, string>;
  private cache = new Map<string, Promise<ReplayEngine>>();

  constructor(opts: { bundlesDir: string; timeoutMs: number }) {
    this.bundlesDir = opts.bundlesDir;
    this.timeoutMs = opts.timeoutMs;
    this.bundles = scanReplayBundles(opts.bundlesDir);
  }

  hasBuild(build: string): boolean {
    return this.bundles.has(build);
  }

  /** loadBundle: import the pinned artifact once per build, then cache. */
  loadBundle(build: string): Promise<ReplayEngine> | null {
    const file = this.bundles.get(build);
    if (!file) return null;
    let p = this.cache.get(build);
    if (!p) {
      installBrowserStubs(); // before the bundle's module bodies run
      // the engine's recorder stamps sealed logs with buildVer() ==
      // globalThis.__GONNA_VER (fallback 'DEV') — pin it to THIS bundle so the
      // artifact behaves exactly like the released client build <VER>
      (globalThis as Record<string, unknown>)['__GONNA_VER'] = build;
      p = import(pathToFileURL(file).href) as Promise<ReplayEngine>;
      this.cache.set(build, p);
    }
    return p;
  }

  /**
   * Recompute the run from the log and compare EXACT integer score.
   * seedLabel is already validated by the caller (chain-derived); stageIdx is
   * the chain-bound one for stage mode.
   */
  async verifyRun(opts: {
    build: string;
    stageMode: 'full' | 'stage';
    stageIdx: number | null;
    seedLabel: string;
    masks: Uint8Array;
    edges?: Uint8Array; // GIL v3 recorded edge stream (verbatim, not regenerated)
    score: number;
  }): Promise<ReplayCheck> {
    const engP = this.loadBundle(opts.build);
    if (!engP) return { ok: false, reason: 'BUILD UNKNOWN TO THE ORACLE', status: 400 };
    let eng: ReplayEngine;
    try {
      eng = await engP;
    } catch {
      return { ok: false, reason: 'replay bundle failed to load', status: 500 };
    }
    // v18.1.2 (Friedbean 100M REPLAY MISMATCH): pre-fix builds gated the
    // slow-mo cadence on the GLOBAL boot frame (this.frame % 3), so a tape
    // recorded in a long-lived browser page replays correctly only under the
    // page's frame PHASE. That phase is unrecoverable from the tape — but it
    // is mod 3, so the whole space is {0,1,2}. Try each phase with a fresh
    // boot and accept the run if ANY phase reproduces the EXACT claimed
    // score. Anti-cheat is untouched: a forged tape still has no reason to
    // reproduce a real score under any phase. Builds >= v18.1.2 gate on the
    // run-local slow-mo counter and are phase-independent (all three attempts
    // agree). Fallback runs on FAILURE only, so the common path costs 1 replay.
    let firstFail: { ok: false; reason: string; status: number; diag?: ReplayDiag } | null = null;
    for (const framePhase of [0, 1, 2]) {
      let result: ReplayResult;
      let game: any = null;
      try {
        (globalThis as Record<string, unknown>)['__GONNA_VER'] = opts.build; // per-request pin (multi-bundle processes)
        game = bootGame(eng);
        // EXACT client boot entries (v16.1): same scene/RNG wiring as the live run
        if (opts.stageMode === 'stage') startStageRun(game, opts.stageIdx ?? 0, opts.seedLabel);
        else startFullRunSeeded(eng, game, opts.seedLabel);
        game.frame = framePhase; // emulate the client page's boot-frame phase
        result = await replayCampaign(game, opts.masks, this.timeoutMs, opts.edges);
      } catch (e) {
        // diag: where the engine was when the abort fired (score/scene only —
        // the replay contract has no per-frame client trace to diff against)
        const abortDiag: ReplayDiag = game ? { partialScore: game.score, endScene: game.scene } : {};
        if (e instanceof ReplayTimeoutError) return { ok: false, reason: 'REPLAY TIMEOUT - RETRY', status: 500, diag: abortDiag };
        if (e instanceof ReplayStuckError) {
          // log never reaches a play frame for the tail masks — try the next phase
          firstFail ??= { ok: false, reason: 'REPLAY MISMATCH', status: 400, diag: abortDiag };
          continue;
        }
        throw e; // engine crash = genuine internal error (500 via onError)
      }
      if (result.score !== opts.score) {
        firstFail ??= {
          ok: false, reason: 'REPLAY MISMATCH', status: 400,
          diag: { replayedScore: result.score, playFrames: result.playFrames, steps: result.steps, endScene: result.scene, elapsedMs: result.elapsedMs },
        };
        continue;
      }
      return { ok: true, result };
    }
    return firstFail ?? { ok: false, reason: 'REPLAY MISMATCH', status: 400 };
  }
}
