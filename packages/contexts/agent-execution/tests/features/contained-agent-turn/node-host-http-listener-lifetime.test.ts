import assert from "node:assert/strict";
import test from "node:test";
import { config, fixture, flush, SyntheticSocket } from "./node-host-http-listener-lifetime-fixture.ts";

// Synthetic source evidence only. Main must separately prove native loopback
// EADDRINUSE while sealed, then successful rebind after final release.
test("inert recipe can seal or close before its one allowed open", async t => {
  const f = fixture(t);
  assert.equal(f.servers.length, 0); assert.equal(f.clock.pending, 0);
  f.recipe.sealAdmission();
  await assert.rejects(f.recipe.open(async () => {assert.fail();}, f.cutoff));
  const closing = f.recipe.close(); assert.equal(f.recipe.close(), closing);
  assert.deepEqual(await closing, { state: "closed" });
  assert.equal(f.servers.length, 0);
});

test("listen options preserve one exact private endpoint and pristine paused binary sockets", async t => {
  const f = fixture(t); let calls = 0;
  const listener = await f.recipe.open(async (socket, signal) => {
    calls += 1;
    assert.equal(signal, f.cutoff.signal); assert.equal(socket.readableEncoding, null);
    assert.equal(socket.readableFlowing, false); assert.equal(socket.allowHalfOpen, true);
    assert.equal(socket.readableHighWaterMark, 65_536);
    assert.equal(socket.listenerCount("data"), 0); assert.equal(socket.listenerCount("readable"), 0);
    socket.destroy();
  }, f.cutoff);
  assert.deepEqual(f.server.options, { allowHalfOpen: true, pauseOnConnect: true, highWaterMark: 65_536 });
  assert.deepEqual(f.server.listenOptions, { host: config.host, port: 0, backlog: 1, exclusive: true });
  assert.equal(f.server.maxConnections, 1); assert.ok(Object.isFrozen(listener.address));
  assert.ok(Object.isFrozen(listener)); assert.ok(Object.isFrozen(f.recipe));
  f.server.connection(); await flush(); f.server.connection(); await flush();
  assert.equal(calls, 2); assert.equal(f.cutoff.signal.aborted, false);
  await assert.rejects(f.recipe.open(async () => {assert.fail();}, new AbortController()));
  assert.equal(f.servers.length, 1);
  assert.deepEqual(await listener.close(), { state: "closed" }); assert.equal(f.clock.pending, 0);
});

for (const seal of ["handle", "recipe", "cutoff"] as const) {
  test(`${seal} seal aborts active work synchronously and retains endpoint until explicit final close`, async t => {
    const f = fixture(t); let calls = 0; let aborted = false;
    const work = Promise.withResolvers<void>();
    const listener = await f.recipe.open(async (_socket, signal) => {
      calls += 1; signal.addEventListener("abort", () => {aborted = true;}); await work.promise;
    }, f.cutoff);
    const socket = f.server.connection();
    if (seal === "handle") {listener.sealAdmission();}
    else if (seal === "recipe") {f.recipe.sealAdmission();}
    else {f.cutoff.abort();}
    assert.equal(aborted, true); assert.equal(socket.destroyed, true);
    assert.equal(f.server.closeCalls, 0); assert.equal(f.server.listening, true);
    const refused = f.server.connection();
    assert.equal(refused.destroyed, true); assert.equal(calls, 1);
    listener.sealAdmission(); f.recipe.sealAdmission(); f.server.emit("listening");
    work.resolve(); await flush(); f.server.connection(); await flush();
    assert.equal(calls, 1); assert.equal(f.server.closeCalls, 0);
    const closing = f.recipe.close(); assert.equal(listener.close(), closing);
    assert.deepEqual(await closing, { state: "closed" });
    assert.equal(f.server.closeCalls, 1); assert.equal(f.server.listening, false);
    assert.equal(f.clock.pending, 0);
  });
}

for (const stop of ["cutoff", "recipe seal", "deadline", "error"] as const) {
  test(`${stop} during pending open rejects promptly and retains late bind until explicit release`, async t => {
    const f = fixture(t, { autoListen: false }); let calls = 0;
    const opening = f.recipe.open(async () => {calls += 1;}, f.cutoff);
    const rejected = assert.rejects(opening, { message: "host HTTP listener unavailable" });
    if (stop === "cutoff") {f.cutoff.abort();}
    else if (stop === "recipe seal") {f.recipe.sealAdmission();}
    else if (stop === "deadline") {await f.clock.advance(config.deadline);}
    else {f.server.emit("error", new Error("sensitive listen failure"));}
    await rejected;
    assert.equal(f.server.closeCalls, 0);
    f.server.bind(); f.server.connection(); await flush();
    assert.equal(calls, 0); assert.equal(f.server.listening, true); assert.equal(f.server.closeCalls, 0);
    await assert.rejects(f.recipe.open(async () => {assert.fail();}, new AbortController()));
    assert.deepEqual(await f.recipe.close(), { state: "closed" });
    assert.equal(f.server.closeCalls, 1); assert.equal(f.clock.pending, 0);
  });
}

test("explicit close while bind is pending cannot mistake unbound close for final closure", async t => {
  const f = fixture(t, { autoListen: false });
  const opening = f.recipe.open(async () => {assert.fail();}, f.cutoff);
  const rejected = assert.rejects(opening); const closing = f.recipe.close();
  let settled = false; void closing.then(() => {settled = true;});
  await rejected; await flush();
  assert.equal(f.server.closeCalls, 1); assert.equal(settled, false);
  f.server.bind(); await flush();
  assert.deepEqual(await closing, { state: "closed" });
  assert.equal(f.server.closeCalls, 2, "one unbound attempt plus exactly one late bound release");
  assert.equal(f.recipe.close(), closing); assert.equal(f.clock.pending, 0);
});

test("cleanup remains armed after its deadline, including listen throwing before publication", async t => {
  const f = fixture(t, { autoListen: false, listenThrows: true });
  await assert.rejects(f.recipe.open(async () => {assert.fail();}, f.cutoff), { message: "host HTTP listener unavailable" });
  assert.equal(f.server.closeCalls, 0);
  const closing = f.recipe.close(); await flush();
  await f.clock.advance(config.closureDeadline);
  assert.deepEqual(await closing, { state: "unknown" });
  f.server.bind(); const socket = f.server.connection(); await flush();
  assert.equal(socket.destroyed, true); assert.equal(f.server.listening, false);
  assert.equal(f.server.closeCalls, 2); assert.equal(f.recipe.close(), closing);
  assert.deepEqual(await f.recipe.close(), { state: "unknown" }); assert.equal(f.clock.pending, 0);
});

test("a synchronous listen failure can still retain a late successful bind for trusted cleanup", async t => {
  const f = fixture(t, { listenThrows: true });
  await assert.rejects(f.recipe.open(async () => {assert.fail();}, f.cutoff), { message: "host HTTP listener unavailable" });
  await flush(); assert.equal(f.server.listening, true); assert.equal(f.server.closeCalls, 0);
  assert.deepEqual(await f.recipe.close(), { state: "closed" }); assert.equal(f.server.closeCalls, 1);
});

for (const invalid of [null, "/tmp/not-an-ip", { address: "127.0.0.2", family: "IPv4", port: 123 },
  { address: config.host, family: "IPv6", port: 123 }, { address: config.host, family: "IPv4", port: 0 }]) {
  test(`invalid address ${JSON.stringify(invalid)} fails publication but retains bound cleanup`, async t => {
    const f = fixture(t, { autoListen: false });
    const opening = f.recipe.open(async () => {assert.fail();}, f.cutoff);
    f.server.reportedAddress = invalid; f.server.bind();
    await assert.rejects(opening, { message: "host HTTP listener unavailable" });
    assert.equal(f.server.listening, true); assert.equal(f.server.closeCalls, 0);
    assert.deepEqual(await f.recipe.close(), { state: "closed" });
  });
}

for (const stop of ["deadline", "server error", "drop", "consumer rejection", "unfinished socket"] as const) {
  test(`${stop} seals admission without releasing endpoint or falsifying subsequent actual closure`, async t => {
    const f = fixture(t);
    const listener = await f.recipe.open(async () => {
      if (stop === "consumer rejection") {throw new Error("sensitive consumer failure");}
    }, f.cutoff);
    if (stop === "deadline") {await f.clock.advance(config.deadline);}
    else if (stop === "server error") {f.server.emit("error", new Error("sensitive server failure"));}
    else if (stop === "drop") {f.server.emit("drop");}
    else {f.server.connection(); await flush();}
    assert.equal(f.cutoff.signal.aborted, true); assert.equal(f.server.closeCalls, 0);
    assert.equal(f.server.listening, true);
    assert.deepEqual(await listener.close(), { state: "closed" }); assert.equal(f.clock.pending, 0);
  });
}

test("busy work cannot admit a second consumer even after the first socket closes", async t => {
  const f = fixture(t); const work = Promise.withResolvers<void>(); let calls = 0;
  const listener = await f.recipe.open(async socket => {calls += 1; socket.destroy(); await work.promise;}, f.cutoff);
  f.server.connection(); await flush(); f.server.connection(); await flush();
  assert.equal(calls, 1); assert.equal(f.cutoff.signal.aborted, true);
  assert.equal(f.server.closeCalls, 0); work.resolve(); await flush();
  f.server.connection(); await flush(); assert.equal(calls, 1);
  assert.deepEqual(await listener.close(), { state: "closed" });
});

for (const missing of ["native close", "socket close", "consumer", "close throws"] as const) {
  test(`missing ${missing} stays unknown and never retries final close`, async t => {
    const f = fixture(t, { autoClose: missing !== "native close", closeThrows: missing === "close throws" });
    const work = Promise.withResolvers<void>(); const socket = new SyntheticSocket();
    socket.autoClose = missing !== "socket close";
    const listener = await f.recipe.open(async () => {await work.promise;}, f.cutoff);
    f.server.connection(socket);
    const closing = listener.close(); let settled = false; void closing.then(() => {settled = true;});
    if (missing !== "consumer") {work.resolve();}
    await flush(); assert.equal(settled, false);
    await f.clock.advance(config.closureDeadline);
    assert.deepEqual(await closing, { state: "unknown" }); assert.equal(f.server.closeCalls, 1);
    work.resolve(); socket.actualClose(); f.server.ackClose(); await flush();
    assert.equal(listener.close(), closing); assert.deepEqual(await closing, { state: "unknown" });
    assert.equal(f.server.closeCalls, 1); assert.equal(f.clock.pending, 0);
  });
}

test("close waits for actual native and refused socket acknowledgement, independent of admission cutoff", async t => {
  const f = fixture(t, { autoClose: false });
  const listener = await f.recipe.open(async () => {assert.fail();}, f.cutoff);
  listener.sealAdmission();
  const refused = new SyntheticSocket(); refused.autoClose = false; f.server.connection(refused);
  const closing = listener.close(); let settled = false; void closing.then(() => {settled = true;});
  assert.equal(f.cutoff.signal.aborted, true);
  await flush(); assert.equal(settled, false); f.server.ackClose();
  await flush(); assert.equal(settled, false); refused.actualClose();
  assert.deepEqual(await closing, { state: "closed" }); assert.equal(f.clock.pending, 0);
});

test("consumer reentrant close retains its own pending work before invoking the consumer", async t => {
  const f = fixture(t); const work = Promise.withResolvers<void>(); let closing: ReturnType<typeof f.recipe.close> | undefined;
  const listener = await f.recipe.open(async () => {closing = f.recipe.close(); await work.promise;}, f.cutoff);
  f.server.connection(); assert.ok(closing); assert.equal(listener.close(), closing);
  let settled = false; void closing.then(() => {settled = true;});
  await flush(); assert.equal(settled, false); work.resolve();
  assert.deepEqual(await closing, { state: "closed" }); assert.equal(f.server.closeCalls, 1);
});

test("constructor failure is sanitized and leaves the recipe responsible for final cleanup", async t => {
  const f = fixture(t, { constructorThrows: true });
  await assert.rejects(f.recipe.open(async () => {assert.fail();}, f.cutoff), { message: "host HTTP listener unavailable" });
  assert.equal(f.cutoff.signal.aborted, true); assert.equal(f.servers.length, 0);
  assert.deepEqual(await f.recipe.close(), { state: "closed" });
  await assert.rejects(f.recipe.open(async () => {assert.fail();}, new AbortController()));
});

for (const before of ["pre-abort", "expired", "final close"] as const) {
  test(`${before} prevents allocation and forever retires opening`, async t => {
    const f = fixture(t);
    if (before === "pre-abort") {f.cutoff.abort();}
    else if (before === "expired") {f.clock.time = config.deadline;}
    else {assert.deepEqual(await f.recipe.close(), { state: "closed" });}
    await assert.rejects(f.recipe.open(async () => {assert.fail();}, f.cutoff));
    await assert.rejects(f.recipe.open(async () => {assert.fail();}, new AbortController()));
    assert.equal(f.servers.length, 0); assert.equal(f.clock.pending, 0);
    assert.deepEqual(await f.recipe.close(), { state: "closed" });
  });
}

test("bound handle closed before listening callback is acknowledged once without publishing", async t => {
  const f = fixture(t, { autoListen: false });
  const opening = f.recipe.open(async () => {assert.fail();}, f.cutoff);
  f.server.listening = true; // Native handle allocated; its listening callback is still queued.
  const rejected = assert.rejects(opening); const closing = f.recipe.close();
  await rejected; assert.deepEqual(await closing, { state: "closed" });
  f.server.emit("listening"); f.server.connection(); await flush();
  assert.equal(f.server.closeCalls, 1); assert.equal(f.cutoff.signal.aborted, true);
});

test("regressing authority time seals a late bind, while explicit cleanup still attempts release", async t => {
  const f = fixture(t, { autoListen: false }); f.clock.time = 100;
  const opening = f.recipe.open(async () => {assert.fail();}, f.cutoff);
  f.clock.time = 1; f.server.bind(); await assert.rejects(opening);
  assert.equal(f.server.closeCalls, 0); assert.equal(f.server.listening, true);
  assert.deepEqual(await f.recipe.close(), { state: "unknown" });
  assert.equal(f.server.closeCalls, 1); assert.equal(f.server.listening, false); assert.equal(f.clock.pending, 0);
});

test("connections before publication cannot invoke consumers or reopen admission", async t => {
  const f = fixture(t, { autoListen: false }); let calls = 0;
  const opening = f.recipe.open(async () => {calls += 1;}, f.cutoff);
  f.server.connection(); f.server.bind(); await assert.rejects(opening);
  f.server.connection(); await flush(); assert.equal(calls, 0); assert.equal(f.server.closeCalls, 0);
  assert.deepEqual(await f.recipe.close(), { state: "closed" });
});
