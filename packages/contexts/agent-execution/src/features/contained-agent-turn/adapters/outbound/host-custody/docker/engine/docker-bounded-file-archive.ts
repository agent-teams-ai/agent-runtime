import { createHash } from "node:crypto";
import { DockerEngineError } from "./docker-engine-error.js";
import type { DockerEngineCall } from "./docker-engine-port.js";

export const DOCKER_ARCHIVE_FILE_MAX_BYTES = 256 * 1_024 * 1_024;
const BLOCK = 512;
const MAX_TRAILER_BYTES = 10_240;
export interface DockerArchiveFile {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly sha256: string;
}
const fail = (): never => {throw new DockerEngineError("malformed-response");};
const zero = (bytes: Uint8Array): boolean => bytes.every(byte => byte === 0);
const text = (bytes: Buffer): string => {
  const end = bytes.indexOf(0);
  const value = end < 0 ? bytes : bytes.subarray(0, end);
  if ((end >= 0 && !zero(bytes.subarray(end))) || value.some(byte => byte < 32 || byte > 126)) {return fail();}
  return value.toString("ascii");
};
const octal = (bytes: Buffer): number => {
  // Reject GNU base-256 and every non-octal/ambiguous numeric representation.
  const value = bytes.toString("latin1");
  if (!/^[0-7]+[\0 ]*$/u.test(value)) {return fail();}
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) {return fail();}
  return number;
};
const header = (block: Buffer, requested: string, maximum: number): {mode: number; size: number} => {
  const checksum = octal(block.subarray(148, 156));
  let sum = 8 * 32;
  for (let i = 0; i < BLOCK; i += 1) {if (i < 148 || i >= 156) {sum += block[i]!;}}
  if (checksum !== sum || text(block.subarray(0, 100)) !== requested.slice(1) ||
      block.subarray(257, 265).toString("latin1") !== "ustar\u000000" ||
      ![0, 48].includes(block[156]!) || !zero(block.subarray(157, 257)) ||
      !zero(block.subarray(345, 512))) {return fail();}
  const mode = octal(block.subarray(100, 108));
  const uid = octal(block.subarray(108, 116));
  const gid = octal(block.subarray(116, 124));
  const size = octal(block.subarray(124, 136));
  octal(block.subarray(136, 148));
  text(block.subarray(265, 297)); text(block.subarray(297, 329));
  // No special bits, writable image code, non-root ownership, or devices.
  if (mode > 0o777 || (mode & 0o222) !== 0 || uid !== 0 || gid !== 0 || size < 1 ||
      size > maximum || [block.subarray(329, 337), block.subarray(337, 345)].some(field => !zero(field) && octal(field) !== 0)) {return fail();}
  return {mode, size};
};

const checkCall = (call: DockerEngineCall): void => {
  if (call.signal.aborted) {throw new DockerEngineError("aborted");}
  if (!Number.isSafeInteger(call.deadlineEpochMs) || Date.now() >= call.deadlineEpochMs) {
    throw new DockerEngineError("deadline-exceeded");
  }
};

/** One root-level regular file, streamed without extraction or retaining its contents.
 * USTAR only: PAX/GNU/sparse/compressed archives are deliberately unsupported.
 * Requiring a root-level path also removes unobserved ancestor symlink resolution.
 */
export const readDockerFileArchive = async (
  source: AsyncIterable<Uint8Array>,
  requested: string,
  maximum: number,
  call: DockerEngineCall,
): Promise<DockerArchiveFile> => {
  if (!/^\/[A-Za-z0-9][A-Za-z0-9._-]{0,98}$/u.test(requested) ||
      !Number.isSafeInteger(maximum) || maximum < 1 || maximum > DOCKER_ARCHIVE_FILE_MAX_BYTES) {
    throw new DockerEngineError("invalid-create-request");
  }
  const digest = createHash("sha256");
  const block = Buffer.alloc(BLOCK);
  let filled = 0;
  let total = 0;
  let facts: {mode: number; size: number} | undefined;
  let remaining = 0;
  let padding = 0;
  let trailer = 0;
  for await (const chunk of source) {
    checkCall(call);
    total += chunk.byteLength;
    if (total > maximum + BLOCK * 2 + MAX_TRAILER_BYTES) {throw new DockerEngineError("response-too-large");}
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (facts === undefined) {
        const count = Math.min(BLOCK - filled, chunk.byteLength - offset);
        block.set(chunk.subarray(offset, offset + count), filled); filled += count; offset += count;
        if (filled === BLOCK) {
          facts = header(block, requested, maximum);
          remaining = facts.size; padding = (BLOCK - facts.size % BLOCK) % BLOCK;
        }
      } else if (remaining > 0) {
        const count = Math.min(remaining, chunk.byteLength - offset);
        digest.update(chunk.subarray(offset, offset + count)); remaining -= count; offset += count;
      } else {
        const count = chunk.byteLength - offset;
        if (!zero(chunk.subarray(offset))) {return fail();}
        const padded = Math.min(padding, count); padding -= padded; trailer += count - padded; offset += count;
        if (trailer > MAX_TRAILER_BYTES) {throw new DockerEngineError("response-too-large");}
      }
    }
  }
  checkCall(call);
  if (facts === undefined || remaining !== 0 || padding !== 0 || trailer < BLOCK * 2 || trailer % BLOCK !== 0) {return fail();}
  return Object.freeze({path: requested, ...facts, sha256: digest.digest("hex")});
};
