// sign.ts — SPEC §1 cryptographic truths. Byte-exact vs contract.py (FROZEN):
//   score msg  : "QA-SCORE|" ‖ u64be(app) ‖ u64be(cid) ‖ u8(seat) ‖ 32B addr ‖ u64be(score)   (66 B)
//   verdict msg: "QA-VERDICT|" ‖ u64be(app) ‖ u64be(cid) ‖ u8(mode) ‖ 32B extra ‖ 32B digest   (92 B)
//   digest     : sha256( u8(seat)‖32B addr‖u64be(score) per SIGNED player, seat order )
//   extra      : 32×0 (MODE_FULL) | 24×0‖u64be(stage_idx) (MODE_STAGE_IDX)
// Signature: ed25519 bare detached, seed = first 32B of the algosdk secret key
// (mirrors PyNaCl SigningKey(seed) — devOracle.ts:32-41, deploy/common.py).
import algosdk from 'algosdk';
import nacl from 'tweetnacl';
import { concatBytes, sha256, u64be } from './util.js';

export const SCORE_DOMAIN = new TextEncoder().encode('QA-SCORE|');
export const VERDICT_DOMAIN = new TextEncoder().encode('QA-VERDICT|');

export const SCORE_MSG_LEN = SCORE_DOMAIN.length + 8 + 8 + 1 + 32 + 8; // 66
export const VERDICT_MSG_LEN = VERDICT_DOMAIN.length + 8 + 8 + 1 + 32 + 32; // 92

export const MODE_FULL = 0;
export const MODE_STAGE_IDX = 1;
export const MODE_RANDOM_RESOLVED = 2;

export interface OracleSigner {
  /** Algorand address (base32, checksum) — public, safe to expose. */
  readonly addr: string;
  /** ed25519 public key (32B) — must equal oracle_pub_key on-chain. */
  readonly publicKey: Uint8Array;
  /** Bare detached ed25519 signature (64B). */
  sign(msg: Uint8Array): Uint8Array;
}

export function signerFromSeed(seed: Uint8Array): OracleSigner {
  if (seed.length !== 32) throw new Error('oracle seed must be 32 bytes');
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    addr: algosdk.encodeAddress(kp.publicKey),
    publicKey: kp.publicKey,
    sign: (msg) => nacl.sign.detached(msg, kp.secretKey),
  };
}

/** algosdk mnemonic → 64B sk; the ed25519 seed is the FIRST 32 bytes. */
export function signerFromMnemonic(mnemonic: string): OracleSigner {
  const acct = algosdk.mnemonicToSecretKey(mnemonic.trim());
  const signer = signerFromSeed(acct.sk.slice(0, 32));
  // sanity: derived address must match the account address of the mnemonic
  if (signer.addr !== acct.addr.toString()) throw new Error('mnemonic/address derivation mismatch');
  return signer;
}

export function scoreMsg(
  appId: number,
  cid: number,
  seat: number,
  addrBytes: Uint8Array,
  score: number,
): Uint8Array {
  if (addrBytes.length !== 32) throw new Error('addr must be 32 bytes');
  const out = new Uint8Array(SCORE_MSG_LEN);
  out.set(SCORE_DOMAIN, 0);
  out.set(u64be(appId), SCORE_DOMAIN.length);
  out.set(u64be(cid), SCORE_DOMAIN.length + 8);
  out.set([seat & 0xff], SCORE_DOMAIN.length + 16);
  out.set(addrBytes, SCORE_DOMAIN.length + 17);
  out.set(u64be(score), SCORE_DOMAIN.length + 49);
  return out;
}

export interface DigestEntry {
  seat: number;
  addr: Uint8Array; // 32B pk
  score: number | bigint;
}

/** sha256 of u8(seat)‖32B addr‖u64be(score) per entry — caller passes ONLY
 *  signed players, already in seat order (contract.py:679-686). */
export function verdictDigest(entries: DigestEntry[]): Uint8Array {
  const raw = new Uint8Array(entries.length * 41);
  entries.forEach((e, i) => {
    raw.set([e.seat & 0xff], i * 41);
    raw.set(e.addr, i * 41 + 1);
    raw.set(u64be(e.score), i * 41 + 33);
  });
  return sha256(raw);
}

export function verdictExtraFull(): Uint8Array {
  return new Uint8Array(32); // 32×0
}

export function verdictExtraStage(stageIdx: number): Uint8Array {
  const out = new Uint8Array(32); // 24×0 ‖ u64be(stage_idx)
  out.set(u64be(stageIdx), 24);
  return out;
}

export function verdictMsg(
  appId: number,
  cid: number,
  stageMode: number,
  extra32: Uint8Array,
  digest: Uint8Array,
): Uint8Array {
  if (extra32.length !== 32) throw new Error('extra must be 32 bytes');
  if (digest.length !== 32) throw new Error('digest must be 32 bytes');
  const out = new Uint8Array(VERDICT_MSG_LEN);
  out.set(VERDICT_DOMAIN, 0);
  out.set(u64be(appId), VERDICT_DOMAIN.length);
  out.set(u64be(cid), VERDICT_DOMAIN.length + 8);
  out.set([stageMode & 0xff], VERDICT_DOMAIN.length + 16);
  out.set(extra32, VERDICT_DOMAIN.length + 17);
  out.set(digest, VERDICT_DOMAIN.length + 49);
  return out;
}
