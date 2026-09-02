// util.ts — byte helpers, base64, sha256. No secrets ever pass through logs.
import { createHash } from 'node:crypto';

export function u64be(v: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), false);
  return b;
}

export function u32be(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, false);
  return b;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export function b64encode(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

export function b64decode(s: string): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  try {
    return new Uint8Array(Buffer.from(s, 'base64'));
  } catch {
    return null;
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Truncate long strings for safe logging. NEVER call this on secrets. */
export function short(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max) + '...';
}
