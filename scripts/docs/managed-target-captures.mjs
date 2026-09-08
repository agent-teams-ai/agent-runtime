import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const MAX_TARGET_CAPTURE_BYTES = 2 * 1024 * 1024;
const defaultFileSystem = Object.freeze({ lstat, open, realpath });
const containedBy = (parent, child) => {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const canonicalPath = path => {
  assert.equal(typeof path, "string", "missing canonical custody path");
  assert.ok(isAbsolute(path) && resolve(path) === path, "custody path must be canonical and absolute");
  return path;
};
const identity = stats => ({
  dev: stats.dev, ino: stats.ino, mode: stats.mode, nlink: stats.nlink,
  size: stats.size, ctimeNs: stats.ctimeNs, mtimeNs: stats.mtimeNs,
});

// Adapted locally from consumer ar2-evidence-custody: direct lineage, single-link,
// no-follow descriptor, bounded reading and before/after identity checks. No AR-2
// path vocabulary, repository default, policy or platform abstraction is imported.
const lineage = async (path, fileSystem, file = false) => {
  let current = parse(path).root;
  const paths = [current];
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    paths.push(current);
  }
  const observations = [];
  for (const [index, entry] of paths.entries()) {
    const stats = await fileSystem.lstat(entry, { bigint: true });
    const terminal = file && index === paths.length - 1;
    assert.ok(!stats.isSymbolicLink(), "symbolic links in custody lineage are forbidden");
    assert.ok(terminal ? stats.isFile() : stats.isDirectory(), "custody requires directories and regular bytes");
    if (terminal) {
      assert.equal(stats.nlink, 1n, "target evidence must have exactly one link");
    }
    // Shared ancestors (including /tmp) may change unrelated children. Bind their
    // inode and mode, not directory timestamps; bind full metadata for the file.
    observations.push(terminal ? identity(stats) : { dev: stats.dev, ino: stats.ino, mode: stats.mode });
  }
  assert.equal(await fileSystem.realpath(path), path, "custody path must have canonical identity");
  return observations;
};

const authorityPlan = authority => {
  assert.ok(authority && typeof authority === "object", "missing retained-root authority");
  assert.deepEqual(Object.keys(authority).sort(), ["cleanupRoots", "mutableTargetRoot", "retainedRoot"]);
  const retainedRoot = canonicalPath(authority.retainedRoot);
  const mutableTargetRoot = canonicalPath(authority.mutableTargetRoot);
  assert.ok(Array.isArray(authority.cleanupRoots) && authority.cleanupRoots.length > 0,
    "cleanup-root authority is required");
  const excludedRoots = [mutableTargetRoot, ...authority.cleanupRoots.map(canonicalPath)];
  for (const excluded of excludedRoots) {
    assert.ok(!containedBy(excluded, retainedRoot) && !containedBy(retainedRoot, excluded),
      "retained root overlaps mutable target or cleanup root");
  }
  return { retainedRoot, excludedRoots };
};

const readBounded = async (handle, maxBytes) => {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) {return Buffer.concat(chunks, total);}
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  assert.fail("target evidence exceeds byte budget");
};

// A custody prerequisite, NOT a managed qualification gate. The coordinator must
// independently supply BOTH expectedSha256 and authority (the retained root and
// complete mutable-target/cleanup roots), never accept them from capture input.
// All roots must exist with canonical, direct directory lineage, outside each
// other's retention/exclusion boundary. The coordinator owns their allocation and
// continued retention. These observations are not a filesystem lock or proof of
// future immutability. Installed product semantics/status wiring remain pending.
// options is a trusted host/test seam, never deserialized evidence.
export async function readRetainedTargetCapture(capture, expectedSha256, authority, options = {}) {
  assert.ok(capture && typeof capture === "object", "missing target evidence");
  assert.deepEqual(Object.keys(capture).sort(), ["path", "sha256"]);
  assert.match(expectedSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(capture.sha256, expectedSha256, "mismatched target evidence selection");
  const path = canonicalPath(capture.path);
  const { retainedRoot, excludedRoots } = authorityPlan(authority);
  assert.ok(path !== retainedRoot && containedBy(retainedRoot, path), "target evidence escapes retained root");
  const { fileSystem = defaultFileSystem, maxBytes = MAX_TARGET_CAPTURE_BYTES } = options;
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_TARGET_CAPTURE_BYTES,
    "invalid target evidence byte budget");
  assert.ok(Number.isInteger(constants.O_NOFOLLOW) && constants.O_NOFOLLOW > 0
    && Number.isInteger(constants.O_NONBLOCK) && constants.O_NONBLOCK > 0,
  "descriptor-bound no-follow reads unsupported");
  const roots = [retainedRoot, ...excludedRoots];
  const inspectRoots = () => Promise.all(roots.map(root => lineage(root, fileSystem)));
  const beforeRoots = await inspectRoots();
  const beforePath = await lineage(path, fileSystem, true);
  let handle;
  try {
    handle = await fileSystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    assert.ok(before.isFile() && before.nlink === 1n, "descriptor must be singly-linked regular bytes");
    assert.deepEqual(identity(before), beforePath.at(-1), "target evidence changed before descriptor binding");
    assert.ok(before.size <= BigInt(maxBytes), "target evidence exceeds byte budget");
    assert.deepEqual(await inspectRoots(), beforeRoots, "custody root identity changed before read");
    assert.deepEqual(await lineage(path, fileSystem, true), beforePath, "custody lineage changed before read");
    const bytes = await readBounded(handle, maxBytes);
    const after = await handle.stat({ bigint: true });
    assert.ok(after.isFile() && after.nlink === 1n, "descriptor must remain singly-linked regular bytes");
    assert.deepEqual(identity(after), identity(before), "target evidence descriptor changed during read");
    assert.equal(BigInt(bytes.length), before.size, "target evidence size changed during read");
    assert.deepEqual(await lineage(path, fileSystem, true), beforePath, "custody lineage changed during read");
    assert.deepEqual(await inspectRoots(), beforeRoots, "custody root identity changed during read");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assert.equal(digest, expectedSha256, "mismatched target evidence bytes");
    return bytes;
  } finally {
    if (handle !== undefined) {await handle.close();}
  }
}
