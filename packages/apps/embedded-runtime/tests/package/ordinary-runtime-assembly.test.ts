import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, realpath, mkdir, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Pool} from "pg";
import {compileComposition} from "@get-modular/core";
import {assemblyFor} from "@get-modular/assembly";
import {isolate, smoke} from "@get-modular/conformance";
import {createScope, type Resources} from "@get-modular/resources";
import {createAgentRuntimeHost} from "../../dist/composition.js";
import {runtimeOrdinarySetupDeclarations, runtimeOrdinarySetupProfile, runtimeSetupDeclarations, runtimeSetupProfile, bindRuntimeSetup, composeRuntimeSetup, createRuntimeSetupFactories, type RuntimeSetupCapabilities} from "../../dist/composition/runtime-setup-assembly.js";
import type {AgentRuntimeHost} from "../../dist/composition/agent-runtime-host.js";
import {createOrdinaryModuleFactories, ordinaryProviderDeclaration, ordinaryRuntimeDeclarations, type OrdinaryRuntimeCapabilities, type OrdinaryRuntimeFactories} from "../../dist/composition/ordinary-runtime-assembly.js";
import {copyObservation} from "../../dist/composition/contained-turn-runtime-validation.js";

test("ordinary active graph has independent exact seven-port parity and passive profile remains separate", async () => {
  const expected = {"operation-store": "agent-runtime/ordinary/store/postgres", security: "agent-runtime/ordinary/security/postgres", "provider-access": "agent-runtime/ordinary/provider-access/postgres", workspace: "agent-runtime/ordinary/workspace/node", artifacts: "agent-runtime/ordinary/artifacts/node", process: "agent-runtime/ordinary/process/node", provider: "agent-runtime/ordinary/provider/codex"};
  assert.deepEqual(Object.fromEntries(runtimeOrdinarySetupProfile.bindings.filter(binding => binding.consumerImplementationId === "agent-runtime/ordinary/turn/default").map(binding => [binding.slotId, binding.providerImplementationIds[0]])), expected);
  assert.deepEqual(ordinaryRuntimeDeclarations.find(d => d.moduleId === "agent-runtime/ordinary/turn")?.slots.map(s => s.slotId).toSorted(), Object.keys(expected).toSorted());
  assert.equal(runtimeSetupProfile.bindings.some(binding => binding.consumerImplementationId.startsWith("agent-runtime/ordinary/")), false);
  const result = await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile: runtimeOrdinarySetupProfile});
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const slotId of Object.keys(expected)) {
    const profile = {...runtimeOrdinarySetupProfile, bindings: runtimeOrdinarySetupProfile.bindings.filter(binding => !(binding.consumerImplementationId === "agent-runtime/ordinary/turn/default" && binding.slotId === slotId))};
    assert.equal((await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile})).ok, false, slotId);
  }
  const swapped = {...runtimeOrdinarySetupProfile, bindings: runtimeOrdinarySetupProfile.bindings.map(binding => binding.consumerImplementationId === "agent-runtime/ordinary/turn/default" && binding.slotId === "process" ? {...binding, providerImplementationIds: ["agent-runtime/ordinary/workspace/node"]} : binding)};
  assert.equal((await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile: swapped})).ok, false);
});
const planRow = (consumer: string, slot: string, provider: string, capability: string) => `${consumer}|${slot}|${provider}|${capability}|${capability}/r1`;
const passiveHost = "agent-runtime/runtime-host/passive";
const ordinaryHost = "agent-runtime/runtime-host/ordinary";
const passiveRows = (host: string) => [
  planRow(host, "authorize-setup-inspection", "agent-runtime/setup-security/default", "agent-runtime/codex-authorization"),
  planRow(host, "authorize-claude-code-setup-inspection", "agent-runtime/setup-security/default", "agent-runtime/claude-authorization"),
  planRow(host, "discover-codex-installations", "agent-runtime/installation-discovery/default", "agent-runtime/codex-installations"),
  planRow(host, "discover-claude-code-installations", "agent-runtime/installation-discovery/default", "agent-runtime/claude-installations"),
  planRow(host, "inspect-codex-configuration", "agent-runtime/codex-configuration/default", "agent-runtime/codex-configuration"),
  planRow(host, "inspect-claude-code-configuration", "agent-runtime/claude-configuration/default", "agent-runtime/claude-configuration"),
  planRow(host, "plan-codex-setup-inspection", "agent-runtime/codex-planner/default", "agent-runtime/codex-planner"),
  planRow(host, "plan-claude-code-setup-inspection", "agent-runtime/claude-planner/default", "agent-runtime/claude-planner"),
];
const planRows = (bindings: readonly {consumerImplementationId: string; slotId: string; providerImplementationIds: readonly string[]; capabilityId: string; compatibility: {token: string}}[]) =>
  bindings.map(b => `${b.consumerImplementationId}|${b.slotId}|${b.providerImplementationIds.join(",")}|${b.capabilityId}|${b.compatibility.token}`).toSorted();

test("compiled binding plans equal the independent identity table and carry revision 1 tokens", async () => {
  const passive = await compileComposition({declarations: runtimeSetupDeclarations, profile: runtimeSetupProfile});
  assert.ok(passive.ok);
  assert.deepEqual(planRows(passive.plan.bindings), passiveRows(passiveHost).toSorted());
  // Construction order is the Core tie-break by implementation ID; a rename must not change it silently.
  assert.deepEqual(passive.plan.dependencyOrder, [
    "agent-runtime/claude-configuration/default", "agent-runtime/claude-planner/default", "agent-runtime/codex-configuration/default",
    "agent-runtime/codex-planner/default", "agent-runtime/installation-discovery/default", "agent-runtime/setup-security/default", passiveHost,
  ]);
  const ordinary = await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile: runtimeOrdinarySetupProfile});
  assert.ok(ordinary.ok);
  assert.deepEqual(ordinary.plan.dependencyOrder, [
    "agent-runtime/claude-configuration/default", "agent-runtime/claude-planner/default", "agent-runtime/codex-configuration/default",
    "agent-runtime/codex-planner/default", "agent-runtime/installation-discovery/default", "agent-runtime/ordinary/artifacts/node",
    "agent-runtime/ordinary/provider/codex", "agent-runtime/ordinary/process/node", "agent-runtime/ordinary/security/postgres",
    "agent-runtime/ordinary/provider-access/postgres", "agent-runtime/ordinary/store/postgres", "agent-runtime/ordinary/workspace/node",
    "agent-runtime/ordinary/turn/default", "agent-runtime/setup-security/default", ordinaryHost,
  ]);
  assert.deepEqual(planRows(ordinary.plan.bindings), [
    ...passiveRows(ordinaryHost),
    planRow("agent-runtime/ordinary/process/node", "prepare-launch", "agent-runtime/ordinary/provider/codex", "agent-runtime/ordinary/prepare-launch"),
    planRow("agent-runtime/ordinary/provider-access/postgres", "register-secrets", "agent-runtime/ordinary/security/postgres", "agent-runtime/ordinary/register-secrets"),
    planRow("agent-runtime/ordinary/turn/default", "operation-store", "agent-runtime/ordinary/store/postgres", "agent-runtime/ordinary/store"),
    planRow("agent-runtime/ordinary/turn/default", "security", "agent-runtime/ordinary/security/postgres", "agent-runtime/ordinary/security"),
    planRow("agent-runtime/ordinary/turn/default", "provider-access", "agent-runtime/ordinary/provider-access/postgres", "agent-runtime/ordinary/provider-access"),
    planRow("agent-runtime/ordinary/turn/default", "workspace", "agent-runtime/ordinary/workspace/node", "agent-runtime/ordinary/workspace"),
    planRow("agent-runtime/ordinary/turn/default", "artifacts", "agent-runtime/ordinary/artifacts/node", "agent-runtime/ordinary/artifacts"),
    planRow("agent-runtime/ordinary/turn/default", "process", "agent-runtime/ordinary/process/node", "agent-runtime/ordinary/process"),
    planRow("agent-runtime/ordinary/turn/default", "provider", "agent-runtime/ordinary/provider/codex", "agent-runtime/ordinary/provider"),
    planRow(ordinaryHost, "ordinary-turn", "agent-runtime/ordinary/turn/default", "agent-runtime/ordinary/turn"),
  ].toSorted());
});

test("one declaration per implementation ID across the passive and ordinary compositions", () => {
  const seen = new Map<string, string>();
  for (const declaration of [...runtimeSetupDeclarations, ...runtimeOrdinarySetupDeclarations]) {
    const json = JSON.stringify(declaration);
    assert.equal(seen.get(declaration.implementationId) ?? json, json, declaration.implementationId);
    seen.set(declaration.implementationId, json);
  }
  assert.equal(seen.size, 6 + 2 + 8);
});

test("module identities stay in the product namespace", () => {
  for (const declaration of [...runtimeSetupDeclarations, ...runtimeOrdinarySetupDeclarations]) {
    assert.ok(declaration.moduleId.startsWith("agent-runtime/"), declaration.moduleId);
    assert.equal(declaration.owner.authority, "agent-runtime", declaration.moduleId);
    assert.ok(declaration.implementationId.startsWith(`${declaration.moduleId}/`), declaration.implementationId);
  }
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
  const api = assemblyFor<RuntimeSetupCapabilities>();
  const bound = bindRuntimeSetup(api, createRuntimeSetupFactories(process.platform), () => {}, undefined, {
    factories: {operationStore: forbiddenFactory, security: forbiddenFactory, providerAccess: forbiddenFactory, workspace: forbiddenFactory, artifacts: forbiddenFactory, process: forbiddenFactory, provider: forbiddenFactory},
    decorateHost: host => host,
  });
  const composition = await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile: runtimeOrdinarySetupProfile});
  assert.equal(composition.ok, true);
  const prepared = await api.prepare({composition, factories: bound.factories.slice(1), roots: bound.roots});
  assert.equal(prepared.status, "failed"); assert.equal(calls, 0);
});

async function forbidden(): Promise<never> {throw new Error("TEST port must remain passive", {cause: "synthetic forbidden port"});}
async function prepareLaunch(): Promise<never> {throw new Error("TEST paired launch", {cause: "synthetic launch"});}
function registerSecrets() {return true;}

function createFakeOrdinaryFactories() {
  const ports = {
    store: {accept: forbidden, prepare: forbidden, read: forbidden, claim: forbidden, cancel: forbidden, append: forbidden, finish: forbidden, reconcile: forbidden},
    security: {resolveAndConsume: forbidden},
    access: {resolveAndConsume: forbidden},
    workspace: {prepare: forbidden, snapshot: forbidden, close: forbidden},
    artifacts: {publish: forbidden},
    process: {reserve: forbidden},
    provider: {supported: {provider: "codex", mode: "workspace-write", executionProfile: "user-session-v1", capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1"} as const, execute: forbidden},
  };
  const counts = {calls: 0, created: 0, released: 0};
  // The three owning modules register a fake owner with their module scope, like the real factories do.
  const released = new Set<object>();
  const own = (resources: Resources, name: string) => resources.setup({name, setup: () => {counts.created += 1; return {name};}, cleanup: owner => {
    assert.equal(released.has(owner), false, `${name} released twice`); released.add(owner); counts.released += 1;
  }});
  const factories: OrdinaryRuntimeFactories = {
    operationStore: async () => {counts.calls += 1; return ports.store;},
    security: async resources => {counts.calls += 1; await own(resources, "security-owner"); return {port: ports.security, registerSecrets};},
    providerAccess: async (register, resources) => {counts.calls += 1; assert.equal(register, registerSecrets); await own(resources, "provider-access-owner"); return ports.access;},
    workspace: async () => {counts.calls += 1; return ports.workspace;},
    artifacts: async () => {counts.calls += 1; return ports.artifacts;},
    provider: async resources => {counts.calls += 1; await own(resources, "codex"); return {provider: ports.provider, prepareLaunch};},
    process: async launch => {counts.calls += 1; assert.equal(launch, prepareLaunch); return ports.process;},
  };
  return {ports, counts, factories};
}

test("materialized ordinary root injects the provider owner's launch capability and all seven bindings", async () => {
  const fakes = createFakeOrdinaryFactories();
  const {ports, counts} = fakes;
  const owners = createScope({name: "test-owners"});
  const factories = createRuntimeSetupFactories(process.platform);
  let hostOwner: Parameters<typeof factories.host>[1];
  const api = assemblyFor<RuntimeSetupCapabilities>();
  const bound = bindRuntimeSetup(api, {...factories, host: (dependencies, owner) => {
    hostOwner = owner; return factories.host(dependencies, owner);
  }}, () => {}, undefined, {factories: fakes.factories, decorateHost: host => host});
  try {
    const mismatched = {...runtimeOrdinarySetupProfile, bindings: runtimeOrdinarySetupProfile.bindings.map(binding => binding.consumerImplementationId === "agent-runtime/ordinary/process/node" ? {...binding, providerImplementationIds: ["agent-runtime/ordinary/workspace/node"]} : binding)};
    const invalid = await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile: mismatched});
    assert.equal(invalid.ok, false); assert.equal(counts.calls, 0);
    const composition = await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile: runtimeOrdinarySetupProfile});
    const preparation = await api.prepare({composition, factories: bound.factories, roots: bound.roots});
    assert.equal(preparation.status, "prepared");
    if (preparation.status !== "prepared") {assert.fail(JSON.stringify(preparation));}
    const result = await preparation.prepared.run({scope: owners.resources});
    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") {assert.fail(JSON.stringify(result));}
    const expected = {"agent-runtime/ordinary/store": ports.store, "agent-runtime/ordinary/security": ports.security, "agent-runtime/ordinary/provider-access": ports.access, "agent-runtime/ordinary/workspace": ports.workspace, "agent-runtime/ordinary/artifacts": ports.artifacts, "agent-runtime/ordinary/process": ports.process, "agent-runtime/ordinary/provider": ports.provider, "agent-runtime/ordinary/prepare-launch": prepareLaunch};
    for (const [capability, value] of Object.entries(expected)) {
      const entry = result.created.find(item => Object.hasOwn(item.capabilities, capability));
      assert.ok(entry); assert.equal(Reflect.get(entry.capabilities, capability), value, capability);
    }
    assert.equal(counts.calls, 7);
    assert.equal(hostOwner, result.created.find(entry => entry.implementationId === "agent-runtime/ordinary/turn/default")?.instance);
    await result.roots.host.dispose();
    assert.equal(counts.created, 3); assert.equal(counts.released, 0);
  } finally {
    assert.equal((await owners.control.close()).complete, true);
  }
  assert.equal(counts.released, 3);
});

test("smoke: the ordinary composition root releases every created owner under injected failure and abort", async () => {
  const fakes = createFakeOrdinaryFactories();
  const composition = await compileComposition({declarations: runtimeOrdinarySetupDeclarations, profile: runtimeOrdinarySetupProfile});
  assert.ok(composition.ok);
  const hosts: AgentRuntimeHost[] = [];
  const steps = await smoke({api: assemblyFor<RuntimeSetupCapabilities>(),
    compose: api => composeRuntimeSetup(api, composition, createRuntimeSetupFactories(process.platform), host => {hosts.push(host);}, undefined,
      {factories: fakes.factories, decorateHost: host => host})});
  assert.equal(steps.length, 31, "one run plus fail and abort at each of 15 modules");
  assert.deepEqual(steps.filter(step => step.problem !== undefined), []);
  assert.ok(fakes.counts.created > 0);
  assert.equal(fakes.counts.released, fakes.counts.created);
  for (const host of hosts) {await host.dispose();}
});

test("isolate: the provider module releases its Codex owner exactly once", async () => {
  const fakes = createFakeOrdinaryFactories();
  await using isolated = await isolate(assemblyFor<OrdinaryRuntimeCapabilities>(), {
    declaration: ordinaryProviderDeclaration, factory: createOrdinaryModuleFactories(fakes.factories).provider, dependencies: {}});
  assert.equal(isolated.instance.provider, fakes.ports.provider);
  assert.equal(fakes.counts.created, 1); assert.equal(fakes.counts.released, 0);
  const report = await isolated.close();
  assert.equal(report.complete, true); assert.equal(fakes.counts.released, 1);
});

test("smoke: the passive composition root releases every attempt under injected failure and abort", async () => {
  const composition = await compileComposition({ declarations: runtimeSetupDeclarations, profile: runtimeSetupProfile });
  assert.ok(composition.ok);
  const hosts: AgentRuntimeHost[] = [];
  const steps = await smoke({ api: assemblyFor<RuntimeSetupCapabilities>(),
    compose: api => composeRuntimeSetup(api, composition, createRuntimeSetupFactories(process.platform), host => { hosts.push(host); }) });
  assert.equal(steps.length, 15, "one run plus fail and abort at each of 7 modules");
  assert.deepEqual(steps.filter(step => step.problem !== undefined), []);
  for (const host of hosts) { await host.dispose(); }
});
