import assert from "node:assert/strict";
import test from "node:test";
import { HostHttpEgressV4Journal } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-journal.js";
import { v4Decode, v4Hash } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import { v4Replay } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-replay.js";
import type { HostHttpEgressV4Intent, HostHttpEgressV4Observed } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-types.js";
import { MemoryV4Storage, SyntheticV4Owner } from "../../fixtures/host-http-egress-v4-fixture.ts";
import { call, deferred, networkFixture } from "../../fixtures/docker-operation-network-fixture.ts";

const fixture = (storage = new MemoryV4Storage()) => {
  const f = networkFixture(); const owner = f.resources();
  // Explicit synthetic stand-in for the separately owned Host projector. It is
  // never provided to the production network issuer, which rejects its tokens.
  const other = new SyntheticV4Owner(); let serial = 0;
  const reader = {readObservation: (token: object) => owner.readObservation(token) ?? other.readObservation(token)};
  const journal = new HostHttpEgressV4Journal(storage, f.subject, reader);
  const command = () => `command:${v4Hash(++serial)}`;
  const state = () => v4Replay(v4Decode(storage.journal!), f.subject);
  const intent = (kind: HostHttpEgressV4Intent) => journal.recordIntent(command(), {kind, targetSha256: journal.target(kind)});
  const external = (kind: HostHttpEgressV4Observed) => journal.recordObservation(command(), other.token({
    kind, subjectSha256: v4Hash(f.subject), observerSha256: f.subject.observerSha256, targetSha256: journal.target(kind),
    actualSha256: v4Hash([kind, serial]), evidenceSha256: v4Hash(["synthetic-other-owner", serial]),
    container: kind === "container_absent" ? state().container : null, writeOutcome: kind === "sockets_closed" ? "unknown" : null,
  }));
  const releasePrerequisites = async () => {
    await intent("cutoff"); await external("cutoff_observed"); await external("container_absent");
  };
  return {...f, io: f.state, owner, journal, storage, command, state, intent, external, releasePrerequisites,
    open: () => journal.prepare(command()), prepare: (signal?: AbortSignal) => owner.prepare(journal, f.current, call(signal))};
};

test("construction performs zero journal or Engine IO; acknowledged intent precedes allocation", async () => {
  const f = fixture();
  assert.equal(f.storage.calls, 0); assert.equal(f.io.calls.length, 0);
  await f.open();
  // Read the V4 file inside external IO to prove ordering at the effect itself.
  const client = f.resourceInput.engine.client!;
  const original = client.buffered.bind(client);
  client.buffered = async input => {
    if (input.method === "POST") {assert.equal(f.state().network.phase, 1);}
    return original(input);
  };
  await f.prepare();
  assert.equal(f.state().network.phase, 2);
  assert.equal(f.journal.evidence().resourceLedger, "open");
});

for (const field of ["operationId", "executionGenerationId", "hostBootId", "committedClaimSha256"] as const) {
  test(`current ${field} mismatch prevents every network effect`, async () => {
    const f = fixture(); await f.open();
    assert.throws(() => f.owner.prepare(f.journal, {...f.current, [field]: "foreign"}, call()));
    assert.equal(f.state().network.phase, 0);
    assert.equal(f.io.calls.length, 0);
    assert.equal(f.owner.signal.aborted, true);
  });
}

test("a raw observation object or token from another owner cannot close V4", async () => {
  const f = networkFixture(); const owner = f.resources(); const storage = new MemoryV4Storage();
  const journal = new HostHttpEgressV4Journal(storage, f.subject, owner);
  await journal.prepare(`command:${v4Hash("open")}`);
  const forged = {kind: "cutoff_observed", subjectSha256: v4Hash(f.subject), observerSha256: f.subject.observerSha256,
    targetSha256: journal.target("cutoff_observed"), actualSha256: v4Hash("fake-closed"),
    evidenceSha256: v4Hash("fake"), container: null, writeOutcome: null};
  assert.equal(owner.readObservation(forged), undefined);
  assert.equal(owner.readObservation(new SyntheticV4Owner().token(forged as never)), undefined);
  await assert.rejects(journal.recordObservation(`command:${v4Hash("forged")}`, forged));
  assert.equal(journal.evidence().resourceLedger, "open");
  const ledger = v4Replay(v4Decode(storage.journal!), f.subject);
  assert.equal(ledger.cutoffObserved, false);
  assert.equal(ledger.retired, false);
});

test("cleanup cannot manufacture missing socket/route/container authority or close the ledger", async () => {
  const f = fixture(); await f.open(); await f.prepare();
  assert.equal(await f.owner.cleanupNetwork(), "unknown");
  assert.equal(f.owner.signal.aborted, true);
  assert.equal(f.state().network.phase, 2);
  assert.equal(f.journal.evidence().resourceLedger, "open");
  await f.releasePrerequisites();
  const one = f.owner.cleanupNetwork(); const two = f.owner.cleanupNetwork(); assert.equal(one, two);
  assert.equal(await one, "absent");
  assert.equal(f.state().network.phase, 4);
  assert.equal(f.state().retired, false);
  assert.equal(f.journal.evidence().resourceLedger, "open");
});

test("real Engine membership issues container_attached only after independent listener evidence", async () => {
  const f = fixture(); await f.open(); await f.prepare();
  await f.intent("listener_intent"); await f.external("listener_allocated");
  f.attach();
  await f.owner.observeContainer(f.container, call());
  assert.deepEqual(f.state().container, f.container);
  assert.equal(f.state().retired, false);
});

test("cancel during journal acknowledgement cannot allocate", async () => {
  const storage = new MemoryV4Storage(); const f = fixture(storage); await f.open();
  const reached = deferred(); const release = deferred(); const append = storage.append.bind(storage);
  storage.append = async (expected, bytes) => {await append(expected, bytes); reached.resolve(); await release.promise;};
  const abort = new AbortController(); const preparation = f.prepare(abort.signal); const rejection = assert.rejects(preparation);
  await reached.promise; abort.abort();
  assert.equal(f.owner.signal.aborted, true);
  release.resolve(); await rejection;
  assert.equal(f.state().network.phase, 1);
  assert.equal(f.state().reconcileRequired, true);
});

test("late allocation after cancellation is retained; cleanup gets a fresh deadline and signal", async () => {
  const f = fixture(); await f.open();
  const reached = deferred(); const release = deferred();
  const client = f.resourceInput.engine.client!; const buffered = client.buffered.bind(client);
  const launch = new AbortController();
  client.buffered = async input => {
    const response = await buffered(input);
    if (input.method === "POST") {reached.resolve(); await release.promise;}
    if (input.method === "DELETE") {assert.notEqual(input.call.signal, launch.signal); assert.equal(input.call.signal.aborted, false);}
    return response;
  };
  const preparation = f.prepare(launch.signal); const rejection = assert.rejects(preparation);
  await reached.promise; launch.abort();
  const cleanup = f.owner.cleanupNetwork();
  release.resolve(); await rejection; assert.equal(await cleanup, "unknown");
  await f.releasePrerequisites();
  assert.equal(await f.owner.cleanupNetwork(), "absent");
  assert.equal(f.state().network.phase, 4);
  assert.equal(f.state().reconcileRequired, true);
  assert.equal(f.state().retired, false);
});

test("journal owner drift after allocation closes admission and retains unknown cleanup", async () => {
  const f = fixture(); await f.open();
  const client = f.resourceInput.engine.client!; const buffered = client.buffered.bind(client);
  client.buffered = async input => {
    const response = await buffered(input);
    if (input.method === "POST") {f.storage.owned = false;}
    return response;
  };
  await assert.rejects(f.prepare());
  assert.equal(f.owner.signal.aborted, true);
  assert.equal(f.journal.evidence().resourceLedger, "quarantined");
  assert.equal(await f.owner.cleanupNetwork(), "unknown");
});
