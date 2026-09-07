import assert from "node:assert/strict";
import test from "node:test";
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

test("a quarantined route release keeps the whole preparation quarantined", async t => {
  const f = await postClaimFixture(t);
  f.route.release = "quarantined";
  const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
  assert.deepEqual(await preparation.prepareClaimed(f.claimed), {kind: "quarantined"});
  assert.ok(f.events.includes("route-release"));
});

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
      assert.equal(result.kind, step === "host-handshake" ? "unsupported" : "quarantined");
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
