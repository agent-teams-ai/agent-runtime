import { CONTAINED_TURN_LIMITS, validateContainedTurnText } from "./contained-turn-limits.js";

declare const canonicalDigestBrand: unique symbol;
declare const commandFingerprintBrand: unique symbol;
declare const cancellationFingerprintBrand: unique symbol;

export type ContainedTurnCanonicalDigest = string & { readonly [canonicalDigestBrand]: true };
export type ContainedTurnCommandFingerprint = string & { readonly [commandFingerprintBrand]: true };
export type ContainedTurnCancellationFingerprint = string & { readonly [cancellationFingerprintBrand]: true };

export type ContainedTurnCanonicalValue =
  | boolean
  | number
  | string
  | null
  | readonly ContainedTurnCanonicalValue[]
  | { readonly [key: string]: ContainedTurnCanonicalValue };

const SHA256_INITIAL = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value: number, count: number): number => (value >>> count) | (value << (32 - count));

const padSha256 = (input: Uint8Array): Uint8Array => {
  const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.byteLength] = 0x80;
  const bitLength = BigInt(input.byteLength) * 8n;
  for (let index = 0; index < 8; index += 1) {
    padded[paddedLength - 1 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
  }
  return padded;
};

const sha256Block = (state: number[], bytes: Uint8Array, offset: number): void => {
  const words = Array.from({ length: 64 }, () => 0);
  for (let index = 0; index < 16; index += 1) {
    const cursor = offset + index * 4;
    words[index] = ((bytes[cursor] ?? 0) << 24) | ((bytes[cursor + 1] ?? 0) << 16) |
      ((bytes[cursor + 2] ?? 0) << 8) | (bytes[cursor + 3] ?? 0);
  }
  for (let index = 16; index < 64; index += 1) {
    const prior15 = words[index - 15] ?? 0;
    const prior2 = words[index - 2] ?? 0;
    const s0 = rotateRight(prior15, 7) ^ rotateRight(prior15, 18) ^ (prior15 >>> 3);
    const s1 = rotateRight(prior2, 17) ^ rotateRight(prior2, 19) ^ (prior2 >>> 10);
    words[index] = (((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) | 0);
  }
  let [a, b, c, d, e, f, g, h] = state as [number, number, number, number, number, number, number, number];
  for (let index = 0; index < 64; index += 1) {
    const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choice = (e & f) ^ (~e & g);
    const temporary1 = (h + sum1 + choice + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) | 0;
    const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temporary2 = (sum0 + majority) | 0;
    [a, b, c, d, e, f, g, h] = [(temporary1 + temporary2) | 0, a, b, c, (d + temporary1) | 0, e, f, g];
  }
  const next = [a, b, c, d, e, f, g, h];
  for (let index = 0; index < state.length; index += 1) {
    state[index] = ((state[index] ?? 0) + (next[index] ?? 0)) | 0;
  }
};

const sha256Hex = (value: string): string => {
  const bytes = padSha256(new TextEncoder().encode(value));
  const state = [...SHA256_INITIAL];
  for (let offset = 0; offset < bytes.byteLength; offset += 64) {sha256Block(state, bytes, offset);}
  return state.map(word => (word >>> 0).toString(16).padStart(8, "0")).join("");
};

const canonicalize = (value: ContainedTurnCanonicalValue): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {return JSON.stringify(value);}
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {throw new TypeError("canonical numbers must be safe integers");}
    return String(value);
  }
  if (Array.isArray(value)) {return `[${value.map(item => canonicalize(item)).join(",")}]`;}
  const record = value as { readonly [key: string]: ContainedTurnCanonicalValue };
  return `{${Object.keys(record).toSorted().map(key => `${JSON.stringify(key)}:${canonicalize(record[key] ?? null)}`).join(",")}}`;
};

export const encodeContainedTurnCanonicalValue = (value: ContainedTurnCanonicalValue): string => canonicalize(value);

export const digestContainedTurnCanonicalValue = (
  value: ContainedTurnCanonicalValue,
): ContainedTurnCanonicalDigest => `sha256:${sha256Hex(canonicalize(value))}` as ContainedTurnCanonicalDigest;

export const parseContainedTurnCanonicalDigest = (value: string): ContainedTurnCanonicalDigest => {
  validateContainedTurnText("digest", value, CONTAINED_TURN_LIMITS.text.digest);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {throw new TypeError("digest must be canonical lowercase sha256");}
  return value as ContainedTurnCanonicalDigest;
};

export const asContainedTurnCommandFingerprint = (value: ContainedTurnCanonicalDigest): ContainedTurnCommandFingerprint =>
  value as string as ContainedTurnCommandFingerprint;

export const asContainedTurnCancellationFingerprint = (value: ContainedTurnCanonicalDigest): ContainedTurnCancellationFingerprint =>
  value as string as ContainedTurnCancellationFingerprint;
