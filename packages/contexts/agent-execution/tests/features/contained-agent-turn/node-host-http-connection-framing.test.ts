import assert from "node:assert/strict";
import { test } from "node:test";
import type { Socket } from "node:net";
import { createNodeHostHttpConnection } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-connection.js";
import { NodeHostHttpConnectionCustody } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-connection-custody.js";
import { NodeHostHttpRequestFrame } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-request-frame.js";
import { fixNodeHostHttpConnectionConfig } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-connection-config.js";
import { readStrictHttpRequest } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-request.js";
import { defaults, encode, fixture, flush, head, ManualClock, ready, SyntheticSocket, wire } from "./node-host-http-connection-fixture.ts";

test("configuration and constructors are inert; genuine Socket is required only at the production seam", () => {
  let calls = 0;
  const clock = { now: () => {calls += 1; return 0;}, within: async <T>(_d: number, run: () => Promise<T>) => {
    calls += 1; return await run();
  } };
  const factory = createNodeHostHttpConnection(defaults, clock);
  assert.equal(calls, 0);
  assert.deepEqual(Object.keys(factory), ["bindAcceptedSocket"]);
  const socket = new SyntheticSocket();
  assert.throws(() => factory.bindAcceptedSocket(socket as unknown as Socket, new AbortController()), /invalid_socket/);
  assert.equal(socket.eventNames().length, 0);
  assert.equal(calls, 0);
});

test("finite frame matches raw bytes and counts without peer TCP EOF; exact three-member connection", async () => {
  const f = fixture();
  assert.deepEqual(Object.keys(f.connection).toSorted(), ["close", "request", "write"]);
  assert.deepEqual(Object.keys(f).filter(key => key === "signal"), ["signal"]);
  assert.equal(f.signal, f.cutoff.signal);
  assert.equal(Object.isFrozen(f.connection), true);
  const raw = wire('{"value":" raw "}', "Authorization: Bearer fixture-cap\r\n");
  const parsing = f.parse();
  f.socket.feed(raw);
  const request = await parsing;
  assert.equal(request.wireBytes, raw.length);
  assert.deepEqual(request.body, encode('{"value":" raw "}'));
  assert.equal(request.headers.find(h => h.name === "authorization")?.value, "Bearer fixture-cap");
  assert.equal(f.socket.readableEnded, false);
  assert.equal(f.socket.closed, false);
  await f.connection.close("abort");
  assert.equal(f.clock.pending, 0);
});

test("all two-fragment splits across every header/body boundary preserve bytes", async () => {
  const raw = wire("body\u0000\r\nbytes");
  for (let split = 1; split < raw.length; split += 1) {
    const f = fixture();
    const parsing = f.parse();
    f.socket.feed(raw.slice(0, split));
    await flush();
    f.socket.feed(raw.slice(split));
    const request = await parsing;
    assert.deepEqual(request.body, encode("body\u0000\r\nbytes"), `split ${split}`);
    assert.equal(request.wireBytes, raw.length);
    await f.connection.close("abort");
  }
});

test("byte-at-a-time head and exact maximum body are bounded without quadratic frame concatenation", async () => {
  const f = fixture();
  const parsing = f.parse();
  for (const byte of encode(head(1_048_576))) {f.socket.feed(new Uint8Array([byte]));}
  for (let index = 0; index < 16; index += 1) {f.socket.feed(new Uint8Array(65_536).fill(65));}
  const request = await parsing;
  assert.equal(request.body.length, 1_048_576);
  assert.ok(request.body.every(value => value === 65));
  assert.ok(f.socket.reads.every(size => size <= 65_536));
  await f.connection.close("abort");
});

const invalid: ReadonlyArray<readonly [string, string]> = [
  ["duplicate CL", head(0, "content-length: 0\r\n")],
  ["conflicting CL", head(0, "Content-Length: 1\r\n")],
  ["duplicate Host", head(0, "HOST: broker.invalid\r\n")],
  ...["Authorization", "Proxy-Authorization", "Connection"].map(name =>
    [`duplicate ${name}`, head(0, `${name}: synthetic\r\n${name}: synthetic\r\n`)] as const),
  ...["Transfer-Encoding", "Trailer", "Expect", "Upgrade"].map(name =>
    [name, head(0, `${name}: synthetic\r\n`)] as const),
  ...["00", "01", "+1", "-1", "1, 1", "1e0", "0x0", "9007199254740992", "1048577"].map(cl =>
    [`CL ${cl}`, head(0).replace("Content-Length: 0", `Content-Length: ${cl}`)] as const),
  ["missing CL", head(0).replace("Content-Length: 0\r\n", "")],
  ["missing Host", head(0).replace("Host: broker.invalid\r\n", "")],
  ["folded", head(0, "X: a\r\n b\r\n")],
  ["field whitespace", head(0, "X : b\r\n")],
  ["NUL", head(0, "X: a\u0000b\r\n")],
  ["DEL", head(0, "X: a\u007fb\r\n")],
  ["high byte", head(0, "X: a\u0080b\r\n")],
  ["tab", head(0, "X: a\tb\r\n")],
  ["bare LF", head(0).replace("\r\n", "\n")],
  ["bare CR", head(0).replace("\r\n", "\rX")],
  ["method", head(0).replace("POST", "GET")],
  ["HEAD", head(0).replace("POST", "HEAD")],
  ["CONNECT", head(0).replace("POST", "CONNECT")],
  ["absolute URI", head(0).replace("/invoke?mode=one", "http://broker.invalid/invoke?mode=one")],
  ["authority form", head(0).replace("/invoke?mode=one", "//broker.invalid/invoke")],
  ["query identity", head(0).replace("mode=one", "mode=two")],
  ["path identity", head(0).replace("/invoke", "/other")],
  ["Host identity", head(0).replace("broker.invalid", "Broker.invalid")],
  ["HTTP version", head(0).replace("HTTP/1.1", "HTTP/1.0")],
  ["request fragment", head(0).replace("mode=one", "mode=one#fragment")],
];
for (const [name, raw] of invalid) {
  test(`strict transport rejects ${name} before yielding or dispatch`, async () => {
    const f = fixture();
    const iterator = f.connection.request[Symbol.asyncIterator]();
    const rejected = assert.rejects(iterator.next());
    f.socket.feed(encode(raw));
    await rejected;
    assert.equal(f.signal.aborted, true);
    assert.equal(f.socket.destroyCalls, 1);
    assert.equal(f.socket.writes.length, 0);
    assert.equal((await f.connection.close("abort")).state, "unknown");
  });
}

test("generic parser retains existing GET and tab grammar and requires EOF after exact body", async () => {
  const expected = { ...defaults.expectedRequest, method: "GET" };
  let finish!: () => void;
  const pending = new Promise<void>(resolve => {finish = resolve;});
  const chunks = { async *[Symbol.asyncIterator]() {
    yield encode(head(0, "X: a\tb\r\n").replace("POST", "GET"));
    await pending;
  } };
  let settled = false;
  const result = readStrictHttpRequest(chunks, expected, defaults.limits, new ManualClock()).then(r => {settled = true; return r;});
  await flush();
  assert.equal(settled, false);
  finish();
  assert.equal((await result).method, "GET");
  assert.throws(() => createNodeHostHttpConnection({ ...defaults, expectedRequest: expected }, new ManualClock()), /invalid_configuration/);
});

test("generic parser still rejects surplus supplied after a valid frame", async () => {
  const chunks = { async *[Symbol.asyncIterator]() {yield wire(); yield encode("x");} };
  await assert.rejects(readStrictHttpRequest(chunks, defaults.expectedRequest, defaults.limits, new ManualClock()), /smuggling/);
});

for (const mode of ["same chunk", "queued", "before iterable EOF", "delayed after EOF"] as const) {
  test(`surplus ${mode} trips the identical one-way cutoff and cannot become another request`, async () => {
    const f = fixture();
    const iterator = f.connection.request[Symbol.asyncIterator]();
    if (mode === "same chunk") {f.socket.feed(encode(head(2) + "{}x"));}
    else if (mode === "queued") {
      f.socket.feed(wire(), false);
      f.socket.feed(encode("x"), false);
    } else {
      f.socket.feed(wire());
      await iterator.next();
      if (mode === "delayed after EOF") {assert.equal((await iterator.next()).done, true);}
      f.socket.feed(encode("GET /second HTTP/1.1\r\n\r\n"));
    }
    await assert.rejects(iterator.next());
    assert.equal(f.signal, f.cutoff.signal);
    assert.equal(f.signal.aborted, true);
    assert.equal(f.socket.writes.length, 0);
    assert.throws(() => f.connection.request[Symbol.asyncIterator](), /closed/);
    assert.equal((await f.connection.close("complete")).state, "unknown");
  });
}

test("head/field/body bounds reject before body allocation; caller getters cannot enlarge chunks", () => {
  const config = fixNodeHostHttpConnectionConfig(defaults);
  const Original = Uint8Array;
  const sizes: number[] = [];
  class RecordedBytes extends Original {
    public constructor(length: number) {sizes.push(length); super(length);}
  }
  const cases = [encode(head(1_048_577)), encode(head(0) + "x"), new Uint8Array(65_537)];
  try {
    globalThis.Uint8Array = RecordedBytes as Uint8ArrayConstructor;
    for (const chunk of cases) {
      sizes.length = 0;
      const frame = new NodeHostHttpRequestFrame(config);
      assert.throws(() => frame.push(chunk));
      assert.ok(sizes.every(size => size <= 16_384));
      frame.release();
    }
  } finally {globalThis.Uint8Array = Original;}
  const fields = fixture({ ...defaults, maxHeaderFields: 2 });
  fields.socket.feed(wire("{}", "X: a\r\n"));
  assert.equal(fields.signal.aborted, true);
});

test("oversized pending socket queue is denied atomically without allocating a read result", async () => {
  const f = fixture();
  f.socket.feed(new Uint8Array(65_537));
  assert.ok(f.socket.reads.every(size => size === 0));
  assert.equal(f.signal.aborted, true);
  await f.connection.close("abort");
});

test("exact header and field limits are accepted; one byte/field more is denied", async () => {
  const bytes = wire("{}", "X: abc\r\n");
  const headBytes = bytes.length - 2;
  for (const max of [headBytes - 1, headBytes]) {
    const f = fixture({ ...defaults, maxHeaderFields: 3,
      limits: { ...defaults.limits, maxInboundHeaderBytes: max } });
    f.socket.feed(bytes);
    if (max < headBytes) {await assert.rejects(f.parse());}
    else {assert.equal((await f.parse()).wireBytes, bytes.length);}
    await f.connection.close("abort");
  }
});

test("pending iterator, abandoned borrowed bytes and duplicate next settle and zeroize", async () => {
  const f = fixture();
  const iterator = f.connection.request[Symbol.asyncIterator]();
  const first = assert.rejects(iterator.next());
  const second = assert.rejects(iterator.next());
  await Promise.all([first, second]);
  await f.connection.close("abort");
  const g = fixture();
  g.socket.feed(wire());
  const it = g.connection.request[Symbol.asyncIterator]();
  const next = await it.next();
  assert.equal(next.done, false);
  const borrowed: Uint8Array = next.value;
  assert.ok(borrowed.some(value => value !== 0));
  await it.return!();
  assert.ok(borrowed.every(value => value === 0));
  assert.equal(g.signal.aborted, true);
  await g.connection.close("abort");
});

for (const phase of ["header", "body", "after EOF"] as const) {
  for (const fault of ["abort", "deadline", "error", "timeout", "premature close"] as const) {
    test(`${fault} during ${phase} closes custody and settles outstanding reads`, async () => {
      const f = phase === "after EOF" ? await ready() : fixture();
      let rejected: Promise<void> | undefined;
      if (phase !== "after EOF") {
        const iterator = f.connection.request[Symbol.asyncIterator]();
        rejected = assert.rejects(iterator.next());
        f.socket.feed(encode(phase === "header" ? "POST /" : head(10) + "a"));
      }
      if (fault === "abort") {f.cutoff.abort(new Error("raw external reason"));}
      if (fault === "deadline") {await f.clock.advance(phase === "header" ? 5_000 : 20_000);}
      if (fault === "error") {f.socket.emit("error", new Error("raw socket token/path"));}
      if (fault === "timeout") {f.socket.emit("timeout");}
      if (fault === "premature close") {f.socket.actualClose();}
      await rejected;
      assert.equal(f.signal.aborted, true);
      assert.equal((await f.connection.close("complete")).state, "unknown");
      assert.equal(f.clock.pending, 0);
    });
  }
}

test("header deadline is capped by operation deadline and disarmed at head completion", async () => {
  const f = fixture({ ...defaults, limits: { ...defaults.limits, deadline: 100 } });
  f.socket.feed(encode("POST /"));
  await f.clock.advance(100);
  assert.equal(f.signal.aborted, true);
  await f.connection.close("abort");
  const g = fixture();
  g.socket.feed(encode(head(2)));
  await g.clock.advance(5_001);
  assert.equal(g.signal.aborted, false);
  g.socket.feed(encode("{}"));
  assert.equal((await g.parse()).body.length, 2);
  await g.connection.close("abort");
});

test("truncation on peer EOF, pre-aborted binding, invalid socket state and config are closed", async () => {
  const f = fixture();
  const next = assert.rejects(f.connection.request[Symbol.asyncIterator]().next());
  f.socket.feed(encode(head(2) + "x"));
  f.socket.peerEnd();
  await next;
  await f.connection.close("abort");
  for (const change of [{ allowHalfOpen: false }, { readableEncoding: "utf8" }, { connecting: true },
    { readableHighWaterMark: 65_537 }, { writableHighWaterMark: 65_537 }, { destroyed: true }]) {
    assert.throws(() => fixture(defaults, Object.assign(new SyntheticSocket(), change)), /invalid_socket/);
  }
  for (const change of [{ maxHeaderFields: 65 }, { headerTimeoutMs: 5_001 }, { writeHighWaterMark: 65_537 }]) {
    assert.throws(() => createNodeHostHttpConnection({ ...defaults, ...change }, new ManualClock()), /invalid_configuration/);
  }
});

test("pre-aborted accepted binding owns cleanup without reading or creating deadlines", async () => {
  const socket = new SyntheticSocket();
  const cutoff = new AbortController();
  const clock = new ManualClock();
  cutoff.abort();
  const owner = new NodeHostHttpConnectionCustody(fixNodeHostHttpConnectionConfig(defaults), clock, cutoff);
  assert.equal(socket.destroyCalls, 0);
  const bound = owner.bind(socket);
  assert.equal(socket.destroyCalls, 1);
  assert.equal(clock.pending, 0);
  assert.equal(socket.reads.length, 0);
  await assert.rejects(bound.connection.request[Symbol.asyncIterator]().next(), /cancelled/);
  assert.equal((await bound.connection.close("abort")).state, "unknown");
});

test("a blocking read that crosses the head deadline is rejected before publication", async () => {
  const socket = new SyntheticSocket();
  const f = fixture(defaults, socket);
  const read = socket.read.bind(socket);
  socket.read = size => {
    const bytes = read(size);
    if (size > 0) {f.clock.time = 5_000;}
    return bytes;
  };
  const rejected = assert.rejects(f.connection.request[Symbol.asyncIterator]().next(), /deadline/);
  socket.feed(wire());
  await rejected;
  assert.equal(f.signal.aborted, true);
  await f.connection.close("abort");
});

test("zero-length faulty read settles without spinning, and pending surplus counts remain raw", async () => {
  const socket = new SyntheticSocket();
  const f = fixture(defaults, socket);
  socket.read = () => new Uint8Array();
  const rejected = assert.rejects(f.connection.request[Symbol.asyncIterator]().next());
  socket.feed(wire());
  await rejected;
  await f.connection.close("abort");
  const g = fixture();
  const raw = wire();
  g.socket.feed(raw, false);
  g.socket.feed(encode("xyz"), false);
  await assert.rejects(g.connection.request[Symbol.asyncIterator]().next());
  assert.equal(g.signal.reason.observedBytes, raw.length + 3);
  await g.connection.close("abort");
});
