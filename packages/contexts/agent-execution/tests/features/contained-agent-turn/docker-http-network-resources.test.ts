import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { DockerHttpNetworkResources } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-http-network-resources.js";
import { HostHttpEgressV4Journal } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-journal.js";
import { v4Decode, v4Hash } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import { v4Replay } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-replay.js";
import type { HostHttpEgressV4Intent, HostHttpEgressV4Observed } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-types.js";
import { MemoryV4Storage, SyntheticV4Owner } from "../../fixtures/host-http-egress-v4-fixture.ts";
import { call, deferred, networkFixture } from "../../fixtures/docker-operation-network-fixture.ts";

const fixture = (storage = new MemoryV4Storage(), cleanupMilliseconds = 5_000) => {
  const f = networkFixture(); const owner = new DockerHttpNetworkResources({...f.resourceInput, cleanupMilliseconds});
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


test("launch abort remains subscribed after successful preparation and cuts admission synchronously", async () => {
  const f = fixture(); await f.open(); const launch = new AbortController();
  await f.prepare(launch.signal);
  assert.equal(f.owner.signal.aborted, false);
  launch.abort();
  assert.equal(f.owner.signal.aborted, true);
  assert.equal(getEventListeners(launch.signal, "abort").length, 0);
  assert.equal(f.state().retired, false);
  assert.equal(f.state().container, null);
  await f.releasePrerequisites();
  assert.equal(await f.owner.cleanupNetwork(), "absent");
});

test("stopped original lifetime abort cuts prepared resources and prevents membership admission", async () => {
  const f = fixture(); await f.open(); const launch = new AbortController();
  launch.signal.addEventListener("abort", event => event.stopImmediatePropagation());
  await f.prepare(launch.signal); launch.abort();
  assert.equal(f.owner.signal.aborted, true);
  f.attach(); const calls = f.io.calls.length;
  await assert.rejects(f.owner.observeContainer(f.container, call()));
  assert.equal(f.io.calls.length, calls); assert.equal(f.state().container, null);
  assert.equal(f.journal.evidence().admission, "closed");
  assert.equal(f.io.writes.filter(value => value.method === "POST").length, 1);
});

for (const kind of ["network_release", "network_absent", "uncertain"] as const) {
  test(`cleanup deadline bounds retained ${kind} acknowledgement without retrying effects`, async t => {
    const storage = new MemoryV4Storage(); const f = fixture(storage, 20);
    await f.open(); await f.prepare(); await f.releasePrerequisites();
    if (kind === "uncertain") {f.io.removeFault = "lost";}
    const reached = deferred(); const release = deferred(); const append = storage.append.bind(storage);
    let acknowledgements = 0;
    storage.append = async (expected, bytes) => {
      await append(expected, bytes);
      if (v4Decode(storage.journal!).at(-1)!.event.kind === kind) {
        acknowledgements += 1; reached.resolve(); await release.promise;
      }
    };
    const first = f.owner.cleanupNetwork(); assert.equal(f.owner.cleanupNetwork(), first);
    await reached.promise;
    // A watchdog exposes the pre-fix hang while finally always releases the fixture.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const bounded = (pending: Promise<"absent" | "unknown">) => Promise.race([pending,
      new Promise<"stuck">(resolve => {watchdog = setTimeout(() => resolve("stuck"), 100);})]);
    try {
      assert.equal(await bounded(first), "unknown"); clearTimeout(watchdog);
      const second = f.owner.cleanupNetwork(); assert.notEqual(second, first);
      assert.equal(await bounded(second), "unknown"); clearTimeout(watchdog);
      assert.equal(acknowledgements, 1);
      assert.equal(f.io.writes.filter(value => value.method === "DELETE").length, kind === "network_release" ? 0 : 1);
    } finally {clearTimeout(watchdog); release.resolve(); await first;}
    // Let the retained flight settle; only a later explicit call may resume cleanup.
    await new Promise<void>(resolve => {setImmediate(resolve);});
    // Recovery has no held IO. Keep CPU scheduling from spending its fresh
    // 20 ms Engine budget after the real caller-deadline probes above.
    const recoveredAt = Date.now(); t.mock.method(Date, "now", () => recoveredAt);
    assert.equal(await f.owner.cleanupNetwork(), "absent");
    assert.equal(acknowledgements, 1);
    assert.equal(f.io.writes.filter(value => value.method === "POST").length, 1);
    assert.equal(f.io.writes.filter(value => value.method === "DELETE").length, 1);
    assert.equal(f.state().network.phase, 4); assert.equal(f.state().retired, false);
    if (kind === "uncertain") {assert.equal(f.journal.evidence().reconcileRequired, true);}
  });
}

test("cleanup deadline bounds a stuck preparation while retaining the late allocation", async () => {
  const f = fixture(new MemoryV4Storage(), 40); await f.open();
  const reached = deferred(); const release = deferred();
  f.io.after = async label => {
    if (label === "POST /v1.47/networks/create") {reached.resolve(); await release.promise;}
  };
  const rejection = assert.rejects(f.prepare()); await reached.promise;
  assert.equal(await f.owner.cleanupNetwork(), "unknown");
  assert.ok(f.io.network);
  assert.equal(f.owner.signal.aborted, true);
  release.resolve(); await rejection;
  await f.releasePrerequisites();
  assert.equal(await f.owner.cleanupNetwork(), "absent");
  assert.equal(f.io.writes.filter(value => value.method === "POST").length, 1);
  assert.equal(f.state().retired, false);
});

test("in-flight membership is retained before cleanup and a late container remains owned", async () => {
  const f = fixture(); await f.open(); await f.prepare();
  await f.intent("listener_intent"); await f.external("listener_allocated"); f.attach();
  const reached = deferred(); const release = deferred();
  f.io.after = async label => {
    if (label === `GET /v1.47/containers/${f.container.containerId}/json`) {reached.resolve(); await release.promise;}
  };
  const rejection = assert.rejects(f.owner.observeContainer(f.container, call())); await reached.promise;
  const cleanup = f.owner.cleanupNetwork(); let settled = false;
  void cleanup.then(() => {settled = true; return settled;}); await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(f.owner.signal.aborted, true);
  release.resolve(); await rejection;
  assert.equal(await cleanup, "unknown");
  assert.equal(f.state().container, null, "cancelled membership is not attached evidence");
  await f.releasePrerequisites();
  await f.intent("listener_release"); await f.external("listener_absent");
  assert.equal(await f.owner.cleanupNetwork(), "unknown", "real container still exists despite synthetic other-owner claim");
  f.io.containerPresent = false; f.io.network.Containers = {};
  assert.equal(await f.owner.cleanupNetwork(), "absent");
  assert.equal(f.state().retired, false);
});

for (const boundary of ["intent-ownership", "intent-append", "allocation-observation"] as const) {
  test(`cancellation at V4 ${boundary} await never grants admission or loses cleanup`, async () => {
    const storage = new MemoryV4Storage(); const f = fixture(storage); await f.open();
    const launch = new AbortController();
    const append = storage.append.bind(storage); const assertOwned = storage.assertOwned.bind(storage);
    let cancelled = false;
    storage.assertOwned = async () => {
      await assertOwned();
      if (!cancelled && boundary === "intent-ownership") {cancelled = true; launch.abort();}
    };
    storage.append = async (expected, bytes) => {
      await append(expected, bytes);
      const phase = f.state().network.phase;
      if (!cancelled && (boundary === "intent-append" && phase === 1 || boundary === "allocation-observation" && phase === 2)) {
        cancelled = true; launch.abort();
      }
    };
    await assert.rejects(f.prepare(launch.signal));
    assert.equal(cancelled, true); assert.equal(f.owner.signal.aborted, true);
    if (boundary !== "allocation-observation") {assert.equal(f.io.writes.length, 0);}
    else {
      await f.releasePrerequisites(); assert.equal(await f.owner.cleanupNetwork(), "absent");
    }
    assert.equal(f.state().retired, false);
  });
}

test("a missing journal observation reader cannot be substituted by matching raw readback", async () => {
  const f = networkFixture(); const owner = f.resources(); const storage = new MemoryV4Storage();
  const observations = new WeakMap<object, never>();
  const journal = new HostHttpEgressV4Journal(storage, f.subject, {readObservation: token => observations.get(token)});
  await journal.prepare(`command:${v4Hash("open-without-network-issuer")}`);
  await assert.rejects(owner.prepare(journal, f.current, call()));
  assert.equal(owner.signal.aborted, true); assert.ok(f.state.network);
  assert.equal(journal.evidence().resourceLedger, "open");
  assert.equal(journal.evidence().admission, "closed");
  assert.equal(journal.evidence().reconcileRequired, true);
  assert.equal(await owner.cleanupNetwork(), "unknown");
});
