import assert from "node:assert/strict";
import test from "node:test";
import {DockerHttpNetworkResources} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-http-network-resources.js";
import {postClaimFixture} from "./support/docker-linux-post-claim-fixture.ts";
import {createDockerLinuxPostClaimPreparation} from "../../../dist/features/contained-agent-turn/composition/docker-linux-post-claim-preparation.js";
import {createDockerLinuxPostClaimPreparation as packedFactory} from "../../../dist/composition.js";
import {ContainedTurnKernelCustodyAdapter} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-adapter.js";
import type {ContainedTurnKernelCustodyAdapterOptions} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-contracts.js";
import type {ContainedTurnKernelCustodyPort} from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import {containedTurnOperationCutoffRevision} from "../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";
import {v4Decode} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import {v4Replay} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-replay.js";
import {adapterSnapshot, attemptId, authorityDigest, commandId, custodyId, effectId, hostBootId, hostInstanceId,
  operationId, preparationToken, providerAccessSnapshot, workspaceId} from "../../contained-turn-kernel-fixtures.ts";
import {committedDispatchProofFixture} from "./support/committed-dispatch-proof-fixture.ts";

const kinds = (bytes: Uint8Array | null): string[] => bytes === null ? [] : v4Decode(bytes).map(record => record.event.kind);
const SETUP = ["engine-identity", "resource-journal", "create", "attach", "start", "host-handshake"] as const;

test("the packed composition exports the same production post-claim factory", () => {
  assert.equal(packedFactory, createDockerLinuxPostClaimPreparation);
});

test("a missing route admission owner is refused before any allocation", async t => {
  const f = await postClaimFixture(t);
  const {routeAdmission: _absent, ...dependencies} = f.dependencies;
  const preparation = createDockerLinuxPostClaimPreparation(dependencies);
  assert.deepEqual(await preparation.prepareClaimed(f.claimed), {kind: "unsupported", reason: "owner"});
  // The custody contract requires refusal before allocation: nothing was created.
  assert.deepEqual(f.network.state.calls, []);
  assert.deepEqual(f.events, []);
  assert.equal(f.journal, undefined);
});

test("preparation is one-use and refuses a signal that is already cut off", async t => {
  const f = await postClaimFixture(t);
  const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
  f.controller.abort();
  assert.deepEqual(await preparation.prepareClaimed(f.claimed), {kind: "unsupported", reason: "owner"});
  assert.deepEqual(await preparation.prepareClaimed(f.claimed), {kind: "unsupported", reason: "owner"});
  assert.deepEqual(f.network.state.calls, []);
});

test("the network is allocated before the container and the listener binds the observed gateway", async t => {
  const f = await postClaimFixture(t, "192.168.77.1");
  const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
  const result = await preparation.prepareClaimed(f.claimed);

  assert.deepEqual(f.events.filter(event => SETUP.includes(event as never)), [...SETUP]);
  // The Engine policy that created the container carries the derived network name,
  // so NetworkMode named a network that already existed.
  assert.deepEqual(f.policies, [f.network.input.policy.allowedNetworkName]);
  // The synthetic Engine asserts the network exists at create time.
  assert.ok(f.network.state.calls.includes("POST /v1.47/networks/create"));
  // The listener recipe was built from the gateway Docker assigned, not a constant.
  assert.deepEqual(f.physical.recipes, ["192.168.77.1"]);
  assert.equal(f.physical.opens, 1);
  assert.equal(f.physical.consumption, 1);
  // Authenticated init readiness is reached; the provider is still not executable.
  assert.ok(f.events.includes("host-handshake"));
  assert.equal(f.events.includes("provider-exec"), false);
  assert.notEqual(result.kind, "prepared");
});

test("a refused route leaves an acknowledged intent, so the release stays uncertain", async t => {
  const f = await postClaimFixture(t);
  const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
  const result = await preparation.prepareClaimed(f.claimed);
  // The joined observation owners carry the ledger through membership, and the
  // release runs in the reverse of allocation once the route is refused.
  assert.deepEqual(kinds(f.v4Storage.journal), ["opened", "network_intent", "network_allocated",
    "listener_intent", "listener_allocated", "container_attached", "route_intent",
    "cutoff", "cutoff_observed", "container_absent", "listener_release", "listener_absent",
    "network_release", "network_absent"]);
  const ledger = v4Replay(v4Decode(f.v4Storage.journal!), f.subject);
  assert.notEqual(ledger.container, null);
  assert.equal(ledger.listener.phase, 4);
  assert.equal(ledger.network.phase, 4);
  assert.equal(ledger.containerAbsent, true);
  assert.equal(f.routeAdmissions.length, 1);
  assert.ok(f.events.includes("remove"));
  // An acknowledged route intent whose installation was never observed may have
  // left a kernel table behind, so a clean refusal cannot be claimed.
  assert.equal(result.kind, "quarantined");
  assert.equal(f.events.includes("provider-exec"), false);
});

test("the container joins the network only after the listener endpoint is published", async t => {
  const f = await postClaimFixture(t);
  const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
  await preparation.prepareClaimed(f.claimed);
  const setup = kinds(f.v4Storage.journal);
  assert.ok(setup.indexOf("listener_allocated") < setup.indexOf("container_attached"));
  assert.ok(setup.indexOf("container_attached") < setup.indexOf("route_intent"));
  // The listener endpoint is the recipe's own readback, not a caller assertion.
  assert.equal(f.physical.opens, 1);
  const admitted = f.routeAdmissions[0] as {endpoint: {address: string; port: number}};
  assert.deepEqual(admitted.endpoint, {address: f.network.gateway, port: 43_129});
});

test("an installed exclusive route is the only thing that prepares the turn", async t => {
  const f = await postClaimFixture(t);
  f.route.lease = f.syntheticLease();
  const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
  const result = await preparation.prepareClaimed(f.claimed);
  assert.deepEqual(result, {kind: "prepared"});
  assert.deepEqual(kinds(f.v4Storage.journal), ["opened", "network_intent", "network_allocated",
    "listener_intent", "listener_allocated", "container_attached", "route_intent", "route_installed"]);
  const ledger = v4Replay(v4Decode(f.v4Storage.journal!), f.subject);
  assert.equal(ledger.route.phase, 2);
  assert.equal(ledger.reconcileRequired, false);
  // A prepared turn keeps every resource it owns: nothing is released here.
  assert.equal(f.events.includes("remove"), false);
  assert.equal(f.events.includes("route-release"), false);
  assert.equal(ledger.network.phase, 2);
});

test("the installed lease publishes its first-write authority once, after the ledger observed it", async t => {
  const f = await postClaimFixture(t);
  const reservations: string[] = [];
  f.route.lease = Object.freeze({...f.syntheticLease(),
    reserveFirstWrite: (_binding: unknown, requestId: string) => {
      reservations.push(requestId); return {consume: () => false};}});
  const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
  assert.deepEqual(await preparation.prepareClaimed(f.claimed), {kind: "prepared"});
  assert.equal(f.publishedFirstWrites.length, 1);
  // The broker's gate is handed over only after the installation was observed.
  const observed = f.events.indexOf("route-first-write");
  assert.ok(observed > f.events.indexOf("route-admission"));
  assert.deepEqual(kinds(f.v4Storage.journal).at(-1), "route_installed");
  // Reservation stays with the lease: the published port only forwards the id.
  const port = f.publishedFirstWrites[0] as {reserve(requestId: string): {consume(): boolean}};
  assert.equal(port.reserve("request:1").consume(), false);
  assert.deepEqual(reservations, ["request:1"]);
});

test("a refused first-write publication fails the preparation instead of admitting the turn", async t => {
  const f = await postClaimFixture(t);
  f.route.lease = f.syntheticLease();
  f.hooks["route-first-write"] = () => {throw new TypeError("synthetic broker session refusal");};
  const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
  const result = await preparation.prepareClaimed(f.claimed);
  assert.notEqual(result.kind, "prepared");
  assert.deepEqual(f.events.filter(event => ["remove", "route-release"].includes(event)), ["remove", "route-release"]);
});

test("the route lease releases its namespace only after the container is gone", async t => {
  const f = await postClaimFixture(t);
  f.route.lease = f.syntheticLease();
  f.hooks["route-admission"] = () => {f.controller.abort();};
  const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
  const result = await preparation.prepareClaimed(f.claimed);
  assert.notEqual(result.kind, "prepared");
  const order = f.events.filter(event => ["remove", "route-release"].includes(event));
  assert.deepEqual(order, ["remove", "route-release"]);
});

for (const [release, expected] of [["closed", {kind: "unsupported", reason: "owner"}],
  ["quarantined", {kind: "quarantined"}]] as const) {
  test(`a ${release} route release decides the verdict of an installed but cut off route`, async t => {
    const f = await postClaimFixture(t);
    f.route.lease = f.syntheticLease();
    f.route.release = release;
    // The route is installed and observed, then the caller cuts off. Everything
    // else releases cleanly, so only the lease's own outcome is left to decide.
    f.hooks["route-admission"] = () => {f.controller.abort();};
    const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
    assert.deepEqual(await preparation.prepareClaimed(f.claimed), expected);
    assert.ok(kinds(f.v4Storage.journal).includes("route_installed"));
    assert.ok(f.events.includes("route-release"));
  });
}

for (const [fault, expected] of [["identity", {kind: "unsupported", reason: "network"}],
  ["journal", {kind: "unsupported", reason: "journal"}]] as const) {
  test(`a ${fault} failure before allocation refuses without an Engine effect`, async t => {
    const f = await postClaimFixture(t);
    f.faults[fault] = true;
    const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
    assert.deepEqual(await preparation.prepareClaimed(f.claimed), expected);
    assert.deepEqual(f.network.state.calls, []);
    assert.equal(f.physical.opens, 0);
  });
}

test("a launch failure retains the network it cannot prove absent", async t => {
  const f = await postClaimFixture(t);
  f.faults.launch = true;
  const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
  // The container was created but never handed back an authority, so there is
  // no handle to contain and nothing can prove this attempt left no residue.
  assert.deepEqual(await preparation.prepareClaimed(f.claimed), {kind: "quarantined"});
  assert.ok(f.network.state.calls.includes("POST /v1.47/networks/create"));
  assert.equal(f.routeAdmissions.length, 0);
  assert.equal(f.events.includes("provider-exec"), false);
});

test("a listener failure releases everything it allocated and refuses cleanly", async t => {
  const f = await postClaimFixture(t);
  f.faults.listener = true;
  const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
  // Nothing was routed and every effect was proven released, so this is the
  // typed refusal the custody contract asks for, not retained ownership.
  assert.deepEqual(await preparation.prepareClaimed(f.claimed), {kind: "unsupported", reason: "broker"});
  assert.ok(f.network.state.calls.includes("POST /v1.47/networks/create"));
  const ledger = v4Replay(v4Decode(f.v4Storage.journal!), f.subject);
  assert.equal(ledger.network.phase, 4);
  assert.equal(ledger.listener.phase, 4);
  assert.equal(f.routeAdmissions.length, 0);
  assert.equal(f.events.includes("provider-exec"), false);
});

test("an unremovable network keeps its ownership instead of refusing cleanly", async t => {
  const f = await postClaimFixture(t);
  f.faults.listener = true;
  f.network.state.removeFault = "lost-before";
  const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
  assert.deepEqual(await preparation.prepareClaimed(f.claimed), {kind: "quarantined"});
  assert.notEqual(v4Replay(v4Decode(f.v4Storage.journal!), f.subject).network.phase, 4);
});

for (const step of ["engine-identity", "resource-journal", "create", "start", "host-handshake"] as const) {
  test(`a cut off at ${step} stops preparation and leaves nothing prepared`, async t => {
    const f = await postClaimFixture(t);
    f.hooks[step] = () => {f.controller.abort();};
    const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
    const result = await preparation.prepareClaimed(f.claimed);
    assert.notEqual(result.kind, "prepared");
    assert.equal(f.routeAdmissions.length, 0);
    assert.equal(f.events.includes("provider-exec"), false);
    if (step === "engine-identity" || step === "resource-journal") {
      assert.deepEqual(f.network.state.calls, []);
      assert.equal(f.physical.opens, 0);
      assert.deepEqual(result, {kind: "unsupported", reason: step === "engine-identity" ? "network" : "journal"});
    } else {
      // Release is not admission: a cut caller still gets its resources released,
      // and only what cannot be proven absent stays quarantined.
      assert.ok(f.network.state.calls.includes("POST /v1.47/networks/create"));
      assert.equal(result.kind, "unsupported");
    }
  });
}

/** The kernel custody adapter must never reach input.execute when this owner
 * refuses, which is the production default while the route owner is unwired. */
test("the custody adapter never calls execute for the default production wiring", async t => {
  const f = await postClaimFixture(t);
  const {routeAdmission: _absent, ...dependencies} = f.dependencies;
  const calls: string[] = [];
  const options: ContainedTurnKernelCustodyAdapterOptions = {
    postClaimPreparation: createDockerLinuxPostClaimPreparation(dependencies),
    hostBootId, hostInstanceId, completionAfterMs: 100, startObservationAfterMs: 5,
    workspaceOwner: {async withLaunchAuthority(_input, consume) {
      return consume({canonicalPath: "/synthetic/disposable", descriptorPath: "/synthetic/descriptor",
        identity: {dev: 1n, ino: 2n, mountId: "mount:synthetic"}});
    }},
    attemptOwner: {
      async prepare() {
        return {arguments: [], binaryRevision: adapterSnapshot.binaryRevision, containmentProfile: "strict-linux-cgroup-v2",
          environment: {}, executablePath: "/synthetic/provider", executableSha256: "a".repeat(64), intentMode: "analysis",
          provider: "codex", privateRootPath: "/synthetic/private", spawnMode: "sdk-delegated"};
      },
      retain() {}, retire() {},
    },
  };
  const custody = new ContainedTurnKernelCustodyAdapter({
    reserve: async () => ({custodyRef: "host:retained"}),
    open: async () => {throw new Error("not the reservation seam");},
    evidence: (): undefined => {},
    requestContainment: async () => {calls.push("contain"); return {kind: "contained" as const, receiptRef: "receipt:synthetic"};},
    release: async () => ({kind: "released" as const}),
  }, options);
  const openInput: Parameters<ContainedTurnKernelCustodyPort["open"]>[0] = Object.freeze({
    adapterSnapshot, attemptId, authorityVectorDigest: authorityDigest, commandId, custodyId, effectId,
    intentMode: "analysis", operationId, operationCutoffRevision: containedTurnOperationCutoffRevision(0),
    operationRevision: 1, preparationToken, providerAccessSnapshot, workspaceId,
  });
  const opened = await custody.open(openInput);
  const started = await custody.start({attemptId, custodyId, intentMode: "analysis", operationId, workspaceId,
    committedDispatchProof: committedDispatchProofFixture(openInput, opened),
    async execute() {calls.push("execute"); return {kind: "completed" as const, outcome: "succeeded" as const};}});
  assert.equal(started.kind, "indeterminate");
  assert.deepEqual(calls, ["contain"]);
  assert.deepEqual(f.network.state.calls, []);
});

// The seam's test owner opens the actual retained init once. It stands in for
// the separate bridge IO issuer; these tests make no bridge-output proof.
const {createDockerLinuxPostClaimOwner} = await import("../../../dist/features/contained-agent-turn/composition/docker-linux-post-claim-preparation.js");
const {createCodexAppServerLaunchPlan} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js");
const {brokerFixture} = await import("../../fixtures/codex-native-broker-0.153.4/fixture.ts");
const {deferred} = await import("../../fixtures/docker-operation-network-fixture.ts");
const joinedFixture = async (t: import("node:test").TestContext) => {
  const f = await postClaimFixture(t);
  f.route.lease = f.syntheticLease();
  const plan = createCodexAppServerLaunchPlan(brokerFixture(t).launchOptions);
  let io: unknown; let launch: unknown; let opens = 0; let finishes = 0;
  const join = {
    prepareProviderIo(input: Parameters<import("../../../dist/features/contained-agent-turn/composition/docker-linux-post-claim-preparation.js").DockerLinuxClaimedJoin<import("../../../dist/features/contained-agent-turn/composition/docker-linux-post-claim-preparation.js").DockerLinuxPreparedProviderIo>["prepareProviderIo"]>[0]) {
      opens += 1; launch = input.launch;
      const session = input.launch.openInitSession(input.init);
      const result = Object.freeze({ready: () => session.ready()}); io = result; return result;
    },
    async finishClaimed(input: {providerIo: unknown; launch: unknown}) {
      finishes += 1;
      assert.equal(input.providerIo, io); assert.equal(input.launch, launch);
      assert.equal(kinds(f.v4Storage.journal).at(-1), "route_installed");
      return {plan};
    },
  };
  return {f, plan, join, get io() {return io;}, get launch() {return launch;},
    counts: () => ({opens, finishes})};
};

test("joined owners are required before allocation", async t => {
  const f = await postClaimFixture(t);
  for (const join of [undefined, {}, {prepareProviderIo() {}}]) {
    assert.throws(() => createDockerLinuxPostClaimOwner(f.dependencies, join as never), /requires IO and finalization/u);
  }
  assert.deepEqual(f.events, []); assert.deepEqual(f.network.state.calls, []);
});

test("success retains exact one-use handoff and cleanup after take", async t => {
  const j = await joinedFixture(t); const {f} = j;
  const owner = createDockerLinuxPostClaimOwner(f.dependencies, j.join);
  assert.throws(() => owner.takePrepared(f.claimed));
  assert.deepEqual(await owner.preparation.prepareClaimed(f.claimed), {kind: "prepared"});
  assert.throws(() => owner.takePrepared({...f.claimed}));
  const handoff = owner.takePrepared(f.claimed);
  assert.equal(handoff.providerIo, j.io); assert.equal(handoff.launch, j.launch); assert.equal(handoff.plan, j.plan);
  assert.throws(() => owner.takePrepared(f.claimed));
  assert.deepEqual(j.counts(), {opens: 1, finishes: 1});
  assert.equal(f.publishedFirstWrites.length, 0);
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 5000}), {kind: "released"});
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 5000}), {kind: "released"});
  assert.equal(f.events.filter(e => e === "remove").length, 1);
  assert.equal(f.events.filter(e => e === "route-release").length, 1);
  assert.equal(f.physical.closes, 1);
});

test("unknown container absence keeps route ownership sticky", async t => {
  const j = await joinedFixture(t); const {f} = j;
  const owner = createDockerLinuxPostClaimOwner(f.dependencies, j.join);
  assert.deepEqual(await owner.preparation.prepareClaimed(f.claimed), {kind: "prepared"});
  t.mock.method(f.engine, "remove", async () => {throw new Error("lost removal acknowledgement");});
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 5000}), {kind: "quarantined"});
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 5000}), {kind: "quarantined"});
  assert.equal(f.events.includes("route-release"), false);
  assert.throws(() => owner.takePrepared(f.claimed));
});

for (const failure of ["throw", "unissued-plan"] as const) {
  test(`finish hook ${failure} prevents publication and retains cleanup`, async t => {
    const j = await joinedFixture(t); const {f} = j;
    const owner = createDockerLinuxPostClaimOwner(f.dependencies, {...j.join, async finishClaimed() {
      if (failure === "throw") {throw new Error("lost finalization acknowledgement");}
      return {plan: {...j.plan}};
    }});
    assert.notEqual((await owner.preparation.prepareClaimed(f.claimed)).kind, "prepared");
    assert.throws(() => owner.takePrepared(f.claimed));
    assert.equal(f.events.filter(e => e === "remove").length, 1);
    await owner.cleanup({deadlineEpochMs: Date.now() + 5000});
    assert.equal(f.events.filter(e => e === "remove").length, 1);
  });
}

test("cleanup timeout detaches its waiter while late finalization remains owned", async t => {
  const j = await joinedFixture(t); const {f} = j;
  const entered = deferred(); const release = deferred();
  const owner = createDockerLinuxPostClaimOwner(f.dependencies, {...j.join, async finishClaimed(input) {
    entered.resolve(); await release.promise; return j.join.finishClaimed(input);
  }});
  const preparing = owner.preparation.prepareClaimed(f.claimed);
  await entered.promise;
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 10}), {kind: "quarantined"});
  assert.equal(f.events.includes("remove"), false, "pending finalizer is joined before resource release");
  release.resolve();
  assert.notEqual((await preparing).kind, "prepared");
  assert.throws(() => owner.takePrepared(f.claimed));
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 5000}), {kind: "released"});
  assert.equal(f.events.filter(e => e === "remove").length, 1);
});

test("a retained cleanup flight survives a waiter timing out during removal", async t => {
  const j = await joinedFixture(t); const {f} = j;
  const owner = createDockerLinuxPostClaimOwner(f.dependencies, j.join);
  await owner.preparation.prepareClaimed(f.claimed);
  const entered = deferred(); const release = deferred();
  const removal = f.engine.remove.bind(f.engine);
  let calls = 0;
  t.mock.method(f.engine, "remove", async (...args) => {
    calls += 1; entered.resolve(); await release.promise; return removal(...args);
  });
  const waiting = owner.cleanup({deadlineEpochMs: Date.now() + 10});
  await entered.promise; assert.deepEqual(await waiting, {kind: "quarantined"});
  const next = owner.cleanup({deadlineEpochMs: Date.now() + 5000});
  release.resolve(); assert.deepEqual(await next, {kind: "released"}); assert.equal(calls, 1);
});

test("late launch acknowledgement after cleanup timeout remains owned", async t => {
  const j = await joinedFixture(t); const {f} = j;
  const entered = deferred(); const release = deferred();
  const start = f.engine.start.bind(f.engine);
  t.mock.method(f.engine, "start", async (...args) => {
    await start(...args); entered.resolve(); await release.promise;
  });
  const owner = createDockerLinuxPostClaimOwner(f.dependencies, j.join);
  const preparing = owner.preparation.prepareClaimed(f.claimed);
  await entered.promise;
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 10}), {kind: "quarantined"});
  release.resolve();
  assert.notEqual((await preparing).kind, "prepared");
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 5000}), {kind: "released"});
  assert.equal(f.events.filter(e => e === "create").length, 1);
  assert.equal(f.events.filter(e => e === "remove").length, 1);
  assert.deepEqual(j.counts(), {opens: 0, finishes: 0});
});

test("lost start acknowledgement joins retained create authority cleanup without retrying launch", async t => {
  const j = await joinedFixture(t); const {f} = j;
  const start = f.engine.start.bind(f.engine);
  t.mock.method(f.engine, "start", async (...args) => {await start(...args); throw new Error("lost start acknowledgement");});
  const owner = createDockerLinuxPostClaimOwner(f.dependencies, j.join);
  assert.equal((await owner.preparation.prepareClaimed(f.claimed)).kind, "unsupported");
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 5000}), {kind: "released"});
  assert.equal(f.events.filter(e => e === "remove").length, 1);
  assert.equal((await owner.preparation.prepareClaimed(f.claimed)).kind, "unsupported");
  assert.equal(f.events.filter(e => e === "create").length, 1);
  assert.equal(f.events.includes("route-release"), false);
});

test("caller cancellation during finalization cannot publish a late success", async t => {
  const j = await joinedFixture(t); const {f} = j;
  const entered = deferred(); const release = deferred();
  const owner = createDockerLinuxPostClaimOwner(f.dependencies, {...j.join, async finishClaimed(input) {
    entered.resolve(); await release.promise; return j.join.finishClaimed(input);
  }});
  const preparing = owner.preparation.prepareClaimed(f.claimed);
  await entered.promise; f.controller.abort(); release.resolve();
  assert.notEqual((await preparing).kind, "prepared");
  assert.throws(() => owner.takePrepared(f.claimed));
  assert.equal(f.events.filter(e => e === "remove").length, 1);
  assert.equal(f.events.filter(e => e === "route-release").length, 1);
});

test("post-claim launch retains immutable admission and independent bounded observation calls", async t => {
  const j = await joinedFixture(t); const {f} = j;
  const launch = f.lifecycle.launch.bind(f.lifecycle);
  let captured: Parameters<typeof launch>[0] | undefined;
  f.lifecycle.launch = async input => {captured = input; return launch(input);};
  const before = Date.now();
  const owner = createDockerLinuxPostClaimOwner(f.dependencies, j.join);
  assert.deepEqual(await owner.preparation.prepareClaimed(f.claimed), {kind: "prepared"});
  assert.ok(captured?.lifetime);
  const {admission, observation} = captured.lifetime;
  assert.ok(admission.deadlineEpochMs >= before + f.dependencies.deadlines.routeLifetimeMs);
  assert.equal(observation.deadlineEpochMs, admission.deadlineEpochMs + f.dependencies.deadlines.cleanupMs);
  const original = admission.deadlineEpochMs;
  owner.cutoff();
  assert.equal(admission.signal.aborted, true);
  assert.equal(observation.signal.aborted, false);
  assert.equal(observation.isActive(), true);
  assert.equal(admission.deadlineEpochMs, original);
  await owner.cleanup({deadlineEpochMs: Date.now() + 5000});
  assert.equal(observation.signal.aborted, true);
  assert.equal(observation.isActive(), false);
});

// These tests use the retained production owners over the synthetic Engine.
test("failed cleanup recovers with fresh observations and concurrent retries share one flight", async t => {
  const j = await joinedFixture(t); const {f} = j;
  const launch = f.lifecycle.launch.bind(f.lifecycle);
  let lifetime: Parameters<typeof launch>[0]["lifetime"] | undefined;
  f.lifecycle.launch = async input => {lifetime = input.lifetime; return launch(input);};
  const owner = createDockerLinuxPostClaimOwner(f.dependencies, {...j.join, async finishClaimed() {
    f.network.state.inspectFault = true;
    throw new Error("finalization failed before network cleanup could observe closure");
  }});
  assert.deepEqual(await owner.preparation.prepareClaimed(f.claimed), {kind: "quarantined"});
  assert.ok(lifetime);
  const originalDeadline = lifetime.observation.deadlineEpochMs;
  assert.equal(lifetime.admission.signal.aborted, true);
  assert.equal(lifetime.observation.signal.aborted, false);
  assert.equal(lifetime.observation.isActive(), true);
  assert.notEqual(f.network.state.network, undefined);
  const before = f.network.state.calls.length;
  f.network.state.inspectFault = false;
  const entered = deferred(); const release = deferred();
  let observations = 0;
  f.network.state.before = async label => {
    if (label.startsWith("GET /v1.47/networks/")) {
      observations += 1;
      if (observations === 1) {entered.resolve(); await release.promise;}
    }
  };
  const first = owner.cleanup({deadlineEpochMs: Date.now() + 5000});
  await entered.promise;
  const second = owner.cleanup({deadlineEpochMs: Date.now() + 5000});
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.equal(observations, 1);
  assert.throws(() => owner.takePrepared(f.claimed));
  assert.deepEqual(await owner.preparation.prepareClaimed(f.claimed), {kind: "unsupported", reason: "owner"});
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [{kind: "released"}, {kind: "released"}]);
  assert.ok(f.network.state.calls.length > before);
  assert.equal(f.network.state.network, undefined);
  assert.equal(v4Replay(v4Decode(f.v4Storage.journal!), f.subject).network.phase, 4);
  assert.equal(lifetime.observation.deadlineEpochMs, originalDeadline);
  assert.equal(lifetime.observation.signal.aborted, true);
  assert.equal(f.events.filter(event => event === "create").length, 1);
  assert.equal(f.events.filter(event => event === "remove").length, 1);
  assert.equal(f.events.filter(event => event === "route-release").length, 1);
  assert.equal(f.physical.closes, 1);
  assert.equal(f.network.state.calls.filter(call => call.startsWith("DELETE ")).length, 1);
  const completedCalls = [...f.network.state.calls];
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 5000}), {kind: "released"});
  assert.deepEqual(f.network.state.calls, completedCalls);
});

test("allocated beforeLaunch failure retries cleanup but cannot invent V2 no-creation evidence", async t => {
  const f = await postClaimFixture(t);
  const cleanup = DockerHttpNetworkResources.prototype.cleanupNetwork;
  let attempts = 0; let launchPreparations = 0; let lateEffects = 0;
  t.mock.method(DockerHttpNetworkResources.prototype, "cleanupNetwork", function (this: DockerHttpNetworkResources) {
    attempts += 1;
    return cleanup.call(this);
  });
  const forbidden = (): never => {
    lateEffects += 1;
    throw new Error("provider IO and finalization are unreachable");
  };
  const owner = createDockerLinuxPostClaimOwner(f.dependencies, {
    async beforeLaunch() {
      launchPreparations += 1;
      assert.notEqual(f.network.state.network, undefined);
      throw new Error("image preparation failed after allocation");
    },
    prepareProviderIo: forbidden,
    finishClaimed: forbidden,
  });
  assert.deepEqual(await owner.preparation.prepareClaimed(f.claimed), {kind: "quarantined"});
  assert.equal(attempts, 1);
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 5000}), {kind: "quarantined"});
  assert.equal(attempts, 2, "a settled failure must reach the actual network owner again");
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 5000}), {kind: "quarantined"});
  assert.equal(attempts, 3);
  // The supplied V2 issuer has no no-creation port. V4 must reject release
  // before Engine deletion, even though composition never invoked launch.
  const ledger = v4Replay(v4Decode(f.v4Storage.journal!), f.subject);
  assert.equal(ledger.containerAbsent, false);
  assert.equal(ledger.network.phase, 2);
  assert.equal(kinds(f.v4Storage.journal).includes("network_release"), false);
  assert.equal(f.network.state.calls.some(call => call.startsWith("DELETE ")), false);
  assert.notEqual(f.network.state.network, undefined);
  assert.equal(launchPreparations, 1);
  assert.equal(lateEffects, 0);
  assert.equal(f.events.includes("create"), false);
  assert.equal(f.routeAdmissions.length, 0);
  assert.equal(f.physical.opens, 0);
  assert.throws(() => owner.takePrepared(f.claimed));
});

test("invalid and expired cleanup waiters schedule no new cleanup effects and permanently cut admission", async t => {
  const j = await joinedFixture(t); const {f} = j;
  const owner = createDockerLinuxPostClaimOwner(f.dependencies, j.join);
  assert.deepEqual(await owner.preparation.prepareClaimed(f.claimed), {kind: "prepared"});
  const calls = [...f.network.state.calls];
  const events = [...f.events];
  for (const deadlineEpochMs of [NaN, Infinity, 1.5, Date.now() - 1]) {
    assert.deepEqual(await owner.cleanup({deadlineEpochMs}), {kind: "quarantined"});
    await new Promise<void>(resolve => {setImmediate(resolve);});
    assert.deepEqual(f.network.state.calls, calls);
    assert.deepEqual(f.events, events);
    assert.equal(f.physical.closes, 0);
  }
  assert.throws(() => owner.takePrepared(f.claimed));
  assert.deepEqual(await owner.preparation.prepareClaimed(f.claimed), {kind: "unsupported", reason: "owner"});
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 5000}), {kind: "released"});
  assert.equal(f.events.filter(event => event === "create").length, 1);
});

test("cleanup before entry permanently forbids allocation even with an invalid deadline", async t => {
  const j = await joinedFixture(t); const {f} = j;
  const owner = createDockerLinuxPostClaimOwner(f.dependencies, j.join);
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: NaN}), {kind: "quarantined"});
  assert.deepEqual(await owner.preparation.prepareClaimed(f.claimed), {kind: "unsupported", reason: "owner"});
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.network.state.calls, []);
  assert.deepEqual(j.counts(), {opens: 0, finishes: 0});
});

test("failed cleanup cannot renew its original observation lifetime", async t => {
  const j = await joinedFixture(t); const {f} = j;
  const launch = f.lifecycle.launch.bind(f.lifecycle);
  let lifetime: Parameters<typeof launch>[0]["lifetime"] | undefined;
  f.lifecycle.launch = async input => {lifetime = input.lifetime; return launch(input);};
  const owner = createDockerLinuxPostClaimOwner(f.dependencies, {...j.join, async finishClaimed() {
    f.network.state.inspectFault = true;
    throw new Error("retain failed cleanup");
  }});
  assert.deepEqual(await owner.preparation.prepareClaimed(f.claimed), {kind: "quarantined"});
  assert.ok(lifetime);
  const deadline = lifetime.observation.deadlineEpochMs;
  assert.equal(lifetime.observation.signal.aborted, false);
  const calls = [...f.network.state.calls];
  const events = [...f.events];
  f.network.state.inspectFault = false;
  t.mock.method(Date, "now", () => deadline);
  assert.equal(lifetime.observation.isActive(), false);
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: deadline + 5000}), {kind: "quarantined"});
  assert.deepEqual(f.network.state.calls, calls);
  assert.deepEqual(f.events, events);
  assert.equal(lifetime.observation.deadlineEpochMs, deadline);
  assert.notEqual(f.network.state.network, undefined);
});
