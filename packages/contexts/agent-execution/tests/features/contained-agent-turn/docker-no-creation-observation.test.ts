import assert from "node:assert/strict";
import test from "node:test";
import {postClaimFixture} from "./support/docker-linux-post-claim-fixture.ts";
import {DockerHostCustodyLifecycle} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";
import {createDockerHostHttpEgressObservers} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/host-http-egress-v4-observers.js";
import {createDockerLinuxPostClaimOwner} from "../../../dist/features/contained-agent-turn/composition/docker-linux-post-claim-preparation.js";
import {v4Decode, v4Hash} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import {v4Replay} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-replay.js";

type Fixture = Awaited<ReturnType<typeof postClaimFixture>>;
const launchInput = (f: Fixture) => {
  const {tenantId, projectId, operationId, attemptId, custodyId, hostInstanceId, hostBootId} = f.subject.attempt;
  return {call: f.engineCall(), create: f.dependencies.create,
    owner: {tenantId, projectId, operationId, attemptId, custodyId, hostInstanceId, hostBootId}};
};
const observe = (f: Fixture) =>
  f.lifecycle.removalObservation.observeNoCreation({key: f.subject.attempt, call: f.engineCall()});
const forbidden = (): never => {throw new Error("provider preparation is unreachable");};
const failingOwner = (f: Fixture) => createDockerLinuxPostClaimOwner(f.dependencies, {
  async beforeLaunch() {throw new Error("image preparation failed");},
  prepareProviderIo: forbidden, finishClaimed: forbidden,
});
const deletes = (f: Fixture) => f.network.state.calls.filter(call => call.startsWith("DELETE "));

test("no-creation tokens are exact, private, same-owner historical evidence", async t => {
  const f = await postClaimFixture(t); const g = await postClaimFixture(t);
  const token = await observe(f); assert.ok(token);
  const removal = f.lifecycle.removalObservation;
  const proof = removal.readNoCreationObservation(token); assert.ok(proof);
  assert.deepEqual(proof.attemptKey, f.subject.attempt);
  assert.equal(proof.journalChecksumSha256, (await f.custodyJournal.lookup(f.subject.attempt)).checksumSha256);
  assert.equal(await observe(f), token);
  assert.equal(removal.readObservation(token), undefined);
  assert.equal(removal.readNoCreationObservation({...token}), undefined);
  assert.equal(removal.readNoCreationObservation({closed: true}), undefined);
  assert.equal(g.lifecycle.removalObservation.readNoCreationObservation(token), undefined);
  assert.equal(JSON.stringify(token), "{}");
  for (const value of [token, proof, proof.attemptKey]) {assert.ok(Object.isFrozen(value));}
  const observers = createDockerHostHttpEgressObservers({subject: f.subject, removal});
  await assert.rejects(observers.observeContainerAbsent({...token}));
  const foreign = createDockerHostHttpEgressObservers({subject: {...f.subject,
    attempt: {...f.subject.attempt, attemptId: `attempt:${v4Hash("foreign-attempt")}`}}, removal});
  await assert.rejects(foreign.observeContainerAbsent(token));
  const otherOwner = createDockerHostHttpEgressObservers({subject: f.subject, removal: g.lifecycle.removalObservation});
  await assert.rejects(otherOwner.observeContainerAbsent(token));
  await assert.rejects(f.lifecycle.launch(launchInput(f)));
  const changed = launchInput(f);
  await assert.rejects(f.lifecycle.launch({...changed,
    create: {...changed.create, operationNonceSha256: v4Hash("different-locator")}}));
  assert.equal(f.events.includes("create"), false);
});

for (const lost of ["before", "after"] as const) {
  test(`cleanup retries an actual V2 close acknowledgement lost ${lost} the append`, async t => {
    const f = await postClaimFixture(t);
    const append = f.custodyJournal.observe.bind(f.custodyJournal);
    let failed = false;
    t.mock.method(f.custodyJournal, "observe", async input => {
      if (input.state !== "closed" || failed) {return append(input);}
      failed = true;
      if (lost === "after") {await append(input);}
      throw new Error("lost V2 journal acknowledgement");
    });
    const owner = failingOwner(f);
    assert.deepEqual(await owner.preparation.prepareClaimed(f.claimed), {kind: "quarantined"});
    assert.deepEqual(deletes(f), []);
    assert.notEqual(f.network.state.network, undefined);
    assert.deepEqual(await Promise.all([
      owner.cleanup({deadlineEpochMs: Date.now() + 5000}),
      owner.cleanup({deadlineEpochMs: Date.now() + 5000}),
    ]), [{kind: "released"}, {kind: "released"}]);
    assert.deepEqual(deletes(f), [`DELETE /v1.47/networks/${f.network.networkId}`]);
    assert.equal(f.network.state.network, undefined);
    const ledger = v4Replay(v4Decode(f.v4Storage.journal!), f.subject);
    assert.equal(ledger.containerAbsent, true);
    assert.equal(ledger.container, null);
    assert.equal(ledger.network.phase, 4);
    assert.equal(f.events.includes("create"), false);
    assert.throws(() => owner.takePrepared(f.claimed));
  });
}

test("a launch suspended in initial Engine identity observes the synchronous seal", async t => {
  const f = await postClaimFixture(t);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const identity = f.engine.identity.bind(f.engine);
  let first = true;
  t.mock.method(f.engine, "identity", async call => {
    if (first) {first = false; entered.resolve(); await release.promise;}
    return identity(call);
  });
  const launching = f.lifecycle.launch(launchInput(f));
  const refused = assert.rejects(launching);
  await entered.promise;
  assert.ok(await observe(f));
  release.resolve(); await refused;
  assert.equal(f.events.includes("create"), false);
});

test("a different lifecycle with prepared authority loses create_requested CAS to closure", async t => {
  const f = await postClaimFixture(t);
  const peer = new DockerHostCustodyLifecycle(f.engine, f.custodyJournal,
    {async proveEmpty() {return "empty";}});
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const beforeAction = f.custodyJournal.beforeAction.bind(f.custodyJournal);
  t.mock.method(f.custodyJournal, "beforeAction", async input => {
    if (input.state === "create_requested") {entered.resolve(); await release.promise;}
    return beforeAction(input);
  });
  const launching = peer.launch(launchInput(f));
  const refused = assert.rejects(launching);
  await entered.promise;
  assert.ok(await observe(f));
  release.resolve(); await refused;
  assert.equal(f.events.includes("create"), false);
});

test("inflight create cannot issue no-creation evidence", async t => {
  const f = await postClaimFixture(t);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  t.mock.method(f.engine, "create", async () => {
    entered.resolve(); await release.promise; throw new Error("ambiguous create");
  });
  const owner = createDockerLinuxPostClaimOwner(f.dependencies,
    {prepareProviderIo: forbidden, finishClaimed: forbidden});
  const preparing = owner.preparation.prepareClaimed(f.claimed);
  await entered.promise;
  assert.equal(await observe(f), undefined);
  release.resolve();
  assert.deepEqual(await preparing, {kind: "quarantined"});
  assert.equal(await observe(f), undefined);
  assert.deepEqual(deletes(f), []);
});

test("started and subsequently removed containers never become no-create history", async t => {
  const f = await postClaimFixture(t);
  f.faults.listener = true;
  const owner = createDockerLinuxPostClaimOwner(f.dependencies,
    {prepareProviderIo: forbidden, finishClaimed: forbidden});
  assert.deepEqual(await owner.preparation.prepareClaimed(f.claimed), {kind: "unsupported", reason: "broker"});
  assert.ok(f.events.includes("start"));
  assert.ok(f.events.includes("remove"));
  assert.equal(await observe(f), undefined);
  const peer = new DockerHostCustodyLifecycle(f.engine, f.custodyJournal,
    {async proveEmpty() {return "empty";}});
  assert.equal(await peer.removalObservation.observeNoCreation({key: f.subject.attempt, call: f.engineCall()}), undefined);
});

for (const closed of [false, true]) {
  test(`create_requested${closed ? " followed by closed" : ""} is never no-create proof`, async t => {
    const f = await postClaimFixture(t);
    const key = f.subject.attempt;
    await f.custodyJournal.prepare(key);
    await f.custodyJournal.beforeAction({key, expectedSequence: 0, state: "create_requested"});
    if (closed) {
      await f.custodyJournal.observe({key, expectedSequence: 1, state: "closed", evidence: {status: "proved"}});
    }
    assert.equal(await observe(f), undefined);
    assert.equal(f.events.includes("create"), false);
  });
}

test("foreign Engine identity cannot acknowledge no-creation closure", async t => {
  const f = await postClaimFixture(t);
  const identity = await f.engine.identity(f.engineCall());
  const peer = new DockerHostCustodyLifecycle({...f.engine,
    async identity() {return {...identity, hostBootGenerationSha256: v4Hash("foreign-boot")};}},
  f.custodyJournal, {async proveEmpty() {return "empty";}});
  assert.equal(await peer.removalObservation.observeNoCreation({key: f.subject.attempt, call: f.engineCall()}), undefined);
  assert.equal(f.custodyStorage.files.size, 0);
});

test("pending journal closure retains its deadline while a later call can read durable closure", async t => {
  const f = await postClaimFixture(t);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const append = f.custodyJournal.observe.bind(f.custodyJournal);
  let writes = 0;
  t.mock.method(f.custodyJournal, "observe", async input => {
    writes += 1; entered.resolve(); await release.promise; return append(input);
  });
  const deadlineEpochMs = Date.now() + 25;
  const pending = f.lifecycle.removalObservation.observeNoCreation({key: f.subject.attempt,
    call: {...f.engineCall(), deadlineEpochMs}});
  await entered.promise;
  assert.equal(await pending, undefined);
  const otherWaiter = observe(f);
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.equal(writes, 1);
  release.resolve();
  assert.equal(await otherWaiter, undefined);
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.ok(await observe(f), "a fresh bounded call can read the late durable closure without another write");
  assert.equal(writes, 1);
  await assert.rejects(f.lifecycle.launch(launchInput(f)));
  assert.equal(f.events.includes("create"), false);
});

test("no-creation capacity retains old fences instead of evicting them", async t => {
  const f = await postClaimFixture(t);
  const peer = new DockerHostCustodyLifecycle(f.engine, f.custodyJournal,
    {async proveEmpty() {return "empty";}}, 1);
  const key = f.subject.attempt;
  const token = await peer.removalObservation.observeNoCreation({key, call: f.engineCall()});
  assert.ok(token);
  assert.equal(await peer.removalObservation.observeNoCreation({key: {...key,
    attemptId: `attempt:${v4Hash("second")}`, operationNonceSha256: v4Hash("second")},
  call: f.engineCall()}), undefined);
  assert.equal(peer.removalObservation.readNoCreationObservation(token)?.attemptKey.attemptId, key.attemptId);
  await assert.rejects(peer.launch(launchInput(f)));
});

test("expired and cancelled no-creation calls perform no Engine or journal work", async t => {
  const f = await postClaimFixture(t);
  for (const call of [{...f.engineCall(), deadlineEpochMs: Date.now() - 1},
    {...f.engineCall(), signal: AbortSignal.abort()}]) {
    assert.equal(await f.lifecycle.removalObservation.observeNoCreation({key: f.subject.attempt, call}), undefined);
  }
  assert.deepEqual(f.events, []);
  assert.equal(f.custodyStorage.files.size, 0);
});
