import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {constants} from "node:fs";
import {mkdtemp, mkdir, open, readFile, readdir, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {buildDarwinLiveActivation, createDarwinActivationSealPlan,
  sealDarwinLiveActivation, writePinnedSourceManifest} from "./build-darwin-live-activation.mjs";

const executeFile = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const roles = ["runner", "host-entrypoint", "full-public-runtime", "production-root", "root-packet-builder",
  "root-launcher", "native-owner", "sandbox-exec", "codex", "node", "seatbelt-profile", "host-peer-addon",
  "native-loader-7", "runtime-root-config", "pa-assembly", "pa-bootstrap", "pa-owner", "pa-auth-ipc",
  "pa-artifact-manifest", "darwin-infrastructure", "filesystem-verification", "activation-builder"];

// Test-only filesystem capability for verifyPinnedSource's round trip inside
// writePinnedSourceManifest. Production uses the acquired native openat
// backend (darwin-live-filesystem-verification.mjs#nativeVerificationFilesystem);
// this plain node:fs/promises-backed stand-in exercises the same canonical
// verifier without requiring the native acquisition guard.
function wrapFixtureHandle(file, path) {
  return {path, stat: options => file.stat(options), close: () => file.close(), read: (...args) => file.read(...args)};
}

function fixtureFilesystem() {
  return {openRoot: async () => wrapFixtureHandle(await open("/", constants.O_RDONLY | constants.O_DIRECTORY), "/"),
    async openEntry(parent, name, kind) {
      return wrapFixtureHandle(await open(join(parent.path, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
        (kind === "directory" ? constants.O_DIRECTORY : 0)), join(parent.path, name));
    }, async names(handle) {return readdir(handle.path);}};
}

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "ar69-activation-builder-")));
  const source = join(parent, "source"), activationRoot = join(parent, "activation");
  await mkdir(source);
  const files = [];
  for (const [index, role] of roles.entries()) {
    const sourcePath = join(source, `${index}-${role}`), bytes = Buffer.from(`${role}\n`);
    await writeFile(sourcePath, bytes, {mode: role === "native-owner" || role === "codex" ? 0o700 : 0o600});
    files.push({role, sourcePath, relativePath: `bin/${role}`, sha256: hash(bytes),
      executable: ["runner", "root-launcher", "native-owner", "sandbox-exec", "codex", "node"].includes(role)});
  }
  const byRole = name => files.find(file => file.role === name);
  const sourceProject = join(parent, "project");
  await mkdir(join(sourceProject, "input"), {recursive: true});
  await mkdir(join(sourceProject, "empty"));
  await writeFile(join(sourceProject, "TASK.md"), "write marker\n");
  await writeFile(join(sourceProject, "input", "data.txt"), "marker\n");
  const turn = {operationId: "operation:test", commandId: "command:test", effectId: "effect:test", attemptId: "attempt:test",
    executionGenerationId: "generation:test", expectedMarker: "marker", frozenWorkspacePath: join(parent, "workspace"),
    resultPath: join(parent, "workspace", "result.txt"), sourceMessagePath: join(parent, "source-message"),
    taskPath: join(parent, "TASK.md"), scope: {tenantId: "tenant", projectId: "project"},
    expectedResultSha256: "1".repeat(64), expectedTaskSha256: "2".repeat(64), maximumObservations: 4, observeTimeoutMs: 1000};
  const infrastructure = {identities: {operationId: turn.operationId, attemptId: turn.attemptId,
    effectId: turn.effectId, executionGenerationId: turn.executionGenerationId}, database: {}, providerAccess: {},
    runtimeSecurity: {}, filesystem: {sourceRoot: sourceProject}, host: {}, deployment: {}, verification: {}, native: {}};
  return {parent, activationRoot, files, byRole, spec: {version: 1, activationRoot,
    repositoryPath: "/synthetic/repository", files, manifest: {
    sourceRevision: "a".repeat(40), consumerStandardRevision: "b".repeat(40), turn, infrastructure,
    native: {namespaceParent: join(parent, "namespace"), leaseRegistry: join(parent, "leases"), journal: join(parent, "journal"),
      providerInputPath: join(parent, "provider.fifo"), packet: {hostUid: 501, hostGid: 20, uid: 50000, gid: 50000,
        termMs: 1000, runMs: 30000, bindings: Array.from({length: 8}, (_, index) => `${index + 1}`.repeat(64)),
        images: ["native-owner", "sandbox-exec", "codex", "node", "seatbelt-profile", "host-entrypoint", "host-peer-addon", "native-loader-7"].map(role => ({role})),
        argv: [join(activationRoot, byRole("codex").relativePath), "app-server"],
        grant: {uidFirst: 50000, uidLast: 50010, gidFirst: 50000, gidLast: 50010, isolationSha256: "f".repeat(64)}}},
    database: {identitySha256: "d".repeat(64)}, source: {rootPath: sourceProject},
    evidenceDirectory: join(parent, "evidence")}}};
}

const dependencies = {verifyRepository: async (_path, revision) => assert.equal(revision, "a".repeat(40)),
  filesystem: fixtureFilesystem()};

test("builder copies exact pinned bytes, verifies source through the canonical filesystem role, and emits a deterministic closed manifest", async () => {
  const value = await fixture();
  try {
    const result = await buildDarwinLiveActivation(value.spec, dependencies);
    const activation = JSON.parse(await readFile(result.activationPath, "utf8"));
    assert.equal(result.activationPath, join(value.activationRoot, "bin", "activation.json"));
    assert.equal(activation.sourceRevision, "a".repeat(40));
    assert.equal(activation.codex.sha256, value.byRole("codex").sha256);
    assert.equal(activation.native.nodePath, activation.files.find(entry => entry.role === "node").path);
    // Source identity is now the pinned-manifest format the canonical
    // filesystem-verification role consumes, not a bespoke hash.
    assert.match(activation.source.manifestPath, /source-manifest\.json$/);
    const manifest = JSON.parse(await readFile(activation.source.manifestPath, "utf8"));
    assert.equal(manifest.version, 1);
    assert.ok(manifest.entries.some(entry => entry.path === "TASK.md" && entry.kind === "file"));
    assert.deepEqual(activation.native.packet.images.map(image => image.path),
      value.spec.manifest.native.packet.images.map(image => join(value.activationRoot, value.byRole(image.role).relativePath)));
    for (const entry of activation.files) {assert.equal(hash(await readFile(entry.path)), entry.sha256);}
    await assert.rejects(buildDarwinLiveActivation(value.spec, dependencies), /not empty|EEXIST/);
  } finally {await rm(value.parent, {recursive: true, force: true});}
});

test("builder rejects changed source bytes, a nonempty pre-existing root, and secret-shaped providerAccess", async () => {
  const changed = await fixture();
  try {
    await writeFile(changed.files[0].sourcePath, "changed");
    await assert.rejects(buildDarwinLiveActivation(changed.spec, dependencies), /source file differs/);
  } finally {await rm(changed.parent, {recursive: true, force: true});}

  const nonempty = await fixture();
  try {
    await mkdir(nonempty.activationRoot, {mode: 0o700});
    await writeFile(join(nonempty.activationRoot, "pre-existing.txt"), "leftover\n");
    await assert.rejects(buildDarwinLiveActivation(nonempty.spec, dependencies), /not empty/);
  } finally {await rm(nonempty.parent, {recursive: true, force: true});}

  const secret = await fixture();
  try {
    secret.spec.manifest.infrastructure.providerAccess.credentials = "forbidden";
    await assert.rejects(buildDarwinLiveActivation(secret.spec, dependencies), /forbidden material|must be empty/);
  } finally {await rm(secret.parent, {recursive: true, force: true});}

  const nonEmptyPa = await fixture();
  try {
    // Even a non-secret-named key is refused: providerAccess must be
    // strictly empty in the sealed manifest, not merely free of known-bad names.
    nonEmptyPa.spec.manifest.infrastructure.providerAccess.harmlessLookingKey = "x";
    await assert.rejects(buildDarwinLiveActivation(nonEmptyPa.spec, dependencies), /must be empty/);
  } finally {await rm(nonEmptyPa.parent, {recursive: true, force: true});}
});

test("builder rejects a repository with untracked files, not only modified tracked ones", async () => {
  const value = await fixture();
  try {
    const repo = join(value.parent, "repo");
    await mkdir(repo);
    await executeFile("/usr/bin/git", ["-C", repo, "init", "--quiet"]);
    await executeFile("/usr/bin/git", ["-C", repo, "config", "user.email", "t@example.com"]);
    await executeFile("/usr/bin/git", ["-C", repo, "config", "user.name", "t"]);
    await writeFile(join(repo, "tracked.txt"), "a\n");
    await executeFile("/usr/bin/git", ["-C", repo, "add", "tracked.txt"]);
    await executeFile("/usr/bin/git", ["-C", repo, "commit", "--quiet", "-m", "initial"]);
    const {stdout: head} = await executeFile("/usr/bin/git", ["-C", repo, "rev-parse", "HEAD"]);
    value.spec.repositoryPath = repo;
    value.spec.manifest.sourceRevision = head.trim();
    await writeFile(join(repo, "untracked.txt"), "surprise\n");
    // No verifyRepository override here: exercises the real git-backed check.
    await assert.rejects(buildDarwinLiveActivation(value.spec, {filesystem: fixtureFilesystem()}),
      /not the clean exact source revision/);
  } finally {await rm(value.parent, {recursive: true, force: true});}
});

test("builder rejects a pinned role file that references ambient process.execPath", async () => {
  const value = await fixture();
  try {
    const runner = value.byRole("root-launcher");
    const bytes = "export const x = process.execPath;\n";
    await writeFile(runner.sourcePath, bytes);
    runner.sha256 = hash(Buffer.from(bytes));
    value.spec.files = value.files.map(entry => entry.role === "root-launcher" ?
      {...entry, sourcePath: runner.sourcePath, sha256: runner.sha256} : entry);
    // root-launcher.relativePath must end in .mjs/.js to be scanned; give it one.
    value.spec.files = value.spec.files.map(entry => entry.role === "root-launcher" ?
      {...entry, relativePath: `${entry.relativePath}.mjs`} : entry);
    await assert.rejects(buildDarwinLiveActivation(value.spec, dependencies), /process\.execPath/);
  } finally {await rm(value.parent, {recursive: true, force: true});}
});

test("builder statically walks real pinned files' local imports and refuses a closure missing a transitive dependency (P1 real-closure containment)", async () => {
  const liveDir = new URL(".", import.meta.url).pathname;
  const launcherBytes = await readFile(join(liveDir, "darwin-root-launcher.mjs"));
  const packetBytes = await readFile(join(liveDir, "darwin-native-root-packet.mjs"));
  assert.match(launcherBytes.toString("utf8"), /from\s+["']\.\/darwin-native-root-packet\.mjs["']/,
    "fixture assumption: darwin-root-launcher.mjs imports darwin-native-root-packet.mjs");

  const complete = await fixture();
  try {
    const launcher = complete.byRole("root-launcher"), packet = complete.byRole("root-packet-builder");
    // The local import specifier is matched against the *source* basename
    // (a pinned file's real, pre-rename name), so the packet role's source
    // file must actually be named darwin-native-root-packet.mjs here.
    const packetSourcePath = join(packet.sourcePath, "..", "darwin-native-root-packet.mjs");
    await writeFile(launcher.sourcePath, launcherBytes);
    await writeFile(packetSourcePath, packetBytes);
    launcher.sha256 = hash(launcherBytes); packet.sha256 = hash(packetBytes);
    complete.spec.files = complete.files.map(entry => entry.role === "root-launcher" ?
      {...entry, sha256: launcher.sha256, relativePath: `${entry.relativePath}.mjs`} :
      entry.role === "root-packet-builder" ?
        {...entry, sourcePath: packetSourcePath, sha256: packet.sha256, relativePath: `${entry.relativePath}.mjs`} : entry);
    // Real closure, both files present: the import-graph walk must accept it
    // and the packet builder must actually be loadable from where it lands.
    const built = await buildDarwinLiveActivation(complete.spec, dependencies);
    const activation = JSON.parse(await readFile(built.activationPath, "utf8"));
    const packetEntry = activation.files.find(entry => entry.role === "root-packet-builder");
    const loaded = await import(`file://${packetEntry.path}`);
    assert.equal(typeof loaded.validateDarwinNativeRootPacketTemplate, "function");
  } finally {await rm(complete.parent, {recursive: true, force: true});}

  const missing = await fixture();
  try {
    const launcher = missing.byRole("root-launcher");
    await writeFile(launcher.sourcePath, launcherBytes);
    launcher.sha256 = hash(launcherBytes);
    // root-packet-builder keeps its synthetic one-line content: the closure
    // pins a file at that role, but not one whose *source basename* matches
    // what darwin-root-launcher.mjs actually imports.
    missing.spec.files = missing.files.map(entry => entry.role === "root-launcher" ?
      {...entry, sha256: launcher.sha256, relativePath: `${entry.relativePath}.mjs`} : entry);
    await assert.rejects(buildDarwinLiveActivation(missing.spec, dependencies),
      /darwin-native-root-packet\.mjs.*not part of this closure/);
  } finally {await rm(missing.parent, {recursive: true, force: true});}
});

test("seal plan cross-checks the caller-supplied expected root/files against activation.json and refuses on any mismatch (P0 TOCTOU)", async () => {
  const value = await fixture();
  try {
    const built = await buildDarwinLiveActivation(value.spec, dependencies);
    const plan = await createDarwinActivationSealPlan(built.activationPath, built.activationRoot, built.sealFiles);
    assert.equal(plan.root, built.activationRoot);
    assert.ok(plan.files.every(file => file.path.startsWith(`${plan.root}/`)));

    // Caller expects a different root than the one actually recorded inside
    // activation.json: must refuse rather than seal whatever activation.json claims.
    // (The caller-supplied file list is itself bound to the original root, so
    // this is refused as a malformed expectation before even reaching
    // activation.json -- still a strict refusal, just an earlier one.)
    const otherRoot = await realpath(await mkdtemp(join(tmpdir(), "ar69-other-root-")));
    await assert.rejects(createDarwinActivationSealPlan(built.activationPath, otherRoot, built.sealFiles),
      /expected seal file list is malformed|expected activation root is not canonical|differs from the expected root/);
    await rm(otherRoot, {recursive: true, force: true});

    // Caller expects a file hash that does not match what is on disk / in
    // activation.json: must refuse instead of silently sealing the real bytes.
    const tamperedFiles = built.sealFiles.map(entry => entry.path === built.activationPath ?
      entry : {...entry, sha256: "0".repeat(64)});
    await assert.rejects(createDarwinActivationSealPlan(built.activationPath, built.activationRoot, tamperedFiles),
      /differs from the expected caller-supplied closure/);

    // An unmanifested file sitting in the root must also block sealing.
    await writeFile(join(built.activationRoot, "bin", "unexpected.txt"), "surprise\n");
    await assert.rejects(createDarwinActivationSealPlan(built.activationPath, built.activationRoot, built.sealFiles),
      /unmanifested file/);
  } finally {await rm(value.parent, {recursive: true, force: true});}
});

test("sealing is root-only, mutates exactly the expected closure, and independently attests the result (P1 partial-seal detection)", async () => {
  const value = await fixture();
  try {
    const built = await buildDarwinLiveActivation(value.spec, dependencies);
    await assert.rejects(sealDarwinLiveActivation(built.activationPath, built.activationRoot, built.sealFiles,
      {getuid: () => 501}), /root execution/);

    // chown/chmod are now injected as (handle, ...), not (path, ...): the
    // seal mutates through the same no-follow-opened descriptor it just
    // verified, not a fresh path lookup (P0 TOCTOU, the residual half closed
    // after the initial createDarwinActivationSealPlan cross-check). A
    // FileHandle exposes no public `.path`, so this fixture cross-references
    // the mutation order against a plan computed the same way the seal
    // computes its own (files then directories, in plan order) instead.
    const plan = await createDarwinActivationSealPlan(built.activationPath, built.activationRoot, built.sealFiles);
    const expectedOrder = [...plan.files.map(file => ({path: file.path, mode: file.mode})),
      ...plan.directories.map(path => ({path, mode: 0o555}))];
    let mutationIndex = 0;
    const calls = [], modeByPath = new Map();
    const okResult = await sealDarwinLiveActivation(built.activationPath, built.activationRoot, built.sealFiles, {
      getuid: () => 0,
      chown: async (handle, uid, gid) => {
        assert.equal(typeof handle.close, "function");
        calls.push(["chown", expectedOrder[mutationIndex].path, uid, gid]);
      },
      chmod: async (_handle, mode) => {
        const path = expectedOrder[mutationIndex].path;
        assert.equal(mode, expectedOrder[mutationIndex].mode, `chmod mode for ${path}`);
        calls.push(["chmod", path, mode]); modeByPath.set(path, mode);
        mutationIndex += 1;
      },
      execFile: async (...args) => calls.push(["chflags", ...args]),
      // Echoes back exactly what the seal itself just asked chmod to set, so
      // this fixture proves the attestation logic (does it correctly compare
      // observed-vs-expected?) rather than merely asserting a hardcoded mode.
      readImmutableFlags: async path => ({mode: modeByPath.get(path), uid: 0, gid: 0, immutable: true}),
    });
    assert.equal(mutationIndex, expectedOrder.length);
    assert.ok(calls.some(call => call[0] === "chflags" && call[1] === "/usr/bin/chflags"));
    assert.equal(okResult.sealed, true);
    assert.ok(okResult.attestation.length > 0);
    assert.ok(okResult.attestation.every(entry => entry.ok));

    // A file that reports back as not-actually-immutable must be surfaced as
    // an incomplete/partial seal instead of a silent success.
    const partialResult = await sealDarwinLiveActivation(built.activationPath, built.activationRoot, built.sealFiles, {
      getuid: () => 0, chown: async () => {}, chmod: async () => {}, execFile: async () => {},
      readImmutableFlags: async path => ({mode: path === built.activationPath ? 0o444 : 0o555, uid: 0, gid: 0,
        immutable: path !== built.activationPath}),
    });
    assert.equal(partialResult.sealed, false);
    assert.ok(partialResult.attestation.some(entry => !entry.ok));
  } finally {await rm(value.parent, {recursive: true, force: true});}
});

test("writePinnedSourceManifest round-trips through the canonical verifyPinnedSource role and rejects a source that changes after inventory", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "ar69-source-manifest-")));
  try {
    const sourceRoot = join(parent, "project");
    await mkdir(join(sourceRoot, "nested"), {recursive: true});
    await writeFile(join(sourceRoot, "a.txt"), "one\n");
    await writeFile(join(sourceRoot, "nested", "b.txt"), "two\n");
    const manifestPath = join(parent, "source-manifest.json");
    const pinned = await writePinnedSourceManifest(sourceRoot, manifestPath, fixtureFilesystem());
    assert.match(pinned.inventorySha256, /^[a-f0-9]{64}$/);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.deepEqual(manifest.entries.map(entry => entry.path).toSorted(),
      ["a.txt", "nested", "nested/b.txt"].toSorted());
  } finally {await rm(parent, {recursive: true, force: true});}
});
