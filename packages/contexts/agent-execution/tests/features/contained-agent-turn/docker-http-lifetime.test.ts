import assert from "node:assert/strict";
import test from "node:test";
import {getEventListeners} from "node:events";
import {fixture, deferred, tick, DockerCustodyHttpReservation, DockerHostCustodyLifecycle} from "./support/docker-http-lifetime-fixture.ts";
import {committedDispatchProofV1} from "../../../dist/features/contained-agent-turn/domain/committed-dispatch-proof-v1.js";
import {claimDockerProviderProcessLaunch} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";
import {readNodeCustodyHttpHandoff} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-http-reservation.js";

const preparationFor = (owner: InstanceType<typeof DockerCustodyHttpReservation>) => DockerCustodyHttpReservation.httpPreparation(owner)!;

test("inert facade binds an actual issued lifecycle launch without opening a resource or acquiring provider IO", async t => {
  const f = await fixture(t); const calls = [...f.calls];
  const owner = f.createOwner(); const preparation = preparationFor(owner);
  assert.equal(preparationFor(owner), preparation); assert.ok(Object.isFrozen(preparation));
  assert.ok(Object.isFrozen(preparation.binding)); assert.ok(Object.isFrozen(preparation.binding.attempt));
  assert.equal(getEventListeners(f.signal.signal, "abort").length, 0);
  assert.equal(getEventListeners(owner.signal, "abort").length, 0);
  assert.equal(owner.pending, undefined); assert.equal(owner.signal.aborted, false);
  assert.deepEqual(f.calls, calls); assert.deepEqual(f.network.state.calls, []);
  assert.deepEqual(f.lifecycle.observeLaunch(f.launched).journal.state, "init_ready");
  // Successful claim proves construction left the original provider capability unused.
  assert.equal(claimDockerProviderProcessLaunch(f.launched).authority, f.launched.authority);
  assert.throws(() => preparation.acquire(f.handoff), /unused/u);
  assert.equal(owner.signal.aborted, true);
});

test("foreign lifecycle, structural launch, proxies and replaced observation methods cannot mint a facade", async t => {
  const f = await fixture(t); const other = await fixture(t); let reads = 0;
  const trap = () => {reads += 1; throw new Error("caller trap");};
  const proxy = new Proxy({}, {get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, has: trap});
  for (const patch of [{lifecycle: other.lifecycle}, {launch: other.launched}, {launch: {...f.launched}},
    {launch: proxy}, {lifecycle: proxy}, {lifecycle: Object.create(DockerHostCustodyLifecycle.prototype)},
    {lifecycle: {observeLaunch: () => {reads += 1; return f.lifecycle.observeLaunch(f.launched);}}}]) {
    assert.throws(() => new DockerCustodyHttpReservation({...f.reservationInput, ...patch} as never));
  }
  const accessor = Object.defineProperty({}, "claimed", {get: trap});
  for (const input of [proxy, accessor, {...f.reservationInput, claimed: proxy},
    {...f.reservationInput, claimed: {...f.handoff, committedDispatchProof: proxy}},
    {...f.reservationInput, claimed: {...f.handoff, signal: proxy}}]) {
    assert.throws(() => new DockerCustodyHttpReservation(input as never));
  }
  t.mock.method(f.lifecycle, "observeLaunch", trap);
  t.mock.method(DockerHostCustodyLifecycle.prototype, "observeLaunch", trap);
  const owner = f.createOwner();
  assert.equal(DockerCustodyHttpReservation.httpPreparation(proxy), undefined);
  assert.equal(DockerCustodyHttpReservation.httpPreparation(new Proxy(owner, {get: trap, has: trap})), undefined);
  assert.equal(reads, 0);
  preparationFor(owner).acquire(f.handoff); assert.equal(reads, 0);
});

test("one owner and one acquisition retain exact original proof, handoff and distinct opaque session identity", async t => {
  const f = await fixture(t); const other = await fixture(t);
  assert.notEqual(f.handoff.underlyingCustodyRef, f.launched.key.custodyId);
  const owner = f.createOwner(); const preparation = preparationFor(owner);
  assert.throws(() => preparation.acquire({...f.handoff, underlyingCustodyRef: f.launched.key.custodyId}), /conflicts/u);
  const foreign = preparationFor(other.createOwner()).acquire(other.handoff);
  assert.throws(() => f.createOwner(), /conflicts/u);
  assert.throws(() => preparation.acquire({...f.handoff, committedDispatchProof: {...f.proof}}), /conflicts/u);
  assert.throws(() => preparation.acquire({...f.handoff, signal: new AbortController().signal}), /conflicts/u);
  const {proofDigest: _digest, ...seed} = f.proof;
  for (const delta of [{executionGenerationId: "execution-generation:foreign"}, {workspaceId: "workspace:foreign"},
    {committedOperationRevision: f.proof.committedOperationRevision + 1}, {operationCutoffRevision: f.proof.operationCutoffRevision + 1}]) {
    const proof = committedDispatchProofV1({...seed, ...delta} as never);
    assert.throws(() => preparation.acquire({...f.handoff, committedDispatchProof: proof}), /conflicts/u);
  }
  // Mutating the input bag cannot change the immutable retained binding.
  const claimed = {...f.handoff}; f.reservationInput.claimed = {...claimed, signal: new AbortController().signal};
  f.reservationInput.hostLifecycleGenerationSha256 = "b".repeat(64);
  const lifetime = preparation.acquire(claimed);
  assert.equal(lifetime.committedDispatchProof, f.proof); assert.equal(lifetime.signal, owner.signal);
  assert.ok(Object.isFrozen(lifetime)); assert.ok(Object.isFrozen(lifetime.executionSessionIdentity));
  assert.equal(Object.getPrototypeOf(lifetime.executionSessionIdentity), null);
  assert.notEqual(lifetime.executionSessionIdentity, foreign.executionSessionIdentity);
  assert.equal(lifetime.hostLifecycleGenerationSha256, preparation.binding.hostLifecycleGenerationSha256);
  assert.throws(() => preparation.acquire(claimed), /conflicts/u);
  for (const bad of [foreign, {...lifetime}, new Proxy(lifetime, {}), {}]) {
    assert.throws(() => preparation.prepareResources(bad as never, {} as never), /conflicts/u);
    assert.throws(() => preparation.openIngress(bad as never), /conflicts/u);
    assert.throws(() => preparation.bindSession(bad as never, {} as never), /conflicts/u);
  }
  const ingress = preparation.openIngress(lifetime);
  assert.ok(ingress); assert.throws(() => preparation.openIngress(lifetime));
  assert.equal(owner.signal.aborted, false);
  preparation.cutoff(); assert.equal(lifetime.signal.aborted, true);
  assert.equal(await preparation.cleanup(Date.now() + 1000), true);
  assert.throws(() => f.createOwner());
});

for (const field of ["tenantId", "projectId", "operationId", "attemptId", "custodyId", "hostInstanceId", "hostBootId"] as const) {
  test(`actual launch rejects a valid foreign ${field} proof before owner reservation`, async t => {
    const f = await fixture(t); const {proofDigest: _digest, ...seed} = f.proof;
    const proof = committedDispatchProofV1({...seed, [field]: `${String(f.proof[field]).split(":")[0]}:foreign`});
    assert.throws(() => new DockerCustodyHttpReservation({...f.reservationInput,
      claimed: {...f.handoff, committedDispatchProof: proof}}), /conflicts/u);
    const owner = f.createOwner(); assert.equal(preparationFor(owner).acquire(f.handoff).committedDispatchProof, f.proof);
  });
}

for (const mode of ["preabort", "cutoff", "containment"] as const) {
  test(`${mode} fences acquisition without creating HTTP resources`, async t => {
    const f = await fixture(t); const owner = f.createOwner(); const preparation = preparationFor(owner);
    if (mode === "preabort") {f.signal.abort();}
    if (mode === "cutoff") {preparation.cutoff();}
    // contain seals actual live admission synchronously, before journal awaits.
    const containing = mode === "containment" ? f.contain() : undefined;
    assert.throws(() => preparation.acquire(f.handoff));
    assert.throws(() => preparation.acquire(f.handoff));
    assert.equal(owner.signal.aborted, true); assert.equal(owner.pending, undefined);
    assert.deepEqual(f.network.state.calls, []); await containing;
  });
}

test("actual containment between acquisition and preparation rejects a stale historical init observation", async t => {
  const f = await fixture(t); const owner = f.createOwner(); const preparation = preparationFor(owner);
  const lifetime = preparation.acquire(f.handoff);
  const historical = f.lifecycle.observeLaunch(f.launched);
  t.mock.method(f.lifecycle, "observeLaunch", () => historical);
  const containing = f.contain();
  assert.throws(() => preparation.prepareResources(lifetime, {} as never));
  assert.equal(owner.signal.aborted, true); assert.equal(owner.pending, undefined); await containing;
});

test("abort forwarding resists stopped propagation and mutated signal cleanup properties", async t => {
  const f = await fixture(t); let reads = 0;
  f.signal.signal.addEventListener("abort", event => event.stopImmediatePropagation(), {once: true});
  const owner = f.createOwner(); const preparation = preparationFor(owner); const lifetime = preparation.acquire(f.handoff);
  lifetime.signal.addEventListener("abort", event => event.stopImmediatePropagation());
  Object.defineProperty(f.signal.signal, "removeEventListener", {get() {reads += 1; throw new Error("mutable cleanup");}});
  f.signal.abort();
  assert.equal(lifetime.signal.aborted, true); assert.equal(reads, 0);
  assert.equal(getEventListeners(f.signal.signal, "abort").length, 0);
  assert.throws(() => preparation.openIngress(lifetime));
  assert.equal(await preparation.cleanup(Date.now() + 1000), true);
});

test("late listener and consumption acquisitions and cleanup survive detached deadline waiters in the same slots", async t => {
  const f = await fixture(t); const owner = f.createOwner(); const preparation = preparationFor(owner);
  const lifetime = preparation.acquire(f.handoff);
  const listenerGate = deferred(); const journalGate = deferred(); const retirement = deferred(); const closeGate = deferred();
  const calls = {open: 0, consumption: 0, seals: 0, quarantines: 0, retire: 0, close: 0, release: 0};
  const opened = {address: {address: "172.30.0.1", family: "IPv4", port: 43129},
    sealAdmission() {calls.seals += 1;}, async close() {calls.close += 1; await closeGate.promise; return {state: "closed"};},
    observe() {throw new Error("no physical proof in synthetic fixture");}};
  const resources = {listener: {async open(_accept: unknown, controller: AbortController) {
    calls.open += 1; assert.equal(controller.signal, lifetime.signal); await listenerGate.promise; return opened;
  }, close: opened.close, sealAdmission: opened.sealAdmission, observe: opened.observe},
  consumption: {async prepare() {calls.consumption += 1; await journalGate.promise;
    return {kind: "ready", journal: {}, quarantine() {calls.quarantines += 1;},
      async retire() {calls.retire += 1; await retirement.promise; return "retired";}};}},
  listenerLifecycle: {bind(actual: object) {assert.equal(actual, lifetime); return {
    async recordOpen() {return {kind: "recorded"};}, async recordRelease() {calls.release += 1; return {kind: "recorded"};}};}},
  accept: async () => {}, localCut: {expectedClock: {authorityId: "clock", epoch: "1"},
    clock: {read: () => ({authorityId: "clock", epoch: "1", controlTime: 1}),
      within: async (_deadline: number, action: () => Promise<unknown>) => action()}, operationDeadline: 1000}};
  const preparing = preparation.prepareResources(lifetime, resources as never); const pending = owner.pending;
  await tick(); assert.equal(calls.open, 1); assert.equal(calls.consumption, 1);
  preparation.cutoff();
  assert.equal(await preparation.cleanup(Date.now() + 10), false);
  assert.equal(owner.pending, pending); assert.equal(lifetime.signal.aborted, true);
  assert.throws(() => preparation.prepareResources(lifetime, resources as never));
  listenerGate.resolve(); journalGate.resolve();
  assert.equal((await preparing).kind, "unproven"); await pending;
  assert.ok(calls.seals >= 2); assert.equal(calls.quarantines, 1); assert.equal(calls.retire, 1);
  assert.equal(await preparation.cleanup(Date.now() + 10), false);
  retirement.resolve(); await tick(); assert.equal(calls.close, 1); assert.equal(calls.release, 1);
  assert.equal(await preparation.cleanup(Date.now() + 10), false);
  closeGate.resolve(); await tick();
  assert.equal(await preparation.cleanup(Date.now() + 1000), true);
  assert.equal(calls.open, 1); assert.equal(calls.consumption, 1); assert.equal(calls.retire, 1); assert.equal(calls.close, 1);
});

test("Node handoff reader retains its detached proof semantics after sharing the internal HTTP contract", async t => {
  const f = await fixture(t); const mutable = {...f.proof};
  const read = readNodeCustodyHttpHandoff({...f.handoff, committedDispatchProof: mutable});
  assert.notEqual(read.committedDispatchProof, mutable); assert.deepEqual(read.committedDispatchProof, mutable);
  assert.equal(Object.isFrozen(mutable), false);
  mutable.committedOperationRevision += 1;
  assert.equal(read.committedDispatchProof.committedOperationRevision, f.proof.committedOperationRevision);
});
