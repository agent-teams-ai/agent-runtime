import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { inspectArchive, canonicalJson, readBoundedArchive } from "./archive.mjs";
import { buildCandidate, candidateIdentity, inspectPackedSurface } from "./candidate.mjs";

export const PACKAGE = "@agent-teams/filesystem-custody";
const PACKAGE_ROOT = "packages/platform/filesystem-custody";
const WORKSPACE_INPUTS = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", ".npmrc"];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function git(repository, args, spawn = spawnSync) {
  const result = spawn("git", ["-C", repository, ...args], { encoding: null, timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } });
  if (result.error || result.status !== 0) { throw new Error(`source: git ${args[0]} failed: ${result.error?.message ?? result.stderr?.toString("utf8")}`); }
  return result.stdout;
}

export function inspectSource(repository, commit, tree) {
  if (!isAbsolute(repository) || !/^[a-f0-9]{40}$/u.test(commit) || !/^[a-f0-9]{40}$/u.test(tree)) {
    throw new Error("source: absolute repository and full commit/tree required");
  }
  if (git(repository, ["rev-parse", "--show-toplevel"]).toString("utf8").trim() !== resolve(repository) ||
      git(repository, ["remote", "get-url", "origin"]).toString("utf8").trim() !==
        "https://github.com/agent-teams-ai/agent-runtime.git") {
    throw new Error("source: wrong repository identity");
  }
  if (git(repository, ["rev-parse", `${commit}^{commit}`]).toString("utf8").trim() !== commit ||
      git(repository, ["rev-parse", `${commit}^{tree}`]).toString("utf8").trim() !== tree) {
    throw new Error("source: commit/tree mismatch");
  }
  const packageInputs = git(repository, ["ls-tree", "-r", "--name-only", commit, "--", PACKAGE_ROOT])
    .toString("utf8").trim().split("\n").filter(Boolean);
  if (!packageInputs.includes(`${PACKAGE_ROOT}/native/rename-no-replace.c`) ||
      !packageInputs.includes(`${PACKAGE_ROOT}/scripts/build-native-helper.mjs`)) { throw new Error("source: native build inputs missing"); }
  const inputs = [...WORKSPACE_INPUTS, ...packageInputs].map(path => ({ path, sha256: sha256(git(repository, ["show", `${commit}:${path}`])) }));
  const sourceManifest = JSON.parse(git(repository, ["show", `${commit}:${PACKAGE_ROOT}/package.json`]).toString("utf8"));
  if (sourceManifest.name !== PACKAGE || sourceManifest.version !== "0.0.0") { throw new Error("source: package coordinates changed"); }
  return { commit, tree, package: PACKAGE, version: sourceManifest.version, inputs, sourceManifest };
}

const MAX_INSTALLED_FILE = 16 * 1024 * 1024;
const MAX_INSTALLED_TOTAL = 64 * 1024 * 1024;
const MAX_INSTALLED_ENTRIES = 256;
const MAX_INSTALLED_DEPTH = 32;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const descriptorPath = (descriptor, name) => `/proc/self/fd/${descriptor}/${name}`;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const directoryState = descriptor => fstatSync(descriptor, { bigint: true });
const sameDirectoryState = (a, b) => sameIdentity(a, b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function boundedDirectoryItems(descriptor) {
  const dir = opendirSync(descriptorPath(descriptor, "."));
  const items = [];
  try {
    for (let item; (item = dir.readSync()) !== null;) {
      if (items.length === MAX_INSTALLED_ENTRIES) { throw new Error("installed: member count limit"); }
      items.push(item);
    }
  } finally { dir.closeSync(); }
  return items;
}

function enumerateInstalled(descriptor, prefix, depth, state, onEnumerated) {
  if (depth > MAX_INSTALLED_DEPTH) { throw new Error("installed: traversal depth limit"); }
  const before = directoryState(descriptor);
  const items = boundedDirectoryItems(descriptor);
  if (state.entries + items.length > MAX_INSTALLED_ENTRIES) { throw new Error("installed: member count limit"); }
  const snapshots = items.map(item => lstatSync(descriptorPath(descriptor, item.name)));
  if (!sameDirectoryState(before, directoryState(descriptor))) { throw new Error("installed: directory changed during enumeration"); }
  const names = items.map(item => item.name).toSorted();
  state.directories.push({ descriptor, state: before, names, path: prefix });
  onEnumerated(prefix);
  for (const [index, item] of items.entries()) {
    if (++state.entries > MAX_INSTALLED_ENTRIES) { throw new Error("installed: member count limit"); }
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) { throw new Error(`installed: linked member ${path}`); }
    if (item.isDirectory()) {
      const child = openSync(descriptorPath(descriptor, item.name), DIRECTORY_FLAGS);
      state.opened.push(child);
      if (!sameIdentity(snapshots[index], fstatSync(child))) { throw new Error(`installed: directory replaced ${path}`); }
      state.directories.push({ descriptor: child, parent: descriptor, name: item.name, snapshot: snapshots[index], path });
      enumerateInstalled(child, path, depth + 1, state, onEnumerated);
    }
    else if (item.isFile()) {
      const file = openSync(descriptorPath(descriptor, item.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      state.opened.push(file);
      const stat = fstatSync(file);
      if (!sameIdentity(snapshots[index], stat) || !stat.isFile() || stat.nlink !== 1) {
        throw new Error(`installed: linked or replaced member ${path}`);
      }
      if (stat.size > MAX_INSTALLED_FILE || state.total + stat.size > MAX_INSTALLED_TOTAL) { throw new Error("installed: byte limit"); }
      state.total += stat.size;
      state.pending.push({ file, parent: descriptor, name: item.name, stat, path });
    }
    else { throw new Error(`installed: nonregular member ${path}`); }
  }
  if (!sameDirectoryState(before, directoryState(descriptor))) { throw new Error("installed: directory changed"); }
}

function readInstalledFile({ file, parent, name, stat, path }) {
  const bytes = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(file, bytes, offset, bytes.length - offset, offset);
    if (count === 0) { throw new Error(`installed: changed during read ${path}`); }
    offset += count;
  }
  const after = fstatSync(file);
  if (!sameIdentity(stat, after) || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs ||
      !sameIdentity(stat, lstatSync(descriptorPath(parent, name)))) {
    throw new Error(`installed: changed during read ${path}`);
  }
  return bytes;
}

export function installedFiles(base, key, onEnumerated = () => {}) {
  if (!isAbsolute(base)) { throw new Error("installed: absolute base directory required"); }
  const files = new Map();
  const state = { opened: [], pending: [], directories: [], entries: 0, total: 0 };
  const baseDescriptor = openSync(base, DIRECTORY_FLAGS);
  try {
    const root = openSync(descriptorPath(baseDescriptor, key), DIRECTORY_FLAGS);
    state.opened.push(root);
    try {
      enumerateInstalled(root, "", 0, state, onEnumerated);
      for (const pending of state.pending) {
        files.set(pending.path, readInstalledFile(pending));
      }
      for (const { descriptor, parent, name, snapshot, state: before, names, path } of state.directories) {
        if (snapshot && (!sameIdentity(snapshot, fstatSync(descriptor)) ||
            !sameIdentity(snapshot, lstatSync(descriptorPath(parent, name))))) {
          throw new Error(`installed: directory replaced ${path}`);
        }
        if (before && (!sameDirectoryState(before, directoryState(descriptor)) ||
            names.join("\0") !== boundedDirectoryItems(descriptor).map(item => item.name).toSorted().join("\0") ||
            !sameDirectoryState(before, directoryState(descriptor)))) {
          throw new Error(`installed: directory changed ${path}`);
        }
      }
      if (!sameIdentity(fstatSync(root), lstatSync(descriptorPath(baseDescriptor, key)))) {
        throw new Error("installed: root directory replaced");
      }
      if (!sameIdentity(fstatSync(baseDescriptor), lstatSync(base))) { throw new Error("installed: base directory replaced"); }
    }
    finally { for (const descriptor of state.opened.toReversed()) { closeSync(descriptor); } }
  } finally { closeSync(baseDescriptor); }
  return files;
}

export function inventoryKey(identity) {
  return sha256(Buffer.from(canonicalJson(identity)));
}

export function collect({ repository, commit, tree, archivePath, installedBase }) {
  const source = inspectSource(repository, commit, tree);
  if (!isAbsolute(archivePath) || !isAbsolute(installedBase)) { throw new Error("absolute archive and installed base required"); }
  const tgz = readBoundedArchive(archivePath);
  const archive = inspectArchive(tgz);
  const surface = inspectPackedSurface(source, archive);
  const identity = candidateIdentity(source, archive);
  const key = inventoryKey(identity);
  const observed = installedFiles(installedBase, key);
  return buildCandidate({ source, archive, surface, observed, identity, key,
    memberHashes: new Map([...observed].map(([path, bytes]) => [path, sha256(bytes)])),
    collectorRuntime: { node: process.version, platform: process.platform, arch: process.arch,
      git: git(repository, ["--version"]).toString("utf8").trim() } });
}

export function assertExternalOutput(repository, output) {
  if (!isAbsolute(output) || relative(realpathSync(repository),
    join(realpathSync(dirname(output)), basename(output))).split(/[\\/]/u)[0] !== "..") {
    throw new Error("output: external absolute path required");
  }
}
