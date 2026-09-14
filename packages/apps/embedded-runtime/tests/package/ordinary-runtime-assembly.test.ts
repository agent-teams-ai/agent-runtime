import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, realpath, mkdir, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Pool} from "pg";
import {compileComposition} from "@get-modular/core";
import {createAgentRuntimeHost} from "../../dist/composition.js";
import {runtimeOrdinarySetupDeclarations, runtimeOrdinarySetupProfile, runtimeSetupProfile, bindRuntimeSetup, createRuntimeSetupFactories} from "../../dist/composition/runtime-setup-assembly.js";
import {ordinaryRuntimeDeclarations} from "../../dist/composition/ordinary-runtime-assembly.js";
import {copyObservation} from "../../dist/composition/contained-turn-runtime-validation.js";

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
  const forbiddenFactory = async (): Promise<never> => {calls += 1; throw new Error("must not construct");};
  const bound = bindRuntimeSetup(createRuntimeSetupFactories(process.platform), () => {}, undefined, {
    factories: {operationStore: forbiddenFactory, security: forbiddenFactory, providerAccess: forbiddenFactory, workspace: forbiddenFactory, artifacts: forbiddenFactory, process: forbiddenFactory, provider: forbiddenFactory},
    decorateHost: host => host,
  });
  const composition = await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile: runtimeOrdinarySetupProfile});
  assert.equal(composition.ok, true);
  const prepared = await bound.assembly.prepare({composition, factories: bound.factories.slice(1), roots: bound.roots});
  assert.equal(prepared.status, "failed"); assert.equal(calls, 0);
});

async function forbidden(): Promise<never> {throw new Error("TEST port must remain passive", {cause: "synthetic forbidden port"});}
async function prepareLaunch(): Promise<never> {throw new Error("TEST paired launch", {cause: "synthetic launch"});}
function registerSecrets() {return true;}

test("materialized ordinary root injects the provider owner's launch capability and all seven bindings", async () => {

  const store = {accept: forbidden, prepare: forbidden, read: forbidden, claim: forbidden, cancel: forbidden, append: forbidden, finish: forbidden, reconcile: forbidden};
  const security = {resolveAndConsume: forbidden};
  const access = {resolveAndConsume: forbidden};
  const workspace = {prepare: forbidden, snapshot: forbidden, close: forbidden};
  const artifacts = {publish: forbidden};
  const processPort = {reserve: forbidden};
  const provider = {supported: {provider: "codex", mode: "workspace-write", executionProfile: "user-session-v1", capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1"} as const, execute: forbidden};

  let calls = 0;
  const factories = createRuntimeSetupFactories(process.platform);
  let hostOwner: Parameters<typeof factories.host>[1];
  const bound = bindRuntimeSetup({...factories, host: (dependencies, owner) => {
    hostOwner = owner; return factories.host(dependencies, owner);
  }}, () => {}, undefined, {
    factories: {
      operationStore: async () => {calls += 1; return store;},
      security: async () => {calls += 1; return {port: security, registerSecrets};},
      providerAccess: async register => {calls += 1; assert.equal(register, registerSecrets); return access;},
      workspace: async () => {calls += 1; return workspace;},
      artifacts: async () => {calls += 1; return artifacts;},
      provider: async () => {calls += 1; return {provider, prepareLaunch};},
      process: async launch => {calls += 1; assert.equal(launch, prepareLaunch); return processPort;},
    }, decorateHost: (host, feature) => {assert.equal(hostOwner, feature); return host;},
  });
  const mismatched = {...runtimeOrdinarySetupProfile, bindings: runtimeOrdinarySetupProfile.bindings.map(binding => binding.consumerImplementationId === "ordinary/process" ? {...binding, providerImplementationIds: ["ordinary/workspace"]} : binding)};
  const invalid = await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile: mismatched});
  assert.equal(invalid.ok, false); assert.equal(calls, 0);
  const composition = await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile: runtimeOrdinarySetupProfile});
  const preparation = await bound.assembly.prepare({composition, factories: bound.factories, roots: bound.roots});
  assert.equal(preparation.status, "prepared");
  if (preparation.status !== "prepared") {assert.fail(JSON.stringify(preparation));}
  const result = await preparation.prepared.run({});
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {assert.fail(JSON.stringify(result));}
  const expected = {"ordinary/store": store, "ordinary/security": security, "ordinary/provider-access": access, "ordinary/workspace": workspace, "ordinary/artifacts": artifacts, "ordinary/process": processPort, "ordinary/provider": provider, "ordinary/prepare-launch": prepareLaunch};
  for (const [capability, value] of Object.entries(expected)) {
    const entry = result.created.find(item => Object.hasOwn(item.capabilities, capability));
    assert.ok(entry); assert.equal(Reflect.get(entry.capabilities, capability), value, capability);
  }
  assert.equal(calls, 7);
  await result.roots.host.dispose();
});
