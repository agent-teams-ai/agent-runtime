import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, Server, type Socket } from "node:net";
import test from "node:test";
import { createNodeHostHttpListener, type NodeHostHttpAccept } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-listener.js";
import { createNodeHostHttpConnection } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-connection.js";
import { readStrictHttpRequest } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-request.js";
import { defaults, ManualClock, wire } from "./node-host-http-connection-fixture.ts";

// Only disposable, ephemeral loopback sockets. No provider/agent/project runtime.
const config = { host: "127.0.0.1", deadline: 20_000, closureDeadline: 25_000 };
const tick = (): Promise<void> => new Promise(resolve => {setImmediate(resolve);});
const fixture = () => {
  const clock = new ManualClock(); const cutoff = new AbortController();
  const recipe = createNodeHostHttpListener(config, clock);
  return { clock, cutoff, recipe };
};
const client = async (port: number): Promise<Socket> => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  await once(socket, "connect"); return socket;
};
const closed = (socket: Socket): Promise<void> => socket.closed ? Promise.resolve()
  : new Promise(resolve => {socket.once("close", () => {resolve();});});

for (const host of ["0.0.0.0", "::", "::1", "localhost", "8.8.8.8", "169.254.1.2", "172.32.1.1", "192.169.1.1"]) {
  test(`listener rejects unsupported bind host ${host}`, () => {
    const clock = new ManualClock();
    assert.throws(() => createNodeHostHttpListener({ ...config, host }, clock));
    assert.equal(clock.pending, 0);
  });
}
test("listener recipe is inert and validates bounded configuration", () => {
  const f = fixture(); assert.equal(f.clock.pending, 0);
  for (const delta of [{ deadline: -1 }, { closureDeadline: 19_999 }, { highWaterMark: 0 },
    { highWaterMark: 65_537 }, { deadline: Number.NaN }]) {
    assert.throws(() => createNodeHostHttpListener({ ...config, ...delta }, f.clock));
  }
  for (const host of ["10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.1.1"]) {
    createNodeHostHttpListener({ ...config, host }, f.clock);
  }
  assert.equal(f.clock.pending, 0);
});

test("one explicit private bind, immutable readback, idempotent actual close", { timeout: 5_000 }, async () => {
  const f = fixture(); let calls = 0;
  const listener = await f.recipe.open(async () => {calls += 1;}, f.cutoff);
  assert.deepEqual({ ...listener.address, port: 0 }, { address: "127.0.0.1", family: "IPv4", port: 0 });
  assert.ok(listener.address.port > 0); assert.ok(Object.isFrozen(listener.address));
  assert.ok(Object.isFrozen(listener)); assert.equal(calls, 0);
  await assert.rejects(f.recipe.open(async () => {}, new AbortController()));
  const first = listener.close(); assert.equal(listener.close(), first);
  assert.deepEqual(await first, { state: "closed" });
  assert.equal(f.cutoff.signal.aborted, true); assert.equal(f.clock.pending, 0);
  await assert.rejects(client(listener.address.port));
});

test("real paused sockets use the existing strict frame adapter for two sequential exchanges", { timeout: 5_000 }, async () => {
  const f = fixture(); const receipts: string[] = []; let callbacks = 0;
  const adapter = createNodeHostHttpConnection(defaults, f.clock);
  const listener = await f.recipe.open(async (socket, signal) => {
    callbacks += 1; assert.equal(signal, f.cutoff.signal);
    assert.equal(socket.allowHalfOpen, true); assert.equal(socket.readableFlowing, false);
    assert.equal(socket.readableEncoding, null); assert.equal(socket.readableHighWaterMark, 65_536);
    const binding = adapter.bindAcceptedSocket(socket, f.cutoff);
    const request = await readStrictHttpRequest(binding.connection.request, defaults.expectedRequest,
      defaults.limits, f.clock, signal);
    assert.equal(new TextDecoder().decode(request.body), "{}");
    await binding.connection.write(new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"));
    receipts.push((await binding.connection.close("complete")).state);
  }, f.cutoff);
  try {
    for (let index = 0; index < 2; index += 1) {
      const socket = await client(listener.address.port); const chunks: Buffer[] = [];
      socket.on("data", bytes => {chunks.push(bytes);});
      const finished = closed(socket); socket.end(wire()); await finished; await tick();
      assert.match(Buffer.concat(chunks).toString(), /200 OK/);
    }
    assert.equal(callbacks, 2); assert.deepEqual(receipts, ["closed", "closed"]);
    assert.equal(f.cutoff.signal.aborted, false);
  } finally {assert.deepEqual(await listener.close(), { state: "closed" });}
  assert.equal(f.clock.pending, 0);
});

test("pre-aborted, expired and regressing time never publish an endpoint", { timeout: 5_000 }, async () => {
  const a = fixture(); a.cutoff.abort();
  await assert.rejects(a.recipe.open(async () => {assert.fail();}, a.cutoff));
  assert.equal(a.clock.pending, 0);
  const b = fixture(); b.clock.time = config.deadline;
  await assert.rejects(b.recipe.open(async () => {assert.fail();}, b.cutoff));
  const c = fixture(); c.clock.time = 100;
  const opening = c.recipe.open(async () => {assert.fail();}, c.cutoff); c.clock.time = 1;
  await assert.rejects(opening); assert.equal(c.cutoff.signal.aborted, true); assert.equal(c.clock.pending, 0);
});

test("abort while listen is pending cannot resurrect a late endpoint", { timeout: 5_000 }, async () => {
  const f = fixture(); let calls = 0;
  const opening = f.recipe.open(async () => {calls += 1;}, f.cutoff);
  f.cutoff.abort(); await assert.rejects(opening); await tick();
  assert.equal(calls, 0); assert.equal(f.clock.pending, 0);
});

test("bind failure is sanitized and retires the one-use recipe", { timeout: 5_000 }, async t => {
  // Deterministic native bind failure; no assumption about the machine's NICs.
  t.mock.method(Server.prototype, "listen", () => {throw new Error("sensitive native bind detail");});
  const f = fixture(); const recipe = createNodeHostHttpListener(config, f.clock);
  await assert.rejects(recipe.open(async () => {}, f.cutoff), { message: "host HTTP listener unavailable" });
  await assert.rejects(recipe.open(async () => {}, new AbortController()));
  assert.equal(f.cutoff.signal.aborted, true); assert.equal(f.clock.pending, 0);
});

test("a second concurrent native socket seals the listener and aborts the active consumer", { timeout: 5_000 }, async () => {
  const f = fixture(); const entered = Promise.withResolvers<void>(); let calls = 0;
  const listener = await f.recipe.open(async (socket, signal) => {
    calls += 1; entered.resolve();
    await new Promise<void>(resolve => {signal.addEventListener("abort", () => {socket.destroy(); resolve();}, { once: true });});
    await closed(socket);
  }, f.cutoff);
  const first = await client(listener.address.port); await entered.promise;
  const second = await client(listener.address.port);
  await Promise.all([closed(first), closed(second)]);
  assert.equal(calls, 1); assert.equal(f.cutoff.signal.aborted, true);
  assert.deepEqual(await listener.close(), { state: "unknown" }); assert.equal(f.clock.pending, 0);
});

test("pending consumer prevents clean closure even after every native socket closes", { timeout: 5_000 }, async () => {
  const f = fixture(); const release = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  const listener = await f.recipe.open(async socket => {entered.resolve(); await release.promise; await closed(socket);}, f.cutoff);
  const socket = await client(listener.address.port); await entered.promise;
  const closing = listener.close(); let settled = false; void closing.then(() => {settled = true; return null;});
  await closed(socket); await tick(); assert.equal(settled, false);
  await f.clock.advance(config.closureDeadline);
  assert.deepEqual(await closing, { state: "unknown" });
  release.resolve(); await tick(); assert.deepEqual(await listener.close(), { state: "unknown" });
  assert.equal(f.clock.pending, 0);
});

test("physical socket close does not permit overlapping consumers", { timeout: 5_000 }, async () => {
  const f = fixture(); const release = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>(); let calls = 0;
  const listener = await f.recipe.open(async socket => {
    calls += 1; socket.destroy(); await closed(socket); entered.resolve(); await release.promise;
  }, f.cutoff);
  const first = await client(listener.address.port); await closed(first); await entered.promise;
  const second = await client(listener.address.port); await closed(second);
  assert.equal(calls, 1); assert.equal(f.cutoff.signal.aborted, true);
  release.resolve(); assert.deepEqual(await listener.close(), { state: "unknown" });
});

for (const accept of [async () => {throw new Error("sensitive path");}, async () => {}] satisfies NodeHostHttpAccept[]) {
  test("consumer failure or unfinished socket aborts without escaping errors", { timeout: 5_000 }, async () => {
    const f = fixture(); const listener = await f.recipe.open(accept, f.cutoff);
    const socket = await client(listener.address.port); await closed(socket);
    assert.equal(f.cutoff.signal.aborted, true);
    assert.equal((f.cutoff.signal.reason as Error).message, "host HTTP listener unavailable");
    assert.deepEqual(await listener.close(), { state: "unknown" }); assert.equal(f.clock.pending, 0);
  });
}

test("operation deadline automatically seals idle admission and closes its native handle", { timeout: 5_000 }, async () => {
  const f = fixture(); const listener = await f.recipe.open(async () => {}, f.cutoff);
  await f.clock.advance(config.deadline);
  assert.deepEqual(await listener.close(), { state: "unknown" }); assert.equal(f.cutoff.signal.aborted, true);
  assert.equal(f.clock.pending, 0); await assert.rejects(client(listener.address.port));
});

test("explicit close waits for a cooperative consumer and its native socket", { timeout: 5_000 }, async () => {
  const f = fixture(); const entered = Promise.withResolvers<void>();
  const listener = await f.recipe.open(async (socket, signal) => {
    entered.resolve(); await once(signal, "abort"); await closed(socket);
  }, f.cutoff);
  const socket = await client(listener.address.port); await entered.promise;
  assert.deepEqual(await listener.close(), { state: "closed" }); await closed(socket);
  assert.equal(f.clock.pending, 0);
});

test("synchronous consumer cancellation keeps pending work in closure accounting", { timeout: 5_000 }, async () => {
  const f = fixture(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const listener = await f.recipe.open(async socket => {
    f.cutoff.abort(); entered.resolve(); await release.promise; await closed(socket);
  }, f.cutoff);
  const socket = await client(listener.address.port); await entered.promise; await closed(socket);
  let settled = false; void listener.close().then(() => {settled = true; return null;});
  await tick(); assert.equal(settled, false);
  release.resolve(); assert.deepEqual(await listener.close(), { state: "closed" });
  assert.equal(f.clock.pending, 0);
});
