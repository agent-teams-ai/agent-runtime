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

test("membership stays unpublished while no owner can observe the listener", async t => {
  const f = await postClaimFixture(t);
  const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
  const result = await preparation.prepareClaimed(f.claimed);
  // container_attached requires listener_allocated, and this revision has no
  // listener observation owner, so the resource ledger stops at listener_intent.
  assert.deepEqual(kinds(f.v4Storage.journal),
    ["opened", "network_intent", "network_allocated", "listener_intent", "uncertain"]);
  const ledger = v4Replay(v4Decode(f.v4Storage.journal!), f.subject);
  assert.equal(ledger.container, null);
  assert.equal(ledger.listener.phase, 1);
  assert.equal(ledger.reconcileRequired, true);
  // The route owner is never consulted for a container that never joined.
  assert.equal(f.routeAdmissions.length, 0);
  // The container is contained, the network keeps its retained ownership.
  assert.ok(f.events.includes("remove"));
  assert.equal(ledger.network.phase, 2);
  assert.equal(result.kind, "quarantined");
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

for (const fault of ["launch", "listener"] as const) {
  test(`a ${fault} failure after allocation retains the network it cannot prove absent`, async t => {
    const f = await postClaimFixture(t);
    f.faults[fault] = true;
    const preparation = createDockerLinuxPostClaimPreparation(f.dependencies);
    const result = await preparation.prepareClaimed(f.claimed);
    assert.equal(result.kind, "quarantined");
    assert.ok(f.network.state.calls.includes("POST /v1.47/networks/create"));
    assert.equal(f.routeAdmissions.length, 0);
    assert.equal(f.events.includes("provider-exec"), false);
  });
}

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
      // Past the first Engine effect nothing can be reported as a clean refusal:
      // the network stays retained until an owner can prove it absent.
      assert.equal(result.kind, "quarantined");
      assert.ok(f.network.state.calls.includes("POST /v1.47/networks/create"));
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
