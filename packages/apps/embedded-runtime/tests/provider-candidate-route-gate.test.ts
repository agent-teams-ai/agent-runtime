import assert from "node:assert/strict";
import { readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { sourceFixture, evidenceInput, git, commit } from "../../../contexts/agent-execution/tests/features/contained-agent-turn/support/provider-candidate-source-fixture.mjs";
import { createProviderCandidateEvidenceEnvelope } from "../../../contexts/agent-execution/tests/live/provider-candidate-evidence-envelope.mjs";

test("exact current provider candidates are absent from the qualification registry", async () => {
  const registry = JSON.parse(await readFile(new URL(
    "../../../../docs/architecture/qualification-registry.json", import.meta.url,
  ), "utf8")) as {entries: readonly unknown[]};
  const serialized = JSON.stringify(registry.entries);
  assert.doesNotMatch(serialized, /0\.150\.1/u);
  assert.doesNotMatch(serialized, /0\.3\.251/u);
  assert.doesNotMatch(serialized, /codex-app-server-current-kernel/u);
  assert.doesNotMatch(serialized, /claude-agent-sdk-current-kernel/u);
});

test("candidate receipt binds a real clean build, HEAD, dependencies and canary", async t => {
  const fixture = await sourceFixture(t);
  const execution = await fixture.resolve();
  const executed = await import(pathToFileURL(fixture.buildPath).href);
  assert.equal(executed.freshBuild, 1);
  const envelope = await fixture.authority.createProviderCandidateEvidenceEnvelope(evidenceInput(fixture, execution));
  assert.equal(envelope.schemaVersion, 2);
  assert.equal(envelope.networkRouteEnforcement, "unqualified");
  assert.equal(envelope.buildIdentity.profile, "local-offline-clean-build/v1");
  for (const key of ["receiptDigest", "treeDigest", "commandDigest", "dependenciesDigest", "nodeDigest"]) {
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
  await assert.rejects(fixture.resolve(), /differs from clean build/u);
  await assert.rejects(fixture.authority.revalidateCanaryExecutionProvenance(first), /changed during execution/u);
  await fixture.build();
  const next = await fixture.resolve();
  assert.notEqual(next.build.treeDigest, first.build.treeDigest);
  assert.notEqual(next.build.receiptDigest, first.build.receiptDigest);
});

test("provenance rejects dirty, absent, outside, and symlinked authority", async t => {
  const fixture = await sourceFixture(t);
  await assert.rejects(fixture.resolve({claimedSourceSha: "0".repeat(40)}), /does not match/u);
  await assert.rejects(fixture.resolve({canarySourceUrl: pathToFileURL(join(fixture.root, "..", "outside.mjs"))}), /absent from source commit/u);
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
    provider: "claude-agent-sdk-current-kernel", canaryId: "claude-contained-turn-live-canary/v1"})), /does not match/u);
});

test("installed dependency edits invalidate an already issued execution receipt", async t => {
  const fixture = await sourceFixture(t);
  const execution = await fixture.resolve();
  await writeFile(join(fixture.root, "node_modules/typescript/injected.js"), "export const injected = true;\n");
  assert.equal(await git(fixture.root, "status", "--porcelain"), "");
  await assert.rejects(fixture.authority.revalidateCanaryExecutionProvenance(execution), /changed during execution/u);
});

test("the provider route gate does not alter the exact seven composition ports", async () => {
  const composition = await readFile(new URL(
    "../src/composition/contained-turn-feature-composition.ts", import.meta.url,
  ), "utf8");
  const supplied = [...composition.matchAll(
    /^    (operationStore|security|providerAccess|workspace|artifacts|custody|provider)(?=:|,$)/gmu,
  )].map(match => match[1]);
  assert.deepEqual(supplied, [
    "operationStore", "security", "providerAccess", "workspace", "artifacts", "custody", "provider",
  ]);
  assert.doesNotMatch(composition, /networkGateway|networkRoutePort/u);
  const publicComposition = await readFile(new URL("../src/composition.ts", import.meta.url), "utf8");
  assert.doesNotMatch(publicComposition, /composeCandidateHostCustodied|composeHostCustodiedContainedTurn/u);
});
