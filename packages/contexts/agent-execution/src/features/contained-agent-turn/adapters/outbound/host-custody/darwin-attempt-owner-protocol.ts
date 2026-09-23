import { createHash } from "node:crypto";
import {darwinAttemptOwnerDigest as digest, darwinAttemptOwnerDigestBytes as digestBytes, darwinAttemptOwnerNumeric as numeric, darwinAttemptOwnerString as text} from "./darwin-attempt-owner-protocol-definitions.js";
export {darwinNativeArgumentsSha256, encodeDarwinNativeFinalLaunchData, type DarwinNativeFinalLaunchData} from "./darwin-attempt-owner-final-launch.js";
/** Host-owned finite transport data, structurally compatible with the existing
 * complete workspace inventory. These are byte/metadata inputs, not filesystem
 * owner handles or receipt authority; native validation retains original roots. */
export interface DarwinNativeWorkspaceTreeLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}
export interface DarwinNativeWorkspaceFileEntry {
  readonly kind: "file";
  readonly relativePath: string;
  readonly mode: number;
  readonly size: number;
  readonly digest: string;
}
export type DarwinNativeWorkspaceFile = Readonly<Omit<DarwinNativeWorkspaceFileEntry, "kind"> & {bytes: Buffer}>;
export interface DarwinNativeWorkspaceTree {
  readonly entries: readonly (DarwinNativeWorkspaceFileEntry | Readonly<{kind: "directory"; relativePath: string; mode: number}>)[];
  readonly files: readonly DarwinNativeWorkspaceFile[];
  readonly rootIdentity: Readonly<{ctimeNs: bigint; dev: bigint; ino: bigint; mode: bigint; mtimeNs: bigint}>;
  readonly treeDigest: string;
}
/** The native header is the only wire-number/limit/slot definition. This
 * source-only adapter deliberately requires that exact adjacent header; root
 * must preserve/pin it in a future reviewed native packaging step. */
export type DarwinAttemptOwnerCommand =
  | "START_ONCE" | "CUTOFF" | "READ_STATUS" | "SETTLE_LAUNCH_ROUTE"
  | "SETTLE_ARTIFACT_RESULT" | "WORKSPACE_FREEZE" | "WORKSPACE_CLEANUP"
  | "WORKSPACE_CLOSE" | "SETTLE_WORKSPACE" | "SETTLE_PRIVATE"
  | "DISPOSE_ONCE" | "READ_CLOSED_WORKSPACE"
  | "MATERIALIZE_BEGIN" | "MATERIALIZE_ENTRY" | "MATERIALIZE_CHUNK" | "MATERIALIZE_FINISH"
  | "COMMIT_CREATION" | "READ_TREE" | "BIND_PREPARED" | "CONFIRM_CLAIM" | "READ_OBSERVATION"
  | "MATERIAL_BEGIN" | "MATERIAL_CHUNK" | "MATERIAL_FINISH" | "BIND_FINAL_LAUNCH"
  | "WRITE_INPUT" | "CLOSE_INPUT" | "QUERY_CLOSED_WORKSPACE";
const DARWIN_ATTEMPT_OWNER_COMMAND_NAMES = Object.freeze([
  "START_ONCE", "CUTOFF", "READ_STATUS", "SETTLE_LAUNCH_ROUTE",
  "SETTLE_ARTIFACT_RESULT", "WORKSPACE_FREEZE", "WORKSPACE_CLEANUP",
  "WORKSPACE_CLOSE", "SETTLE_WORKSPACE", "SETTLE_PRIVATE",
  "DISPOSE_ONCE", "READ_CLOSED_WORKSPACE",
  "MATERIALIZE_BEGIN", "MATERIALIZE_ENTRY", "MATERIALIZE_CHUNK", "MATERIALIZE_FINISH", "COMMIT_CREATION", "READ_TREE", "BIND_PREPARED", "CONFIRM_CLAIM", "READ_OBSERVATION", "MATERIAL_BEGIN", "MATERIAL_CHUNK", "MATERIAL_FINISH", "BIND_FINAL_LAUNCH", "WRITE_INPUT", "CLOSE_INPUT", "QUERY_CLOSED_WORKSPACE",
] as const satisfies readonly DarwinAttemptOwnerCommand[]);
export interface DarwinAttemptOwnerRequest {
  readonly command: DarwinAttemptOwnerCommand;
  readonly sequence: number;
  readonly binding: string;
  readonly launch: string;
  readonly argument: number;
}
export const darwinAttemptOwnerFrameBytes = numeric("FRAME_BYTES");
const exactKeys = Object.freeze(["argument", "binding", "command", "launch", "sequence"] as const);

const zeroRequestArgument = (argument: number): boolean => argument === 0;
const requestArgumentValidators: Readonly<Record<DarwinAttemptOwnerCommand, (argument: number) => boolean>> = {
  MATERIALIZE_BEGIN: argument => argument === 16,
  MATERIALIZE_ENTRY: argument => argument >= 25 && argument <= 279,
  MATERIALIZE_CHUNK: argument => argument > 8 && argument <= numeric("TREE_REQUEST_MAX_BYTES"),
  COMMIT_CREATION: argument => argument === numeric("CREATION_BYTES"),
  WRITE_INPUT: argument => argument > 0 && argument <= numeric("STREAM_CHUNK_BYTES"),
  BIND_FINAL_LAUNCH: argument => argument === numeric("FINAL_LAUNCH_BYTES"),
  MATERIAL_BEGIN: argument => argument === 44,
  MATERIAL_CHUNK: argument => argument > 8 && argument <= numeric("TREE_REQUEST_MAX_BYTES"),
  BIND_PREPARED: argument => argument === numeric("PREPARED_BYTES"),
  CONFIRM_CLAIM: argument => argument > numeric("PREPARED_BYTES") && argument <= numeric("TREE_REQUEST_MAX_BYTES"),
  CLOSE_INPUT: zeroRequestArgument,
  CUTOFF: zeroRequestArgument,
  DISPOSE_ONCE: zeroRequestArgument,
  MATERIALIZE_FINISH: zeroRequestArgument,
  MATERIAL_FINISH: zeroRequestArgument,
  QUERY_CLOSED_WORKSPACE: zeroRequestArgument,
  READ_CLOSED_WORKSPACE: zeroRequestArgument,
  READ_OBSERVATION: zeroRequestArgument,
  READ_STATUS: zeroRequestArgument,
  READ_TREE: zeroRequestArgument,
  SETTLE_ARTIFACT_RESULT: zeroRequestArgument,
  SETTLE_LAUNCH_ROUTE: zeroRequestArgument,
  SETTLE_PRIVATE: zeroRequestArgument,
  SETTLE_WORKSPACE: zeroRequestArgument,
  START_ONCE: zeroRequestArgument,
  WORKSPACE_CLEANUP: zeroRequestArgument,
  WORKSPACE_CLOSE: zeroRequestArgument,
  WORKSPACE_FREEZE: zeroRequestArgument,
};
const validRequestArgument = (command: DarwinAttemptOwnerCommand, argument: number): boolean =>
  requestArgumentValidators[command](argument);
export function encodeDarwinAttemptOwnerRequest(request: DarwinAttemptOwnerRequest): Buffer {
  // Reject extra keys, accessors, symbols and prototypes before reading values.
  if (Object.getPrototypeOf(request) !== Object.prototype ||
      Reflect.ownKeys(request).length !== exactKeys.length ||
      Object.keys(request).toSorted().some((key, index) => key !== exactKeys[index]) ||
      Object.values(Object.getOwnPropertyDescriptors(request)).some((item) => !("value" in item))) {
    throw new Error("inexact owner command shape");
  }
  if (!DARWIN_ATTEMPT_OWNER_COMMAND_NAMES.includes(request.command) || !Number.isInteger(request.sequence) ||
      request.sequence < 1 || request.sequence > 0xffff_ffff ||
      typeof request.binding !== "string" || !digest.test(request.binding) ||
      typeof request.launch !== "string" || !digest.test(request.launch) ||
      !Number.isInteger(request.argument) || request.argument < 0 ||
      !validRequestArgument(request.command, request.argument)) {
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
  const command = DARWIN_ATTEMPT_OWNER_COMMAND_NAMES.find((name) => numeric(name) === frame.readUInt32BE(numeric("KIND_OFFSET")));
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

export type DarwinAttemptOwnerEventKind = "STATUS" | "PREEXEC" | "IMAGE" | "EXIT" | "STREAMS" | "STDOUT" | "STDERR" |
  "REFUSED" | "HELLO" | "RELEASED" | "TREE_ENTRY" | "TREE_CHUNK" | "TREE_END" | "CLOSED_READ" | "OBSERVATION" |
  "MATERIAL_RESULT";
const DARWIN_ATTEMPT_OWNER_EVENT_NAMES = Object.freeze([
  "STATUS", "PREEXEC", "IMAGE", "EXIT", "STREAMS", "STDOUT", "STDERR", "REFUSED", "HELLO", "RELEASED",
  "TREE_ENTRY", "TREE_CHUNK", "TREE_END", "CLOSED_READ", "OBSERVATION", "MATERIAL_RESULT",
] as const satisfies readonly DarwinAttemptOwnerEventKind[]);
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
  readonly kind: DarwinAttemptOwnerEventKind;
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
  const kind = DARWIN_ATTEMPT_OWNER_EVENT_NAMES.find((name) => numeric(`EVENT_${name}`) === frame.readUInt32BE(8));
  const length = frame.readUInt32BE(numeric("EVENT_LENGTH_OFFSET"));
  const bounds: Partial<Record<DarwinAttemptOwnerEventKind, readonly [number, number]>> = {
    STDOUT: [1, numeric("STREAM_CHUNK_BYTES")], STDERR: [1, numeric("STREAM_CHUNK_BYTES")],
    OBSERVATION: [numeric("OBSERVATION_BYTES"), numeric("OBSERVATION_BYTES")],
    MATERIAL_RESULT: [numeric("MATERIAL_RESULT_BYTES"), numeric("MATERIAL_RESULT_BYTES")],
    TREE_END: [24, 24], TREE_ENTRY: [25, 279], TREE_CHUNK: [9, numeric("TREE_REQUEST_MAX_BYTES")],
    HELLO: [numeric("HELLO_BYTES"), numeric("HELLO_BYTES")],
    RELEASED: [numeric("CLOSED_RECORD_BYTES"), numeric("CLOSED_RECORD_BYTES")],
    CLOSED_READ: [numeric("CLOSED_RECORD_BYTES"), numeric("CLOSED_RECORD_BYTES")],
  };
  const [min, max] = (kind && bounds[kind]) || [0, 0];
  if (!kind || length > numeric("EVENT_MAX_BYTES") || length < min || length > max) {
    throw new Error("unknown, oversized or inexact native event");
  }
  return length;
};
const validateCapturedHello = (frame: Buffer, payload: Uint8Array): void => {
  const bytes = Buffer.from(payload);
  const namespace = bytes.subarray(0, 40);
  const manifest = bytes.subarray(40, 40 + numeric("MANIFEST_BYTES"));
  const launch = createHash("sha256").update(manifest).digest();
  const scopes = manifest.subarray(numeric("MANIFEST_BINDINGS_OFFSET"), numeric("MANIFEST_IMAGES_OFFSET"));
  const initial = createHash("sha256").update(scopes).digest();
  const binding = createHash("sha256").update(initial).update(namespace).update(Buffer.alloc(1)).digest();
  if (!/^attempt-[a-f0-9]{32}$/u.test(namespace.toString("ascii")) || !launch.equals(frame.subarray(48, 80)) ||
      !binding.equals(frame.subarray(16, 48))) {throw new Error("captured native manifest/namespace binding mismatch");}
};
const validateClosedTicket = (frame: Buffer, payload: Uint8Array): void => {
  const bytes = Buffer.from(payload);
  const magic = text("RECORD_MAGIC");
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
const validateEventExit = (exit: number, signal: number): void => {
  if ((exit !== 0xffff_ffff && exit > 255) || signal > 127 ||
      (exit !== 0xffff_ffff && signal !== 0)) {
    throw new Error("inconsistent native event exit fields");
  }
};
export function decodeDarwinAttemptOwnerEvent(frame: Buffer, payload: Uint8Array): DarwinAttemptOwnerEvent {
  if (eventPayloadLength(frame) !== payload.byteLength) {throw new Error("partial or surplus native payload");}
  const kind = DARWIN_ATTEMPT_OWNER_EVENT_NAMES.find((name) => numeric(`EVENT_${name}`) === frame.readUInt32BE(8));
  if (kind === undefined) {throw new Error("unknown native event");}
  const get = (name: string): number => frame.readUInt32BE(numeric(`EVENT_${name}_OFFSET`));
  const wide = (name: string): string => frame.readBigUInt64BE(numeric(`EVENT_${name}_OFFSET`)).toString();
  const commandNumber = get("COMMAND");
  const command = DARWIN_ATTEMPT_OWNER_COMMAND_NAMES.find((name) => numeric(name) === commandNumber);
  const owner = imageAt(frame, numeric("EVENT_OWNER_OFFSET"));
  const child = imageAt(frame, numeric("EVENT_CHILD_OFFSET"));
  const flags = get("FLAGS");
  const exit = get("EXIT_CODE");
  if (!owner || get("SERIAL") === 0 || get("PHASE") > numeric("PHASE_QUARANTINED") || get("WORKSPACE") > numeric("WORKSPACE_CLOSED") || flags > (numeric("FLAG_PROVIDER") * 2 - 1) ||
      get("RESULT") > numeric("RESULT_UNKNOWN") || (commandNumber !== 0 && command === undefined) ||
      get("SLOT") !== 0 || get("MODE") > 0o777) {
    throw new Error("inconsistent native event fields");
  }
  validateEventExit(exit, get("EXIT_SIGNAL"));
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
    if (this.#closed || chunk.byteLength === 0 || chunk.byteLength > numeric("EVENT_MAX_BYTES") + darwinAttemptOwnerEventBytes) {
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

export {captureDarwinWorkspaceTree, DarwinWorkspaceTreeReceiver} from "./darwin-attempt-owner-workspace-tree.js";
export type DarwinNativeDirectoryData = Readonly<{path: string; dev: bigint; ino: bigint; uid: number; mode: number}>;
export type DarwinNativeLaunchData = Readonly<{
  operationId: string; generation: string; leasedUid: number;
  privateRoot: DarwinNativeDirectoryData; codexHome: DarwinNativeDirectoryData;
  tmpDir: DarwinNativeDirectoryData; workspace: DarwinNativeDirectoryData;
}>;
const decodeNativeText = (bytes: Buffer, offset: number): string => {
  const length = bytes.readUInt32BE(offset);
  if (!length || length > 1024) {throw new Error("invalid native fixed text length");}
  const encoded = bytes.subarray(offset + 4, offset + 4 + length);
  if (encoded.includes(0) || bytes.subarray(offset + 4 + length, offset + 1028).some(value => value !== 0)) {
    throw new Error("invalid native fixed text padding");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(encoded);
};
const decodeNativeDirectory = (bytes: Buffer, offset: number, uid: number): DarwinNativeDirectoryData => {
  const path = decodeNativeText(bytes, offset);
  const dev = bytes.readBigUInt64BE(offset + 1028), ino = bytes.readBigUInt64BE(offset + 1036);
  const actualUid = bytes.readUInt32BE(offset + 1044), mode = bytes.readUInt32BE(offset + 1048);
  if (!path.startsWith("/") || path.slice(1).split("/").some(part => !part || part === "." || part === "..") ||
      !dev || !ino || actualUid !== uid || mode !== 0o700) {throw new Error("invalid native directory fact");}
  return Object.freeze({path, dev, ino, uid, mode});
};
/** Decodes authenticated channel data only. Opaque authority is issued by the retained selection owner. */
export function decodeDarwinNativeLaunchData(event: DarwinAttemptOwnerEvent): DarwinNativeLaunchData {
  if ((event.kind !== "OBSERVATION" && event.kind !== "MATERIAL_RESULT") ||
      event.payload.length !== (event.kind === "OBSERVATION" ? 5244 : 8520)) {throw new Error("missing native launch observation");}
  const bytes = event.payload;
  const operationId = decodeNativeText(bytes, 0), leasedUid = bytes.readUInt32BE(1028);
  const generation = bytes.readUInt32BE(1032);
  if (!leasedUid || !generation || generation !== event.revision) {throw new Error("invalid native observation generation");}
  const privateRoot = decodeNativeDirectory(bytes, 1036, leasedUid);
  const codexHome = decodeNativeDirectory(bytes, 2088, leasedUid);
  const tmpDir = decodeNativeDirectory(bytes, 3140, leasedUid);
  const workspace = decodeNativeDirectory(bytes, 4192, leasedUid);
  if (codexHome.path !== privateRoot.path + "/codex-home" || tmpDir.path !== privateRoot.path + "/tmp" ||
      workspace.dev.toString() !== event.workspaceDev || workspace.ino.toString() !== event.workspaceIno ||
      new Set([privateRoot.ino, codexHome.ino, tmpDir.ino, workspace.ino]).size !== 4 ||
      [privateRoot, codexHome, tmpDir].some(fact => fact.dev !== workspace.dev)) {throw new Error("foreign native observation tree");}
  return Object.freeze({operationId, generation: String(generation), leasedUid, privateRoot, codexHome, tmpDir, workspace});
}

export type DarwinNativeFileData = Readonly<DarwinNativeDirectoryData & {nlink: number; bytes: number; sha256: string}>;
export function decodeDarwinNativeMaterialData(event: DarwinAttemptOwnerEvent): Readonly<{
  observation: DarwinNativeLaunchData; config: DarwinNativeFileData; catalog: DarwinNativeFileData; installation: DarwinNativeFileData;
}> {
  if (event.kind !== "MATERIAL_RESULT") {throw new Error("missing native material result");}
  const observation = decodeDarwinNativeLaunchData(event);
  const file = (index: number, name: string, mode: number): DarwinNativeFileData => {
    const offset = 5244 + index * 1092, data = event.payload;
    const path = decodeNativeText(data, offset), dev = data.readBigUInt64BE(offset + 1028), ino = data.readBigUInt64BE(offset + 1036);
    const uid = data.readUInt32BE(offset + 1044), actualMode = data.readUInt32BE(offset + 1048);
    const nlink = data.readUInt32BE(offset + 1052), bytes = data.readUInt32BE(offset + 1056);
    if (path !== observation.codexHome.path + "/" + name || dev !== observation.codexHome.dev ||
        !ino || uid !== observation.leasedUid || actualMode !== mode || nlink !== 1) {throw new Error("foreign native material file");}
    return Object.freeze({path, dev, ino, uid, mode, nlink, bytes, sha256: data.subarray(offset + 1060, offset + 1092).toString("hex")});
  };
  const config = file(0, "config.toml", 0o600), catalog = file(1, "models.json", 0o600), installation = file(2, "installation_id", 0o644);
  if (!config.bytes || config.bytes > numeric("CONFIG_MAX_BYTES") || catalog.bytes !== numeric("CATALOG_BYTES") || installation.bytes !== 36 ||
      new Set([config.ino, catalog.ino, installation.ino, observation.codexHome.ino]).size !== 4) {throw new Error("invalid native material inventory");}
  return Object.freeze({observation, config, catalog, installation});
}
