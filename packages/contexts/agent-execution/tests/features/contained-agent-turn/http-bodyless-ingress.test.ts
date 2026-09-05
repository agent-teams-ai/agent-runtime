import assert from "node:assert/strict";
import test from "node:test";
import type { HttpEgressExpectedRequest } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-contracts.js";
import { fixNodeHostHttpConnectionConfig } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-connection-config.js";
import { readStrictHttpRequest } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-request.js";
import { snapshotHttpEgressOperation } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-ingress-validation.js";
import { defaults, encode, fixture, flush, ManualClock } from "./node-host-http-connection-fixture.ts";

const config = (method: "HEAD") => ({...defaults,
  expectedRequest: {...defaults.expectedRequest, method, path: "/api/hello", bodyMode: "forbidden" as const},
  limits: {...defaults.limits, maxInboundBodyBytes: 0}});
const wire = (method: string, fields = "") =>
  `${method} /api/hello HTTP/1.1\r\nHost: broker.invalid\r\n${fields}\r\n`;
const source = (parts: readonly string[]) => ({async *[Symbol.asyncIterator]() {for (const p of parts) {yield encode(p);}}});

for (const method of ["HEAD"] as const) {
  for (const fields of ["", "Content-Length: 0\r\n"]) {
    test(`explicit bodyless ${method} preserves raw headers at every split: ${JSON.stringify(fields)}`, async () => {
      const raw = encode(wire(method, fields));
      for (let split = 1; split < raw.length; split += 1) {
        const f = fixture(config(method));
        try {
          const pending = f.parse();
          f.socket.feed(raw.slice(0, split)); await flush(); f.socket.feed(raw.slice(split));
          const parsed = await pending;
          assert.equal(parsed.method, method); assert.equal(parsed.body.length, 0); assert.equal(parsed.wireBytes, raw.length);
          assert.equal(parsed.headers.some(h => h.name === "content-length"), fields !== "", "do not invent a header");
          assert.equal(f.socket.readableEnded, false, "finite TCP frame must not wait for peer EOF");
        } finally {await f.connection.close("abort");}
        assert.equal(f.clock.pending, 0);
      }
    });
  }
  test(`generic ${method} parser keeps EOF ownership after an explicitly bodyless frame`, async () => {
    const gate = Promise.withResolvers<void>(); let settled = false;
    const chunks = {async *[Symbol.asyncIterator]() {yield encode(wire(method)); await gate.promise;}};
    const c = config(method);
    const pending = readStrictHttpRequest(chunks, c.expectedRequest, c.limits, new ManualClock()).then(r => {settled = true; return r;});
    await flush(); assert.equal(settled, false); gate.resolve(); assert.equal((await pending).body.length, 0);
  });
  for (const fields of ["Content-Length: 1\r\n", "Content-Length: 00\r\n", "Content-Length: +0\r\n",
    "Content-Length: -1\r\n", "Content-Length: 0\r\nContent-Length: 0\r\n",
    "Transfer-Encoding: chunked\r\n", "Expect: 100-continue\r\n", "Trailer: x\r\n",
    "Upgrade: websocket\r\n", "Host: broker.invalid\r\n"]) {
    test(`${method} body prohibition rejects ${JSON.stringify(fields)}`, async () => {
      const f = fixture(config(method));
      try {
        const rejected = assert.rejects(f.parse()); f.socket.feed(encode(wire(method, fields))); await rejected;
        assert.equal(f.signal.aborted, true); assert.equal(f.socket.writes.length, 0);
      } finally {await f.connection.close("abort");}
    });
  }
  for (const phase of ["same", "queued", "after-frame"] as const) {
    test(`bodyless ${method} surplus at ${phase} burns the connection`, async () => {
      const f = fixture(config(method));
      try {
        if (phase === "after-frame") {
          f.socket.feed(encode(wire(method))); await f.parse(); f.socket.feed(encode("x")); await flush();
        } else {
          const rejected = assert.rejects(f.parse());
          if (phase === "same") {f.socket.feed(encode(wire(method) + "x"));}
          else {f.socket.feed(encode(wire(method)), false); f.socket.feed(encode("x"));}
          await rejected;
        }
        assert.equal(f.signal.aborted, true); assert.equal(f.socket.writes.length, 0);
        assert.equal((await f.connection.close("complete")).state, "unknown");
      } finally {await f.connection.close("abort");}
    });
  }
  test(`bodyless ${method} does not widen exact method, path, query or Host`, async () => {
    const c = config(method);
    for (const raw of [wire("POST"), wire(method).replace("/api/hello", "/api/hello?x=1"),
      wire(method).replace("/api/hello", "/v1/messages"), wire(method).replace("broker.invalid", "other.invalid")]) {
      await assert.rejects(readStrictHttpRequest(source([raw]), c.expectedRequest, c.limits, new ManualClock()), /route_mismatch/);
    }
  });
}

test("bodyless declaration is explicit, closed and paired with a zero body budget", async () => {
  for (const method of ["HEAD"] as const) {
    const c = config(method); const {bodyMode: _mode, ...unspecified} = c.expectedRequest;
    assert.throws(() => fixNodeHostHttpConnectionConfig({...c, expectedRequest: unspecified}), /invalid_configuration/);
    await assert.rejects(readStrictHttpRequest(source([wire(method)]), unspecified, c.limits, new ManualClock()), /smuggling/);
    assert.throws(() => fixNodeHostHttpConnectionConfig({...c, limits: {...c.limits, maxInboundBodyBytes: 1}}), /invalid_configuration/);
    await assert.rejects(readStrictHttpRequest(source([wire(method)]), c.expectedRequest,
      {...c.limits, maxInboundBodyBytes: 1}, new ManualClock()));
  }
  for (const change of [{method: "GET"}, {method: "POST"}, {method: "PUT"}, {bodyMode: "optional"}, {bodyMode: null}]) {
    const c = config("HEAD"); const expected = {...c.expectedRequest, ...change} as HttpEgressExpectedRequest;
    assert.throws(() => fixNodeHostHttpConnectionConfig({...c, expectedRequest: expected}), /invalid_configuration/);
    await assert.rejects(readStrictHttpRequest(source([wire(expected.method, "Content-Length: 0\r\n")]),
      expected, c.limits, new ManualClock()));
  }
});

test("trusted operation snapshots retain body policy and reject accessor or extra policy keys", async () => {
  const c = config("HEAD"); const f = fixture(c);
  const operation = {operationId: "operation:test", attemptId: "attempt:test", expectedRequest: c.expectedRequest,
    connection: f.connection, limits: c.limits};
  try {
    const captured = snapshotHttpEgressOperation(operation);
    assert.equal(captured.expectedRequest.bodyMode, "forbidden"); assert.equal(Object.isFrozen(captured.expectedRequest), true);
    (c.expectedRequest as {bodyMode: string}).bodyMode = "optional";
    assert.equal(captured.expectedRequest.bodyMode, "forbidden");
    assert.throws(() => snapshotHttpEgressOperation(operation), /invalid HTTP/);
    let getterCalls = 0;
    const accessor = {...config("HEAD").expectedRequest};
    Object.defineProperty(accessor, "bodyMode", {get: () => {getterCalls += 1; return "forbidden";}});
    assert.throws(() => snapshotHttpEgressOperation({...operation, expectedRequest: accessor}), /invalid HTTP/);
    assert.equal(getterCalls, 0);
    assert.throws(() => snapshotHttpEgressOperation({...operation,
      expectedRequest: {...config("HEAD").expectedRequest, allowBody: true}}), /invalid HTTP/);
  } finally {await f.connection.close("abort");}
});
