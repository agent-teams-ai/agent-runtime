import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import {fixture as hostFixture, generation, DockerCustodyHttpReservation} from "./support/docker-http-lifetime-fixture.ts";
import { networkFixture } from "../../fixtures/docker-operation-network-fixture.ts";
const {createDockerHostHttpResources} = await import("../../../dist/features/contained-agent-turn/composition/docker-host-http-resources.js");
const {createDockerOperationNetworkOwner} = await import("../../../dist/features/contained-agent-turn/composition/docker-operation-network-owner.js");
const {createHostHttpLocalCutOwner} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-local-cut-owner.js");

test("composition rejects structural Host preparation suppliers before any Engine IO", () => {
  const network = networkFixture();
  const owner = createDockerOperationNetworkOwner(network.resourceInput);
  assert.throws(() => createDockerHostHttpResources({host: {httpPreparation: () => ({acquire() {}})},
    network: owner, allocated: {networkName: owner.networkName, gateway: "172.30.0.1"},
    hostLifecycleGenerationSha256: "a".repeat(64)}));
  assert.deepEqual(network.state.calls, []);
});

test("composition refuses a gateway that the network owner never observed", async t => {
  const host = await hostFixture(t); const owner = host.createOwner();
  for (const allocated of [{networkName: host.allocated.networkName, gateway: "10.0.0.1"},
    {networkName: `${host.allocated.networkName}x`, gateway: host.allocated.gateway}]) {
    assert.throws(() => createDockerHostHttpResources({host: owner, network: host.networkOwner,
      allocated, hostLifecycleGenerationSha256: generation}), /allocation is unproven/u);
  }
  // A network owner that never allocated cannot supply a listener address at all.
  const fresh = createDockerOperationNetworkOwner(host.network.resourceInput);
  assert.throws(() => createDockerHostHttpResources({host: owner, network: fresh,
    allocated: host.allocated, hostLifecycleGenerationSha256: generation}), /allocation is unproven/u);
  assert.deepEqual(host.network.state.calls, host.networkCalls);
});

test("composition is inert and opens no Host resource for a foreign handoff", async t => {
  const host = await hostFixture(t); const owner = host.createOwner(); const calls = [...host.calls];
  const product = createDockerHostHttpResources({host: owner, network: host.networkOwner,
    allocated: host.allocated, hostLifecycleGenerationSha256: generation});
  assert.deepEqual(host.network.state.calls, host.networkCalls); assert.deepEqual(host.calls, calls);
  assert.equal(product.gateway, host.allocated.gateway);
  assert.equal(product.observationOwner.readObservation({kind: "listener_allocated"}), undefined);
  await assert.rejects(product.prepare(host.v4 as never, {...host.handoff, underlyingCustodyRef: "foreign-reservation"},
    {} as never, async () => {throw new Error("foreign callback");}));
  assert.deepEqual(host.network.state.calls, host.networkCalls);
});

test("current Host lifecycle generation mismatch prevents listener composition", async t => {
  const host = await hostFixture(t); const owner = host.createOwner();
  assert.throws(() => createDockerHostHttpResources({host: owner, network: host.networkOwner,
    allocated: host.allocated, hostLifecycleGenerationSha256: "b".repeat(64)}), /generation changed/u);
  assert.deepEqual(host.network.state.calls, host.networkCalls); assert.equal(owner.signal.aborted, false);
});

// Concrete Host reservation/resources and Docker owners, with explicit synthetic
// leaf resource recipes. These fixtures issue no Host physical observation token.
const {v4Decode, v4Replay} = {
  ...await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js"),
  ...await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-replay.js"),
};
const {deferred} = await import("../../fixtures/docker-operation-network-fixture.ts");

const preparedFixture = async (t: TestContext, address?: string, gateway?: string) => {
  const host = await hostFixture(t, gateway); const {network, handoff} = host;
  const owner = host.createOwner();
  const preparation = DockerCustodyHttpReservation.httpPreparation(owner)!;
  const product = createDockerHostHttpResources({host: owner, network: host.networkOwner,
    allocated: host.allocated, hostLifecycleGenerationSha256: generation});
  const storage = host.v4Storage; const journal = host.v4;
  const physical = {opens: 0, seals: 0, closes: 0, consumption: 0, firstWrites: 0, sealed: false,
    recipes: [] as string[], gate: undefined as Promise<void> | undefined};
  const listener = {
    observe() {throw new Error("synthetic recipe supplies no physical observation");},
    async open() {
      physical.opens += 1;
      assert.equal(v4Replay(v4Decode(storage.journal!), network.subject).listener.phase, 1);
      await physical.gate;
      return {address: {address: address ?? physical.recipes.at(-1)!, family: "IPv4", port: 43129},
        sealAdmission: listener.sealAdmission, close: listener.close, observe: listener.observe};
    },
    sealAdmission() {physical.seals += 1; physical.sealed = true;},
    async close() {physical.closes += 1; return {state: "closed"};},
  };
  const resources = {
    // The recipe only exists once the observed gateway is known.
    listenerFor: (bindHost: string) => {physical.recipes.push(bindHost); return listener;},
    consumption: {async prepare() {physical.consumption += 1;
      return {kind: "ready", journal: {}, quarantine() {}, async retire() {return "retired";}};}},
    accept: async () => {if (physical.sealed) {throw new Error("synthetic admission cut");} physical.firstWrites += 1;},
    localCut: {expectedClock: {authorityId: "synthetic-clock", epoch: "1"},
      clock: {read: () => ({authorityId: "synthetic-clock", epoch: "1", controlTime: 1}),
        within: async (_deadline: number, action: () => Promise<unknown>) => action()}, operationDeadline: 20_000},
  };
  const callback = {async afterListenerOpened() {
    return {selectedDockerAuthorityDigest: `sha256:${"a".repeat(64)}`, networkNamespaceIdentity: "netns:1:2", cgroupIdentity: "cgroup:3:4"};
  }};
  return {host, owner, preparation, handoff, network, product, storage, journal, physical, resources, callback,
    prepare: () => product.prepare(journal as never, handoff as never, resources as never, callback.afterListenerOpened)};
};

test("actual Docker facade prepares the shared Host resources without inventing V4 observations", async t => {
  const f = await preparedFixture(t); const result = await f.prepare();
  assert.equal(result.kind, "prepared"); assert.equal(f.physical.opens, 1); assert.equal(f.physical.consumption, 1);
  assert.deepEqual(f.physical.recipes, [f.host.allocated.gateway]);
  assert.deepEqual(v4Decode(f.storage.journal!).map(record => record.event.kind),
    ["opened", "network_intent", "network_allocated", "listener_intent"]);
  assert.equal(f.product.observationOwner.readObservation({kind: "listener_allocated"}), undefined);
  f.host.signal.abort();
  assert.equal(f.physical.sealed, true, "Host lifetime remains connected after prepare returns");
  await assert.rejects(f.resources.accept()); assert.equal(f.physical.firstWrites, 0);
  assert.equal(await f.product.cleanupNetwork(), "unknown", "Host physical closure evidence is still missing");
  assert.equal(f.journal.evidence().resourceLedger, "open");
});

for (const gateway of ["192.168.211.1", "10.44.0.1"]) {
  test(`the listener binds the gateway Docker actually assigned (${gateway})`, async t => {
    // Nothing may assume 10.203.0.1 or any other fixture constant: IPAM.Config is
    // empty on create, so only the daemon's answer names the bridge address.
    const f = await preparedFixture(t, undefined, gateway);
    assert.equal(f.host.allocated.gateway, gateway);
    assert.equal(f.product.gateway, gateway);
    const result = await f.prepare();
    assert.equal(result.kind, "prepared");
    assert.equal(result.address.address, gateway);
    assert.deepEqual(f.physical.recipes, [gateway]);
  });
}

test("composition retains the recipe it built and fences a listener that ignored the gateway", async t => {
  const f = await preparedFixture(t, "172.31.0.1"); const release = deferred();
  f.physical.gate = release.promise;
  const rejected = assert.rejects(f.prepare(), /listener preparation/u);
  // No later recipe supplier can redirect the already retained native open or cut.
  f.resources.listenerFor = () => {throw new Error("mutated listener recipe supplier");};
  release.resolve(); await rejected;
  assert.deepEqual(f.physical.recipes, [f.host.allocated.gateway]);
  assert.equal(f.physical.opens, 1); assert.equal(f.physical.sealed, true);
  assert.equal(await f.product.cleanupNetwork(), "unknown");
});

for (const mode of ["product", "lifetime"] as const) {
  test(`${mode} cutoff before preparation prevents Host listener and consumption allocation`, async t => {
    const f = await preparedFixture(t);
    if (mode === "product") {f.product.cutoff();} else {f.host.signal.abort();}
    await assert.rejects(f.prepare());
    assert.equal(f.physical.opens, 0); assert.equal(f.physical.consumption, 0);
    assert.deepEqual(f.physical.recipes, []);
    assert.deepEqual(f.network.state.calls, f.host.networkCalls);
    assert.equal(await f.product.cleanupNetwork(), "unknown");
  });
}

for (const method of ["read", "within"] as const) {
  test(`composition clock ${method} retains the original mutable receiver across listener IO`, async t => {
    const f = await preparedFixture(t); const release = deferred();
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
    t.mock.method(NodeCustodyHttpResources.prototype, "prepare", function (this: InstanceType<typeof NodeCustodyHttpResources>, lifetime: Parameters<typeof prepare>[0], input: Parameters<typeof prepare>[1]) {
      const proof = lifetime.committedDispatchProof;
      owner = createHostHttpLocalCutOwner({...input.localCut,
        claimed: {signal: lifetime.signal, committedDispatchProof: proof, underlyingCustodyRef: lifetime.underlyingCustodyRef},
        identity: {operationId: proof.operationId, attemptId: proof.attemptId, custodyId: proof.custodyId,
          hostBootId: proof.hostBootId, liveProcessSessionIdentity: lifetime.executionSessionIdentity}});
      return prepare.call(this, lifetime, input);
    });
    f.physical.gate = release.promise;
    const preparing = f.prepare();
    while (f.physical.opens === 0) {await new Promise(resolve => {setImmediate(resolve);});}
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

test("ingress and session use the one acquired lifetime with strict one-use fences", async t => {
  const f = await preparedFixture(t);
  assert.throws(() => f.product.openIngress(), /not ready/u);
  assert.throws(() => f.product.bindSession({} as never), /not ready/u);
  const {NodeCustodyHttpResources} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-custody-http-resources.js");
  let retainedLifetime: unknown;
  const prepare = NodeCustodyHttpResources.prototype.prepare;
  t.mock.method(NodeCustodyHttpResources.prototype, "prepare", function(lifetime, resources) {
    retainedLifetime = lifetime; return prepare.call(this, lifetime, resources);
  });
  await f.prepare();
  assert.throws(() => f.preparation.acquire(f.handoff), /lifetime unavailable/u);
  let ingress = 0; let binds = 0;
  t.mock.method(NodeCustodyHttpResources.prototype, "openIngress", lifetime => {
    assert.equal(lifetime, retainedLifetime); ingress += 1; return {kind: "synthetic"};
  });
  t.mock.method(NodeCustodyHttpResources.prototype, "bindSession", () => {binds += 1; throw new Error("synthetic binding refusal");});
  f.product.openIngress();
  assert.throws(() => f.product.openIngress(), /already entered/u);
  assert.throws(() => f.product.bindSession({} as never), /synthetic binding refusal/u);
  assert.throws(() => f.product.bindSession({} as never), /already entered/u);
  assert.equal(ingress, 1); assert.equal(binds, 1);
  f.product.cutoff();
  assert.throws(() => f.product.openIngress(), /admission is closed/u);
  assert.throws(() => f.product.bindSession({} as never), /admission is closed/u);
});

test("consumption waits for post-open observations and captures its original receiver", async t => {
  const f = await preparedFixture(t); const gate = deferred(); const entered = deferred();
  f.callback.afterListenerOpened = async () => {entered.resolve(); await gate.promise;
    return {selectedDockerAuthorityDigest: `sha256:${"a".repeat(64)}`, networkNamespaceIdentity: "netns:1:2", cgroupIdentity: "cgroup:3:4"};};
  const consumption = {async prepare(references: unknown) {
    assert.equal(this, consumption);
    assert.deepEqual(references, {selectedDockerAuthorityDigest: `sha256:${"a".repeat(64)}`,
      networkNamespaceIdentity: "netns:1:2", cgroupIdentity: "cgroup:3:4",
      listenerIdentity: `listener:ipv4:${f.host.allocated.gateway}:43129`});
    f.physical.consumption++;
    return {kind: "ready", journal: {}, quarantine() {}, async retire() {return "retired";}};
  }};
  f.resources.consumption = consumption as never;
  const pending = f.prepare(); await entered.promise;
  assert.equal(f.physical.opens, 1); assert.equal(f.physical.consumption, 0);
  consumption.prepare = async () => {throw new Error("replaced callback");};
  gate.resolve(); assert.equal((await pending).kind, "prepared");
  assert.equal(f.physical.consumption, 1);
});

for (const failure of ["reject", "cancel"] as const) {
  test(`post-open callback ${failure} unwinds without self-cleanup deadlock and closes retained listener`, {timeout: 5000}, async t => {
    const f = await preparedFixture(t);
    const {NodeCustodyHttpResources} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-custody-http-resources.js");
    const original = NodeCustodyHttpResources.prototype.prepare;
    let releaseAllowed = false;
    // The fixture has no container-absence issuer. Double only its release gate
    // to test retained listener custody independently of V4 proof collection.
    t.mock.method(NodeCustodyHttpResources.prototype, "prepare", function (this: InstanceType<typeof NodeCustodyHttpResources>,
      lifetime: Parameters<typeof original>[0], input: Parameters<typeof original>[1]) {
      return original.call(this, lifetime, {...input, listenerLifecycle: {bind(value) {
        const bound = input.listenerLifecycle.bind(value);
        return {...bound, async recordRelease() {
          if (!releaseAllowed) {throw new Error("synthetic missing release proof");}
          return {kind: "recorded" as const};
        }};
      }}});
    });
    f.callback.afterListenerOpened = async () => {
      if (failure === "cancel") {f.host.signal.abort();}
      throw new Error("post-open callback failed");
    };
    await assert.rejects(f.prepare());
    assert.equal(f.physical.opens, 1); assert.equal(f.physical.consumption, 0);
    assert.equal(await f.product.cleanupResources(Date.now() + 1000), false);
    assert.equal(f.physical.closes, 0);
    releaseAllowed = true;
    await f.product.cleanupResources(Date.now() + 1000);
    assert.equal(f.physical.closes, 1);
  });
}
