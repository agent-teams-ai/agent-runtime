import assert from "node:assert/strict";
import {test} from "node:test";
import {createLinuxCodexNodeRecipe, type LinuxCodexNodeRecipeSelection} from "../dist/composition/linux-codex-node-recipe.js";
import {bindLinuxCodexNodeConsumption} from "../dist/composition/linux-codex-node-recipe-consumption.js";
import type {LinuxCodexDeploymentInfrastructure} from "../dist/composition/linux-codex-deployment.js";
import {policy, createInput, call} from "../../../contexts/agent-execution/tests/fixtures/docker-engine-test-fixture.ts";

type Input = Parameters<LinuxCodexDeploymentInfrastructure["recipe"]>[0];
const input = {kernel: {operationId: "operation-1", attemptId: "attempt-1", custodyId: "custody-1"},
  record: {privateRootPath: "/synthetic/private/operation", boundary: {workspaceRef: "/synthetic/workspaces/operation"}}} as Input;

// Synthetic selection facts only. No daemon, provider, native file installation,
// filesystem preparation, route effect, accepted claim or qualification here.
const fixture = () => {
  const events: string[] = [];
  const {allowedNetworkName: _network, ...enginePolicy} = policy("/synthetic");
  const selection: LinuxCodexNodeRecipeSelection = {
    node: {enginePolicy, custodyJournalRoot: "/synthetic/custody", resourceJournalRoot: "/synthetic/resource",
      nsenter: {path: "/synthetic/nsenter", sha256: "a".repeat(64)}, nft: {path: "/synthetic/nft", sha256: "b".repeat(64)}},
    create: createInput("/synthetic"),
    subjectFacts: {scopeSha256: "c".repeat(64), observerSha256: "d".repeat(64),
      networkHandle: "network-1", listenerHandle: "listener-1", routeHandle: "route-1"},
    initOptions: {authority: {generation: "generation-1"}, isCurrentGeneration: () => false} as LinuxCodexNodeRecipeSelection["initOptions"],
    deadlines: {engineIdentityMs: 100, allocationMs: 100, launchMs: 100, membershipMs: 100,
      cleanupMs: 100, routeMs: 100, routeLifetimeMs: 1000}, cleanupMilliseconds: 100,
    consumptionSubject: {tenantId: "tenant-1", projectId: "project-1", executionGenerationId: "execution-1"},
    localCut: {expectedClock: {authorityId: "clock-1", epoch: "epoch-1"}, operationDeadline: 1000,
      clock: {read: () => ({authorityId: "clock-1", epoch: "epoch-1", controlTime: 1}),
        within: async (_deadline, operation) => operation()}},
    connection: {limits: {deadline: 1000, closureDeadline: 2000}} as LinuxCodexNodeRecipeSelection["connection"],
    consumption: {directory: {path: "/synthetic/consumption", device: "1", inode: "1"}},
    workspaceBackingTreeOwnership: {kind: "exclusive-host-owned-disposable-tree", evidenceRef: "urn:synthetic:workspace-ownership"},
    nativeFileOptions: {catalogSource: new Uint8Array(), ownerUid: 0, ownerGid: 0},
  };
  const factory = () => createLinuxCodexNodeRecipe({hostBootId: "boot-1", hostInstanceId: "host-1",
    select(request) {assert.equal(request, input); events.push("select"); return selection;}});
  return {selection, events, factory};
};

test("Node recipe supplies infrastructure.recipe with actual construction and fixed launch mounts", async () => {
  const f = fixture(); const owner = f.factory();
  const recipe: LinuxCodexDeploymentInfrastructure["recipe"] = owner.recipe;
  const result = recipe(input);
  assert.deepEqual(f.events, ["select"]);
  assert.equal(result.preparation.create.privateRootSource, input.record.privateRootPath);
  assert.equal(result.preparation.create.workspaceSource, input.record.boundary.workspaceRef);
  assert.equal(result.preparation.create.imageDigest, f.selection.create.imageDigest);
  assert.equal(result.preparation.hostLifecycleGenerationSha256, "");
  assert.equal("engineClient" in result.preparation, false);
  assert.equal("allowedNetworkName" in result.preparation.enginePolicy, false);
  assert.equal(typeof result.route.engine.inspect, "function");
  assert.equal(typeof result.preparation.openLifecycle, "function");
  assert.equal(typeof result.preparation.openResourceJournal, "function");
  assert.throws(() => result.hostSession.localAuthorityCut.read(), /not been activated/u);
  assert.equal(result.hostSession.journal.consume({} as never, "fingerprint"), "unknown");
  // The existing finalizer supplies the issued recipe, not this test fixture.
  await assert.rejects(result.nativeFiles.install({} as never), /installation unavailable/u);
  assert.equal(result.nativeFiles.snapshot().binding, "unbound");
  assert.deepEqual(f.events, ["select"]);
  assert.equal(await owner.releaseAfterHostCleanup(call()), "released");
  assert.throws(() => recipe(input), /reservation unavailable/u);
});

test("selection is one-use and captures mutable deployment facts without opening resources", async () => {
  const f = fixture(); const owner = f.factory(); const result = owner.recipe(input);
  const before = result.preparation.create.imageDigest;
  (f.selection.create as {imageDigest: string}).imageDigest = "changed";
  (f.selection.node.nft as {path: string}).path = "/changed";
  (f.selection.deadlines as {routeLifetimeMs: number}).routeLifetimeMs = 999999;
  assert.equal(result.preparation.create.imageDigest, before);
  assert.equal(result.route.nft.path, "/synthetic/nft");
  assert.equal(result.preparation.deadlines.routeLifetimeMs, 1000);
  assert.throws(() => owner.recipe(input), /reservation unavailable/u);
  assert.deepEqual(f.events, ["select"]);
  assert.equal(await owner.releaseAfterHostCleanup(call()), "released");
});

test("missing production joins refuse before Engine or native resource preparation", async () => {
  const f = fixture();
  const {nativeFileOptions: _options, ...unavailable} = f.selection;
  const owner = createLinuxCodexNodeRecipe({hostBootId: "boot-1", hostInstanceId: "host-1", select: () => unavailable});
  assert.throws(() => owner.recipe(input), /native-file installation options/u);
  assert.deepEqual(f.events, []);
  assert.equal(await owner.releaseAfterHostCleanup(call()), "released");
});

test("consumption binder joins observed references and rejects changed subject fields", () => {
  const expected = {operationId: "operation-1", attemptId: "attempt-1", custodyId: "custody-1", tenantId: "tenant-1",
    projectId: "project-1", scopeDigest: `sha256:${"c".repeat(64)}`, hostBootId: "boot-1", hostInstanceId: "host-1",
    executionGenerationId: "execution-1"};
  const references = {selectedDockerAuthorityDigest: `sha256:${"a".repeat(64)}`, networkNamespaceIdentity: "netns:1:2",
    cgroupIdentity: "cgroup:3:4", listenerIdentity: "listener:ipv4:172.30.0.1:43129", signerIdentity: `sha256:${"b".repeat(64)}`};
  const storage = {directory: {path: "/synthetic/consumption", device: "1", inode: "1"}};
  const bound = bindLinuxCodexNodeConsumption(storage, expected);
  const envelope = bound.readEnvelope(references);
  assert.deepEqual(envelope, {...expected, ...references});
  assert.ok(Object.isFrozen(envelope));
  for (const key of Object.keys(expected)) {
    assert.throws(() => bound.readEnvelope({...references, [key]: "wrong-binding"}), /binding mismatch/u);
  }
  storage.directory.path = "/replaced"; expected.operationId = "changed";
  assert.equal(bound.directory.path, "/synthetic/consumption");
  assert.equal(bound.readEnvelope(references).operationId, "operation-1");
});

test("a reentrant selection cannot construct a second owner or reopen closed admission", async () => {
  const f = fixture();
  const owner = createLinuxCodexNodeRecipe({hostBootId: "boot-1", hostInstanceId: "host-1", select(request) {
    assert.throws(() => owner.recipe(request), /reservation unavailable/u);
    void owner.releaseAfterHostCleanup(call());
    return f.selection;
  }});
  assert.throws(() => owner.recipe(input), /closed during selection/u);
  assert.equal(await owner.releaseAfterHostCleanup(call()), "released");
});

test("init selection freezes identity while captured methods observe their original live receiver", async () => {
  const f = fixture();
  const expectedIdentity = {containerImageSha256: "a".repeat(64)};
  const init = {...f.selection.initOptions, generationCurrent: true, observationActive: true, time: 1,
    authority: {...f.selection.initOptions.authority, expectedIdentity},
    isCurrentGeneration(generation: string) {assert.equal(this, init); return this.generationCurrent && generation === "generation-1";},
    isObservationActive() {assert.equal(this, init); return this.observationActive;},
    monotonicNow() {assert.equal(this, init); return this.time;},
    onOutput() {assert.equal(this, init);},
    onRootExit() {assert.equal(this, init);},
    onDrainComplete() {assert.equal(this, init);},
  };
  const owner = createLinuxCodexNodeRecipe({hostBootId: "boot-1", hostInstanceId: "host-1",
    select: () => ({...f.selection, initOptions: init as LinuxCodexNodeRecipeSelection["initOptions"]})});
  const captured = owner.recipe(input).preparation.initOptions;
  expectedIdentity.containerImageSha256 = "b".repeat(64);
  init.generationCurrent = false; init.observationActive = false; init.time = 42;
  init.isCurrentGeneration = () => true; init.isObservationActive = () => true; init.monotonicNow = () => -1;
  assert.equal(captured.authority.expectedIdentity.containerImageSha256, "a".repeat(64));
  assert.ok(Object.isFrozen(captured.authority.expectedIdentity));
  assert.ok(Object.isFrozen(captured.authority)); assert.ok(Object.isFrozen(captured));
  // Rebinding at the later init preparation boundary must retain the selected receiver.
  assert.equal(captured.isCurrentGeneration.bind(captured)("generation-1"), false);
  assert.equal(captured.isObservationActive!.bind(captured)(), false);
  assert.equal(captured.monotonicNow!.bind(captured)(), 42);
  await captured.onOutput!({} as never); await captured.onRootExit!({} as never); await captured.onDrainComplete!({} as never);
  assert.equal(await owner.releaseAfterHostCleanup(call()), "released");
});

test("Node consumption subject must match actual claimed journal handoff before journal IO", () => {
  const f = fixture(); const prepared = f.factory().recipe(input).preparation;
  const attempt = {tenantId: "tenant-1", projectId: "project-1", operationId: "operation-1", attemptId: "attempt-1",
    custodyId: "custody-1", hostBootId: "boot-1", hostInstanceId: "host-1"};
  const subject = {attempt, executionGenerationId: "execution-1", scopeSha256: "c".repeat(64)};
  for (const key of Object.keys(attempt)) {
    assert.throws(() => prepared.openResourceJournal({subject: {...subject, attempt: {...attempt, [key]: "foreign"}}} as never),
      /conflicts with claimed handoff/u);
  }
  for (const key of ["executionGenerationId", "scopeSha256"]) {
    assert.throws(() => prepared.openResourceJournal({subject: {...subject, [key]: "foreign"}} as never),
      /conflicts with claimed handoff/u);
  }
  assert.deepEqual(f.events, ["select"]);
});

test("optional deployment decorator is inert and requires the committed resource subject", async () => {
  const f = fixture();
  const ordinary = f.factory();
  assert.equal(ordinary.recipe(input).preparation.resources.decorateListener, undefined);
  assert.equal(await ordinary.releaseAfterHostCleanup(call()), "released");
  let invoked = false;
  const owner = createLinuxCodexNodeRecipe({hostBootId: "boot-1", hostInstanceId: "host-1",
    select: () => ({...f.selection, decorateListener(listener) {invoked = true; return listener;}})});
  const selected = owner.recipe(input);
  assert.equal(invoked, false);
  assert.throws(() => selected.preparation.resources.decorateListener!({} as never), /subject unavailable/u);
  assert.equal(invoked, false);
  assert.equal(await owner.releaseAfterHostCleanup(call()), "released");
});
