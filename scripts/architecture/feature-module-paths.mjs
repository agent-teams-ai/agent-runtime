import { lstat, opendir, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, parse, posix, relative, resolve, win32 } from "node:path";

export const FILESYSTEM_IDENTITY_CODE = "FM_FILESYSTEM_IDENTITY";

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const separators = (value) => String(value).replaceAll("\\", "/");
// Upper-then-lower is a bounded, locale-independent approximation of Unicode
// case folding. It catches multi-code-point and final-form aliases that a
// single lower-case conversion misses while NFC keeps canonically equivalent
// spellings in one identity bucket.
const folded = (value) => value.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
const hasControlCharacter = (value) => [...value].some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 0x1F
    || codePoint >= 0x7F && codePoint <= 0x9F
    || codePoint === 0x61C
    || codePoint === 0x200E
    || codePoint === 0x200F
    || codePoint === 0x2028
    || codePoint === 0x2029
    || codePoint >= 0x202A && codePoint <= 0x202E
    || codePoint >= 0x2066 && codePoint <= 0x2069;
});
const windowsDeviceName = (segment) => /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment);
const unsafeSegment = (segment) => !segment
  || segment === "."
  || segment === ".."
  || segment !== segment.normalize("NFC")
  || segment !== segment.trim()
  || hasControlCharacter(segment)
  || /[<>:"/\\|?*]/u.test(segment)
  || /[. ]$/u.test(segment)
  || windowsDeviceName(segment);

const absoluteOnAnyHost = (value) => {
  const normalized = separators(value);
  return isAbsolute(normalized)
    || win32.isAbsolute(String(value))
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.startsWith("//");
};

export const portableRepositoryPath = (value, { canonical = true } = {}) => {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") || absoluteOnAnyHost(value)) {return;}
  const normalized = separators(value);
  if (canonical && normalized !== value) {return;}
  const segments = normalized.split("/");
  if (segments.some(unsafeSegment)) {return;}
  return segments.join("/");
};

const identityMessage = "filesystem path must have one canonical, non-symlinked, repository-contained identity";
export const filesystemIdentityIssue = (issue, path) => issue(FILESYSTEM_IDENTITY_CODE, path, 1, identityMessage);

const invalidRootSpelling = (value) => {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") || value !== value.trim() || value.includes("\0")) {return true;}
  if (value === ".") {return false;}
  let normalized = separators(value);
  const driveAbsolute = /^[A-Za-z]:\//u.test(normalized), driveQualified = /^[A-Za-z]:/u.test(normalized);
  // UNC/device paths are deliberately unsupported. A POSIX host must not
  // reinterpret a literal backslash as a filename character, and a Windows
  // host must not resolve a drive-relative or current-drive-rooted spelling.
  if (normalized.startsWith("//")) {return true;}
  if (process.platform === "win32") {
    if (normalized.startsWith("/") || driveQualified && !driveAbsolute) {return true;}
  } else if (value.includes("\\") || driveQualified) {return true;}
  if (/^[A-Za-z]:\//u.test(normalized)) {normalized = normalized.slice(3);}
  else if (normalized.startsWith("/")) {normalized = normalized.slice(1);}
  else if (normalized.startsWith("./")) {normalized = normalized.slice(2);}
  const segments = normalized ? normalized.split("/") : [];
  return segments.some(unsafeSegment);
};

const ambiguousRootSegments = async (absolutePath) => {
  const rootPath = parse(absolutePath).root;
  const segments = separators(relative(rootPath, absolutePath)).split("/").filter(Boolean);
  let current = rootPath;
  for (const segment of segments) {
    const aliases = (await readdir(current)).filter((name) => folded(name) === folded(segment));
    if (aliases.length !== 1 || aliases[0] !== segment) {return true;}
    current = join(current, segment);
  }
  return false;
};

export const canonicalRoot = async (value) => {
  if (invalidRootSpelling(value)) {return { ok: false };}
  try {
    const absolutePath = resolve(value);
    if (await ambiguousRootSegments(absolutePath)) {return { ok: false };}
    const canonicalPath = await realpath(absolutePath);
    if (invalidRootSpelling(canonicalPath) || await ambiguousRootSegments(canonicalPath)) {return { ok: false };}
    const metadata = await stat(canonicalPath);
    if (!metadata.isDirectory()) {return { ok: false };}
    return { ok: true, absolutePath, canonicalPath, dev: metadata.dev, ino: metadata.ino };
  } catch {return { ok: false };}
};

export const sameFilesystemIdentity = (left, right) => Boolean(
  left?.ok && right?.ok && left.dev === right.dev && left.ino === right.ino
);

export const repositoryPath = (root, absolutePath) => separators(relative(root.canonicalPath, absolutePath));
const isContained = (root, absolutePath) => {
  const candidate = relative(root.canonicalPath, absolutePath);
  return candidate === "" || candidate !== ".." && !candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(candidate);
};

const matchingEntry = async (directory, segment) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const aliases = entries.filter((entry) => folded(entry.name) === folded(segment));
  if (aliases.length > 1) {return { ambiguous: true };}
  const exact = entries.find((entry) => entry.name === segment);
  if (exact) {return { entry: exact };}
  return aliases.length ? { ambiguous: true } : { missing: true };
};

export const inspectRepositoryPath = async (root, value, { kind = "file", optional = false } = {}) => {
  const path = portableRepositoryPath(value);
  if (!root?.ok || !path) {return { ok: false, path: path ?? "<path>", identity: true };}
  let current = root.canonicalPath;
  try {
    for (const segment of path.split("/")) {
      const matched = await matchingEntry(current, segment);
      if (matched.ambiguous) {return { ok: false, path, identity: true };}
      if (matched.missing) {return { ok: false, path, missing: true, optional };}
      if (unsafeSegment(matched.entry.name)) {return { ok: false, path, identity: true };}
      current = join(current, matched.entry.name);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {return { ok: false, path, identity: true };}
    }
    const canonicalPath = await realpath(current);
    if (!isContained(root, canonicalPath) || repositoryPath(root, canonicalPath) !== path) {
      return { ok: false, path, identity: true };
    }
    const metadata = await stat(canonicalPath);
    const validKind = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
    return validKind ? { ok: true, path, absolutePath: canonicalPath, metadata } : { ok: false, path, identity: true };
  } catch (error) {
    if (error?.code === "ENOENT") {return { ok: false, path, missing: true, optional };}
    return { ok: false, path, identity: true };
  }
};

const recordCollisionIssues = (entries, directoryPath, context) => {
  const seen = new Map();
  for (const entry of entries) {
    const key = folded(entry.name);
    const previous = seen.get(key);
    if (previous && previous !== entry.name) {
      recordIssue(context, filesystemIdentityIssue(context.issue, posix.join(directoryPath, entry.name)));
    } else {seen.set(key, entry.name);}
  }
};

const recordIssue = (context, entry) => {
  if (context.issues.length < context.maxIssues) {context.issues.push(entry);}
  else {context.overflow = true;}
};

const readDirectoryEntries = async (context, absoluteDirectory) => {
  const entries = [], remaining = context.maxEntries - context.budget.entries;
  if (remaining <= 0) {context.overflow = true; return entries;}
  const directory = await opendir(absoluteDirectory);
  for await (const entry of directory) {
    if (entries.length >= remaining) {context.overflow = true; break;}
    entries.push(entry);
  }
  context.budget.entries += entries.length;
  return entries;
};

const exceedsFileBudget = (context, metadata) => metadata.size > context.maxFileBytes
  || context.budget.files >= context.maxFiles
  || context.budget.sourceBytes + metadata.size > context.maxSourceBytes;

const scanDirectory = async (context, absoluteDirectory, directoryPath, depth = 0) => {
  if (context.overflow) {return;}
  let entries;
  try {entries = await readDirectoryEntries(context, absoluteDirectory);}
  catch {recordIssue(context, filesystemIdentityIssue(context.issue, directoryPath)); return;}
  if (context.overflow) {return;}
  entries.sort((left, right) => compareText(left.name, right.name));
  recordCollisionIssues(entries, directoryPath, context);
  for (const entry of entries) {
    if (context.overflow) {break;}
    const path = posix.join(directoryPath, entry.name), absolutePath = join(absoluteDirectory, entry.name);
    if (context.excludedDirectories.has(entry.name)) {continue;}
    if (unsafeSegment(entry.name)) {recordIssue(context, filesystemIdentityIssue(context.issue, path)); continue;}
    let metadata;
    try {metadata = await lstat(absolutePath);}
    catch {recordIssue(context, filesystemIdentityIssue(context.issue, path)); continue;}
    if (metadata.isSymbolicLink()) {recordIssue(context, filesystemIdentityIssue(context.issue, path)); continue;}
    if (metadata.isDirectory()) {
      if (depth >= context.maxDepth) {context.overflow = true; break;}
      await scanDirectory(context, absolutePath, path, depth + 1); continue;
    }
    if (!metadata.isFile()) {
      if (context.extensions.has(extname(entry.name))) {recordIssue(context, filesystemIdentityIssue(context.issue, path));}
      continue;
    }
    if (!context.extensions.has(extname(entry.name))) {continue;}
    if (exceedsFileBudget(context, metadata)) {
      context.overflow = true; break;
    }
    const identity = `${metadata.dev}:${metadata.ino}`, previous = context.identities.get(identity);
    if (previous && previous !== path) {recordIssue(context, filesystemIdentityIssue(context.issue, path)); continue;}
    context.identities.set(identity, path);
    context.budget.files += 1;
    context.budget.sourceBytes += metadata.size;
    context.files.push(absolutePath);
  }
};

export const inventoryRepositoryFiles = async ({ root, startPath, extensions, issue, optional = false, excludedDirectories = new Set(), identities = new Map(), budget = { entries: 0, files: 0, sourceBytes: 0 }, maxEntries = Number.POSITIVE_INFINITY, maxDepth = Number.POSITIVE_INFINITY, maxFiles = Number.POSITIVE_INFINITY, maxFileBytes = Number.POSITIVE_INFINITY, maxSourceBytes = Number.POSITIVE_INFINITY, maxIssues = Number.POSITIVE_INFINITY }) => {
  const inspected = startPath === ""
    ? { ok: true, absolutePath: root.canonicalPath, path: "" }
    : await inspectRepositoryPath(root, startPath, { kind: "directory", optional });
  if (!inspected.ok) {
    if (inspected.missing && optional) {return { files: [], issues: [] };}
    return { files: [], issues: [filesystemIdentityIssue(issue, inspected.path)] };
  }
  budget.entries ??= 0;
  const context = { extensions, issue, files: [], issues: [], identities, budget, excludedDirectories, maxEntries, maxDepth, maxFiles, maxFileBytes, maxSourceBytes, maxIssues, overflow: false };
  await scanDirectory(context, inspected.absolutePath, inspected.path);
  return { files: context.files, issues: context.issues, overflow: context.overflow };
};

const sourcePath = (value) => value
  .replace(/\.mjs$/u, ".mts")
  .replace(/\.cjs$/u, ".cts")
  .replace(/\.jsx$/u, ".tsx")
  .replace(/\.js$/u, ".ts");

export const createPathIndex = (paths) => {
  const exact = new Set(paths), aliases = new Map();
  for (const path of exact) {
    const key = folded(path), entries = aliases.get(key) ?? [];
    entries.push(path); aliases.set(key, entries);
  }
  return { exact, aliases };
};

const indexedPath = (path, index, { requireExisting = true } = {}) => {
  const canonical = portableRepositoryPath(path);
  if (!canonical || canonical !== path) {return { ok: false, identity: true };}
  const candidates = [...new Set([path, sourcePath(path)])], matches = [];
  for (const candidate of candidates) {
    const aliases = index?.aliases.get(folded(candidate)) ?? [];
    if (aliases.length && (aliases.length !== 1 || aliases[0] !== candidate)) {return { ok: false, identity: true };}
    if (index?.exact.has(candidate)) {matches.push(candidate);}
  }
  if (matches.length > 1) {return { ok: false, identity: true };}
  if (matches.length === 1) {return { ok: true, path: matches[0] };}
  return requireExisting ? { ok: false, missing: true } : { ok: true, path: sourcePath(path) };
};

export const resolveRelativeSpecifier = (fromPath, specifier, index) => {
  const source = portableRepositoryPath(fromPath);
  if (!source || typeof specifier !== "string" || specifier !== specifier.normalize("NFC") || specifier.includes("\0")) {
    return { kind: "invalid", identity: true };
  }
  const normalized = separators(specifier);
  if (absoluteOnAnyHost(specifier) || /^file:/iu.test(normalized)) {return { kind: "invalid", identity: true };}
  if (!(normalized.startsWith("./") || normalized.startsWith("../"))) {
    return normalized === specifier ? { kind: "external" } : { kind: "invalid", identity: true };
  }
  const target = posix.normalize(posix.join(posix.dirname(source), normalized));
  if (target === ".." || target.startsWith("../") || absoluteOnAnyHost(target)) {return { kind: "invalid", identity: true };}
  const canonicalTarget = portableRepositoryPath(target);
  if (!canonicalTarget || canonicalTarget !== target) {return { kind: "invalid", identity: true };}
  const indexed = indexedPath(canonicalTarget, index, { requireExisting: true });
  if (indexed.ok) {return { kind: "local", path: indexed.path };}
  // Package tests may name emitted dist paths. The owning-package resolver
  // translates only this explicit build-output shape to its source root and
  // performs the same strict indexed lookup after translation.
  if (indexed.missing && (canonicalTarget.startsWith("dist/") || canonicalTarget.includes("/dist/"))) {
    return { kind: "local", path: sourcePath(canonicalTarget), deferredBuildOutput: true };
  }
  return { kind: "invalid", identity: true, missing: true, path: sourcePath(canonicalTarget) };
};

export const resolveIndexedPath = (value, index, options) => indexedPath(value, index, options);
