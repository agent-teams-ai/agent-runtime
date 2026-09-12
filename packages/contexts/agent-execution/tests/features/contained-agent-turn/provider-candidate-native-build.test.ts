import assert from "node:assert/strict";
import { readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { nativeFixture, freeze, artifact } from "./support/provider-candidate-native-fixture.mjs";
import { evidenceInput } from "./support/provider-candidate-source-fixture.mjs";
import { captureNativeQualification, nativeInvocation, matchNativeOutput } from "../../live/provider-candidate-native-build.mjs";
import { trustedToolchainQualification, matchTrustedToolchain } from "../../live/provider-candidate-toolchain.mjs";
import { sha256 } from "../../live/provider-candidate-build-tree.mjs";
import { execFileAsync } from "../../live/provider-candidate-source.mjs";

// Retain the actual observation; tolerate exactly the documented Darwin spawn
// addition, never arbitrary search-path/loader flags or a supplied inherited value.
const assertEnvironment = (actual, expected, platform = process.platform) => {
  const {__CF_USER_TEXT_ENCODING: encoding, ...controlled} = actual;
  if (encoding !== undefined) {
    assert.equal(platform, "darwin");
    assert.match(encoding, /^0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+$/u);
  }
  assert.deepEqual(controlled, expected);
};

const changedNative = (q, patch) => freeze({...q, native: freeze({...q.native, ...patch})});
const missingMarker = marker => assert.rejects(readFile(marker), {code: "ENOENT"});

test("native independent output and fresh BOTH-package rebuild bind a private receipt", async t => {
  const f = await nativeFixture(t);
  const execution = await f.resolve({}, f.qualification);
  const invocation = JSON.parse(await readFile(f.marker, "utf8"));
  assertEnvironment(invocation.env, {LC_ALL: "C", TZ: "UTC", SOURCE_DATE_EPOCH: "0"});
  assert.ok(invocation.args.includes(`--ld-path=${f.qualification.native.inputs.linker.path}`));
  assert.ok(invocation.args.includes(f.qualification.native.inputs.resources.path));
  assert.ok(invocation.args.includes(`--sysroot=${f.qualification.native.inputs.sysroot.path}`));
  assert.ok(invocation.args.includes("-nostdinc"));
  const envelope = await f.authority.createProviderCandidateEvidenceEnvelope(evidenceInput(f, execution));
  assert.equal(envelope.schemaVersion, 4);
  assert.equal(envelope.qualification, "implementation-evidence-only");
  assert.equal(envelope.buildIdentity.nativeOutputDigest, `sha256:${sha256(artifact)}`);
  assert.equal(envelope.buildIdentity.nativeRecipeDigest, `sha256:${f.qualification.native.recipeDigest}`);
  assert.doesNotMatch(JSON.stringify(envelope), /ar-native-approved|installationProvenance|clang-shared/u);
  await assert.rejects(f.authority.revalidateCanaryExecutionProvenance(freeze(JSON.parse(JSON.stringify(execution)))), /verified canary/u);
  await writeFile(f.output, "substituted artifact\n");
  await assert.rejects(f.authority.createProviderCandidateEvidenceEnvelope(evidenceInput(f, execution)), /changed during execution/u);
});

test("native input, source, recipe, host and executed output mismatch before compiler/helper execution", async t => {
  const f = await nativeFixture(t);
  const q = f.qualification;
  for (const patch of [
    {sourceSha: "0".repeat(40)}, {sourceTreeDigest: "0".repeat(64)}, {cSourceDigest: "0".repeat(64)},
    {recipeDigest: "0".repeat(64)}, {epoch: "1"},
    {environment: freeze({...q.native.environment, release: "unapproved host"})},
    ...Object.keys(q.native.inputs).map(role => ({inputs: freeze({...q.native.inputs,
      [role]: freeze({...q.native.inputs[role], digest: "0".repeat(64)})})})),
    {expectedOutput: freeze({...q.native.expectedOutput, digest: "0".repeat(64)})},
  ]) {
    await assert.rejects(f.resolve({}, changedNative(q, patch)), /native .*differs/u);
    await missingMarker(f.marker);
  }
  await writeFile(f.output, "stale");
  await assert.rejects(f.resolve({}, q));
  await missingMarker(f.marker);
});

test("fresh native bytes must equal independent expectation even when workspace carries that expectation", async t => {
  const f = await nativeFixture(t);
  const forged = "x".repeat(Buffer.byteLength(artifact));
  await writeFile(f.output, forged);
  const q = changedNative(f.qualification, {expectedOutput: freeze({path: "dist/rename-no-replace.node",
    digest: sha256(forged), bytes: Buffer.byteLength(forged)})});
  await assert.rejects(f.resolve({}, q), /native output differs|file exceeds/u);
  assert.ok(await readFile(f.marker));
});

test("publication revalidates installed native inputs and cannot replay unchanged output", async t => {
  const f = await nativeFixture(t);
  const execution = await f.resolve({}, f.qualification);
  await writeFile(join(f.qualification.native.inputs.resources.path, "approved-input"), "mutated");
  await assert.rejects(f.authority.createProviderCandidateEvidenceEnvelope(evidenceInput(f, execution)), /changed during execution/u);
});

test("nested native qualification never executes accessors or proxy traps and detaches every record", async t => {
  const f = await nativeFixture(t);
  const q = f.qualification;
  let calls = 0;
  const proxy = value => new Proxy(value, {get() {calls++; throw Error("trap");}, ownKeys() {calls++; throw Error("trap");}});
  const getter = value => freeze(Object.defineProperty({...value}, Object.keys(value)[0], {
    enumerable: true, get() {calls++; throw Error("getter");},
  }));
  for (const alter of [proxy, getter, value => ({...value}), value => freeze({...value, extra: true})]) {
    const malformed = [changedNative(q, {inputs: alter(q.native.inputs)}),
      changedNative(q, {environment: alter(q.native.environment)}),
      changedNative(q, {expectedOutput: alter(q.native.expectedOutput)}),
      changedNative(q, {inputs: freeze({...q.native.inputs, compiler: alter(q.native.inputs.compiler)})}),
      freeze({...q, native: alter(q.native)})];
    for (const input of malformed) {assert.throws(() => trustedToolchainQualification(input), TypeError);}
  }
  assert.equal(calls, 0);
  for (const patch of [
    {expectedOutput: freeze({...q.native.expectedOutput, path: "dist/another.node"})},
    {expectedOutput: freeze({...q.native.expectedOutput, bytes: 0})},
    {inputs: freeze({...q.native.inputs, compiler: freeze({...q.native.inputs.compiler, path: "cc"})})},
    {deploymentTarget: "arbitrary flags"}, {recipe: "callback"},
  ]) {assert.throws(() => trustedToolchainQualification(changedNative(q, patch)), TypeError);}
  const detached = trustedToolchainQualification(q);
  assert.notEqual(detached.native, q.native);
  assert.notEqual(detached.native.inputs.compiler, q.native.inputs.compiler);
  assert.deepEqual(detached, q);
  await missingMarker(f.marker);
});

test("exact Linux x64 and Darwin arm64 recipes are closed and Node-only refuses both", async t => {
  const f = await nativeFixture(t);
  for (const [platform, architecture] of [["linux", "x64"], ["darwin", "arm64"]]) {
    const native = freeze({...f.qualification.native,
      recipe: platform === "linux" ? "linux-x64-clang-shared/v1" : "darwin-arm64-clang-bundle/v1",
      deploymentTarget: platform === "linux" ? "none" : "13.0"});
    const captured = captureNativeQualification(native, platform, architecture);
    assert.equal(nativeInvocation(captured).args[2], native.recipe);
    assert.throws(() => captureNativeQualification(native, platform, architecture === "x64" ? "arm64" : "x64"), TypeError);
    // Refusal has no ambient-platform conditional: source requiring native tools
    // cannot be authorized by Node-only qualification on either target.
    await assert.rejects(matchTrustedToolchain(f.snapshot, freeze({...f.qualification,
      profile: "node-only-offline-toolchain/v1", platform, architecture}), {}), /native compiler\/header/u);
  }
  const helper = join(f.root, "packages/platform/filesystem-custody/scripts/build-native-helper.mjs");
  for (const args of [["--qualified"], ["--qualified", "node-only-offline-toolchain/v1"],
    nativeInvocation(f.qualification.native).args.slice(1)]) {
    await assert.rejects(execFileAsync(process.execPath, [helper, ...args], {cwd: f.root, env: {}}), /qualified native recipe inputs/u);
  }
  await missingMarker(f.marker);
  // Exercise the real helper's two recipe branches with a synthetic executable,
  // never a platform compiler. This is no Darwin reproducibility evidence.
  const preload = join(f.root, "simulated-platform.mjs");
  for (const [platform, arch] of [["linux", "x64"], ["darwin", "arm64"]]) {
    await writeFile(preload, `Object.defineProperty(process, 'platform', {value:${JSON.stringify(platform)}});
Object.defineProperty(process, 'arch', {value:${JSON.stringify(arch)}});`);
    const recipe = platform === "linux" ? "linux-x64-clang-shared/v1" : "darwin-arm64-clang-bundle/v1";
    const native = {...f.qualification.native, recipe, deploymentTarget: platform === "linux" ? "none" : "13.0"};
    const invocation = nativeInvocation(native);
    const options = {cwd: join(f.root, "packages/platform/filesystem-custody"), env: invocation.environment};
    await assert.rejects(execFileAsync(process.execPath, ["--import", preload, helper,
      "--qualified", "node-only-offline-toolchain/v1"], options), /qualified native recipe inputs/u);
    await execFileAsync(process.execPath, ["--import", preload, ...invocation.args], options);
    const actual = JSON.parse(await readFile(f.marker, "utf8"));
    const inputs = native.inputs;
    assert.deepEqual(actual.args, ["-O2", "-Wall", "-Wextra", "-Werror", "-fPIC", "-nostdinc",
      `--ld-path=${inputs.linker.path}`, "-resource-dir", inputs.resources.path,
      `--sysroot=${inputs.sysroot.path}`, "-isystem", join(inputs.resources.path, "include"),
      "-isystem", join(inputs.sysroot.path, "usr/include"), `-I${inputs.nodeHeaders.path}`,
      ...(platform === "linux" ? ["--target=x86_64-unknown-linux-gnu", "-shared"] :
        ["--target=arm64-apple-darwin", "-arch", "arm64", "-mmacosx-version-min=13.0",
          "-bundle", "-undefined", "dynamic_lookup", "-lsandbox"]),
      "native/rename-no-replace.c", "-o", "dist/rename-no-replace.node"]);
    assert.equal(actual.args.includes("-shared"), platform === "linux");
    assert.equal(actual.args.includes("-bundle"), platform === "darwin");
    assert.equal(actual.args.includes("dynamic_lookup"), platform === "darwin");
    assertEnvironment(actual.env, invocation.environment);
  }
});

test("Darwin spawn allowance is bounded and never hides compiler or loader injection", () => {
  const env = {LC_ALL: "C", TZ: "UTC", SOURCE_DATE_EPOCH: "0"};
  assertEnvironment({...env, __CF_USER_TEXT_ENCODING: "0x1F5:0x7:0x31"}, env, "darwin");
  for (const platform of ["linux", "darwin"]) {
    for (const key of ["PATH", "CPATH", "LIBRARY_PATH", "GCC_EXEC_PREFIX", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]) {
      assert.throws(() => assertEnvironment({...env, [key]: "unapproved"}, env, platform));
    }
  }
  assert.throws(() => assertEnvironment({...env, __CF_USER_TEXT_ENCODING: "arbitrary"}, env, "darwin"));
  assert.throws(() => assertEnvironment({...env, __CF_USER_TEXT_ENCODING: "0x1:0x0:0x0"}, env, "linux"));
});

test("native output still rejects aliased parents and symlinked artifact", async t => {
  const f = await nativeFixture(t);
  const alias = join(f.root, "package-alias");
  await symlink(join(f.root, "packages/platform/filesystem-custody"), alias, "dir");
  await assert.rejects(matchNativeOutput(alias, f.qualification.native), /unaliased/u);
  const target = join(f.root, "artifact");
  await writeFile(target, artifact);
  await rm(f.output);
  await symlink(target, f.output);
  await assert.rejects(matchNativeOutput(join(f.root, "packages/platform/filesystem-custody"), f.qualification.native), /unaliased/u);
});

test("GCC recipe selects real driver argv and absolute assembler/linker without Clang flags", async t => {
  const f = await nativeFixture(t, true);
  const native = f.qualification.native;
  const captured = captureNativeQualification(freeze({...native, deploymentTarget: "none"}), "linux", "x64");
  assert.throws(() => captureNativeQualification(freeze({...captured,
    environment: freeze({...captured.environment, defaultResolutionDigest: undefined})}), "linux", "x64"), TypeError);
  const preload = join(f.root, "gcc-platform.mjs");
  await writeFile(preload, `Object.defineProperty(process, 'platform', {value:'linux'});
Object.defineProperty(process, 'arch', {value:'x64'});`);
  const invocation = nativeInvocation(captured);
  await execFileAsync(process.execPath, ["--import", preload, ...invocation.args], {
    cwd: join(f.root, "packages/platform/filesystem-custody"),
    env: {...invocation.environment, CPATH: "unapproved", GCC_EXEC_PREFIX: "unapproved",
      LIBRARY_PATH: "unapproved", COMPILER_PATH: "unapproved"},
  });
  const actual = JSON.parse(await readFile(f.marker, "utf8"));
  const inputs = captured.inputs;
  assert.deepEqual(actual.tools, {as: inputs.assembler.path, ld: inputs.linker.path, "ld.bfd": inputs.linker.path});
  const toolPrefix = actual.args[6];
  assert.match(toolPrefix, /^-B\/.+\/dist\/\.gcc-tools-[^/]+\/$/u);
  assert.deepEqual(actual.args, ["-O2", "-Wall", "-Wextra", "-Werror", "-fPIC", "-nostdinc",
    toolPrefix, `-B${inputs.resources.path}/`, "-fuse-ld=bfd", "-fno-use-linker-plugin", "-m64",
    `--sysroot=${inputs.sysroot.path}`, "-isystem", join(inputs.resources.path, "include"),
    "-isystem", join(inputs.sysroot.path, "usr/include"), "-isystem", join(inputs.sysroot.path, "usr/include/x86_64-linux-gnu"),
    `-I${inputs.nodeHeaders.path}`,
    "-shared", "native/rename-no-replace.c", "-o", "dist/rename-no-replace.node"]);
  assertEnvironment(actual.env, invocation.environment);
  await assert.rejects(readFile(join(toolPrefix.slice(2), "as")), {code: "ENOENT"});
  await rm(preload);
  if (process.platform === "linux" && process.arch === "x64") {
    await f.resolve({}, f.qualification);
    await writeFile(join(inputs.resources.path, "cc1"), "changed driver");
    await assert.rejects(f.resolve({}, f.qualification), /native input differs/u);
  }
});

test("fresh build canonicalizes its own root beneath an aliased temporary parent", async t => {
  const f = await nativeFixture(t);
  const alias = join(f.root, "temporary-parent");
  await symlink(f.root, alias, "dir");
  await execFileAsync(process.execPath, ["--test", "--test-name-pattern=^native independent output",
    new URL(import.meta.url).pathname], {env: {...process.env, TMPDIR: alias, TMP: alias, TEMP: alias},
    timeout: 120_000, maxBuffer: 1024 ** 2});
});
