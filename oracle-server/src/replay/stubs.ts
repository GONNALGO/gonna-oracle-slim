// replay/stubs.ts — minimal browser stubs to boot the GONNA engine HEADLESS
// in Node (M2 replay verification). TS port of the M2-0 spike stubs
// (oracle-server/replay/stubs.mjs — verdetto bit-exact Node<->Chromium).
// The sim path (Game.step -> updatePlay) never renders; canvas/Image/Audio
// are only touched at CONSTRUCTION. Installed ONCE per process, lazily, the
// first time a replay bundle is loaded (never at module top level).
/* eslint-disable @typescript-eslint/no-explicit-any */

const noop = (): void => {};

function makeGradient(): { addColorStop: () => void } {
  return { addColorStop: noop };
}

function makeCtx2D(canvas: unknown): unknown {
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'canvas') return canvas;
      if (prop === 'measureText') return () => ({ width: 0 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') {
        return () => makeGradient();
      }
      if (prop === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h });
      if (prop === 'createImageData') return (w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h });
      if (prop === 'getLineDash') return () => [];
      if (typeof prop === 'string' && !(prop in t)) t[prop] = noop;
      return t[prop];
    },
    set(t, prop, v) {
      t[prop] = v;
      return true;
    },
  });
}

export function makeCanvas(): any {
  const c: any = {
    width: 300,
    height: 150,
    style: {},
    addEventListener: noop,
    removeEventListener: noop,
    toDataURL: () => 'data:image/png;base64,',
    getContext() {
      return (this._ctx ??= makeCtx2D(this));
    },
  };
  return c;
}

function makeElement(tag: string): any {
  if (tag === 'canvas') return makeCanvas();
  return {
    tagName: tag.toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    setAttribute: noop,
    getAttribute: () => null,
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: (x: unknown) => x,
    removeChild: noop,
    remove: noop,
    focus: noop,
    blur: noop,
    click: noop,
    select: noop,
  };
}

class AudioParamStub {
  value: number;
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(): this {
    return this;
  }
  linearRampToValueAtTime(): this {
    return this;
  }
  exponentialRampToValueAtTime(): this {
    return this;
  }
  setTargetAtTime(): this {
    return this;
  }
  setValueCurveAtTime(): this {
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
  cancelAndHoldAtTime(): this {
    return this;
  }
}

class AudioNodeStub {
  gain = new AudioParamStub(1);
  frequency = new AudioParamStub(440);
  Q = new AudioParamStub(1);
  detune = new AudioParamStub(0);
  playbackRate = new AudioParamStub(1);
  pan = new AudioParamStub(0);
  threshold = new AudioParamStub(0);
  knee = new AudioParamStub(0);
  ratio = new AudioParamStub(1);
  attack = new AudioParamStub(0);
  release = new AudioParamStub(0);
  type = 'sine';
  buffer: unknown = null;
  loop = false;
  connect(x: unknown): unknown {
    return x;
  }
  disconnect(): void {}
  start(): void {}
  stop(): void {}
  setPeriodicWave(): void {}
}

class AudioContextStub {
  state = 'suspended';
  currentTime = 0;
  sampleRate = 44100;
  destination = new AudioNodeStub();
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  createGain(): AudioNodeStub {
    return new AudioNodeStub();
  }
  createOscillator(): AudioNodeStub {
    return new AudioNodeStub();
  }
  createBufferSource(): AudioNodeStub {
    return new AudioNodeStub();
  }
  createBiquadFilter(): AudioNodeStub {
    return new AudioNodeStub();
  }
  createDynamicsCompressor(): AudioNodeStub {
    return new AudioNodeStub();
  }
  createStereoPanner(): AudioNodeStub {
    return new AudioNodeStub();
  }
  createPeriodicWave(): Record<string, never> {
    return {};
  }
  createBuffer(_ch: number, len: number): { getChannelData: () => Float32Array; duration: number } {
    return { getChannelData: () => new Float32Array(len), duration: len / 44100 };
  }
}

class StorageStub {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

class ImageStub {
  width = 0;
  height = 0;
  onload: unknown = null;
  onerror: unknown = null;
  set src(_v: string) {
    /* never fires onload: nothing in the sim path awaits images */
  }
}

class AudioStub {
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
}

let installed = false;
export function installBrowserStubs(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as any;
  const documentStub = {
    createElement: makeElement,
    createElementNS: (_ns: string, tag: string) => makeElement(tag),
    body: makeElement('body'),
    head: makeElement('head'),
    documentElement: makeElement('html'),
    activeElement: null,
    hidden: false,
    addEventListener: noop,
    removeEventListener: noop,
    fonts: { load: () => Promise.resolve(), ready: Promise.resolve() },
  };
  g.window = g;
  g.document = documentStub;
  g.localStorage = new StorageStub();
  g.sessionStorage = new StorageStub();
  g.location = { href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '', hash: '', replace: noop, assign: noop };
  g.history = { replaceState: noop, pushState: noop };
  // Node 21+ exposes globalThis.navigator as a GETTER-ONLY accessor — a plain
  // assignment throws and would abort stub installation halfway (Render
  // build/node 22 lesson). defineProperty overrides it safely.
  Object.defineProperty(g, 'navigator', {
    value: { userAgent: 'm2-replay-headless', vibrate: () => false, maxTouchPoints: 0, clipboard: { writeText: () => Promise.resolve() }, mediaDevices: undefined },
    configurable: true,
    writable: true,
  });
  g.innerWidth = 1280;
  g.innerHeight = 720;
  g.devicePixelRatio = 1;
  g.visualViewport = undefined;
  g.addEventListener = noop;
  g.removeEventListener = noop;
  g.requestAnimationFrame = () => 0; // never fires: the verifier steps manually
  g.cancelAnimationFrame = noop;
  g.scrollTo = noop;
  g.open = () => null;
  g.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
  g.Image = ImageStub;
  g.Audio = AudioStub;
  g.AudioContext = AudioContextStub;
  g.webkitAudioContext = AudioContextStub;
  // keep the native fetch (the server makes REAL algod/indexer calls); only
  // stub when absent. The engine's fire-and-forget skin fetch fails fast and
  // is caught engine-side either way.
  if (typeof g.fetch !== 'function') g.fetch = () => Promise.reject(new Error('headless replay: no network'));
  g.prompt = () => null;
  g.alert = noop;
  if (typeof g.performance === 'undefined') g.performance = { now: () => Date.now() };
}
