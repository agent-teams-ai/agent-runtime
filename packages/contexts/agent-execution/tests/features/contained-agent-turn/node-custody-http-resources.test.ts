import assert from "node:assert/strict";
import { test } from "node:test";
import { createV4HostHttpListenerLifecycle, fixture, deferred, tick, liveFor, Core, Kernel, nodeFixture, resourcesFor, kernelHost, proofFor } from "./node-custody-http-resources-fixture.ts";

const burn = (f: Awaited<ReturnType<typeof fixture>>) => f.controller.abort();

test("loaded resource fixture rejects native sockets and Docker filesystem access", async () => {
  // Import after fixture setup so these are the bindings seen by its adapters.
  const {createConnection, Socket} = await import("node:net");
  const {open, readdir, readlink} = await import("node:fs/promises");
  let connected = false;
  const onConnect = () => {connected = true;};
  assert.throws(() => createConnection({path: "/synthetic/docker.sock"}, onConnect), /network connections forbidden/u);
  assert.throws(() => createConnection({host: "10.203.0.1", port: 43129}, onConnect), /network connections forbidden/u);
  assert.throws(() => new Socket(), /network connections forbidden/u);
  await assert.rejects(open("/synthetic/docker.sock", "r"), /filesystem access forbidden/u);
  await assert.rejects(readdir("/synthetic"), /filesystem access forbidden/u);
  await assert.rejects(readlink("/synthetic/docker.sock"), /filesystem access forbidden/u);
  await tick();
  assert.equal(connected, false);
});

test("trusted actual kernel claim acquires and prepares fixed resources on its underlying reservation", async () => {
  const f = await nodeFixture();
  let resources: Awaited<ReturnType<typeof fixture>> | undefined;
  const kernel = new Kernel(f.core, {...kernelHost,
    workspaceOwner: {async withLaunchAuthority(_input, consume) {return consume(f.workspaceAuthority);}},
    attemptOwner: {async prepare() {return f.plan;}, retain() {}, retire() {}},
    postClaimPreparation: {async prepareClaimed(handoff) {
      const lifetime = f.preparation.acquire(handoff);
      resources = await resourcesFor(f, lifetime);
      assert.equal(resources.servers.length, 0); assert.equal(resources.storage.opens, 0);
      assert.equal((await resources.prepare()).kind, "prepared");
      assert.equal(resources.servers.length, 1); assert.equal(resources.storage.locks, 1);
      assert.ok(liveFor(handoff.underlyingCustodyRef).httpReservation.pending);
      // Local resource preparation cannot qualify the missing live route.
      return {kind: "unsupported", reason: "network"};
    }},
  });
  const opened = await kernel.open(f.kernelInput);
  const proof = proofFor(f.kernelInput, opened);
  const result = await kernel.start({...f.identity, intentMode: "analysis", committedDispatchProof: proof,
    execute: async () => {throw new Error("live route must remain closed");}});
  assert.equal(result.kind, "indeterminate");
  assert.ok(resources); assert.equal(resources.lifetime.signal.aborted, true);
  assert.equal(resources.storage.tombstones, 1); assert.equal(resources.servers[0]!.closeCalls, 0);
  assert.equal((await resources.release()).kind, "unproven");
});

test("foreign, copied, changed receiver and duplicate capabilities reject before any allocation", async () => {
  const f = await fixture();
  const foreign = await nodeFixture();
  assert.throws(() => foreign.preparation.prepareResources(f.lifetime, f.resourceInput), /conflicts/u);
  assert.throws(() => f.preparation.prepareResources({...f.lifetime}, f.resourceInput), /conflicts/u);
  assert.throws(() => f.preparation.prepareResources.call({}, f.lifetime, f.resourceInput), /conflicts/u);
  assert.throws(() => f.preparation.acquire(f.handoff), /conflicts/u);
  assert.equal(f.servers.length, 0); assert.equal(f.storage.opens, 0);
  const prepared = f.prepare();
  assert.throws(() => f.prepare(), /conflicts/u);
  assert.equal((await prepared).kind, "prepared");
  assert.equal(f.storage.opens, 1); assert.equal(f.servers.length, 1);
  burn(f); await tick();
});

for (const mode of ["cut", "released"] as const) {
  test(`${mode} reservation cannot obtain resource authority`, async () => {
    const f = await fixture();
    burn(f);
    if (mode === "released") {assert.equal((await f.release()).kind, "released");}
    assert.throws(() => f.prepare(), /sealed|conflicts/u);
    assert.throws(() => f.preparation.acquire(f.handoff), /unavailable|conflicts/u);
    assert.equal(f.storage.opens, 0); assert.equal(f.servers.length, 0);
  });
}

for (const missing of ["v4", "network-observation", "subject", "consumption"] as const) {
  test(`missing ${missing} stays unsupported before listener/journal allocation`, async () => {
    const f = await fixture();
    let input = f.resourceInput;
    if (missing === "v4") {input = {...input, listenerLifecycle: createV4HostHttpListenerLifecycle({v4: {} as never, subject: f.subject})};}
    if (missing === "network-observation") {await f.intent("cutoff");}
    if (missing === "subject") {input = {...input, listenerLifecycle: createV4HostHttpListenerLifecycle({v4: f.v4, subject: {...f.subject, effectId: `effect:${"f".repeat(64)}`}})};}
    if (missing === "consumption") {input = {...input, consumption: undefined as never};}
    assert.equal((await f.preparation.prepareResources(f.lifetime, input)).kind, "unsupported");
    assert.equal(f.storage.opens, 0); assert.equal(f.servers.length, 0);
    assert.equal((await f.release()).kind, "released");
  });
}

test("cutoff during concrete consumption preparation quarantines late journal success", async () => {
  const journal = deferred<void>();
  const f = await fixture({pendingJournal: journal.promise});
  const pending = f.prepare(); await tick();
  const owned = liveFor(f.custodyRef).httpReservation.pending;
  assert.ok(owned); assert.equal(f.storage.opens, 1); assert.equal(f.servers.length, 1);
  burn(f);
  let settled = false; void pending.then(() => {settled = true; return settled;});
  await tick(); assert.equal(settled, false);
  assert.equal(liveFor(f.custodyRef).httpReservation.pending, owned);
  assert.equal(f.servers[0]!.listening, true); assert.equal(f.servers[0]!.closeCalls, 0);
  journal.resolve(); assert.equal((await pending).kind, "unproven"); await tick();
  assert.equal(f.storage.created, 1); assert.equal(f.storage.tombstones, 1); assert.equal(f.storage.closes, 1);
  assert.match(f.storage.disposition, /quarantined/u);
  assert.equal((await f.release()).kind, "unproven");
  assert.equal(f.servers[0]!.closeCalls, 0);
  await f.authorizeRelease();
  // Actual quarantined consumption deliberately retires as unknown, even after
  // its descriptor/lock cleanup: retain reconciliation, never claim released.
  assert.equal((await f.release()).kind, "unproven");
  assert.equal(f.servers[0]!.closeCalls, 1); assert.equal(f.servers[0]!.listening, false);
  assert.ok(f.records().includes("listener_release"));
  assert.equal((await f.release()).kind, "unproven"); assert.equal(f.servers[0]!.closeCalls, 1);
});

test("late consumption rejection preserves unknown outcome and the reservation", async () => {
  const journal = deferred<void>();
  const f = await fixture({pendingJournal: journal.promise});
  const pending = f.prepare(); await tick(); burn(f);
  journal.reject(new Error("synthetic late storage failure"));
  assert.equal((await pending).kind, "unproven");
  await f.authorizeRelease();
  assert.equal((await f.release()).kind, "unproven");
  assert.equal(f.servers[0]!.closeCalls, 1);
  assert.equal(f.storage.opens, 1); assert.equal(f.storage.created, 0);
  assert.equal(liveFor(f.custodyRef).httpReservation.signal.aborted, true);
  assert.throws(() => f.prepare(), /sealed/u);
});

for (const phase of ["listen", "journal"] as const) {
  test(`synchronous ${phase} reentrancy sees owned completion and seals before returning`, async () => {
    const f = await fixture();
    let observed = false;
    const reenter = () => {
      assert.ok(liveFor(f.custodyRef).httpReservation.pending);
      assert.throws(() => f.prepare(), /conflicts/u);
      burn(f); observed = true;
    };
    if (phase === "listen") {f.duringListen(reenter);} else {f.duringStorageOpen(reenter);}
    assert.equal((await f.prepare()).kind, "unproven"); await tick();
    assert.equal(observed, true); assert.equal(f.lifetime.signal.aborted, true);
    assert.equal(f.servers[0]!.closeCalls, 0);
    if (phase === "journal") {assert.equal(f.storage.tombstones, 1);}
    await f.authorizeRelease(); await f.release();
    assert.equal(f.servers[0]!.closeCalls, 1);
  });
}

test("synchronous listener throw cannot orphan a recipe that later binds", async () => {
  const f = await fixture({pendingListen: true});
  f.duringListen(() => {throw new Error("synthetic native listen throw");});
  assert.equal((await f.prepare()).kind, "unproven");
  assert.equal(f.lifetime.signal.aborted, true); assert.equal(f.servers[0]!.closeCalls, 0);
  assert.equal(f.storage.opens, 0);
  f.servers[0]!.bind();
  assert.equal((await f.release()).kind, "unproven");
  await f.authorizeRelease();
  assert.equal((await f.release()).kind, "released");
  assert.equal(f.servers[0]!.closeCalls, 1);
});

test("same finalized authenticated/local-cut session is synchronously sealed with concrete resources", async () => {
  const f = await fixture(); assert.equal((await f.prepare()).kind, "prepared");
  const {session, bundle} = await f.finalize();
  assert.equal(Core.launchView(f.core, f.custodyRef)!.readFinal(), bundle);
  assert.equal(typeof session.nativeBearerToken(), "string");
  burn(f);
  assert.throws(() => session.nativeBearerToken(), /inbound_authentication_denied/u);
  assert.equal(f.storage.tombstones, 1); assert.equal(f.servers[0]!.closeCalls, 0);
  assert.throws(() => Core.startFinalized(f.core, f.custodyRef, bundle, new AbortController().signal), /sealed/u);
  assert.equal((await f.release()).kind, "unproven");
});

test("unknown listener cleanup cannot tombstone even after later native close acknowledgement", async () => {
  const f = await fixture({unknownClose: true});
  // Stop before consumption allocation, isolating the actual listener's unknown
  // close receipt from the independent journal reconciliation outcome.
  f.duringListen(() => burn(f));
  assert.equal((await f.prepare()).kind, "unproven"); await tick();
  await f.authorizeRelease();
  const releasing = f.release(); await tick();
  assert.equal(f.servers[0]!.closeCalls, 1);
  f.advance(25_000); assert.equal((await releasing).kind, "unproven");
  f.servers[0]!.ackClose();
  assert.equal((await f.release()).kind, "unproven");
  assert.equal(f.servers[0]!.closeCalls, 1); assert.equal(f.storage.opens, 0);
});

test("release timeout keeps concrete pending retirement and cannot report released", async () => {
  const f = await fixture(); assert.equal((await f.prepare()).kind, "prepared");
  const retirement = deferred<void>(); f.storage.closeGate = retirement.promise;
  burn(f); await tick();
  // Exercise the existing bounded release without waiting the default 15 seconds.
  const live = liveFor(f.custodyRef);
  const {releaseHostCustody} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-release.js");
  const contained = await f.contain(); assert.equal(contained.kind, "contained");
  if (contained.kind !== "contained") {return;}
  const state = {byRef: new Map([[f.custodyRef, live]]), byAttempt: new Map([[live.attemptId, live]]),
    tombstonesByRef: new Map(), tombstonesByAttempt: new Map(), cleanupAfterMs: 1,
    maxTombstones: 10, monotonicNow: () => 0};
  const result = await releaseHostCustody(state, {...f.containmentInput, receiptRef: contained.receiptRef});
  assert.equal(result.kind, "unproven"); assert.equal(state.byRef.get(f.custodyRef), live);
  assert.equal(state.tombstonesByRef.size, 0); assert.equal(f.storage.closes, 1);
  retirement.resolve(); await tick(); await f.authorizeRelease();
  assert.equal((await f.release()).kind, "unproven"); assert.equal(f.storage.closes, 1);
});

test("retained endpoint requires V4 cutoff, socket closure, exact removal and a fresh release intent", async () => {
  const f = await fixture(); assert.equal((await f.prepare()).kind, "prepared");
  await f.observe("listener_allocated"); await f.observe("container_attached");
  await f.intent("route_intent"); await f.observe("route_installed");
  await f.intent("inbound_intent"); await f.observe("inbound_allocated");
  await f.intent("upstream_intent"); await f.observe("upstream_allocated");
  burn(f);
  assert.equal((await f.release()).kind, "unproven"); assert.equal(f.servers[0]!.closeCalls, 0);
  await f.intent("cutoff"); await f.observe("cutoff_observed");
  assert.equal((await f.release()).kind, "unproven"); assert.equal(f.servers[0]!.closeCalls, 0);
  await f.intent("sockets_close"); await f.observe("sockets_closed");
  assert.equal((await f.release()).kind, "unproven"); assert.equal(f.servers[0]!.closeCalls, 0);
  await f.observe("container_absent");
  assert.equal((await f.release()).kind, "unproven"); assert.equal(f.servers[0]!.closeCalls, 1);
  const events = f.records();
  assert.ok(events.indexOf("sockets_closed") < events.indexOf("container_absent"));
  assert.ok(events.indexOf("container_absent") < events.indexOf("listener_release"));
  assert.equal(events.filter(kind => kind === "listener_release").length, 1);
  assert.equal((await f.release()).kind, "unproven"); assert.equal(f.servers[0]!.closeCalls, 1);
});

test("previously recorded V4 release intent does not permit this owner to close the endpoint", async () => {
  const f = await fixture(); assert.equal((await f.prepare()).kind, "prepared");
  burn(f); await f.authorizeRelease(); await f.intent("listener_release");
  assert.equal((await f.release()).kind, "unproven"); assert.equal(f.servers[0]!.closeCalls, 0);
  assert.equal(f.servers[0]!.listening, true);
});

test("the retained local-cut session propagates shutdown to the same reservation and resources", async () => {
  const f = await fixture(); assert.equal((await f.prepare()).kind, "prepared");
  const {session} = await f.finalize();
  f.shutdown.abort();
  assert.equal(f.lifetime.signal.aborted, true);
  assert.throws(() => session.nativeBearerToken(), /inbound_authentication_denied/u);
  assert.equal(f.storage.tombstones, 1); assert.equal(f.servers[0]!.closeCalls, 0);
});

for (const cancelled of [false, true]) {
  test(`deferred listener ACK gates consumption and retains late cleanup (cancelled=${cancelled})`, async () => {
    const f = await fixture({pendingListen: true});
    let reads = 0;
    const consumption = {async prepare() {
      reads++;
      assert.equal(f.servers[0]!.listening, true);
      return f.resourceInput.consumption.prepare();
    }};
    const pending = f.preparation.prepareResources(f.lifetime, {...f.resourceInput, consumption});
    await tick();
    assert.equal(f.servers.length, 1); assert.equal(reads, 0); assert.equal(f.storage.opens, 0);
    const owned = liveFor(f.custodyRef).httpReservation.pending;
    assert.ok(owned);
    if (cancelled) {burn(f);}
    f.servers[0]!.bind();
    assert.equal((await pending).kind, cancelled ? "unproven" : "prepared");
    assert.equal(reads, cancelled ? 0 : 1);
    assert.equal(f.storage.opens, cancelled ? 0 : 1);
    assert.equal(f.servers[0]!.closeCalls, 0);
    assert.equal((await f.release()).kind, "unproven");
    await f.authorizeRelease();
    assert.equal((await f.release()).kind, cancelled ? "released" : "unproven");
    assert.equal(f.servers[0]!.closeCalls, 1);
  });
}

test("unknown deployment close retains the same listener and original release intent for retry", async () => {
  const f = await fixture();
  let closes = 0;
  const original = f.resourceInput.listener;
  const listener = {...original, async close() {
    closes++;
    const result = await original.close();
    return closes === 1 ? {state: "unknown" as const} : result;
  }};
  assert.equal((await f.preparation.prepareResources(f.lifetime, {...f.resourceInput, listener})).kind, "prepared");
  burn(f); await f.authorizeRelease();
  await f.release(); assert.equal(closes, 1);
  await f.release(); assert.equal(closes, 2);
  assert.equal(f.records().filter(kind => kind === "listener_release").length, 1);
});
