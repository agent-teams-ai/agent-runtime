import assert from "node:assert/strict";
import test from "node:test";
import { createNodeHostHttpListener, type NodeHostHttpListenerObservation } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-listener.js";
import { config, fixture, flush, SyntheticSocket } from "./node-host-http-listener-lifetime-fixture.ts";

// Event-only Node mocks, run through the source hook in the bounded worker.
// The fixture forbids native listen/connect. This is no live/kernel qualification.
const frozen = (value: NodeHostHttpListenerObservation): void => {
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.sockets));
  assert.ok(Object.isFrozen(value.uncertainty));
  assert.equal(value.scope, "retained-node-server-and-delivered-sockets");
  assert.equal(value.sockets.observed, value.sockets.closeEvents + value.sockets.awaitingClose);
};

test("observation is inert, detached, immutable and carries no native close acknowledgement", async t => {
  const f = fixture(t); const first = f.recipe.observe(); frozen(first);
  assert.deepEqual(first, {
    scope: "retained-node-server-and-delivered-sockets", openState: "not-attempted", listenerState: "not-attempted",
    admissionSealed: false, nativeBindPending: false, closeRequested: false, serverCloseAcknowledged: false,
    sockets: { observed: 0, closeEvents: 0, awaitingClose: 0, droppedWithoutSocket: 0 },
    consumerPending: false, consumerWorkPending: false, uncertainty: [],
  });
  for (let index = 0; index < 20; index += 1) {
    const next = f.recipe.observe(); frozen(next); assert.deepEqual(next, first);
    assert.notEqual(next, first); assert.notEqual(next.sockets, first.sockets);
    assert.notEqual(next.uncertainty, first.uncertainty);
  }
  assert.equal(f.servers.length, 0); assert.equal(f.clock.pending, 0);
  f.recipe.sealAdmission();
  assert.equal(f.recipe.observe().admissionSealed, true);
  assert.deepEqual(await f.recipe.close(), { state: "closed" });
  const after = f.recipe.observe(); frozen(after);
  assert.equal(after.closeRequested, true); assert.equal(after.listenerState, "not-attempted");
  assert.equal(after.serverCloseAcknowledged, false); assert.equal(first.admissionSealed, false);
  await assert.rejects(f.recipe.open(async () => {assert.fail();}, f.cutoff));
  assert.equal(f.recipe.observe().openState, "not-attempted"); assert.equal(f.servers.length, 0);
});

for (const failure of ["pre-abort", "expired", "constructor"] as const) {
  test(`${failure} leaves failed opening observable without pretending a Server closed`, async t => {
    const f = fixture(t, { constructorThrows: failure === "constructor" });
    if (failure === "pre-abort") {f.cutoff.abort();}
    if (failure === "expired") {f.clock.time = config.deadline;}
    await assert.rejects(f.recipe.open(async () => {assert.fail();}, f.cutoff));
    const value = f.recipe.observe(); frozen(value);
    assert.equal(value.openState, "failed"); assert.equal(value.listenerState, "not-attempted");
    assert.equal(value.nativeBindPending, false); assert.equal(value.serverCloseAcknowledged, false);
    assert.equal(value.admissionSealed, true); assert.equal(f.servers.length, 0);
    assert.deepEqual(await f.recipe.close(), { state: "closed" });
    assert.equal(f.recipe.observe().serverCloseAcknowledged, false); assert.equal(f.clock.pending, 0);
  });
}

test("pending native bind and unbound close events never produce closed observations", async t => {
  const f = fixture(t, { autoListen: false, autoClose: false });
  const opening = f.recipe.open(async () => {assert.fail();}, f.cutoff);
  const pending = f.recipe.observe(); frozen(pending);
  assert.equal(pending.openState, "pending"); assert.equal(pending.listenerState, "pending");
  assert.equal(pending.nativeBindPending, true); assert.equal(pending.serverCloseAcknowledged, false);
  assert.deepEqual(pending.uncertainty, ["native-bind-unresolved"]);
  const rejected = assert.rejects(opening); const closing = f.recipe.close();
  f.server.ackClose(); await rejected;
  const unresolved = f.recipe.observe(); frozen(unresolved);
  assert.equal(unresolved.openState, "failed"); assert.equal(unresolved.listenerState, "unknown");
  assert.equal(unresolved.nativeBindPending, true); assert.equal(unresolved.serverCloseAcknowledged, false);
  assert.equal(unresolved.closeRequested, true); assert.equal(f.server.closeCalls, 1);
  await f.clock.advance(config.closureDeadline); assert.deepEqual(await closing, { state: "unknown" });
  assert.deepEqual(f.recipe.observe(), unresolved);
  f.server.bind();
  assert.equal(f.server.closeCalls, 2); assert.equal(f.recipe.observe().nativeBindPending, false);
  assert.equal(f.recipe.observe().serverCloseAcknowledged, false);
  f.server.ackClose();
  assert.equal(f.recipe.observe().listenerState, "closed");
  assert.equal(f.recipe.observe().serverCloseAcknowledged, true);
  assert.deepEqual(await closing, { state: "unknown" }); assert.equal(f.recipe.close(), closing);
  assert.equal(pending.nativeBindPending, true); assert.equal(f.clock.pending, 0);
});

test("bound handle before its listening callback remains pending until trusted close observes it", async t => {
  const f = fixture(t, { autoListen: false });
  const opening = f.recipe.open(async () => {assert.fail();}, f.cutoff);
  f.server.listening = true;
  assert.equal(f.recipe.observe().listenerState, "pending");
  assert.equal(f.recipe.observe().nativeBindPending, true);
  const rejected = assert.rejects(opening); const closing = f.recipe.close();
  await rejected; assert.deepEqual(await closing, { state: "closed" });
  const value = f.recipe.observe(); frozen(value);
  assert.equal(value.listenerState, "closed"); assert.equal(value.nativeBindPending, false);
  assert.equal(value.serverCloseAcknowledged, true);
  f.server.emit("listening"); assert.deepEqual(f.recipe.observe(), value);
  assert.equal(f.server.closeCalls, 1);
});

for (const failure of ["throw", "error", "abort", "deadline"] as const) {
  test(`${failure} during bind retains observation and a late endpoint without admission release`, async t => {
    const f = fixture(t, { autoListen: false, listenThrows: failure === "throw" });
    const opening = f.recipe.open(async () => {assert.fail();}, f.cutoff);
    const rejected = assert.rejects(opening, { message: "host HTTP listener unavailable" });
    if (failure === "error") {f.server.emit("error", new Error("private native error"));}
    if (failure === "abort") {f.cutoff.abort();}
    if (failure === "deadline") {await f.clock.advance(config.deadline);}
    await rejected;
    const failed = f.recipe.observe(); frozen(failed);
    assert.equal(failed.openState, "failed"); assert.equal(failed.listenerState, "unknown");
    assert.equal(failed.nativeBindPending, true); assert.equal(failed.serverCloseAcknowledged, false);
    assert.equal(failed.admissionSealed, true); assert.equal(f.server.closeCalls, 0);
    f.server.bind();
    const late = f.recipe.observe(); frozen(late);
    assert.equal(late.openState, "failed"); assert.equal(late.listenerState, "open");
    assert.equal(late.nativeBindPending, false); assert.equal(late.admissionSealed, true);
    assert.equal(late.closeRequested, false); assert.equal(late.serverCloseAcknowledged, false);
    assert.equal(f.server.closeCalls, 0); assert.equal(f.server.listening, true);
    await assert.rejects(f.recipe.open(async () => {assert.fail();}, new AbortController()));
    assert.deepEqual(await f.recipe.close(), { state: "closed" });
    assert.equal(f.recipe.observe().listenerState, "closed"); assert.equal(f.clock.pending, 0);
  });
}

test("failed publication still exposes actual bound custody through the recipe", async t => {
  const f = fixture(t, { autoListen: false });
  const opening = f.recipe.open(async () => {assert.fail();}, f.cutoff);
  f.server.reportedAddress = null; f.server.bind(); await assert.rejects(opening);
  const value = f.recipe.observe(); frozen(value);
  assert.equal(value.openState, "failed"); assert.equal(value.listenerState, "open");
  assert.equal(value.admissionSealed, true); assert.equal(value.serverCloseAcknowledged, false);
  assert.equal(value.nativeBindPending, false); assert.equal(f.server.closeCalls, 0);
  assert.deepEqual(await f.recipe.close(), { state: "closed" });
});

test("seal retains the endpoint; only a late actual close event acknowledges Server closure", async t => {
  const f = fixture(t, { autoClose: false });
  const listener = await f.recipe.open(async () => {assert.fail();}, f.cutoff);
  const open = listener.observe(); frozen(open);
  assert.deepEqual(open, f.recipe.observe()); assert.equal(open.listenerState, "open");
  assert.equal(open.openState, "published"); assert.equal(open.serverCloseAcknowledged, false);
  listener.sealAdmission();
  assert.equal(listener.observe().admissionSealed, true);
  assert.equal(listener.observe().listenerState, "open"); assert.equal(f.server.closeCalls, 0);
  const closing = listener.close(); const waiting = listener.observe(); frozen(waiting);
  assert.equal(waiting.listenerState, "unknown"); assert.equal(waiting.serverCloseAcknowledged, false);
  assert.deepEqual(waiting.uncertainty, ["server-close-unacknowledged"]);
  await f.clock.advance(config.closureDeadline); assert.deepEqual(await closing, { state: "unknown" });
  assert.deepEqual(listener.observe(), waiting);
  f.server.ackClose(); const late = listener.observe(); frozen(late);
  assert.equal(late.listenerState, "closed"); assert.equal(late.serverCloseAcknowledged, true);
  assert.deepEqual(late.uncertainty, []); assert.equal(f.recipe.close(), closing);
  assert.deepEqual(await closing, { state: "unknown" }); assert.equal(f.server.closeCalls, 1);
  assert.equal(waiting.serverCloseAcknowledged, false); assert.equal(open.admissionSealed, false);
  assert.equal(f.clock.pending, 0);
});

test("a close invocation that throws is not a native acknowledgement", async t => {
  const f = fixture(t, { closeThrows: true });
  const listener = await f.recipe.open(async () => {assert.fail();}, f.cutoff);
  const closing = listener.close();
  assert.equal(listener.observe().listenerState, "open");
  assert.equal(listener.observe().closeRequested, true); assert.equal(listener.observe().serverCloseAcknowledged, false);
  await f.clock.advance(config.closureDeadline); assert.deepEqual(await closing, { state: "unknown" });
  f.server.ackClose(); assert.equal(listener.observe().serverCloseAcknowledged, true);
  assert.equal(listener.close(), closing); assert.equal(f.server.closeCalls, 1);
});

test("nonsettling consumer stays pending independently of every native close event", async t => {
  const f = fixture(t); const work = Promise.withResolvers<void>();
  const listener = await f.recipe.open(async () => {await work.promise;}, f.cutoff);
  f.server.connection();
  const active = listener.observe(); frozen(active);
  assert.equal(active.consumerPending, true); assert.equal(active.consumerWorkPending, true);
  assert.deepEqual(active.sockets, { observed: 1, closeEvents: 0, awaitingClose: 1, droppedWithoutSocket: 0 });
  const closing = listener.close(); await flush();
  const drainedSockets = listener.observe(); frozen(drainedSockets);
  assert.equal(drainedSockets.listenerState, "closed"); assert.equal(drainedSockets.serverCloseAcknowledged, true);
  assert.equal(drainedSockets.sockets.awaitingClose, 0); assert.equal(drainedSockets.sockets.closeEvents, 1);
  assert.equal(drainedSockets.consumerPending, true); assert.equal(drainedSockets.consumerWorkPending, true);
  assert.deepEqual(drainedSockets.uncertainty, ["consumer-unsettled"]);
  await f.clock.advance(config.closureDeadline); assert.deepEqual(await closing, { state: "unknown" });
  assert.deepEqual(listener.observe(), drainedSockets);
  work.resolve(); await flush();
  assert.equal(listener.observe().consumerPending, false); assert.equal(listener.observe().consumerWorkPending, false);
  assert.deepEqual(listener.observe().uncertainty, []); assert.equal(drainedSockets.consumerPending, true);
  assert.deepEqual(await listener.close(), { state: "unknown" }); assert.equal(f.clock.pending, 0);
});

test("destroyed and closed Socket flags cannot replace its retained close event", async t => {
  const f = fixture(t); const socket = new SyntheticSocket(); socket.autoClose = false;
  const listener = await f.recipe.open(async accepted => {accepted.destroy();}, f.cutoff);
  f.server.connection(socket); await flush(); socket.closed = true;
  assert.equal(socket.destroyed, true);
  const value = listener.observe(); frozen(value);
  assert.equal(value.sockets.closeEvents, 0); assert.equal(value.sockets.awaitingClose, 1);
  assert.equal(value.consumerPending, false); assert.equal(value.consumerWorkPending, true);
  assert.deepEqual(value.uncertainty, ["socket-close-unobserved", "consumer-work-unsettled"]);
  const closing = listener.close(); await flush();
  assert.equal(listener.observe().serverCloseAcknowledged, true);
  assert.equal(listener.observe().sockets.awaitingClose, 1);
  await f.clock.advance(config.closureDeadline); assert.deepEqual(await closing, { state: "unknown" });
  socket.emit("close"); await flush();
  const late = listener.observe(); frozen(late);
  assert.equal(late.sockets.closeEvents, 1); assert.equal(late.sockets.awaitingClose, 0);
  assert.equal(late.consumerWorkPending, false); assert.deepEqual(late.uncertainty, []);
  socket.emit("close"); assert.deepEqual(listener.observe(), late);
  assert.equal(value.sockets.closeEvents, 0); assert.deepEqual(await closing, { state: "unknown" });
});

for (const rejection of ["sync", "async"] as const) {
  test(`${rejection} consumer rejection still requires a socket close event`, async t => {
    const f = fixture(t); const socket = new SyntheticSocket(); socket.autoClose = false;
    const listener = await f.recipe.open(() => {
      if (rejection === "sync") {throw new Error("private consumer detail");}
      return Promise.reject(new Error("private consumer detail"));
    }, f.cutoff);
    f.server.connection(socket); await flush();
    const value = listener.observe(); frozen(value);
    assert.equal(value.admissionSealed, true); assert.equal(value.listenerState, "open");
    assert.equal(value.consumerPending, false); assert.equal(value.consumerWorkPending, true);
    assert.equal(value.sockets.awaitingClose, 1); assert.equal(value.sockets.closeEvents, 0);
    assert.equal(f.server.closeCalls, 0); socket.actualClose(); await flush();
    assert.equal(listener.observe().consumerWorkPending, false);
    assert.deepEqual(await listener.close(), { state: "closed" });
  });
}

test("rejected prepublication connections are included even when open never yields a handle", async t => {
  const f = fixture(t, { autoListen: false }); const socket = new SyntheticSocket(); socket.autoClose = false;
  const opening = f.recipe.open(async () => {assert.fail();}, f.cutoff);
  f.server.connection(socket); await assert.rejects(opening);
  assert.equal(socket.destroyed, true);
  const value = f.recipe.observe(); frozen(value);
  assert.equal(value.openState, "failed"); assert.equal(value.nativeBindPending, true);
  assert.equal(value.sockets.observed, 1); assert.equal(value.sockets.awaitingClose, 1);
  assert.equal(value.consumerPending, false); assert.equal(value.consumerWorkPending, false);
  f.server.bind(); const closing = f.recipe.close(); await flush();
  assert.equal(f.recipe.observe().serverCloseAcknowledged, true);
  assert.equal(f.recipe.observe().sockets.awaitingClose, 1);
  socket.actualClose(); assert.deepEqual(await closing, { state: "closed" });
  assert.equal(f.recipe.observe().sockets.closeEvents, 1);
});

test("every extra connection retains its close event without creating an overlapping consumer", async t => {
  const f = fixture(t); const work = Promise.withResolvers<void>(); let calls = 0;
  const listener = await f.recipe.open(async () => {calls += 1; await work.promise;}, f.cutoff);
  const first = new SyntheticSocket(); const extra = new SyntheticSocket(); const sealed = new SyntheticSocket();
  first.autoClose = false; extra.autoClose = false; sealed.autoClose = false;
  f.server.connection(first); f.server.connection(extra); f.server.connection(sealed);
  const value = listener.observe(); frozen(value);
  assert.equal(value.admissionSealed, true); assert.equal(calls, 1);
  assert.equal(value.sockets.observed, 3); assert.equal(value.sockets.awaitingClose, 3);
  assert.equal(value.consumerPending, true); assert.equal(f.server.closeCalls, 0);
  assert.equal(extra.destroyed, true); assert.equal(sealed.destroyed, true);
  first.actualClose(); extra.actualClose(); work.resolve(); await flush();
  const refusedPending = listener.observe(); frozen(refusedPending);
  assert.equal(refusedPending.consumerWorkPending, false); assert.equal(refusedPending.sockets.awaitingClose, 1);
  assert.equal(refusedPending.sockets.closeEvents, 2);
  const closing = listener.close(); await flush();
  assert.equal(listener.observe().serverCloseAcknowledged, true);
  assert.deepEqual(listener.observe().uncertainty, ["socket-close-unobserved"]);
  sealed.actualClose(); assert.deepEqual(await closing, { state: "closed" });
  assert.equal(listener.observe().sockets.closeEvents, 3); assert.equal(calls, 1);
});

test("native drop has explicit unobserved socket scope even after Server cleanup", async t => {
  const f = fixture(t); const listener = await f.recipe.open(async () => {assert.fail();}, f.cutoff);
  f.server.emit("drop"); f.server.emit("drop");
  const value = listener.observe(); frozen(value);
  assert.equal(value.admissionSealed, true); assert.equal(value.sockets.observed, 0);
  assert.equal(value.sockets.droppedWithoutSocket, 2); assert.equal(f.server.closeCalls, 0);
  assert.deepEqual(value.uncertainty, ["native-drop-unobserved"]);
  assert.deepEqual(await listener.close(), { state: "closed" });
  assert.equal(listener.observe().serverCloseAcknowledged, true);
  assert.deepEqual(listener.observe().uncertainty, ["native-drop-unobserved"]);
});

test("consumer reentrancy sees its retained pending promise and cannot supply observation facts", async t => {
  const f = fixture(t); const work = Promise.withResolvers<void>();
  const fake = { listenerState: "closed", serverCloseAcknowledged: true, consumerPending: false };
  let during: NodeHostHttpListenerObservation | undefined;
  const input = { accept: async () => {
    during = Reflect.apply(f.recipe.observe, fake, [fake]) as NodeHostHttpListenerObservation;
    void f.recipe.close(); await work.promise;
  } };
  const listener = await f.recipe.open(input.accept, f.cutoff);
  input.accept = async () => {assert.fail("retained consumer was replaced");};
  f.server.connection(); assert.ok(during); frozen(during);
  assert.equal(during.listenerState, "open"); assert.equal(during.serverCloseAcknowledged, false);
  assert.equal(during.consumerPending, true); assert.equal(during.consumerWorkPending, true);
  fake.consumerPending = true; fake.serverCloseAcknowledged = false;
  await flush(); const pending = listener.observe(); frozen(pending);
  assert.equal(pending.serverCloseAcknowledged, true); assert.equal(pending.consumerPending, true);
  const malicious = new Proxy({}, { get: () => {assert.fail("caller snapshot read");} });
  assert.deepEqual(Reflect.apply(listener.observe, malicious, [malicious]), pending);
  assert.equal(Reflect.set(pending, "consumerPending", false), false);
  assert.equal(Reflect.set(pending.sockets, "awaitingClose", 99), false);
  assert.equal(Reflect.set(pending.uncertainty, "0", "forged"), false);
  assert.deepEqual(listener.observe(), pending);
  work.resolve(); assert.deepEqual(await listener.close(), { state: "closed" });
  assert.equal(listener.observe().consumerPending, false); assert.equal(pending.consumerPending, true);
});

test("repeated observations never sample time or mutable consumer Socket properties", async t => {
  const f = fixture(t); const work = Promise.withResolvers<void>();
  const listener = await f.recipe.open(async () => {await work.promise;}, f.cutoff);
  const socket = f.server.connection(); const original = listener.observe();
  const clockWatchers = f.clock.pending; const nativeListeners = f.server.eventNames().map(name => f.server.listenerCount(name));
  const now = t.mock.method(f.clock, "now", () => {assert.fail("observation sampled clock");});
  const within = t.mock.method(f.clock, "within", () => {assert.fail("observation armed clock");});
  Object.defineProperty(socket, "destroyed", { configurable: true, get: () => {assert.fail("observation read socket flag");} });
  for (let index = 0; index < 100; index += 1) {const value = listener.observe(); frozen(value); assert.deepEqual(value, original);}
  assert.equal(now.mock.callCount(), 0); assert.equal(within.mock.callCount(), 0);
  assert.equal(f.clock.pending, clockWatchers); assert.equal(f.server.closeCalls, 0);
  assert.deepEqual(f.server.eventNames().map(name => f.server.listenerCount(name)), nativeListeners);
  now.mock.restore(); within.mock.restore();
  Object.defineProperty(socket, "destroyed", { configurable: true, writable: true, value: false });
  work.resolve(); assert.deepEqual(await listener.close(), { state: "closed" });
});

test("normal sequential cleanup counts actual events with no retained unsettled work", async t => {
  const f = fixture(t);
  const listener = await f.recipe.open(async socket => {socket.destroy();}, f.cutoff);
  for (let index = 1; index <= 3; index += 1) {
    f.server.connection(); await flush(); const value = listener.observe(); frozen(value);
    assert.equal(value.listenerState, "open"); assert.equal(value.admissionSealed, false);
    assert.equal(value.sockets.observed, index); assert.equal(value.sockets.closeEvents, index);
    assert.equal(value.sockets.awaitingClose, 0); assert.equal(value.consumerPending, false);
    assert.equal(value.consumerWorkPending, false); assert.deepEqual(value.uncertainty, []);
  }
  const closing = listener.close(); assert.equal(f.recipe.close(), closing);
  assert.deepEqual(await closing, { state: "closed" }); const final = listener.observe(); frozen(final);
  assert.equal(final.listenerState, "closed"); assert.equal(final.serverCloseAcknowledged, true);
  assert.equal(final.nativeBindPending, false); assert.equal(final.admissionSealed, true);
  assert.deepEqual(final.uncertainty, []); assert.equal(f.clock.pending, 0);
  assert.deepEqual(f.recipe.observe(), final); assert.equal(f.server.closeCalls, 1);
});

test("an extracted observer remains bound to its recipe across other listener lifetimes", async t => {
  const f = fixture(t); const observe = f.recipe.observe;
  const other = createNodeHostHttpListener(config, f.clock);
  const otherListener = await other.open(async () => {assert.fail();}, new AbortController());
  assert.equal(observe.call(other).listenerState, "not-attempted");
  assert.equal(other.observe().listenerState, "open");
  const listener = await f.recipe.open(async () => {assert.fail();}, f.cutoff);
  assert.equal(observe.call(other).listenerState, "open");
  assert.deepEqual(await listener.close(), { state: "closed" });
  assert.equal(observe.call(other).listenerState, "closed");
  assert.equal(otherListener.observe().listenerState, "open");
  assert.deepEqual(await otherListener.close(), { state: "closed" });
  assert.equal(f.servers.length, 2); assert.equal(f.clock.pending, 0);
});
