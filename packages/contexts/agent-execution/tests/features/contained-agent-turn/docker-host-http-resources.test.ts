import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import {fixture as hostFixture, generation, DockerCustodyHttpReservation} from "./support/docker-http-lifetime-fixture.ts";
import { networkFixture } from "../../fixtures/docker-operation-network-fixture.ts";
const {createDockerHostHttpResources} = await import("../../../dist/features/contained-agent-turn/composition/docker-host-http-resources.js");
const {createHostHttpLocalCutOwner} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-local-cut-owner.js");

test("composition rejects structural Host preparation suppliers before any Engine IO", () => {
  const network = networkFixture();
  assert.throws(() => createDockerHostHttpResources({host: {httpPreparation: () => ({acquire() {}})},
    network: network.resourceInput, hostLifecycleGenerationSha256: "a".repeat(64)}));
  assert.deepEqual(network.state.calls, []);
});

test("composition is inert and actual Docker lifetime acquisition precedes network preparation", async t => {
  const host = await hostFixture(t); const owner = host.createOwner(); const calls = [...host.calls];
  const product = createDockerHostHttpResources({host: owner, network: host.network.resourceInput,
    hostLifecycleGenerationSha256: generation});
  assert.deepEqual(host.network.state.calls, []); assert.deepEqual(host.calls, calls);
  assert.equal(product.observationOwner.readObservation({kind: "listener_allocated"}), undefined);
  await assert.rejects(product.prepare({} as never, {...host.handoff, underlyingCustodyRef: "foreign-reservation"},
    {} as never, Date.now() + 5_000));
  assert.deepEqual(host.network.state.calls, []);
});

test("current Host lifecycle generation mismatch prevents allocation", async t => {
  const host = await hostFixture(t); const owner = host.createOwner();
  assert.throws(() => createDockerHostHttpResources({host: owner, network: host.network.resourceInput,
    hostLifecycleGenerationSha256: "b".repeat(64)}), /generation changed/u);
  assert.deepEqual(host.network.state.calls, []); assert.equal(owner.signal.aborted, false);
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

const preparedFixture = async (t: TestContext, address = "172.30.0.1") => {
  const host = await hostFixture(t); const {network, handoff} = host;
  const owner = host.createOwner();
  const preparation = DockerCustodyHttpReservation.httpPreparation(owner)!;
  const product = createDockerHostHttpResources({host: owner, network: network.resourceInput,
    hostLifecycleGenerationSha256: generation});
  const storage = new MemoryV4Storage(); const journal = new HostHttpEgressV4Journal(storage, network.subject, product.observationOwner);
  await journal.prepare(`command:${v4Hash("open-composition")}`);
  const physical = {opens: 0, seals: 0, closes: 0, consumption: 0, firstWrites: 0, sealed: false};
  const listener = {
    observe() {throw new Error("synthetic recipe supplies no physical observation");},
    async open() {
      physical.opens += 1;
      assert.equal(v4Replay(v4Decode(storage.journal!), network.subject).listener.phase, 1);
      return {address: {address, family: "IPv4", port: 43129}, sealAdmission: listener.sealAdmission,
        close: listener.close, observe: listener.observe};
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
  return {host, owner, preparation, handoff, network, product, storage, journal, physical, resources,
    prepare: () => product.prepare(journal, handoff as never, resources as never, Date.now() + 5_000)};
};

test("actual Docker facade prepares the shared Host resources without inventing V4 observations", async t => {
  const f = await preparedFixture(t); const result = await f.prepare();
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

test("composition captures resource methods before delayed network IO and fences on gateway mismatch", async t => {
  const f = await preparedFixture(t, "172.31.0.1"); const reached = deferred(); const release = deferred();
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

test("composition cutoff during delayed POST prevents Host listener and consumption allocation", async t => {
  const f = await preparedFixture(t); const reached = deferred(); const release = deferred();
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

for (const method of ["read", "within"] as const) {
  test(`composition clock ${method} retains the original mutable receiver across network IO`, async t => {
    const f = await preparedFixture(t); const reached = deferred(); const release = deferred();
    const clock = {
      controlTime: 0, withinCalls: 0,
      read() {return {authorityId: "synthetic-clock", epoch: "1", controlTime: this.controlTime};},
      async within<T>(deadline: number, action: () => Promise<T>): Promise<T> {
        this.withinCalls += 1;
        if (this.controlTime >= deadline) {throw new Error("synthetic deadline");}
        return action();
      },
    };
    f.resources.localCut = {...f.resources.localCut, clock, operationDeadline: 1000};
    let owner: ReturnType<typeof createHostHttpLocalCutOwner> | undefined;
    // Inspect the actual projection delivered to the existing Host consumer.
    // Reuse the acquired lifetime's real identity/proof; no reservation is invented.
    const {NodeCustodyHttpResources} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-custody-http-resources.js");
    const prepare = NodeCustodyHttpResources.prototype.prepare;
    t.mock.method(NodeCustodyHttpResources.prototype, "prepare", function (this: InstanceType<typeof NodeCustodyHttpResources>, lifetime, input) {
      const proof = lifetime.committedDispatchProof;
      owner = createHostHttpLocalCutOwner({...input.localCut,
        claimed: {signal: lifetime.signal, committedDispatchProof: proof, underlyingCustodyRef: lifetime.underlyingCustodyRef},
        identity: {operationId: proof.operationId, attemptId: proof.attemptId, custodyId: proof.custodyId,
          hostBootId: proof.hostBootId, liveProcessSessionIdentity: lifetime.executionSessionIdentity}});
      return prepare.call(this, lifetime, input);
    });
    f.network.state.after = async label => {
      if (label === "POST /v1.47/networks/create") {reached.resolve(); await release.promise;}
    };
    const preparing = f.prepare(); await reached.promise;
    assert.equal(Object.isFrozen(clock), false);
    clock.read = () => {throw new Error("replaced read must not be invoked");};
    clock.within = async () => {throw new Error("replaced within must not be invoked");};
    release.resolve(); await preparing; assert.ok(owner);
    let borrowed: Parameters<Parameters<typeof owner.bindSession>[1]>[0]["clock"] | undefined;
    owner.bindSession({} as never, ports => {
      borrowed = ports.clock;
      return {close() {}, async execute() {throw new Error("synthetic session never executes");}} as never;
    });
    try {
      assert.equal(owner.cut.read().status, "current");
      if (method === "within") {
        assert.equal(await borrowed!.within(1000, async () => "observed"), "observed");
        assert.equal(clock.withinCalls, 1);
      }
      clock.controlTime = 1000;
      if (method === "within") {await assert.rejects(borrowed!.within(1000, async () => "expired"), /deadline/u);}
      assert.deepEqual(owner.cut.read(), {authorityId: "synthetic-clock", epoch: "1", controlTime: 1000, status: "revoked"});
      assert.equal(owner.signal.aborted, true);
    } finally {owner.dispose(); f.product.cutoff();}
  });
}
