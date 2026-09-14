import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, realpath, mkdir, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Pool} from "pg";
import {compileComposition} from "@get-modular/core";
import {createAgentRuntimeHost} from "../dist/composition.js";
import {runtimeOrdinarySetupDeclarations, runtimeOrdinarySetupProfile, runtimeSetupProfile, bindRuntimeSetup, createRuntimeSetupFactories} from "../dist/composition/runtime-setup-assembly.js";
import {ordinaryRuntimeDeclarations} from "../dist/composition/ordinary-runtime-assembly.js";
import {copyObservation} from "../dist/composition/contained-turn-runtime-validation.js";

test("ordinary active graph has independent exact seven-port parity and passive profile remains separate", async () => {
  const expected = {"operation-store": "ordinary/store", security: "ordinary/security", "provider-access": "ordinary/provider-access", workspace: "ordinary/workspace", artifacts: "ordinary/artifacts", process: "ordinary/process", provider: "ordinary/provider"};
  assert.deepEqual(Object.fromEntries(runtimeOrdinarySetupProfile.bindings.filter(binding => binding.consumerImplementationId === "ordinary/turn").map(binding => [binding.slotId, binding.providerImplementationIds[0]])), expected);
  assert.deepEqual(ordinaryRuntimeDeclarations.find(d => d.moduleId === "ordinary/turn")?.slots.map(s => s.slotId).toSorted(), Object.keys(expected).toSorted());
  assert.equal(runtimeSetupProfile.bindings.some(binding => binding.consumerImplementationId.startsWith("ordinary/")), false);
  const result = await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile: runtimeOrdinarySetupProfile});
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const slotId of Object.keys(expected)) {
    const profile = {...runtimeOrdinarySetupProfile, bindings: runtimeOrdinarySetupProfile.bindings.filter(binding => !(binding.consumerImplementationId === "ordinary/turn" && binding.slotId === slotId))};
    assert.equal((await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile})).ok, false, slotId);
  }
  const swapped = {...runtimeOrdinarySetupProfile, bindings: runtimeOrdinarySetupProfile.bindings.map(binding => binding.consumerImplementationId === "ordinary/turn" && binding.slotId === "process" ? {...binding, providerImplementationIds: ["ordinary/workspace"]} : binding)};
  assert.equal((await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile: swapped})).ok, false);
});
test("public ordinary construction and disposal never capture auth or start provider and borrow pool", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "ordinary-public-TEST-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const dirs = Object.fromEntries(["auth", "private", "evidence", "source", "workspace", "artifact"].map(name => [name, join(root, name)]));
  for (const path of Object.values(dirs)) {await mkdir(path, {mode: 0o700});}
  const pool = new Pool(); let migrations = 0; let ended = 0;
  t.mock.method(pool, "query", async () => {migrations += 1; return {rows: [], rowCount: 0};});
  t.mock.method(pool, "connect", async () => ({query: async () => {migrations += 1; return {rows: [], rowCount: 0};}, release() {}}));
  t.mock.method(pool, "end", async () => {ended += 1;});
  const pending = createAgentRuntimeHost({execution: {provider: "codex", executablePath: join(root, "absent-codex-TEST"), authSourceDirectory: dirs.auth, privateRoot: dirs.private, evidenceRoot: dirs.evidence, sourceDirectory: dirs.source, workspaceRoot: dirs.workspace, artifactRoot: dirs.artifact, sourceRevision: "synthetic-TEST-revision"}, storage: {pool}, scope: {tenantId: "test", projectId: "TEST"}});
  assert.ok(pending instanceof Promise);
  const host = await pending;
  assert.ok(migrations > 0);
  assert.equal((await readdir(dirs.private)).length, 0);
  assert.equal((await readdir(dirs.workspace)).length, 0);
  assert.equal((await readdir(dirs.evidence)).length, 1);
  assert.throws(() => host.bindAccess({containedTurn: {tenantId: "other", projectId: "TEST"}}), /scope/);
  const access = host.bindAccess({containedTurn: {tenantId: "test", projectId: "TEST"}});
  assert.equal(typeof access.containedTurn.submit, "function");
  await host.dispose(); await host.dispose();
  assert.equal(ended, 0);
});
test("ordinary observation exposes exact profile, preserves early cancellation, rejects profile confusion", () => {
  const profile = {executionProfile: "user-session-v1", effectClass: "ordinary_user_session_effect", capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1"};
  const turn = {commandId: "command", effectId: "effect", operationId: "op", provider: "codex", revision: 1, output: [], status: "cancelled", ...profile};
  const result = copyObservation({status: "observed", turn}, "op");
  assert.equal(result.status, "observed");
  if (result.status === "observed") {assert.equal(result.turn.executionProfile, profile.executionProfile);}
  assert.notEqual(copyObservation({status: "observed", turn: {...turn, executionProfile: "host-custody-v1"}}, "op").status, "observed");
  assert.notEqual(copyObservation({status: "observed", turn: {...turn, status: "succeeded"}}, "op").status, "observed");
});

test("ordinary preparation fails before owner construction when a selected factory is missing", async () => {
  let calls = 0;
  const forbidden = async (): Promise<never> => {calls += 1; throw new Error("must not construct");};
  const bound = bindRuntimeSetup(createRuntimeSetupFactories(process.platform), () => {}, undefined, {
    factories: {operationStore: forbidden, security: forbidden, providerAccess: forbidden, workspace: forbidden, artifacts: forbidden, process: forbidden, provider: forbidden},
    decorateHost: host => host,
  });
  const composition = await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile: runtimeOrdinarySetupProfile});
  assert.equal(composition.ok, true);
  const prepared = await bound.assembly.prepare({composition, factories: bound.factories.slice(1), roots: bound.roots});
  assert.equal(prepared.status, "failed"); assert.equal(calls, 0);
});
