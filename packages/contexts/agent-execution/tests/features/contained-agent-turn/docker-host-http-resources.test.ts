import assert from "node:assert/strict";
import test from "node:test";
import { fixture as hostFixture } from "./node-custody-http-reservation-fixture.ts";
import { networkFixture } from "../../fixtures/docker-operation-network-fixture.ts";
const {createDockerHostHttpResources} = await import("../../../dist/features/contained-agent-turn/composition/docker-host-http-resources.js");

test("composition rejects structural Host preparation suppliers before any Engine IO", () => {
  const network = networkFixture();
  assert.throws(() => createDockerHostHttpResources({host: {httpPreparation: () => ({acquire() {}})},
    network: network.resourceInput, hostLifecycleGenerationSha256: "a".repeat(64)}));
  assert.deepEqual(network.state.calls, []);
});

test("composition is inert and genuine Host reservation acquisition precedes network preparation", async () => {
  const host = hostFixture(); const network = networkFixture();
  const product = createDockerHostHttpResources({host: host.core, network: network.resourceInput,
    hostLifecycleGenerationSha256: "a".repeat(64)});
  assert.deepEqual(network.state.calls, []);
  assert.equal(product.observationOwner.readObservation({kind: "listener_allocated"}), undefined);
  await assert.rejects(product.prepare({} as never, host.handoff("foreign-reservation") as never, {} as never, Date.now() + 5_000));
  assert.deepEqual(network.state.calls, []);
});

test("current Host lifecycle generation mismatch prevents allocation after a real reservation claim", async () => {
  const host = hostFixture(); const network = networkFixture(); const reservation = await host.reserve();
  const product = createDockerHostHttpResources({host: host.core, network: network.resourceInput,
    hostLifecycleGenerationSha256: "a".repeat(64)});
  await assert.rejects(product.prepare({} as never, host.handoff(reservation.custodyRef) as never,
    {} as never, Date.now() + 5_000), /generation changed/u);
  assert.deepEqual(network.state.calls, []);
});

// Concrete Host reservation/resources and Docker owners, with explicit synthetic
// leaf resource recipes. These fixtures issue no Host physical observation token.
const {HostHttpEgressV4Journal} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-journal.js");
const {v4Hash, v4Decode, v4Replay} = {
  ...await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js"),
  ...await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-replay.js"),
};
const {MemoryV4Storage} = await import("../../fixtures/host-http-egress-v4-fixture.ts");
const {deferred} = await import("../../fixtures/docker-operation-network-fixture.ts");

const preparedFixture = async (address = "172.30.0.1") => {
  const host = hostFixture(); const template = networkFixture().subject;
  const reservation = await host.core.reserve({...host.reservation,
    operationId: template.attempt.operationId, attemptId: template.attempt.attemptId} as never);
  const proof = host.proofFor({hostBootId: template.attempt.hostBootId, hostInstanceId: template.attempt.hostInstanceId,
    hostCustodyProof: {proofId: "proof:synthetic-composition"}}, {
    tenantId: template.attempt.tenantId, projectId: template.attempt.projectId, operationId: template.attempt.operationId,
    attemptId: template.attempt.attemptId, custodyId: template.attempt.custodyId, effectId: template.effectId,
    workspaceId: template.workspaceId, executionGenerationId: template.executionGenerationId});
  const handoff = {underlyingCustodyRef: reservation.custodyRef, signal: host.signal.signal, committedDispatchProof: proof};
  const network = networkFixture({...template, attempt: {...template.attempt, tenantId: proof.tenantId,
    projectId: proof.projectId, operationId: proof.operationId, attemptId: proof.attemptId, custodyId: proof.custodyId,
    hostInstanceId: proof.hostInstanceId, hostBootId: proof.hostBootId},
    effectId: proof.effectId, workspaceId: proof.workspaceId, executionGenerationId: proof.executionGenerationId,
    committedClaimSha256: proof.proofDigest.slice(7), acceptedAuthoritySha256: proof.acceptedAuthorityVectorDigest.slice(7)});
  const product = createDockerHostHttpResources({host: host.core, network: network.resourceInput,
    hostLifecycleGenerationSha256: host.live().identity.hostLifecycleGenerationSha256});
  const storage = new MemoryV4Storage(); const journal = new HostHttpEgressV4Journal(storage, network.subject, product.observationOwner);
  await journal.prepare(`command:${v4Hash("open-composition")}`);
  const physical = {opens: 0, seals: 0, closes: 0, consumption: 0, firstWrites: 0, sealed: false};
  const listener = {
    async open() {
      physical.opens += 1;
      assert.equal(v4Replay(v4Decode(storage.journal!), network.subject).listener.phase, 1);
      return {address: {address, family: "IPv4", port: 43129}, sealAdmission: listener.sealAdmission,
        close: listener.close};
    },
    sealAdmission() {physical.seals += 1; physical.sealed = true;},
    async close() {physical.closes += 1; return {state: "closed"};},
  };
  const resources = {listener,
    consumption: {async prepare() {physical.consumption += 1;
      return {kind: "ready", journal: {}, quarantine() {}, async retire() {return "retired";}};}},
    accept: async () => {if (physical.sealed) {throw new Error("synthetic admission cut");} physical.firstWrites += 1;},
    localCut: {expectedClock: {authorityId: "synthetic-clock", epoch: "1"},
      clock: {read: () => ({authorityId: "synthetic-clock", epoch: "1", controlTime: 1}),
        within: async (_deadline: number, action: () => Promise<unknown>) => action()}, operationDeadline: 20_000},
  };
  return {host, handoff, network, product, storage, journal, physical, resources,
    prepare: () => product.prepare(journal, handoff as never, resources as never, Date.now() + 5_000)};
};

test("real post-claim composition prepares the existing Host resources without inventing V4 observations", async () => {
  const f = await preparedFixture(); const result = await f.prepare();
  assert.equal(result.kind, "prepared"); assert.equal(f.physical.opens, 1); assert.equal(f.physical.consumption, 1);
  assert.deepEqual(v4Decode(f.storage.journal!).map(record => record.event.kind),
    ["opened", "network_intent", "network_allocated", "listener_intent"]);
  assert.equal(f.product.observationOwner.readObservation({kind: "listener_allocated"}), undefined);
  f.host.signal.abort();
  assert.equal(f.physical.sealed, true, "Host lifetime remains connected after prepare returns");
  await assert.rejects(f.resources.accept()); assert.equal(f.physical.firstWrites, 0);
  assert.equal(await f.product.cleanupNetwork(), "unknown", "Host physical closure evidence is still missing");
  assert.equal(f.journal.evidence().resourceLedger, "open");
});

test("composition captures resource methods before delayed network IO and fences on gateway mismatch", async () => {
  const f = await preparedFixture("172.31.0.1"); const reached = deferred(); const release = deferred();
  f.network.state.after = async label => {
    if (label === "POST /v1.47/networks/create") {reached.resolve(); await release.promise;}
  };
  const rejected = assert.rejects(f.prepare(), /listener preparation/u); await reached.promise;
  // No later recipe can redirect the already retained native open or cut.
  f.resources.listener = {open: async () => {throw new Error("mutated listener");},
    sealAdmission() {throw new Error("mutated listener");}, close: async () => {throw new Error("mutated listener");}} as never;
  release.resolve(); await rejected;
  assert.equal(f.physical.opens, 1); assert.equal(f.physical.sealed, true);
  assert.equal(await f.product.cleanupNetwork(), "unknown");
});

test("composition cutoff during delayed POST prevents Host listener and consumption allocation", async () => {
  const f = await preparedFixture(); const reached = deferred(); const release = deferred();
  f.network.state.after = async label => {
    if (label === "POST /v1.47/networks/create") {reached.resolve(); await release.promise;}
  };
  const rejected = assert.rejects(f.prepare()); await reached.promise;
  f.product.cutoff(); assert.equal(f.physical.sealed, true);
  release.resolve(); await rejected;
  assert.equal(f.physical.opens, 0); assert.equal(f.physical.consumption, 0);
  assert.equal(f.network.state.writes.filter(value => value.method === "POST").length, 1);
  assert.equal(await f.product.cleanupNetwork(), "unknown");
});
