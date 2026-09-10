import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

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

const eventNames = ["STATUS", "PREEXEC", "IMAGE", "EXIT", "STREAMS", "ARTIFACT", "STDOUT", "STDERR", "REFUSED", "HELLO", "RELEASED"] as const;
export interface DarwinAttemptOwnerImage {
  readonly protocol: "ae-darwin-owned-image/v1";
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly birthSeconds: string;
  readonly birthMicros: number;
  readonly dev: string;
  readonly ino: string;
}
export interface DarwinAttemptOwnerEvent {
  readonly kind: typeof eventNames[number];
  readonly sequence: number;
  readonly serial: number;
  readonly revision: number;
  readonly command: DarwinAttemptOwnerCommand | undefined;
  readonly result: number;
  readonly binding: string;
  readonly launch: string;
  readonly phase: number;
  readonly workspace: number;
  readonly preexecApplied: boolean;
  readonly reaped: boolean;
  readonly streamsSealed: boolean;
  readonly cutoff: boolean;
  readonly providerSeen: boolean;
  readonly exitCode: number | undefined;
  readonly exitSignal: number;
  readonly owner: DarwinAttemptOwnerImage;
  readonly child: DarwinAttemptOwnerImage | undefined;
  readonly imageIndex: number;
  readonly slot: number;
  readonly mode: number;
  readonly dev: string;
  readonly ino: string;
  readonly workspaceDev: string;
  readonly workspaceIno: string;
  readonly attestation: string;
  /** Private copied source bytes; these are never a public artifact receipt. */
  readonly payload: Buffer;
}
export const darwinAttemptOwnerEventBytes = numeric("EVENT_BYTES");
const imageAt = (frame: Buffer, offset: number): DarwinAttemptOwnerImage | undefined => {
  const pid = frame.readUInt32BE(offset);
  const seconds = frame.readBigUInt64BE(offset + 16);
  const micros = frame.readBigUInt64BE(offset + 24);
  if (pid === 0 || seconds === 0n) {return undefined;}
  if (pid > 0x7fff_ffff || micros >= 1_000_000n || frame.readBigUInt64BE(offset + 40) === 0n) {
    throw new Error("invalid native birth/image record");
  }
  return Object.freeze({ protocol: "ae-darwin-owned-image/v1", pid,
    ppid: frame.readUInt32BE(offset + 4), pgid: frame.readUInt32BE(offset + 8),
    birthSeconds: seconds.toString(), birthMicros: Number(micros),
    dev: frame.readBigUInt64BE(offset + 32).toString(), ino: frame.readBigUInt64BE(offset + 40).toString() });
};
const eventPayloadLength = (frame: Buffer): number => {
  if (frame.length !== darwinAttemptOwnerEventBytes || frame.readUInt32BE(0) !== numeric("EVENT_MAGIC") ||
      frame.readUInt32BE(4) !== numeric("VERSION")) {throw new Error("invalid native event header");}
  const kind = eventNames.find((name) => numeric(`EVENT_${name}`) === frame.readUInt32BE(8));
  const length = frame.readUInt32BE(numeric("EVENT_LENGTH_OFFSET"));
  if (kind === undefined || length > numeric("ARTIFACT_MAX_BYTES") ||
      ((kind === "STDOUT" || kind === "STDERR") && (length === 0 || length > numeric("STREAM_CHUNK_BYTES"))) ||
      (kind === "HELLO" && length !== numeric("HELLO_BYTES")) ||
      (kind === "RELEASED" && length !== numeric("CLOSED_RECORD_BYTES")) ||
      (!["ARTIFACT", "STDOUT", "STDERR", "HELLO", "RELEASED"].includes(kind) && length !== 0)) {
    throw new Error("unknown, oversized or inexact native event");
  }
  return length;
};
const validateCapturedHello = (frame: Buffer, payload: Uint8Array): void => {
  const bytes = Buffer.from(payload);
  const namespace = bytes.subarray(0, 40);
  const manifest = bytes.subarray(40);
  const launch = createHash("sha256").update(manifest).digest();
  const scopes = manifest.subarray(numeric("MANIFEST_BINDINGS_OFFSET"), numeric("MANIFEST_IMAGES_OFFSET"));
  const initial = createHash("sha256").update(scopes).digest();
  const binding = createHash("sha256").update(initial).update(namespace).update(Buffer.alloc(1)).digest();
  if (!/^attempt-[a-f0-9]{32}$/u.test(namespace.toString("ascii")) || !launch.equals(frame.subarray(48, 80)) ||
      !binding.equals(frame.subarray(16, 48))) {throw new Error("captured native manifest/namespace binding mismatch");}
};
const validateClosedTicket = (frame: Buffer, payload: Uint8Array): void => {
  const bytes = Buffer.from(payload);
  const magic = definitions.get("AE_RECORD_MAGIC");
  if (typeof magic !== "string") {throw new Error("missing native closed record definition");}
  const hashOffset = numeric("RECORD_HASH_OFFSET");
  if (!bytes.subarray(0, numeric("RECORD_MAGIC_BYTES")).equals(Buffer.from(magic)) ||
      bytes.subarray(numeric("RECORD_MAGIC_BYTES"), numeric("RECORD_BINDING_OFFSET")).some((byte) => byte !== 0) ||
      !createHash("sha256").update(bytes.subarray(0, hashOffset)).digest().equals(bytes.subarray(hashOffset))) {
    throw new Error("torn or foreign native closed record");
  }
  const matches = (name: string, eventName = name, width = 4): boolean => bytes.subarray(numeric(`RECORD_${name}_OFFSET`), numeric(`RECORD_${name}_OFFSET`) + width)
    .equals(frame.subarray(numeric(`EVENT_${eventName}_OFFSET`), numeric(`EVENT_${eventName}_OFFSET`) + width));
  if (!bytes.subarray(numeric("RECORD_BINDING_OFFSET"), numeric("RECORD_BINDING_OFFSET") + 32).equals(frame.subarray(16, 48)) ||
      !bytes.subarray(numeric("RECORD_LAUNCH_OFFSET"), numeric("RECORD_LAUNCH_OFFSET") + 32).equals(frame.subarray(48, 80)) ||
      !matches("PHASE") || !matches("WORKSPACE") || !matches("REVISION") ||
      !matches("WORKSPACE_DEVICE", "WORKSPACE_DEVICE", 8) || !matches("WORKSPACE_INODE", "WORKSPACE_INODE", 8) ||
      bytes.readUInt32BE(numeric("RECORD_SEQUENCE_OFFSET")) !== frame.readUInt32BE(12)) {
    throw new Error("native closed record does not match its retained owner event");
  }
  validateClosedState(bytes);
  validateClosedObservations(frame, bytes);
};
const validateClosedObservations = (frame: Buffer, bytes: Buffer): void => {
  const flags = frame.readUInt32BE(numeric("EVENT_FLAGS_OFFSET"));
  for (const name of ["REAPED", "PREEXEC", "STREAMS", "CUTOFF"]) {
    if (Boolean(flags & numeric(`FLAG_${name}`)) !== Boolean(bytes.readUInt32BE(numeric(`RECORD_${name}_OFFSET`)))) {
      throw new Error("native closed observation flags disagree");
    }
  }
  for (const name of ["EXIT_CODE", "EXIT_SIGNAL"]) {
    if (bytes.readUInt32BE(numeric(`RECORD_${name}_OFFSET`)) !== frame.readUInt32BE(numeric(`EVENT_${name}_OFFSET`))) {
      throw new Error("native closed wait outcome disagrees");
    }
  }
};
const validateClosedState = (bytes: Buffer): void => {
  const get = (name: string): number => bytes.readUInt32BE(numeric(`RECORD_${name}_OFFSET`));
  if (get("PHASE") !== numeric("PHASE_RELEASED") || get("WORKSPACE") !== numeric("WORKSPACE_CLOSED") ||
      get("SETTLEMENTS") !== 15 || get("STREAMS") !== 1 || get("PENDING") !== 0 || get("ARGUMENT") !== 0 ||
      get("REAPED") > 1 || get("PREEXEC") > 1 || get("CUTOFF") > 1 || get("BIRTH_ATTEMPTED") !== get("REAPED")) {
    throw new Error("native closed record retains unresolved lifecycle debt");
  }
};
const validateEventImage = (frame: Buffer, kind: string, child: DarwinAttemptOwnerImage | undefined, owner: DarwinAttemptOwnerImage): void => {
  if (frame.readUInt32BE(numeric("EVENT_OWNER_OFFSET") + 12) !== numeric("IMAGE_HELPER")) {
    throw new Error("invalid native owner image");
  }
  if ((kind === "PREEXEC" || kind === "IMAGE") && (!child || child.ppid !== owner.pid ||
      (child.birthSeconds === owner.birthSeconds && child.birthMicros === owner.birthMicros))) {
    throw new Error("invalid distinct child birth");
  }
};
export function decodeDarwinAttemptOwnerEvent(frame: Buffer, payload: Uint8Array): DarwinAttemptOwnerEvent {
  if (eventPayloadLength(frame) !== payload.byteLength) {throw new Error("partial or surplus native payload");}
  const kind = eventNames.find((name) => numeric(`EVENT_${name}`) === frame.readUInt32BE(8));
  if (kind === undefined) {throw new Error("unknown native event");}
  const get = (name: string): number => frame.readUInt32BE(numeric(`EVENT_${name}_OFFSET`));
  const wide = (name: string): string => frame.readBigUInt64BE(numeric(`EVENT_${name}_OFFSET`)).toString();
  const commandNumber = get("COMMAND");
  const command = commandNames.find((name) => numeric(name) === commandNumber);
  const owner = imageAt(frame, numeric("EVENT_OWNER_OFFSET"));
  const child = imageAt(frame, numeric("EVENT_CHILD_OFFSET"));
  const flags = get("FLAGS");
  const exit = get("EXIT_CODE");
  if (!owner || get("SERIAL") === 0 || get("PHASE") > numeric("PHASE_QUARANTINED") || get("WORKSPACE") > numeric("WORKSPACE_CLOSED") || flags > (numeric("FLAG_PROVIDER") * 2 - 1) ||
      get("RESULT") > numeric("RESULT_UNKNOWN") || (commandNumber !== 0 && command === undefined) ||
      (exit !== 0xffff_ffff && exit > 255) || get("EXIT_SIGNAL") > 127 ||
      (exit !== 0xffff_ffff && get("EXIT_SIGNAL") !== 0) ||
      get("SLOT") >= numeric("ARTIFACT_SLOTS") || get("MODE") > 0o777) {
    throw new Error("inconsistent native event fields");
  }
  validateEventImage(frame, kind, child, owner);
  if (kind === "HELLO") {validateCapturedHello(frame, payload);}
  if (kind === "RELEASED") {validateClosedTicket(frame, payload);}
  return Object.freeze({ kind, sequence: frame.readUInt32BE(12), serial: get("SERIAL"), revision: get("REVISION"),
    command, result: get("RESULT"), binding: frame.subarray(16, 48).toString("hex"), launch: frame.subarray(48, 80).toString("hex"),
    phase: get("PHASE"), workspace: get("WORKSPACE"), preexecApplied: Boolean(flags & numeric("FLAG_PREEXEC")), reaped: Boolean(flags & numeric("FLAG_REAPED")),
    streamsSealed: Boolean(flags & numeric("FLAG_STREAMS")), cutoff: Boolean(flags & numeric("FLAG_CUTOFF")), providerSeen: Boolean(flags & numeric("FLAG_PROVIDER")),
    exitCode: exit === 0xffff_ffff ? undefined : exit, exitSignal: get("EXIT_SIGNAL"), owner, child,
    imageIndex: frame.readUInt32BE(numeric("EVENT_CHILD_OFFSET") + 12), slot: get("SLOT"), mode: get("MODE"),
    dev: wide("DEVICE"), ino: wide("INODE"), workspaceDev: wide("WORKSPACE_DEVICE"), workspaceIno: wide("WORKSPACE_INODE"),
    attestation: frame.subarray(numeric("EVENT_ATTESTATION_OFFSET")).toString("hex"), payload: Buffer.from(payload) });
}
/** Bounded incremental decoding of the real native wire, including coalesced
 * headers and payloads. A partial terminal frame permanently poisons readback. */
export class DarwinAttemptOwnerEventReader {
  #header = Buffer.alloc(darwinAttemptOwnerEventBytes);
  #payload: Buffer | undefined;
  #used = 0;
  #closed = false;
  push(chunk: Uint8Array): readonly DarwinAttemptOwnerEvent[] {
    if (this.#closed || chunk.byteLength === 0 || chunk.byteLength > numeric("ARTIFACT_MAX_BYTES") + darwinAttemptOwnerEventBytes) {
      this.#closed = true;
      throw new Error("native event channel closed or oversized");
    }
    const events: DarwinAttemptOwnerEvent[] = [];
    let offset = 0;
    try {
      while (offset < chunk.byteLength) {
        const target = this.#payload ?? this.#header;
        const count = Math.min(chunk.byteLength - offset, target.length - this.#used);
        target.set(chunk.subarray(offset, offset + count), this.#used);
        offset += count; this.#used += count;
        if (this.#used !== target.length) {continue;}
        if (this.#payload === undefined) {
          this.#payload = Buffer.alloc(eventPayloadLength(this.#header));
          this.#used = 0;
          if (this.#payload.length !== 0) {continue;}
        }
        events.push(decodeDarwinAttemptOwnerEvent(this.#header, this.#payload));
        this.#header = Buffer.alloc(darwinAttemptOwnerEventBytes);
        this.#payload = undefined; this.#used = 0;
      }
      return events;
    } catch (error) {this.#closed = true; throw error;}
  }
  end(): void {
    this.#closed = true;
    if (this.#used !== 0 || this.#payload !== undefined) {throw new Error("native owner lost with partial event");}
  }
}

export const darwinAttemptOwnerStates = Object.freeze({
  phase: Object.freeze({ staged: numeric("PHASE_STAGED"), child: numeric("PHASE_CHILD_OWNED"),
    exit: numeric("PHASE_EXIT_PROVED"), noStart: numeric("PHASE_NO_START"), disposed: numeric("PHASE_DISPOSED"),
    released: numeric("PHASE_RELEASED"), quarantined: numeric("PHASE_QUARANTINED") }),
  workspace: Object.freeze({ active: numeric("WORKSPACE_ACTIVE"), frozen: numeric("WORKSPACE_FROZEN"),
    cleanup: numeric("WORKSPACE_CLEANING"), closed: numeric("WORKSPACE_CLOSED") }),
  result: Object.freeze({ accepted: numeric("RESULT_ACCEPTED"), unknown: numeric("RESULT_UNKNOWN") }),
  image: Object.freeze({ helper: numeric("IMAGE_HELPER"), provider: numeric("IMAGE_PROVIDER") }),
  closedRecordBytes: numeric("CLOSED_RECORD_BYTES"),
});
