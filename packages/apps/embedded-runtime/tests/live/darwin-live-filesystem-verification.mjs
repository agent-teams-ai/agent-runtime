import {createHash} from "node:crypto";
import {isAbsolute} from "node:path";

const MAX_ENTRIES = 4096, MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const refused = detail => new Error(`DARWIN_LIVE_FILESYSTEM_REFUSED: ${detail}`);
const identityKeys = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
const same = (left, right) => identityKeys.every(key => left[key] === right[key]);
const namesEqual = (left, right) => left.length === right.length && left.every((name, index) => name === right[index]);
const components = path => {
  if (!isAbsolute(path) || path.includes("\0") || path.length > 4096 || path.endsWith("/")) {throw refused("canonical absolute path required");}
  const parts = path.slice(1).split("/");
  if (parts.length > 64 || parts.some(part => !part || part === "." || part === "..")) {throw refused("invalid path components");}
  return parts;
};

/** Uses only the existing initialized acquisition guard. This never installs a
 * guard, starts a process, or falls back to path-based child opens on Darwin. */
export async function nativeVerificationFilesystem() {
  const api = await import("../../../../platform/filesystem-custody/dist/index.js");
  return Object.freeze({openRoot: api.openNativeHostRoot, openEntry: api.openNativeHostEntry, names: api.nativeHostNames});
}

async function withAbsolute(path, kind, filesystem, consume, parentIdentity) {
  const parts = components(path), lineage = [];
  const fs = filesystem ?? await nativeVerificationFilesystem(), handles = [await fs.openRoot()];
  try {
    for (const [index, name] of parts.entries()) {
      const parent = handles.at(-1), entryKind = index === parts.length - 1 ? kind : "directory";
      const handle = await fs.openEntry(parent, name, entryKind);
      handles.push(handle);
      const stat = await handle.stat({bigint: true});
      lineage.push({parent, name, handle, stat, kind: entryKind});
    }
    if (parentIdentity) {
      const parent = await handles.at(-2).stat({bigint: true});
      if (parent.dev !== parentIdentity.dev || parent.ino !== parentIdentity.ino) {throw refused("retained result directory identity differs");}
    }
    const value = await consume(handles.at(-1), fs);
    // Reopen every component through the retained parent descriptors. Ancestor
    // inode identity must remain bound even when its unrelated children change.
    for (const entry of lineage) {
      const current = await fs.openEntry(entry.parent, entry.name, entry.kind);
      try {
        const stat = await current.stat({bigint: true});
        if (stat.dev !== entry.stat.dev || stat.ino !== entry.stat.ino || stat.mode !== entry.stat.mode ||
            (entry.kind === "inspect" && !same(stat, entry.stat))) {
          throw refused("path lineage replaced");
        }
      } finally {await current.close();}
    }
    return value;
  } finally {for (const handle of handles.toReversed()) {await handle.close();}}
}

async function stableBytes(handle, maximumBytes) {
  const before = await handle.stat({bigint: true});
  if (!before.isFile() || before.nlink !== 1n || before.size < 0n || before.size > BigInt(maximumBytes)) {
    throw refused("bounded single-link regular file required");
  }
  const bytes = Buffer.alloc(Number(before.size) + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) {break;}
    offset += bytesRead;
  }
  if (offset !== Number(before.size) || !same(before, await handle.stat({bigint: true}))) {throw refused("file changed during read");}
  return {bytes: bytes.subarray(0, offset), stat: before};
}

export async function readStableVerificationFile(path, maximumBytes = MAX_FILE_BYTES, filesystem, parentIdentity) {
  return withAbsolute(path, "inspect", filesystem, async handle => (await stableBytes(handle, maximumBytes)).bytes, parentIdentity);
}

export async function captureVerificationDirectoryIdentity(path, filesystem) {
  return withAbsolute(path, "directory", filesystem, async handle => {
    const stat = await handle.stat({bigint: true});
    if (!stat.isDirectory()) {throw refused("result directory required");}
    return Object.freeze({dev: stat.dev, ino: stat.ino});
  });
}

function parseManifest(bytes) {
  const value = JSON.parse(bytes);
  if (Object.keys(value).toSorted().join(",") !== "entries,version" || value.version !== 1 ||
      !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {throw refused("invalid bounded source manifest");}
  const entries = new Map(); let total = 0;
  for (const entry of value.entries) {
    if (!entry || typeof entry.path !== "string" || entry.path.startsWith("/")) {throw refused("invalid source entry");}
    components(`/${entry.path}`);
    const keys = Object.keys(entry).toSorted().join(",");
    if (entries.has(entry.path) || (entry.kind === "directory" ? keys !== "kind,path" :
      entry.kind !== "file" || keys !== "kind,path,sha256,size" || !Number.isSafeInteger(entry.size) ||
      entry.size < 0 || entry.size > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/u.test(entry.sha256))) {throw refused("invalid source entry schema");}
    total += entry.kind === "file" ? entry.size : 0;
    if (total > MAX_TOTAL_BYTES) {throw refused("source inventory byte budget exceeded");}
    entries.set(entry.path, entry);
  }
  return entries;
}

async function directoryNames(handle, fs) {
  const names = [...await fs.names(handle, MAX_ENTRIES + 1)].toSorted();
  if (names.length > MAX_ENTRIES || new Set(names).size !== names.length ||
      names.some(name => typeof name !== "string" || !name || name.includes("/") || name === "." || name === "..")) {
    throw refused("directory enumeration invalid or over budget");
  }
  return names;
}

async function scanDirectory(handle, fs, prefix, context) {
  const before = await handle.stat({bigint: true}), names = await directoryNames(handle, fs);
  if (!before.isDirectory()) {throw refused("directory replaced");}
  const facts = new Map();
  for (const name of names) {
    const path = prefix ? `${prefix}/${name}` : name, expected = context.entries.get(path);
    if (!expected || ++context.count > MAX_ENTRIES) {throw refused("unexpected source entry");}
    const child = await fs.openEntry(handle, name, expected.kind === "directory" ? "directory" : "inspect");
    try {
      let fact;
      if (expected.kind === "directory") {fact = await scanDirectory(child, fs, path, context);}
      else {
        const read = await stableBytes(child, MAX_FILE_BYTES);
        if (read.bytes.length !== expected.size || digest(read.bytes) !== expected.sha256) {throw refused("source content differs");}
        fact = {stat: read.stat};
      }
      facts.set(name, fact);
    } finally {await child.close();}
  }
  if (!namesEqual(names, await directoryNames(handle, fs)) || !same(before, await handle.stat({bigint: true}))) {
    throw refused("source directory changed during scan");
  }
  return {stat: before, names, facts};
}

async function verifyFinalTree(handle, fs, tree) {
  if (!same(tree.stat, await handle.stat({bigint: true})) || !namesEqual(tree.names, await directoryNames(handle, fs))) {
    throw refused("source directory changed before final rescan");
  }
  for (const name of tree.names) {
    const fact = tree.facts.get(name), child = await fs.openEntry(handle, name, fact.names ? "directory" : "inspect");
    try {
      if (!same(fact.stat, await child.stat({bigint: true}))) {throw refused("source entry replaced before final rescan");}
      if (fact.names) {await verifyFinalTree(child, fs, fact);}
    } finally {await child.close();}
  }
  if (!namesEqual(tree.names, await directoryNames(handle, fs)) || !same(tree.stat, await handle.stat({bigint: true}))) {
    throw refused("source directory changed during final rescan");
  }
}

/** Pinned source format: {version:1, entries:[{kind:"directory",path} |
 * {kind:"file",path,size,sha256}]}. No other fields, duplicate paths, symlinks
 * or hard links. Budgets: 1 MiB manifest, 4096 entries, 64 path components,
 * 16 MiB per file, 64 MiB aggregate. Path names are root-relative and canonical.
 */
export async function verifyPinnedSource(activation, filesystem) {
  const {source} = activation;
  if (!source?.manifestPath || !/^[a-f0-9]{64}$/u.test(source.inventorySha256 ?? "")) {throw refused("source manifest path and hash unavailable");}
  const bytes = await readStableVerificationFile(source.manifestPath, 1024 * 1024, filesystem);
  if (digest(bytes) !== source.inventorySha256) {throw refused("source manifest hash differs");}
  const entries = parseManifest(bytes), root = activation.infrastructure.filesystem.sourceRoot;
  return withAbsolute(root, "directory", filesystem, async (handle, fs) => {
    const context = {entries, count: 0}, tree = await scanDirectory(handle, fs, "", context);
    if (context.count !== entries.size) {throw refused("source entries missing");}
    await verifyFinalTree(handle, fs, tree);
    return true;
  });
}
