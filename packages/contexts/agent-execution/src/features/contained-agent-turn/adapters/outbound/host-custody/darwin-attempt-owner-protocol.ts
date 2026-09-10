import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  "DISPOSE_ONCE", "READ_CLOSED_WORKSPACE",
  "MATERIALIZE_BEGIN", "MATERIALIZE_ENTRY", "MATERIALIZE_CHUNK", "MATERIALIZE_FINISH", "COMMIT_CREATION", "READ_TREE", "BIND_PREPARED", "CONFIRM_CLAIM", "READ_OBSERVATION", "MATERIAL_BEGIN", "MATERIAL_CHUNK", "MATERIAL_FINISH", "BIND_FINAL_LAUNCH", "WRITE_INPUT", "CLOSE_INPUT", "QUERY_CLOSED_WORKSPACE",
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

const validRequestArgument = (command: DarwinAttemptOwnerCommand, argument: number): boolean => {
  switch (command) {
    case "MATERIALIZE_BEGIN": return argument === 16;
    case "MATERIALIZE_ENTRY": return argument >= 25 && argument <= 279;
    case "MATERIALIZE_CHUNK": return argument > 8 && argument <= numeric("TREE_REQUEST_MAX_BYTES");
    case "COMMIT_CREATION": return argument === numeric("CREATION_BYTES");
    case "WRITE_INPUT": return argument > 0 && argument <= numeric("STREAM_CHUNK_BYTES");
    case "BIND_FINAL_LAUNCH": return argument === numeric("FINAL_LAUNCH_BYTES");
    case "MATERIAL_BEGIN": return argument === 44;
    case "MATERIAL_CHUNK": return argument > 8 && argument <= numeric("TREE_REQUEST_MAX_BYTES");
    case "BIND_PREPARED": return argument === numeric("PREPARED_BYTES");
    case "CONFIRM_CLAIM": return argument > numeric("PREPARED_BYTES") && argument <= numeric("TREE_REQUEST_MAX_BYTES");
    default: return argument === 0;
  }
};
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

const eventNames = ["STATUS", "PREEXEC", "IMAGE", "EXIT", "STREAMS", "STDOUT", "STDERR", "REFUSED", "HELLO", "RELEASED", "TREE_ENTRY", "TREE_CHUNK", "TREE_END", "CLOSED_READ", "OBSERVATION", "MATERIAL_RESULT"] as const;
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
  const bounds: Partial<Record<typeof eventNames[number], readonly [number, number]>> = {
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
const validateEventExit = (exit: number, signal: number): void => {
  if ((exit !== 0xffff_ffff && exit > 255) || signal > 127 ||
      (exit !== 0xffff_ffff && signal !== 0)) {
    throw new Error("inconsistent native event exit fields");
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

/** Complete-tree data validation. This never issues workspace or attempt
 * authority. Copy before the first transport await: Buffers in a frozen source
 * object are still mutable. The digest encoding is the canonical scanner's
 * UTF-16 sorted JSON inventory, including directories and exact mode bits. */
export function captureDarwinWorkspaceTree(
  tree: DarwinNativeWorkspaceTree,
  limits: DarwinNativeWorkspaceTreeLimits,
): DarwinNativeWorkspaceTree {
  validateTreeLimits(limits);
  if (tree.entries.length > limits.maxEntries || tree.files.length > tree.entries.length) {
    throw new Error("native tree entry budget exceeded");
  }
  const files = tree.files.map(file => Object.freeze({ relativePath: file.relativePath,
    mode: file.mode, size: file.size, digest: file.digest, bytes: Buffer.from(file.bytes) }));
  const byPath = new Map(files.map(file => [file.relativePath, file]));
  if (byPath.size !== files.length) {throw new Error("duplicate native tree content");}
  const entries = tree.entries.map(entry => entry.kind === "file"
    ? Object.freeze({ kind: entry.kind, relativePath: entry.relativePath, mode: entry.mode, size: entry.size, digest: entry.digest })
    : Object.freeze({ kind: entry.kind, relativePath: entry.relativePath, mode: entry.mode }));
  const directories = new Set<string>([""]);
  const names = new Map<string, Set<string>>();
  let previous: string | undefined;
  let total = 0;
  for (const entry of entries) {
    if (previous !== undefined && previous >= entry.relativePath) {throw new Error("native tree inventory is not canonical");}
    previous = entry.relativePath;
    validateTreePath(entry.relativePath, directories, names, entry.kind === "directory", limits.maxDepth);
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {throw new Error("invalid native tree mode");}
    if (entry.kind === "directory") {directories.add(entry.relativePath); continue;}
    if (entry.kind !== "file") {throw new Error("unsupported native tree entry");}
    const file = byPath.get(entry.relativePath);
    validateTreeFile(file, entry, limits.maxFileBytes);
    total += entry.size;
    if (total > limits.maxTotalBytes) {throw new Error("native tree total budget exceeded");}
    byPath.delete(entry.relativePath);
  }
  if (byPath.size !== 0 || files.some((file, index) => index > 0 && files[index - 1]!.relativePath >= file.relativePath)) {
    throw new Error("native tree content is not the complete canonical inventory");
  }
  const inventory = entries.map(entry => entry.kind === "directory"
    ? [entry.kind, entry.relativePath, entry.mode]
    : [entry.kind, entry.relativePath, entry.mode, entry.size, entry.digest]);
  const treeDigest = createHash("sha256").update(Buffer.from(JSON.stringify(inventory), "utf8")).digest("hex");
  if (treeDigest !== tree.treeDigest) {throw new Error("native tree semantic digest mismatch");}
  return Object.freeze({ entries: Object.freeze(entries), files: Object.freeze(files),
    rootIdentity: Object.freeze({ ...tree.rootIdentity }), treeDigest });
}
const validateTreeFile = (file: DarwinNativeWorkspaceFile | undefined, entry: DarwinNativeWorkspaceFileEntry, maxBytes: number): void => {
  if (!file || file.mode !== entry.mode || file.size !== entry.size || file.digest !== entry.digest ||
      file.bytes.length !== entry.size || entry.size > maxBytes ||
      createHash("sha256").update(file.bytes).digest("hex") !== entry.digest) {
    throw new Error("native tree file inventory/content mismatch");
  }
};
const validateTreeLimits = (limits: DarwinNativeWorkspaceTreeLimits): void => {
  const ceilings = { maxDepth: 32, maxEntries: 4096, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 };
  for (const key of Object.keys(ceilings) as (keyof typeof ceilings)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0 || limits[key] > ceilings[key]) {
      throw new Error("native tree limit exceeds canonical ceiling");
    }
  }
  if (limits.maxFileBytes > limits.maxTotalBytes) {throw new Error("native file budget exceeds tree budget");}
};
const validateTreePath = (path: string, directories: Set<string>, names: Map<string, Set<string>>, directory: boolean, maxDepth: number): void => {
  const components = path.split("/");
  const name = components.pop()!;
  const parent = components.join("/");
  if (!directories.has(parent) || components.length + Number(directory) > maxDepth ||
      components.some(component => component === "") || name === "" || name !== name.normalize("NFC") ||
      /[ .]$/u.test(name) || /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/iu.test(name) ||
      /[<>:"/\\|?*]/u.test(name) || [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || Buffer.byteLength(name, "utf8") > 255) {
    throw new Error("native tree path is not canonical portable data");
  }
  const siblings = names.get(parent) ?? new Set<string>();
  const key = name.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
  if (siblings.has(key)) {throw new Error("native tree contains a portable name collision");}
  siblings.add(key); names.set(parent, siblings);
};

/** Receives bounded observed data from an already authenticated owner channel.
 * Completion alone is not authority: the bridge must also await the matching
 * successful command acknowledgement before returning this snapshot. */
export class DarwinWorkspaceTreeReceiver {
  readonly #limits: DarwinNativeWorkspaceTreeLimits;
  readonly #entries: { path: string; directory: boolean; mode: number; size: number; bytes: Buffer; used: number }[] = [];
  readonly #dev: string;
  readonly #ino: string;
  #total = 0;
  #ended: DarwinAttemptOwnerEvent | undefined;
  #failed = false;
  constructor(limits: DarwinNativeWorkspaceTreeLimits, dev: string, ino: string) {
    validateTreeLimits(limits); this.#limits = Object.freeze({ ...limits }); this.#dev = dev; this.#ino = ino;
  }
  accept(event: DarwinAttemptOwnerEvent): void {
    if (this.#failed || this.#ended) {throw new Error("native tree stream already terminal");}
    try {
      if (event.workspaceDev !== this.#dev || event.workspaceIno !== this.#ino) {throw new Error("foreign native tree root");}
      if (event.kind === "TREE_ENTRY") {this.#entry(event);}
      else if (event.kind === "TREE_CHUNK") {this.#chunk(event.payload);}
      else if (event.kind === "TREE_END") {this.#completeFile(); this.#ended = event;}
      else {throw new Error("unexpected native tree event");}
    } catch (error) {this.#failed = true; throw error;}
  }
  #completeFile(): void {
    const last = this.#entries.at(-1);
    if (last && last.used !== last.size) {throw new Error("incomplete native file transfer");}
  }
  #entry(event: DarwinAttemptOwnerEvent): void {
    this.#completeFile();
    const bytes = event.payload;
    const ordinal = bytes.readUInt32BE(0), parent = bytes.readUInt32BE(4);
    const directory = bytes.readUInt32BE(8), mode = bytes.readUInt32BE(12), size = bytes.readUInt32BE(16);
    const nameBytes = bytes.subarray(24), name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    if (ordinal !== this.#entries.length || ordinal >= this.#limits.maxEntries || directory > 1 ||
        nameBytes.length !== bytes.readUInt32BE(20) || name.includes("/") || name.includes("\0") ||
        mode > 0o777 || (directory === 1 && size !== 0) || size > this.#limits.maxFileBytes ||
        size > this.#limits.maxTotalBytes - this.#total || event.dev !== this.#dev || event.ino === "0") {
      throw new Error("invalid native tree inventory event");
    }
    const retainedParent = parent === 0xffff_ffff ? undefined : this.#entries[parent];
    if (parent !== 0xffff_ffff && !retainedParent?.directory) {throw new Error("native tree parent is not a retained directory");}
    const path = retainedParent ? `${retainedParent.path}/${name}` : name;
    this.#entries.push({ path, directory: directory === 1, mode, size, bytes: Buffer.alloc(size), used: 0 });
    this.#total += size;
  }
  #chunk(payload: Buffer): void {
    const entry = this.#entries[payload.readUInt32BE(0)];
    const bytes = payload.subarray(8);
    if (!entry || entry !== this.#entries.at(-1) || entry.directory || payload.readUInt32BE(4) !== entry.used ||
        bytes.length === 0 || bytes.length > 16384 || bytes.length > entry.size - entry.used) {
      throw new Error("out-of-order native tree chunk");
    }
    bytes.copy(entry.bytes, entry.used); entry.used += bytes.length;
  }
  finish(): DarwinNativeWorkspaceTree {
    const end = this.#ended;
    if (this.#failed || !end) {throw new Error("native tree completion missing");}
    const observed = this.#entries.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const files = observed.filter(entry => !entry.directory).map(entry => Object.freeze({ relativePath: entry.path,
      mode: entry.mode, size: entry.size, bytes: entry.bytes, digest: createHash("sha256").update(entry.bytes).digest("hex") }));
    const byPath = new Map(files.map(file => [file.relativePath, file]));
    const entries = observed.map(entry => entry.directory
      ? Object.freeze({ kind: "directory" as const, relativePath: entry.path, mode: entry.mode })
      : Object.freeze({ kind: "file" as const, relativePath: entry.path, mode: entry.mode,
        size: entry.size, digest: byPath.get(entry.path)!.digest }));
    const inventory = entries.map(entry => entry.kind === "directory" ? [entry.kind, entry.relativePath, entry.mode]
      : [entry.kind, entry.relativePath, entry.mode, entry.size, entry.digest]);
    const treeDigest = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
    return captureDarwinWorkspaceTree({ entries, files, treeDigest, rootIdentity: {
      dev: BigInt(this.#dev), ino: BigInt(this.#ino), mode: BigInt(end.payload.readUInt32BE(0)),
      ctimeNs: end.payload.readBigUInt64BE(8), mtimeNs: end.payload.readBigUInt64BE(16),
    } }, this.#limits);
  }
}

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


/** Inert final data, not an authority issuer. Only the private HTTP owner may
 * transmit it after authenticating its retained same-object final launch. */
export interface DarwinNativeFinalLaunchData {
  readonly home: string; readonly codexHome: string; readonly tmpDir: string;
  readonly localCapability: string; readonly port: number;
  readonly preparedSha256: string; readonly profileSha256: string;
  readonly configSha256: string; readonly catalogSha256: string; readonly installationSha256: string;
  readonly fingerprintSha256: string; readonly materialSha256: string;
  readonly executableSha256: string; readonly argumentsSha256: string;
}
const finalDigestBytes = (value: string): Buffer => {
  if (typeof value !== "string" || !digest.test(value)) {throw new Error("invalid final native binding digest");}
  return Buffer.from(value, "hex");
};
const canonicalFinalPath = (value: string): boolean => value.startsWith("/") &&
  !value.slice(1).split("/").some(part => !part || part === "." || part === "..");
export function encodeDarwinNativeFinalLaunchData(input: DarwinNativeFinalLaunchData): Buffer {
  const names = ["home", "codexHome", "tmpDir", "localCapability", "port", "preparedSha256", "profileSha256",
    "configSha256", "catalogSha256", "installationSha256", "fingerprintSha256", "materialSha256", "executableSha256", "argumentsSha256"];
  if (Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== names.length ||
      names.some(name => !Object.hasOwn(input, name)) ||
      Object.values(Object.getOwnPropertyDescriptors(input)).some(field => !("value" in field) ||
        (typeof field.value !== "string" && typeof field.value !== "number"))) {
    throw new Error("final native launch requires exact inert data");
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || (typeof input.localCapability !== "string" || !digest.test(input.localCapability))) {
    throw new Error("invalid final native local route");
  }
  const packet = Buffer.alloc(numeric("FINAL_LAUNCH_BYTES"));
  packet.writeUInt32BE(1, 0); packet.writeUInt32BE(input.port, 4);
  const fields = [input.home, input.codexHome, input.tmpDir, input.localCapability,
    `http://127.0.0.1:${input.port}/backend-api/codex`];
  for (const [index, value] of fields.entries()) {
    if (typeof value !== "string" || !value || !value.isWellFormed() || value.includes("\0") ||
        Buffer.byteLength(value) > 1024 || (index < 3 && !canonicalFinalPath(value))) {
      throw new Error("invalid final native environment field");
    }
    const offset = numeric("FINAL_TEXT_OFFSET") + index * 1028;
    packet.writeUInt32BE(Buffer.byteLength(value), offset); packet.write(value, offset + 4, "utf8");
  }
  const hashes = [input.preparedSha256, input.profileSha256, input.configSha256, input.catalogSha256,
    input.installationSha256, input.fingerprintSha256, input.materialSha256, input.executableSha256, input.argumentsSha256];
  for (const [index, value] of hashes.entries()) {
    finalDigestBytes(value).copy(packet, numeric("FINAL_DIGEST_OFFSET") + index * 32);
  }
  return packet;
}

export function darwinNativeArgumentsSha256(executable: string, args: readonly string[]): string {
  if (args.length > 7) {throw new Error("native argument count exceeds root bound");}
  const hash = createHash("sha256");
  for (const value of [executable, ...args]) {
    if (typeof value !== "string" || !value || !value.isWellFormed() || value.includes("\0") || Buffer.byteLength(value) > 255) {
      throw new Error("native argument exceeds fixed root slot");
    }
    const count = Buffer.alloc(4); count.writeUInt32BE(Buffer.byteLength(value)); hash.update(count).update(value);
  }
  return hash.digest("hex");
}
