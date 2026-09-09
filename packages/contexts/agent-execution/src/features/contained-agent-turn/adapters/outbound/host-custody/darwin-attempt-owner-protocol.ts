import { readFileSync } from "node:fs";

/** The native header is the only wire-number/limit/slot definition. This
 * source-only adapter deliberately requires that exact adjacent header; root
 * must preserve/pin it in a future reviewed native packaging step. */
const header = readFileSync(new URL("./native/darwin-attempt-owner-protocol.h", import.meta.url), "utf8");
const definitions = new Map<string, number | string>();
for (const match of header.matchAll(/^#define (AE_[A-Z0-9_]+) (\d+|"[^"\n]+")$/gmu)) {
  const name = match[1];
  const literal = match[2];
  if (name === undefined || literal === undefined || definitions.has(name)) {
    throw new Error("duplicate native owner protocol definition");
  }
  definitions.set(name, literal.startsWith('"') ? literal.slice(1, -1) : Number(literal));
}
const numeric = (name: string): number => {
  const value = definitions.get(`AE_${name}`);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`missing native owner protocol definition: ${name}`);
  }
  return value;
};
const commandNames = [
  "START_ONCE", "CUTOFF", "READ_STATUS", "SETTLE_LAUNCH_ROUTE",
  "SETTLE_ARTIFACT_RESULT", "WORKSPACE_FREEZE", "WORKSPACE_CLEANUP",
  "WORKSPACE_CLOSE", "SETTLE_WORKSPACE", "SETTLE_PRIVATE",
  "READ_ARTIFACT_SLOT", "DISPOSE_ONCE", "READ_CLOSED_WORKSPACE",
] as const;
export type DarwinAttemptOwnerCommand = typeof commandNames[number];
export interface DarwinAttemptOwnerRequest {
  readonly command: DarwinAttemptOwnerCommand;
  readonly sequence: number;
  readonly binding: string;
  readonly launch: string;
  readonly argument: number;
}
export const darwinAttemptOwnerFrameBytes = numeric("FRAME_BYTES");
const digestBytes = numeric("DIGEST_BYTES");
const digest = new RegExp(`^[a-f0-9]{${digestBytes * 2}}$`, "u");
const exactKeys = ["argument", "binding", "command", "launch", "sequence"];

export function encodeDarwinAttemptOwnerRequest(request: DarwinAttemptOwnerRequest): Buffer {
  // Reject extra keys, accessors, symbols and prototypes before reading values.
  if (Object.getPrototypeOf(request) !== Object.prototype ||
      Reflect.ownKeys(request).length !== exactKeys.length ||
      Object.keys(request).toSorted().some((key, index) => key !== exactKeys[index]) ||
      Object.values(Object.getOwnPropertyDescriptors(request)).some((item) => !("value" in item))) {
    throw new Error("inexact owner command shape");
  }
  if (!commandNames.includes(request.command) || !Number.isInteger(request.sequence) ||
      request.sequence < 1 || request.sequence > 0xffff_ffff ||
      typeof request.binding !== "string" || !digest.test(request.binding) ||
      typeof request.launch !== "string" || !digest.test(request.launch) ||
      !Number.isInteger(request.argument) || request.argument < 0 ||
      (request.command === "READ_ARTIFACT_SLOT" ? request.argument >= numeric("ARTIFACT_SLOTS") : request.argument !== 0)) {
    throw new Error("invalid owner command value");
  }
  const bytes = Buffer.alloc(darwinAttemptOwnerFrameBytes);
  bytes.writeUInt32BE(numeric("MAGIC"), numeric("MAGIC_OFFSET"));
  bytes.writeUInt32BE(numeric("VERSION"), numeric("VERSION_OFFSET"));
  bytes.writeUInt32BE(numeric(request.command), numeric("KIND_OFFSET"));
  bytes.writeUInt32BE(request.sequence, numeric("SEQUENCE_OFFSET"));
  Buffer.from(request.binding, "hex").copy(bytes, numeric("BINDING_OFFSET"));
  Buffer.from(request.launch, "hex").copy(bytes, numeric("LAUNCH_OFFSET"));
  bytes.writeUInt32BE(request.argument, numeric("ARGUMENT_OFFSET"));
  return bytes;
}

export function decodeDarwinAttemptOwnerRequest(bytes: Uint8Array): DarwinAttemptOwnerRequest {
  if (bytes.byteLength !== darwinAttemptOwnerFrameBytes) {throw new Error("inexact owner frame length");}
  const frame = Buffer.from(bytes);
  if (frame.readUInt32BE(numeric("MAGIC_OFFSET")) !== numeric("MAGIC") ||
      frame.readUInt32BE(numeric("VERSION_OFFSET")) !== numeric("VERSION") ||
      frame.subarray(numeric("ARGUMENT_OFFSET") + 4).some((byte) => byte !== 0)) {
    throw new Error("invalid owner frame header or reserved bytes");
  }
  const command = commandNames.find((name) => numeric(name) === frame.readUInt32BE(numeric("KIND_OFFSET")));
  if (command === undefined) {throw new Error("unknown owner command");}
  const request = {
    command,
    sequence: frame.readUInt32BE(numeric("SEQUENCE_OFFSET")),
    binding: frame.subarray(numeric("BINDING_OFFSET"), numeric("BINDING_OFFSET") + digestBytes).toString("hex"),
    launch: frame.subarray(numeric("LAUNCH_OFFSET"), numeric("LAUNCH_OFFSET") + digestBytes).toString("hex"),
    argument: frame.readUInt32BE(numeric("ARGUMENT_OFFSET")),
  };
  encodeDarwinAttemptOwnerRequest(request);
  return Object.freeze(request);
}

/** One bounded outstanding frame. A transport must stop reading after one
 * frame and serialize dispatch; this decoder never queues a second START. */
export class DarwinAttemptOwnerFrameReader {
  readonly #bytes = Buffer.alloc(darwinAttemptOwnerFrameBytes);
  #used = 0;
  #finished = false;
  push(chunk: Uint8Array): DarwinAttemptOwnerRequest | undefined {
    if (this.#finished) {throw new Error("owner frame already consumed or lost");}
    if (chunk.byteLength === 0 || chunk.byteLength > this.#bytes.length - this.#used) {
      this.#finished = true;
      throw new Error("empty, oversized or queued owner frame");
    }
    this.#bytes.set(chunk, this.#used);
    this.#used += chunk.byteLength;
    if (this.#used !== this.#bytes.length) {return undefined;}
    this.#finished = true;
    return decodeDarwinAttemptOwnerRequest(this.#bytes);
  }
  end(): void {
    this.#finished = true;
    if (this.#used !== this.#bytes.length) {throw new Error("owner channel lost with incomplete frame");}
  }
}
