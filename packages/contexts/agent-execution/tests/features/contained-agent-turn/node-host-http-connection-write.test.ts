import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { defaults, encode, fixture, flush, ready, SyntheticSocket, wire } from "./node-host-http-connection-fixture.ts";

for (const order of ["callback then drain", "drain then callback", "reentrant both"] as const) {
  test(`write false waits for callback AND drain: ${order}`, async () => {
    const socket = new SyntheticSocket();
    socket.onWrite = (_bytes, callback) => {
      if (order === "reentrant both") {
        socket.writableLength = 0;
        callback();
        socket.emit("drain");
      }
      return false;
    };
    const f = await ready(socket);
    let completed = false;
    const writing = f.connection.write(encode("response"));
    void writing.then(() => {completed = true; return null;});
    if (order !== "reentrant both") {
      if (order === "callback then drain") {socket.ack();} else {socket.emit("drain");}
      await flush();
      assert.equal(completed, false);
      assert.ok(socket.writes[0]!.bytes.some(byte => byte !== 0));
      if (order === "callback then drain") {socket.emit("drain");} else {socket.ack();}
    }
    await writing;
    assert.ok(socket.writes[0]!.bytes.every(byte => byte === 0));
    socket.peerEnd();
    assert.equal((await f.connection.close("complete")).state, "closed");
  });
}

test("write true is not callback acknowledgement; input copied and spoofed size/slice never consulted", async () => {
  const socket = new SyntheticSocket();
  socket.autoAck = false;
  const f = await ready(socket);
  const input = encode("response");
  Object.defineProperty(input, "byteLength", { get: () => {throw new Error("spoofed size");} });
  Object.defineProperty(input, "slice", { value: () => {throw new Error("spoofed copy");} });
  let completed = false;
  const writing = f.connection.write(input);
  void writing.then(() => {completed = true; return null;});
  input.fill(0);
  await flush();
  assert.equal(completed, false);
  assert.deepEqual(socket.writes[0]!.bytes, encode("response"));
  socket.ack();
  await writing;
  assert.ok(socket.writes[0]!.bytes.every(byte => byte === 0));
  await f.connection.close("abort");
});

for (const fault of ["callback then throw", "callback then error", "error callback", "short callback", "double callback"] as const) {
  test(`${fault} makes write uncertain, canonical, and never recovers to successful close`, async () => {
    const socket = new SyntheticSocket();
    socket.autoClose = false;
    socket.onWrite = (_bytes, callback) => {
      if (fault !== "short callback") {socket.writableLength = 0;}
      callback(fault === "error callback" ? new Error("secret/path/socket-detail") : undefined);
      if (fault === "callback then throw") {throw new Error("secret/path/socket-detail");}
      if (fault === "callback then error") {socket.emit("error", new Error("secret/path/socket-detail"));}
      if (fault === "double callback") {callback();}
      return true;
    };
    const f = await ready(socket);
    await assert.rejects(f.connection.write(encode("synthetic-token-response")), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "write_failed");
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(f.signal.aborted, true);
    assert.ok(socket.writes[0]!.bytes.some(byte => byte !== 0), "retain until actual close");
    const closing = f.connection.close("complete");
    socket.actualClose();
    const receipt = await closing;
    assert.equal(receipt.state, "unknown");
    assert.ok(socket.writes[0]!.bytes.every(byte => byte === 0));
    assert.equal(receipt.receiptDigest, createHash("sha256").update("agent-runtime.node-host-http-closure/v1\nunknown\n").digest("hex"));
    await assert.rejects(f.connection.write(encode("retry")), /closed/);
    assert.equal(socket.writes.length, 1);
  });
}

for (const phase of ["callback", "drain"] as const) {
  for (const fault of ["abort", "deadline", "timeout", "error", "actual close"] as const) {
    test(`${fault} while waiting for write ${phase} rejects, preserves bytes until actual close, and settles cleanup`, async () => {
      const socket = new SyntheticSocket();
      socket.autoClose = false;
      socket.onWrite = () => phase === "callback";
      const f = await ready(socket);
      const rejected = assert.rejects(f.connection.write(encode("retained-response")), /write_failed/);
      if (phase === "drain") {socket.ack();}
      if (fault === "abort") {f.cutoff.abort();}
      if (fault === "deadline") {await f.clock.advance(20_000);}
      if (fault === "timeout") {socket.emit("timeout");}
      if (fault === "error") {socket.emit("error", new Error("untrusted error"));}
      if (fault === "actual close") {socket.actualClose();}
      await rejected;
      if (fault !== "actual close") {assert.ok(socket.writes[0]!.bytes.some(byte => byte !== 0));}
      const closing = f.connection.close("abort");
      socket.actualClose();
      assert.equal((await closing).state, "unknown");
      assert.ok(socket.writes[0]!.bytes.every(byte => byte === 0));
      socket.ack();
      socket.emit("drain");
      socket.emit("error", new Error("late raw error"));
      assert.equal(f.clock.pending, 0);
      assert.deepEqual(socket.eventNames(), ["error"]);
    });
  }
}

test("write cap checked atomically, shared backing rejected, concurrent writes have no pending queue", async () => {
  for (const input of [new Uint8Array(65_537), new Uint8Array(new SharedArrayBuffer(4)), new Uint8Array()]) {
    const f = await ready();
    await assert.rejects(f.connection.write(input), /write_failed/);
    assert.equal(f.socket.writes.length, 0);
    await f.connection.close("abort");
  }
  const socket = new SyntheticSocket();
  socket.autoAck = false;
  const f = await ready(socket);
  const first = assert.rejects(f.connection.write(encode("first")), /write_failed/);
  await assert.rejects(f.connection.write(encode("second")), /write_failed/);
  await first;
  assert.equal(socket.writes.length, 1);
  await f.connection.close("abort");
});

test("error/surplus after an acknowledged response write is closure uncertainty, never zero-send evidence", async () => {
  for (const fault of ["error", "surplus"] as const) {
    const f = await ready();
    await f.connection.write(encode("response already sent"));
    assert.equal(f.socket.writes.length, 1);
    if (fault === "error") {f.socket.emit("error", new Error("raw socket message"));}
    else {f.socket.feed(wire());}
    assert.equal(f.signal.aborted, true);
    const receipt = await f.connection.close("complete");
    assert.equal(receipt.state, "unknown");
    assert.deepEqual(Object.keys(receipt).toSorted(), ["receiptDigest", "state"]);
  }
});

test("complete waits for writes, FIN finish, peer EOF and actual close in either finish/EOF order", async () => {
  for (const peerFirst of [true, false]) {
    const socket = new SyntheticSocket();
    socket.autoAck = false;
    socket.autoFinish = false;
    socket.autoClose = false;
    const f = await ready(socket);
    const writing = f.connection.write(encode("response"));
    let completed = false;
    const closing = f.connection.close("complete");
    void closing.then(() => {completed = true; return null;});
    await flush();
    assert.equal(socket.endCalls, 0);
    socket.ack();
    await writing;
    await flush();
    assert.equal(socket.endCalls, 1);
    if (peerFirst) {socket.peerEnd();} else {socket.finish();}
    await flush();
    assert.equal(completed, false);
    if (peerFirst) {socket.finish();} else {socket.peerEnd();}
    await flush();
    assert.equal(completed, false);
    socket.actualClose();
    assert.equal((await closing).state, "closed");
    assert.equal(socket.destroyCalls, 0);
    assert.equal(f.clock.pending, 0);
    assert.deepEqual(socket.eventNames(), ["error"]);
    socket.emit("error", new Error("late socket error"));
    await assert.rejects(f.connection.write(encode("after-close")), /closed/);
  }
});

for (const missing of ["callback", "finish", "peer EOF", "actual close"] as const) {
  test(`close deadline with missing ${missing} forces unknown and leaves late completion harmless`, async () => {
    const socket = new SyntheticSocket();
    socket.autoClose = false;
    socket.autoFinish = missing !== "finish";
    const f = await ready(socket);
    let failedWrite: Promise<void> | undefined;
    if (missing === "callback") {
      socket.autoAck = false;
      failedWrite = assert.rejects(f.connection.write(encode("retained")), /write_failed/);
    }
    const closing = f.connection.close("complete");
    await flush();
    if (missing !== "peer EOF") {socket.peerEnd();}
    await f.clock.advance(2_000);
    assert.equal((await closing).state, "unknown");
    await failedWrite;
    assert.equal(socket.destroyCalls, 1);
    if (missing === "callback") {assert.ok(socket.writes[0]!.bytes.some(byte => byte !== 0));}
    socket.actualClose();
    if (missing === "callback") {
      assert.ok(socket.writes[0]!.bytes.every(byte => byte === 0));
      socket.ack();
    }
    assert.equal(f.connection.close("complete"), closing);
    assert.equal((await closing).state, "unknown");
    assert.equal(f.clock.pending, 0);
  });
}

test("close escalation and abort idempotence destroy once and wait independently for actual close", async () => {
  const socket = new SyntheticSocket();
  socket.autoClose = false;
  const f = await ready(socket);
  const closing = f.connection.close("complete");
  await flush();
  assert.equal(f.connection.close("complete"), closing);
  assert.equal(f.connection.close("abort"), closing);
  assert.equal(f.connection.close("abort"), closing);
  let settled = false;
  void closing.then(() => {settled = true; return null;});
  await flush();
  assert.equal(settled, false);
  assert.equal(socket.destroyCalls, 1);
  socket.actualClose();
  assert.equal((await closing).state, "unknown");
});

test("aborting a pending request settles its iterator but waits boundedly for actual socket close", async () => {
  const socket = new SyntheticSocket();
  socket.autoClose = false;
  const f = fixture(defaults, socket);
  const rejected = assert.rejects(f.connection.request[Symbol.asyncIterator]().next());
  const closing = f.connection.close("abort");
  await rejected;
  await f.clock.advance(2_000);
  assert.equal((await closing).state, "unknown");
  socket.actualClose();
  assert.equal(f.clock.pending, 0);
});

test("operation deadline crossing/clock regression at write denies before socket.write", async () => {
  for (const time of [20_000, -1, Number.NaN]) {
    const f = await ready();
    f.clock.time = time;
    await assert.rejects(f.connection.write(encode("should not be written")));
    assert.equal(f.socket.writes.length, 0);
    assert.equal((await f.connection.close("complete")).state, "unknown");
  }
});

test("reentrant abort during close preserves the single close promise", async () => {
  const socket = new SyntheticSocket();
  socket.autoClose = false;
  const f = await ready(socket);
  let reentrant: ReturnType<typeof f.connection.close> | undefined;
  f.signal.addEventListener("abort", () => {reentrant = f.connection.close("abort");});
  const closing = f.connection.close("abort");
  assert.equal(closing, reentrant);
  socket.actualClose();
  assert.equal((await closing).state, "unknown");
  assert.equal(socket.destroyCalls, 1);
  assert.equal(f.clock.pending, 0);
});

test("close deadline rejection cannot be erased by actual close before its continuation", async () => {
  const socket = new SyntheticSocket();
  socket.autoClose = false;
  const f = await ready(socket);
  const closing = f.connection.close("complete");
  await flush();
  socket.peerEnd();
  const expired = f.clock.advance(2_000);
  socket.actualClose();
  await expired;
  assert.equal((await closing).state, "unknown");
  assert.equal(f.signal.aborted, true);
  assert.equal(f.connection.close("abort"), closing);
  assert.equal(f.clock.pending, 0);
});

for (const time of [49, Number.NaN, Number.POSITIVE_INFINITY, "throw"] as const) {
  test(`actual close cannot backdate or lose monotonic clock authority: ${time}`, async () => {
    const socket = new SyntheticSocket();
    socket.autoClose = false;
    const f = await ready(socket);
    f.clock.time = 50;
    const closing = f.connection.close("complete");
    await flush();
    socket.peerEnd();
    if (time === "throw") {f.clock.now = () => {throw new Error("synthetic clock failure");};}
    else {f.clock.time = time;}
    socket.actualClose();
    assert.equal((await closing).state, "unknown");
    assert.equal(f.signal.aborted, true);
    assert.equal(f.clock.pending, 0);
    assert.deepEqual(socket.eventNames(), ["error"]);
  });
}

for (const fault of ["throw", "rejection"] as const) {
  test(`close watchdog ${fault} remains unknown even with physical closure`, async () => {
    const socket = new SyntheticSocket();
    socket.autoClose = false;
    const f = await ready(socket);
    const failed = Promise.withResolvers<never>();
    f.clock.within = () => {
      if (fault === "throw") {throw new Error("synthetic watchdog failure");}
      return failed.promise;
    };
    const closing = f.connection.close("complete");
    await flush();
    socket.peerEnd();
    if (fault === "rejection") {failed.reject(new Error("synthetic watchdog failure"));}
    socket.actualClose();
    assert.equal((await closing).state, "unknown");
    assert.equal(f.connection.close("complete"), closing);
    assert.equal(f.signal.aborted, true);
    assert.equal(f.clock.pending, 0);
  });
}

test("timely actual close remains closed when watchdog continuation runs after the deadline", async () => {
  const socket = new SyntheticSocket();
  socket.autoClose = false;
  const f = await ready(socket);
  const closing = f.connection.close("complete");
  await flush();
  socket.peerEnd();
  f.clock.time = 1_999;
  socket.actualClose();
  f.clock.time = 2_001;
  assert.equal((await closing).state, "closed");
  assert.equal(f.signal.aborted, false);
  assert.equal(f.clock.pending, 0);
});

test("expired close keeps its receipt and borrowed write bytes until late physical cleanup", async () => {
  const socket = new SyntheticSocket();
  socket.autoAck = false;
  socket.autoClose = false;
  const f = await ready(socket);
  const writing = assert.rejects(f.connection.write(encode("retained until close")), /write_failed/);
  const closing = f.connection.close("complete");
  await f.clock.advance(2_000);
  const receipt = await closing;
  await writing;
  assert.equal(receipt.state, "unknown");
  assert.equal(f.connection.close("abort"), closing);
  socket.ack();
  socket.emit("drain");
  assert.deepEqual(socket.writes[0]!.bytes, encode("retained until close"));
  f.clock.time = 1_999; // Backdating cannot repair an already failed deadline.
  socket.actualClose();
  socket.emit("close");
  socket.emit("error", new Error("late synthetic error"));
  assert.ok(socket.writes[0]!.bytes.every(byte => byte === 0));
  assert.equal(await f.connection.close("complete"), receipt);
  assert.equal(socket.destroyCalls, 1);
  assert.equal(f.clock.pending, 0);
  assert.deepEqual(socket.eventNames(), ["error"]);
});

test("closure grace after FIN is independent of the operation deadline and cannot permit more writes", async () => {
  const f = await ready();
  f.clock.time = 19_999;
  const closing = f.connection.close("complete");
  await flush();
  assert.equal(f.socket.endCalls, 1);
  await f.clock.advance(20_001);
  await assert.rejects(f.connection.write(encode("forbidden")), /closed/);
  f.socket.peerEnd();
  assert.equal((await closing).state, "closed");
});

for (const fault of ["end throws", "close hadError", "surplus at close"] as const) {
  test(`${fault} after FIN cannot yield a clean receipt`, async () => {
    const socket = new SyntheticSocket();
    socket.autoClose = false;
    const f = await ready(socket);
    if (fault === "end throws") {socket.end = () => {throw new Error("raw secret socket detail");};}
    const closing = f.connection.close("complete");
    await flush();
    if (fault === "surplus at close") {socket.feed(encode("surplus"), false);}
    socket.actualClose(fault === "close hadError");
    assert.equal((await closing).state, "unknown");
    assert.equal(f.signal.aborted, true);
  });
}
