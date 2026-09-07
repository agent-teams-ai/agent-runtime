import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { nativeFixture, freeze, artifact } from "./support/provider-candidate-native-fixture.mjs";
import { evidenceInput } from "./support/provider-candidate-source-fixture.mjs";
import { captureNativeQualification, nativeInvocation } from "../../live/provider-candidate-native-build.mjs";
import { trustedToolchainQualification, matchTrustedToolchain } from "../../live/provider-candidate-toolchain.mjs";
import { sha256 } from "../../live/provider-candidate-build-tree.mjs";
import { execFileAsync } from "../../live/provider-candidate-source.mjs";

const changedNative = (q, patch) => freeze({...q, native: freeze({...q.native, ...patch})});
const missingMarker = marker => assert.rejects(readFile(marker), {code: "ENOENT"});

test("native independent output and fresh BOTH-package rebuild bind a private receipt", async t => {
  const f = await nativeFixture(t);
  const execution = await f.resolve({}, f.qualification);
  const invocation = JSON.parse(await readFile(f.marker, "utf8"));
  assert.deepEqual(invocation.env, {LC_ALL: "C", TZ: "UTC", SOURCE_DATE_EPOCH: "0"});
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
    assert.equal(actual.args.includes("-shared"), platform === "linux");
    assert.equal(actual.args.includes("-bundle"), platform === "darwin");
    assert.equal(actual.args.includes("dynamic_lookup"), platform === "darwin");
    assert.deepEqual(actual.env, invocation.environment);
  }
});

test("live imports are inert and missing separately trusted data causes zero candidate imports", async () => {
  let candidateImports = 0;
  const hook = registerHooks({resolve(specifier, context, nextResolve) {
    if (specifier.includes("/dist/") || specifier === "@anthropic-ai/claude-agent-sdk") {
      candidateImports++; throw Error("candidate import forbidden");
    }
    return nextResolve(specifier, context);
  }});
  try {
    const codex = await import("../../live/codex-contained-turn-live-canary.mjs");
    const claude = await import("../../live/claude-contained-turn-live-canary.mjs");
    assert.equal(candidateImports, 0);
    await assert.rejects(codex.runCanary(), /separately trusted exact/u);
    await assert.rejects(claude.runCanary(), /separately trusted exact/u);
    assert.equal(candidateImports, 0);
    for (const provider of ["codex", "claude"]) {
      const entry = new URL(`../../live/${provider}-contained-turn-live-canary.mjs`, import.meta.url);
      await assert.rejects(execFileAsync(process.execPath, [entry.pathname], {env: {}}), /separate trusted composition required/u);
    }
  } finally {hook.deregister();}
});
