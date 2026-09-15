import {createHash} from "node:crypto";
import type {DarwinNativeWorkspaceTree, DarwinNativeWorkspaceTreeLimits, DarwinNativeWorkspaceFile, DarwinNativeWorkspaceFileEntry, DarwinAttemptOwnerEvent} from "./darwin-attempt-owner-protocol.js";
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
    if (!isFileKind(entry.kind)) {throw new Error("unsupported native tree entry");}
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
      /[<>:"/\\|?*]/u.test(name) || Array.from(name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || Buffer.byteLength(name, "utf8") > 255) {
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
    if (parent !== 0xffff_ffff && retainedParent?.directory !== true) {throw new Error("native tree parent is not a retained directory");}
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


const isFileKind = (kind: unknown): boolean => kind === "file";
