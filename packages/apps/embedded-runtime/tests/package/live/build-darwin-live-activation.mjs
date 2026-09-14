#!/usr/bin/env node
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {constants} from "node:fs";
import {chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath} from "node:fs/promises";
import {dirname, isAbsolute, join, relative, resolve as resolvePath, sep} from "node:path";
import {fileURLToPath} from "node:url";

import {createDarwinLiveActivationManifest, plainJson} from "./darwin-live-activation-manifest.mjs";
import {validateDarwinNativeRootPacketTemplate} from "../../live/darwin-native-root-packet.mjs";
import {verifyPinnedSource} from "./darwin-live-filesystem-verification.mjs";

const fail = message => {throw new Error(`DARWIN_ACTIVATION_BUILDER: ${message}`);};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const inside = (root, path) => {
  const child = relative(root, path);
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};
const canonicalJson = value => JSON.stringify(value, (_key, item) => {
  if (!item || Array.isArray(item) || typeof item !== "object") {return item;}
  return Object.fromEntries(Object.entries(item).toSorted(([left], [right]) => left.localeCompare(right)));
});
const executeFile = promisify(execFile);

// The pinned-source inventory is built (non-privileged) here, but it is never
// trusted on its own: writePinnedSourceManifest round-trips every entry
// through verifyPinnedSource, the same descriptor-stable no-TOCTOU verifier
// every runtime consumer of this activation uses (darwin-live-verification.mjs
// .verifySourceInventory). That is the single source of truth for "what does
// this tree contain" (finding 7); this walk only produces a candidate for it
// to confirm.
async function walkSourceEntries(root) {
  const entries = [];
  const visit = async (directory, prefix) => {
    const children = (await readdir(directory, {withFileTypes: true})).toSorted((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name, childPath = join(directory, child.name);
      const stat = await lstat(childPath);
      if (child.isDirectory() && !stat.isSymbolicLink()) {
        entries.push({kind: "directory", path: relativePath});
        await visit(childPath, relativePath);
      } else if (child.isFile() && !stat.isSymbolicLink()) {
        if (stat.size > 16 * 1024 * 1024) {fail("source file exceeds verification byte budget");}
        entries.push({kind: "file", path: relativePath, size: stat.size, sha256: sha256(await readFile(childPath))});
      } else {fail("source inventory contains a symlink or special file");}
    }
  };
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) {fail("source root is not canonical");}
  await visit(canonicalRoot, "");
  if (entries.length > 4096) {fail("source inventory exceeds entry budget");}
  return entries;
}

export async function writePinnedSourceManifest(sourceRoot, manifestPath, filesystem) {
  const entries = await walkSourceEntries(sourceRoot);
  const bytes = Buffer.from(`${JSON.stringify({version: 1, entries})}\n`);
  await mkdir(dirname(manifestPath), {recursive: true, mode: 0o700});
  const writer = await open(manifestPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o400);
  try {await writer.writeFile(bytes); await writer.sync();} finally {await writer.close();}
  const inventorySha256 = sha256(bytes);
  const verified = await verifyPinnedSource(
    {source: {manifestPath, inventorySha256}, infrastructure: {filesystem: {sourceRoot}}}, filesystem);
  if (verified !== true) {fail("pinned source manifest failed canonical verification round-trip");}
  return {manifestPath, inventorySha256};
}

// Repository cleanliness must include untracked files, not just modified
// tracked ones: an untracked file under the pinned source root would silently
// ride along in walkSourceEntries as part of "the exact source revision"
// without ever having been reviewed or committed (finding 4, source half).
async function verifyRepository(path, revision) {
  const root = await realpath(path);
  if (root !== path || !/^[a-f0-9]{40}$/u.test(revision)) {fail("repository identity is invalid");}
  const [{stdout: head}, {stdout: status}] = await Promise.all([
    executeFile("/usr/bin/git", ["-C", root, "rev-parse", "HEAD"], {env: {PATH: "/usr/bin:/bin"}}),
    executeFile("/usr/bin/git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], {env: {PATH: "/usr/bin:/bin"}}),
  ]);
  if (head.trim() !== revision || status.trim()) {
    fail("repository is not the clean exact source revision (tracked or untracked changes present)");
  }
}

const validateFileInput = entry => {
  if (typeof entry?.role !== "string" || !entry.role || !isAbsolute(entry.sourcePath ?? "") ||
      typeof entry.relativePath !== "string" || !entry.relativePath || isAbsolute(entry.relativePath) ||
      resolvePath("/", entry.relativePath).includes("/../") || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "") ||
      typeof entry.executable !== "boolean") {fail("invalid staged file identity");}
};

async function copyPinnedFile(root, entry) {
  validateFileInput(entry);
  const source = await realpath(entry.sourcePath), stat = await lstat(entry.sourcePath);
  if (source !== entry.sourcePath || !stat.isFile() || stat.isSymbolicLink() ||
      sha256(await readFile(source)) !== entry.sha256) {fail(`source file differs for role ${entry.role}`);}
  const target = resolvePath(root, entry.relativePath);
  if (!inside(root, target)) {fail("staged file escapes activation root");}
  await mkdir(dirname(target), {recursive: true, mode: 0o700});
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await chmod(target, entry.executable ? 0o500 : 0o400);
  return Object.freeze({role: entry.role, path: target, sha256: entry.sha256});
}

const role = (files, name) => {
  const matches = files.filter(entry => entry.role === name);
  if (matches.length !== 1) {fail(`closure role ${name} must occur exactly once`);}
  return matches[0];
};

/** Materializes only caller-pinned, non-secret bytes into a fresh disposable root. */
// oxlint-disable-next-line complexity -- validates the complete one-shot activation boundary before copying any bytes
export async function buildDarwinLiveActivation(rawSpec, dependencies = {}) {
  const spec = plainJson(rawSpec);
  if (spec.version !== 1 || !isAbsolute(spec.activationRoot ?? "") ||
      !isAbsolute(spec.repositoryPath ?? "") || !Array.isArray(spec.files) || spec.files.length === 0 ||
      !/^[a-f0-9]{40}$/u.test(spec.manifest?.sourceRevision ?? "") ||
      !/^[a-f0-9]{40}$/u.test(spec.manifest?.consumerStandardRevision ?? "")) {fail("invalid v1 build specification");}
  await (dependencies.verifyRepository ?? verifyRepository)(spec.repositoryPath, spec.manifest.sourceRevision);
  const source = spec.manifest.source;
  if (!isAbsolute(source?.rootPath ?? "") || source.rootPath !== spec.manifest.infrastructure?.filesystem?.sourceRoot) {
    fail("source identity is incomplete");
  }
  const root = resolvePath(spec.activationRoot);
  if (root !== spec.activationRoot || root === "/") {fail("activation root must be canonical and bounded");}
  // A pre-existing nonempty root could already carry attacker- or
  // previous-run-controlled files that this build never accounts for and a
  // later seal would then immutabilize as if they were part of the closure
  // (finding 5a). Distinguish "already exists" from other mkdir failures so a
  // pre-existing *empty* root (e.g. created by the caller's own tooling) is
  // still accepted, but any pre-existing content is refused explicitly.
  try {await mkdir(root, {mode: 0o700});}
  catch (error) {if (error.code !== "EEXIST") {throw error;}}
  if (await realpath(root) !== root) {fail("activation root is not canonical");}
  if ((await readdir(root)).length !== 0) {fail("activation root is not empty");}

  const files = [];
  for (const entry of spec.files) {files.push(await copyPinnedFile(root, entry));}
  if (new Set(files.map(entry => entry.role)).size !== files.length ||
      new Set(files.map(entry => entry.path)).size !== files.length) {fail("duplicate closure role or path");}

  const runner = role(files, "runner"), launcher = role(files, "root-launcher");
  const codex = role(files, "codex"), runtimeRoot = role(files, "runtime-root-config");
  const paBootstrap = role(files, "pa-bootstrap"), infrastructure = role(files, "darwin-infrastructure");
  role(files, "pa-artifact-manifest"); role(files, "filesystem-verification"); role(files, "activation-builder");
  const owner = role(files, "native-owner"), node = role(files, "node");
  const fixedImageRoles = ["native-owner", "sandbox-exec", "codex", "node", "seatbelt-profile", "host-entrypoint", "host-peer-addon"];
  const native = {...spec.manifest.native, rootLauncherPath: launcher.path, ownerPath: owner.path, nodePath: node.path,
    packet: {...spec.manifest.native.packet, images: spec.manifest.native.packet.images.map((image, index) => {
      const expectedRole = fixedImageRoles[index] ?? `native-loader-${index}`;
      if (image.role !== expectedRole) {fail(`native image slot ${index} must use role ${expectedRole}`);}
      const file = role(files, expectedRole);
      return {path: file.path, sha256: file.sha256};
    })}};
  validateDarwinNativeRootPacketTemplate(native.packet);

  // Every pinned JS entrypoint must reach the closure's own pinned node
  // binary, never the ambient interpreter that happened to invoke it: an
  // ambient-execPath re-spawn is unbound from this exact sealed closure
  // (finding 4, runner half; the literal `process` `.` `execPath` token is
  // split across words here so this explanatory comment does not itself trip
  // the scan below when this file is pinned as the "activation-builder"
  // role). This is a static source scan of what is about to be sealed, not a
  // runtime behavioral guarantee of the pinned files themselves.
  // The set of original (pre-rename) source basenames every pinned .mjs/.js
  // role could plausibly import by a bare `./name.mjs` local specifier.
  const pinnedSourceBasenames = new Set(spec.files.map(entry => entry.sourcePath.split("/").at(-1)));
  for (const entry of files) {
    if (!entry.path.endsWith(".mjs") && !entry.path.endsWith(".js")) {continue;}
    const text = await readFile(entry.path, "utf8");
    if (/\bprocess\s*\.\s*execPath\b/u.test(text)) {fail(`role ${entry.role} references the ambient interpreter's own exec path`);}
    // Every local import the pinned source file makes must resolve to a
    // basename this closure also pins. A local import to a file that never
    // got staged would silently break at E2E time; catch it here instead
    // (finding 3).
    for (const specifier of text.matchAll(/from\s+["']\.\/([\w.-]+\.m?js)["']/gu)) {
      if (!pinnedSourceBasenames.has(specifier[1])) {
        fail(`role ${entry.role} imports "./${specifier[1]}", which is not part of this closure`);
      }
    }
  }

  const activationPath = join(dirname(launcher.path), "activation.json");
  if (dirname(runner.path) !== dirname(launcher.path)) {fail("runner and root launcher must share the activation directory");}

  const sourceManifestPath = join(root, "source-manifest.json");
  const pinnedSource = await (dependencies.writePinnedSourceManifest ?? writePinnedSourceManifest)(
    source.rootPath, sourceManifestPath, dependencies.filesystem);

  const generated = await createDarwinLiveActivationManifest({...spec.manifest,
    closure: files, codexPath: codex.path, codexSha256: codex.sha256, native,
    runtimeRootModulePath: runtimeRoot.path, paRuntimeModulePath: paBootstrap.path,
    infrastructureModulePath: infrastructure.path,
    source: {rootPath: source.rootPath, manifestPath: pinnedSource.manifestPath, inventorySha256: pinnedSource.inventorySha256}});
  const manifest = Object.freeze({...generated, activationRoot: root});
  const writer = await open(activationPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o400);
  try {await writer.writeFile(`${canonicalJson(manifest)}\n`); await writer.sync();}
  finally {await writer.close();}
  const directory = await open(dirname(activationPath), constants.O_RDONLY | constants.O_DIRECTORY);
  try {await directory.sync();} finally {await directory.close();}

  // Every path a later seal is allowed to mutate, bound here in the build's
  // own return value rather than left for the seal step to trust solely from
  // re-reading activation.json off disk (finding 1).
  const sealFiles = [
    {path: activationPath, sha256: sha256(await readFile(activationPath))},
    {path: sourceManifestPath, sha256: sha256(await readFile(sourceManifestPath))},
    ...files.map(entry => ({path: entry.path, sha256: entry.sha256})),
  ];
  return Object.freeze({activationPath, activationRoot: root, runnerPath: runner.path,
    manifestSha256: sealFiles[0].sha256, sealFiles: Object.freeze(sealFiles.map(Object.freeze))});
}

const openRegularNoFollow = async path => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = await handle.stat();
  if (!stat.isFile()) {await handle.close(); fail(`seal target ${path} is not a regular file`);}
  return {handle, stat};
};

/**
 * Builds the exact set of privileged mutations a seal is allowed to perform.
 * `expectedRoot`/`expectedFiles` must come from the caller's own trusted
 * record of what build() returned (e.g. the operator's sudo invocation is
 * itself given the exact root/file list as arguments) -- never solely from
 * re-reading activation.json, which is owned by the non-root build step and
 * could have been replaced by anything with write access to that step's
 * output between build and seal (finding 1, the P0 TOCTOU).
 */
// oxlint-disable-next-line complexity -- every branch is a distinct fail-closed check guarding the P0 TOCTOU fix; splitting it would obscure which check is which
export async function createDarwinActivationSealPlan(activationPath, expectedRoot, expectedFiles) {
  if (!isAbsolute(expectedRoot ?? "") || !Array.isArray(expectedFiles) || expectedFiles.length === 0) {
    fail("seal requires an explicit caller-supplied expected root and file list");
  }
  const expected = new Map(expectedFiles.map(entry => [entry.path, entry.sha256]));
  if (expected.size !== expectedFiles.length || [...expected.keys()].some(path => !isAbsolute(path) || (path !== activationPath && !inside(expectedRoot, path)))) {
    fail("expected seal file list is malformed");
  }
  const root = await realpath(expectedRoot);
  if (root !== expectedRoot) {fail("expected activation root is not canonical");}
  const path = await realpath(activationPath);
  if (path !== activationPath || !inside(root, path)) {fail("activation path differs from the expected root");}

  const {handle: activationHandle} = await openRegularNoFollow(path);
  let activationBytes, activation;
  try {activationBytes = await activationHandle.readFile(); activation = JSON.parse(activationBytes);}
  finally {await activationHandle.close();}
  // Cross-check the file's own claims against the caller-supplied expectation
  // instead of trusting either source alone.
  if (activation.activationRoot !== root || path !== join(dirname(activation.native?.rootLauncherPath ?? ""), "activation.json")) {
    fail("activation content differs from the expected root");
  }
  if (!/^[a-f0-9]{64}$/u.test(activation.source?.inventorySha256 ?? "") || typeof activation.source?.manifestPath !== "string") {
    fail("activation source manifest identity is missing");
  }
  const claimed = new Map([[path, sha256(activationBytes)],
    [activation.source.manifestPath, activation.source.inventorySha256],
    ...(activation.files ?? []).map(entry => [entry.path, entry.sha256])]);
  if (claimed.size !== expected.size || [...expected].some(([itemPath, itemHash]) => claimed.get(itemPath) !== itemHash)) {
    fail("activation content differs from the expected caller-supplied closure");
  }

  const files = [];
  for (const item of [...expected.keys()].toSorted()) {
    const {handle, stat} = await openRegularNoFollow(item);
    try {
      if (item !== path) {
        const bytes = await handle.readFile();
        if (sha256(bytes) !== expected.get(item)) {fail(`seal target ${item} hash differs`);}
      }
      files.push(Object.freeze({path: item, mode: stat.mode & 0o111 ? 0o555 : 0o444}));
    } finally {await handle.close();}
  }

  // Refuse to seal a root that contains anything the caller did not expect:
  // an unmanifested file would silently ride along as if it were part of the
  // reviewed closure (finding 5b).
  const onDisk = new Set();
  const walk = async directory => {
    for (const child of await readdir(directory, {withFileTypes: true})) {
      const childPath = join(directory, child.name);
      if (child.isSymbolicLink()) {fail(`seal root contains a symlink at ${childPath}`);}
      if (child.isDirectory()) {await walk(childPath);} else {onDisk.add(childPath);}
    }
  };
  await walk(root);
  const manifested = new Set(expected.keys());
  for (const item of onDisk) {if (!manifested.has(item)) {fail(`seal root contains an unmanifested file at ${item}`);}}
  if (onDisk.size !== manifested.size) {fail("seal root is missing a manifested file");}

  const directories = [...new Set(files.flatMap(file => {
    const result = [];
    for (let current = dirname(file.path); inside(root, current); current = dirname(current)) {result.push(current);}
    return result;
  }).concat(root))].toSorted((left, right) => right.length - left.length);
  return Object.freeze({root, files: Object.freeze(files), directories: Object.freeze(directories)});
}

async function readImmutableFlags(path, execute) {
  const {stdout} = await execute("/usr/bin/stat", ["-f", "%p %u %g %Sf", path], {env: {PATH: "/usr/bin:/bin"}});
  const [mode, uid, gid, flags] = stdout.trim().split(/\s+/u);
  return {mode: Number.parseInt(mode, 8) & 0o7777, uid: Number(uid), gid: Number(gid),
    immutable: /(^|,)\s*(uchg|schg)(,|$)/u.test(flags ?? "")};
}

// fchown(2)/fchmod(2) on a handle already opened O_NOFOLLOW bind the mutation
// to the exact inode that was verified, closing the residual TOCTOU window a
// path-based chown/chmod call would reopen between createDarwinActivationSealPlan's
// verification and the actual privileged mutation (finding 1, the remaining
// half of the P0: every privileged mutation gets its own no-follow check
// immediately before it, not one shared verification earlier).
async function mutateOwnedNoFollow(path, mode, isDirectory, setOwner, setMode) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (isDirectory ? constants.O_DIRECTORY : constants.O_NONBLOCK));
  try {
    const stat = await handle.stat();
    if (isDirectory ? !stat.isDirectory() : !stat.isFile()) {fail(`seal target ${path} changed type before mutation`);}
    await setOwner(handle, 0, 0);
    await setMode(handle, mode);
  } finally {await handle.close();}
}

/**
 * Seals the plan and then independently reads every path back (mode, owner,
 * immutable flag) to attest the mutation actually landed exactly as intended,
 * rather than trusting that the chown/chmod/chflags calls themselves did not
 * fail silently partway through (finding 2). Returns `sealed: false` with the
 * partial attestation on any mismatch instead of throwing after mutations
 * have already been applied, since a caller must be able to detect and react
 * to a partially-sealed root rather than lose that information to an
 * exception.
 */
export async function sealDarwinLiveActivation(activationPath, expectedRoot, expectedFiles, dependencies = {}) {
  if ((dependencies.getuid ?? process.getuid)?.() !== 0) {fail("root execution is required for sealing");}
  const plan = await createDarwinActivationSealPlan(activationPath, expectedRoot, expectedFiles);
  const setOwner = dependencies.chown ?? ((handle, uid, gid) => handle.chown(uid, gid));
  const setMode = dependencies.chmod ?? ((handle, mode) => handle.chmod(mode));
  const execute = dependencies.execFile ?? executeFile;
  for (const file of plan.files) {await mutateOwnedNoFollow(file.path, file.mode, false, setOwner, setMode);}
  for (const directory of plan.directories) {await mutateOwnedNoFollow(directory, 0o555, true, setOwner, setMode);}
  await execute("/usr/bin/chflags", ["uchg", ...plan.files.map(file => file.path), ...plan.directories],
    {env: {PATH: "/usr/bin:/bin"}});

  const readFlags = dependencies.readImmutableFlags ?? (path => readImmutableFlags(path, execute));
  const attestation = [];
  let sealed = true;
  for (const file of [...plan.files, ...plan.directories.map(path => ({path, mode: 0o555}))]) {
    const observed = await readFlags(file.path);
    const ok = observed.mode === file.mode && observed.uid === 0 && observed.gid === 0 && observed.immutable === true;
    if (!ok) {sealed = false;}
    attestation.push(Object.freeze({path: file.path, expectedMode: file.mode, ...observed, ok}));
  }
  return Object.freeze({...plan, sealed, attestation: Object.freeze(attestation)});
}

async function main(argv = process.argv.slice(2)) {
  const [mode, path, expectedRootArg, expectedFilesPath] = argv;
  if (mode === "--build") {
    if (!isAbsolute(path ?? "") || argv.length !== 2) {fail("expected --build SPEC.json");}
    const spec = JSON.parse(await readFile(path, "utf8"));
    const result = await buildDarwinLiveActivation(spec);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (mode === "--seal") {
    if (!isAbsolute(path ?? "") || !isAbsolute(expectedRootArg ?? "") || !isAbsolute(expectedFilesPath ?? "") || argv.length !== 4) {
      fail("expected --seal activation.json EXPECTED_ROOT EXPECTED_FILES.json (the operator's own record of build()'s return value)");
    }
    const expectedFiles = JSON.parse(await readFile(expectedFilesPath, "utf8"));
    process.stdout.write(`${JSON.stringify(await sealDarwinLiveActivation(path, expectedRootArg, expectedFiles))}\n`);
  } else {fail("unknown mode");}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {await main();}
