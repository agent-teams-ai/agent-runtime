import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const defaultFileSystem = Object.freeze({ lstat, open, readdir, realpath });
const SUPPORTED_PLATFORMS = new Set([
  "aix", "darwin", "freebsd", "linux", "openbsd", "sunos",
]);

const fail = (_path, reason) => assert.fail(
  `AR-2 evidence custody rejected: ${reason}`,
);

const portableRelativePath = (path, { allowRoot = false } = {}) => {
  if (allowRoot && path === ".") {return [];}
  if (typeof path !== "string") {fail("<invalid>", "the path must be a string");}
  if (
    isAbsolute(path) || win32.isAbsolute(path)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)
  ) {fail("<invalid>", "the path must be repository-relative");}
  if (!/^[A-Za-z0-9._/-]+$/u.test(path)) {
    fail("<invalid>", "the path must use unencoded portable separators and ASCII segments");
  }
  const segments = path.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    fail("<invalid>", "the path must not contain empty or dot segments");
  }
  return segments;
};

const asDirectoryPath = root => fileURLToPath(root instanceof URL
  ? new URL(root)
  : pathToFileURL(resolve(root)));

const identity = stats => ({
  ctimeNs: stats.ctimeNs,
  dev: stats.dev,
  ino: stats.ino,
  mode: stats.mode,
  mtimeNs: stats.mtimeNs,
  nlink: stats.nlink,
  size: stats.size,
});

const sameIdentity = (left, right) => Object.keys(left)
  .every(key => left[key] === right[key]);

const containedBy = (parent, child) => {
  const coordinate = relative(parent, child);
  return coordinate !== ".." && !coordinate.startsWith(`..${sep}`) && !isAbsolute(coordinate);
};

const observe = async (path, operation, reason) => {
  try {return await operation();} catch {fail(path, reason);}
};

const inspectLineage = async ({ fileSystem, repositoryPath, segments, targetPath }) => {
  const observations = [];
  const root = await observe(targetPath, () => fileSystem.lstat(repositoryPath, { bigint: true }),
    "the repository root is missing or unreadable");
  if (root.isSymbolicLink() || !root.isDirectory()) {
    fail(targetPath, "the repository root is not a direct directory");
  }
  observations.push(identity(root));
  let currentPath = repositoryPath;
  for (const [index, segment] of segments.entries()) {
    const names = await observe(targetPath, () => fileSystem.readdir(currentPath),
      "an ancestor directory is missing or unreadable");
    const portableIdentity = segment.normalize("NFC").toLowerCase();
    const matches = names.filter(name => name.normalize("NFC").toLowerCase() === portableIdentity);
    if (matches.length !== 1 || matches[0] !== segment) {
      fail(targetPath, "a path segment is missing or has ambiguous identity");
    }
    currentPath = join(currentPath, segment);
    const stats = await observe(targetPath, () => fileSystem.lstat(currentPath, { bigint: true }),
      "a path segment is missing or unreadable");
    if (stats.isSymbolicLink()) {fail(targetPath, "symbolic links are forbidden");}
    const terminal = index === segments.length - 1;
    if (terminal ? !stats.isFile() : !stats.isDirectory()) {
      fail(targetPath, terminal
        ? "the evidence target is not a regular file"
        : "an ancestor is not a directory");
    }
    if (terminal && stats.nlink !== 1n) {
      fail(targetPath, "the evidence target must have exactly one link");
    }
    observations.push(identity(stats));
  }
  return observations;
};

const canonicalCoordinates = async ({ allowedRootPath, fileSystem, path, targetPath }) => {
  const [allowedRoot, target] = await observe(targetPath, () => Promise.all([
    fileSystem.realpath(allowedRootPath), fileSystem.realpath(path),
  ]), "canonical path identity could not be established");
  if (!containedBy(allowedRoot, target)) {
    fail(targetPath, "canonical path escapes its allowed root");
  }
  return { allowedRoot, target };
};

const readBounded = async (path, handle, maxBytes) => {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await observe(path, () => handle.read(buffer, 0, buffer.length, null),
      "the validated evidence descriptor could not be read");
    if (bytesRead === 0) {return Buffer.concat(chunks, total);}
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  fail(path, "the evidence target exceeds its byte budget");
};

export const assertAr2EvidenceCustodyCapability = (
  platform = process.platform,
  fileSystemConstants = constants,
) => {
  const noFollow = fileSystemConstants.O_NOFOLLOW;
  const nonBlock = fileSystemConstants.O_NONBLOCK;
  const readOnly = fileSystemConstants.O_RDONLY;
  if (
    !SUPPORTED_PLATFORMS.has(platform)
    || !Number.isInteger(readOnly) || readOnly < 0
    || !Number.isInteger(noFollow) || noFollow <= 0
    || !Number.isInteger(nonBlock) || nonBlock <= 0
  ) {
    fail("<invalid>", "descriptor-bound no-follow reads are unsupported on this platform");
  }
};

const custodyPlan = (targetPath, options) => {
  const {
    allowedRoot = ".", evidenceRoot, fileSystem = defaultFileSystem,
    maxBytes = DEFAULT_MAX_BYTES,
  } = options;
  const segments = portableRelativePath(targetPath);
  const allowedSegments = portableRelativePath(allowedRoot, { allowRoot: true });
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    fail(targetPath, "the byte budget is invalid");
  }
  if (
    segments.length < allowedSegments.length
    || allowedSegments.some((segment, index) => segments[index] !== segment)
  ) {fail(targetPath, "the lexical path escapes its allowed root");}
  assertAr2EvidenceCustodyCapability();
  const repositoryPath = asDirectoryPath(evidenceRoot ?? new URL("../../", import.meta.url));
  return {
    allowedRootPath: join(repositoryPath, ...allowedSegments), fileSystem, maxBytes,
    openFlags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    path: join(repositoryPath, ...segments), repositoryPath, segments,
  };
};

const assertBoundDescriptor = (targetPath, stats, pathIdentity, maxBytes) => {
  const descriptor = identity(stats);
  if (!stats.isFile() || stats.nlink !== 1n) {
    fail(targetPath, "the opened evidence descriptor is not a singly-linked regular file");
  }
  if (!sameIdentity(descriptor, pathIdentity)) {
    fail(targetPath, "the evidence target changed before descriptor binding");
  }
  if (stats.size > BigInt(maxBytes)) {
    fail(targetPath, "the evidence target exceeds its byte budget");
  }
  return descriptor;
};

const sameLineage = (left, right) => left.length === right.length
  && left.every((entry, index) => sameIdentity(entry, right[index]));

export const readCustodiedRepositoryFile = async (targetPath, options = {}) => {
  const {
    allowedRootPath, fileSystem, maxBytes, openFlags, path, repositoryPath, segments,
  } = custodyPlan(targetPath, options);
  const beforeLineage = await inspectLineage({
    fileSystem, repositoryPath, segments, targetPath,
  });
  const beforeCanonical = await canonicalCoordinates({
    allowedRootPath, fileSystem, path, targetPath,
  });
  let handle;
  try {
    handle = await observe(targetPath, () => fileSystem.open(
      path, openFlags,
    ), "the validated evidence target could not be opened without following links");
    const beforeDescriptorStats = await observe(targetPath,
      () => handle.stat({ bigint: true }), "the evidence descriptor could not be inspected");
    const beforeDescriptor = assertBoundDescriptor(
      targetPath, beforeDescriptorStats, beforeLineage.at(-1), maxBytes,
    );
    const bytes = await readBounded(targetPath, handle, maxBytes);
    const afterDescriptorStats = await observe(targetPath,
      () => handle.stat({ bigint: true }), "the evidence descriptor could not be re-inspected");
    if (
      !afterDescriptorStats.isFile() || afterDescriptorStats.nlink !== 1n
      || !sameIdentity(beforeDescriptor, identity(afterDescriptorStats))
    ) {fail(targetPath, "the evidence descriptor identity drifted during read");}
    const afterLineage = await inspectLineage({
      fileSystem, repositoryPath, segments, targetPath,
    });
    if (!sameLineage(beforeLineage, afterLineage)) {
      fail(targetPath, "the evidence path or an ancestor changed during read");
    }
    const afterCanonical = await canonicalCoordinates({
      allowedRootPath, fileSystem, path, targetPath,
    });
    if (
      beforeCanonical.allowedRoot !== afterCanonical.allowedRoot
      || beforeCanonical.target !== afterCanonical.target
    ) {fail(targetPath, "canonical path identity drifted during read");}
    return bytes;
  } finally {
    if (handle !== undefined) {
      try {await handle.close();} catch {fail(targetPath, "the evidence descriptor could not be closed");}
    }
  }
};
