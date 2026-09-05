import assert from "node:assert/strict";
import { readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { sourceFixture, evidenceInput, git, commit } from "./support/provider-candidate-source-fixture.mjs";
import { createProviderCandidateEvidenceEnvelope } from "../../live/provider-candidate-evidence-envelope.mjs";

test("candidate receipt binds a disposable clean build, HEAD, dependencies and canary", async t => {
  const fixture = await sourceFixture(t);
  const execution = await fixture.resolve();
  const executed = await fixture.executeBuild();
  assert.equal(executed.freshBuild, 1);
  const envelope = await fixture.authority.createProviderCandidateEvidenceEnvelope(evidenceInput(fixture, execution));
  assert.equal(envelope.schemaVersion, 3);
  assert.equal(envelope.networkRouteEnforcement, "unqualified");
  assert.equal(envelope.buildIdentity.profile, "qualified-offline-clean-build/v2");
  for (const key of ["receiptDigest", "treeDigest", "sourceTreeDigest", "packageClosureDigest", "commandDigest", "dependenciesDigest", "nodeDigest", "compilerDigest", "toolchainQualificationDigest"]) {
    assert.match(envelope.buildIdentity[key], /^sha256:[a-f0-9]{64}$/u);
  }
  assert.equal(envelope.sourceSha, await git(fixture.root, "rev-parse", "HEAD"));
  assert.deepEqual(await fixture.resolve(), execution);
  await writeFile(fixture.buildPath, "export const stale = true;\n");
  await assert.rejects(fixture.authority.createProviderCandidateEvidenceEnvelope(evidenceInput(fixture, execution)), /changed during execution/u);
  await assert.rejects(fixture.resolve(), /differs from clean build/u);
});

test("counterexample: clean source HEAD moves while ignored dist remains stale", async t => {
  const fixture = await sourceFixture(t);
  const first = await fixture.resolve();
  const stale = await readFile(fixture.buildPath);
  await writeFile(fixture.sourcePath, "export const freshBuild: number = 2;\n");
  await commit(fixture.root);
  assert.notEqual(await git(fixture.root, "rev-parse", "HEAD"), first.sourceSha);
  assert.equal(await git(fixture.root, "status", "--porcelain"), "");
  assert.deepEqual(await readFile(fixture.buildPath), stale);
  assert.equal((await fixture.executeBuild()).freshBuild, 1);
  await assert.rejects(fixture.resolve(), /differs from clean build/u);
  await assert.rejects(fixture.authority.revalidateCanaryExecutionProvenance(first), /changed during execution/u);
  await fixture.build();
  const next = await fixture.resolve();
  assert.equal((await fixture.executeBuild(next.sourceSha)).freshBuild, 2);
  assert.notEqual(next.build.treeDigest, first.build.treeDigest);
  assert.notEqual(next.build.receiptDigest, first.build.receiptDigest);
});

test("provenance rejects dirty, absent, outside, and symlinked authority", async t => {
  const fixture = await sourceFixture(t);
  await assert.rejects(fixture.resolve({claimedSourceSha: "0".repeat(40)}), /does not match/u);
  await assert.rejects(fixture.resolve({canarySourceUrl: pathToFileURL(join(fixture.root, "..", "outside.mjs")).href}), /exact provider entrypoint/u);
  await writeFile(fixture.canaryPath, "export const dirty = true;\n");
  await assert.rejects(fixture.resolve(), /checkout is dirty/u);
  const noGit = await sourceFixture(t, "codex", false);
  await assert.rejects(noGit.resolve(), /provenance is unavailable/u);
  const linked = await sourceFixture(t);
  await symlink(linked.canaryPath, join(linked.root, "packages/contexts/agent-execution/dist/linked.js"));
  await assert.rejects(linked.resolve(), /symbolic link/u);
});

test("evidence rejects forged execution and provider/canary replay", async t => {
  const fixture = await sourceFixture(t);
  const execution = await fixture.resolve();
  const input = evidenceInput(fixture, execution);
  await assert.rejects(createProviderCandidateEvidenceEnvelope(input), /verified canary execution/u);
  await assert.rejects(fixture.authority.createProviderCandidateEvidenceEnvelope(Object.freeze({...input,
    executionProvenance: Object.freeze({...execution})})), /verified canary execution/u);
  await assert.rejects(fixture.authority.createProviderCandidateEvidenceEnvelope(Object.freeze({...input,
    binaryRevision: `sha256:${"a".repeat(64)}`,
    packageIdentity: Object.freeze({sdkRevision: "@anthropic-ai/claude-agent-sdk@0.3.251"}),
    provider: "claude-agent-sdk-current-kernel", canaryId: "claude-contained-turn-live-canary/v1"})), /does not match/u);
});

test("installed dependency edits invalidate an already issued execution receipt", async t => {
  const fixture = await sourceFixture(t);
  const execution = await fixture.resolve();
  await writeFile(join(fixture.root, "node_modules/typescript/injected.js"), "export const injected = true;\n");
  assert.equal(await git(fixture.root, "status", "--porcelain"), "");
  await assert.rejects(fixture.authority.revalidateCanaryExecutionProvenance(execution), /changed during execution/u);
});

test("dependency link target bytes are bound, while external links fail closed", async t => {
  const fixture = await sourceFixture(t, "codex", true, true);
  const target = join(fixture.root, ".cache/linked-sdk");
  const execution = await fixture.resolve();
  await writeFile(join(target, "sdk.js"), "export const revision = 2;\n");
  assert.equal(await git(fixture.root, "status", "--porcelain"), "");
  await assert.rejects(fixture.authority.revalidateCanaryExecutionProvenance(execution), /changed during execution/u);
  await symlink("/tmp", join(fixture.root, "node_modules/outside"));
  await assert.rejects(fixture.resolve(), /unauthorized symbolic link/u);
});

test("unchanged generated JS cannot hide changes to package closure or canary source", async t => {
  const fixture = await sourceFixture(t);
  const first = await fixture.resolve();
  await writeFile(join(fixture.root, "pnpm-lock.yaml"), 'lockfileVersion: "9.0"\n# revised closure\n');
  await commit(fixture.root);
  await assert.rejects(fixture.resolve(), /does not match separately trusted qualification/u);
  const qualification = fixture.qualifyPackages([["pnpm-lock.yaml", 'lockfileVersion: "9.0"\n# revised closure\n']]);
  const changedLock = await fixture.resolve({}, qualification);
  assert.equal(changedLock.build.treeDigest, first.build.treeDigest);
  assert.notEqual(changedLock.build.sourceTreeDigest, first.build.sourceTreeDigest);
  assert.notEqual(changedLock.build.packageClosureDigest, first.build.packageClosureDigest);
  assert.notEqual(changedLock.build.receiptDigest, first.build.receiptDigest);
  await writeFile(fixture.canaryPath, "export const canary = false;\n");
  await commit(fixture.root);
  const changedCanary = await fixture.resolve({}, qualification);
  assert.notEqual(changedCanary.canary.sourceDigest, changedLock.canary.sourceDigest);
  assert.notEqual(changedCanary.build.receiptDigest, changedLock.build.receiptDigest);
  await assert.rejects(fixture.resolve({canarySourceUrl: pathToFileURL(fixture.sourcePath).href}), /exact provider entrypoint/u);
});

test("assume-unchanged source edits cannot pair old HEAD with changed bytes", async t => {
  const fixture = await sourceFixture(t);
  const relative = "packages/contexts/agent-execution/src/runtime.ts";
  await git(fixture.root, "update-index", "--assume-unchanged", relative);
  await writeFile(fixture.sourcePath, "export const freshBuild: number = 9;\n");
  assert.equal(await git(fixture.root, "status", "--porcelain"), "");
  await assert.rejects(fixture.resolve(), /source bytes do not match exact HEAD/u);
});

test("stale workspace dependency output is rejected before Agent Execution compilation", async t => {
  const fixture = await sourceFixture(t);
  await writeFile(join(fixture.root, "packages/platform/filesystem-custody/src/runtime.ts"), "export const freshBuild: number = 3;\n");
  await commit(fixture.root);
  assert.equal(await git(fixture.root, "status", "--porcelain"), "");
  await assert.rejects(fixture.resolve(), /executed dependency build differs from clean build/u);
});

test("provenance input rejects getters, proxies, mutable records and mutable URL objects", async t => {
  const fixture = await sourceFixture(t);
  const value = Object.freeze({provider: fixture.providerId, canaryId: fixture.canaryId,
    claimedSourceSha: await git(fixture.root, "rev-parse", "HEAD"),
    canarySourceUrl: pathToFileURL(fixture.canaryPath).href,
    buildRootUrl: pathToFileURL(join(fixture.root, "packages/contexts/agent-execution/dist")).href});
  let calls = 0;
  const reject = (input: unknown) => assert.rejects(fixture.authority.resolveCanaryExecutionProvenance(input, fixture.qualification), TypeError);
  await reject({...value});
  await reject(new Proxy(value, {get() {calls += 1; throw new Error("must not evaluate");}}));
  await reject(Object.freeze(Object.defineProperty({...value}, "provider", {get() {calls += 1; return fixture.providerId;}})));
  await reject(Object.freeze({...value, canarySourceUrl: pathToFileURL(fixture.canaryPath)}));
  await reject(Object.freeze({...value, canarySourceUrl: `${value.canarySourceUrl}#preload`}));
  await reject(Object.freeze({...value, canarySourceUrl: "x".repeat(4097)}));
  assert.equal(calls, 0);
});
