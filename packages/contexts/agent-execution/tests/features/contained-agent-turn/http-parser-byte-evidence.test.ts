import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  HttpEgressConnection,
  HttpEgressExpectedRequest,
  HttpEgressLimits,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-contracts.js";
import type { HttpEgressClock } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import {
  readStrictHttpRequest,
  StrictHttpRequestError,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-request.js";
import {
  forwardStrictHttpResponse,
  StrictHttpResponseError,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-response.js";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const expected: HttpEgressExpectedRequest = Object.freeze({
  requestId: "request-1", method: "POST", path: "/invoke", host: "broker.invalid",
});
const limits: HttpEgressLimits = Object.freeze({
  maxInboundHeaderBytes: 256,
  maxInboundBodyBytes: 32,
  maxUpstreamHeaderBytes: 256,
  maxOutputBytes: 64,
  maxBufferedBytes: 256,
  maxUpstreamWireBytes: 512,
  deadline: 100,
  closureDeadline: 200,
});
const clock: HttpEgressClock = Object.freeze({
  now: () => 0,
  within: async <T>(_deadline: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    return await operation();
  },
});

const source = (chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> => Object.freeze({
  async *[Symbol.asyncIterator]() {
    yield* chunks;
  },
});

const requestError = async (
  chunks: AsyncIterable<Uint8Array>,
  expectedKind: StrictHttpRequestError["kind"],
  expectedBytes: number,
  requestClock: HttpEgressClock = clock,
  signal?: AbortSignal,
): Promise<void> => {
  await assert.rejects(readStrictHttpRequest(chunks, expected, limits, requestClock, signal), error => {
    assert.ok(error instanceof StrictHttpRequestError);
    assert.equal(error.kind, expectedKind);
    assert.equal(error.observedBytes, expectedBytes);
    assert.equal(Number.isSafeInteger(error.observedBytes), true);
    assert.ok(error.observedBytes >= 0);
    return true;
  });
};

test("request errors report every yielded byte without retaining an oversized first chunk", async () => {
  const chunk = encode("x".repeat(limits.maxInboundHeaderBytes + limits.maxInboundBodyBytes + 1));
  await requestError(source([chunk]), "headers_oversized", chunk.byteLength);

  const declaredOversized = encode("POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 33\r\n\r\n");
  await requestError(source([declaredOversized]), "body_oversized", declaredOversized.byteLength);
});

test("request malformed and truncated evidence includes the complete yielded wire", async () => {
  const malformed = encode("POST /invoke HTTP/1.0\r\nHost: broker.invalid\r\nContent-Length: 2\r\n\r\n{}");
  await requestError(source([malformed]), "malformed", malformed.byteLength);

  const truncated = encode("POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 2\r\n\r\nx");
  await requestError(source([truncated]), "malformed", truncated.byteLength);
});

test("request deadline and cancellation preserve partial-stream byte evidence", async () => {
  const partial = encode("POST /invoke HTTP/1.1\r\n");
  let calls = 0;
  const deadlineClock: HttpEgressClock = {
    now: () => 0,
    within: async <T>(_deadline: number, operation: () => Promise<T>): Promise<T> => {
      calls += 1;
      if (calls > 1) {throw new Error("synthetic deadline");}
      return await operation();
    },
  };
  await requestError(source([partial]), "deadline", partial.byteLength, deadlineClock);

  const controller = new AbortController();
  const cancelling: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      let yielded = false;
      return {
        next: async (): Promise<IteratorResult<Uint8Array>> => {
          if (yielded) {return { done: true, value: undefined };}
          yielded = true;
          controller.abort();
          return { done: false, value: partial };
        },
      };
    },
  };
  await requestError(cancelling, "cancelled", partial.byteLength, clock, controller.signal);
});

test("a valid request still reports its exact accepted wire size", async () => {
  const wire = encode("POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
  const request = await readStrictHttpRequest(source([wire.slice(0, 17), wire.slice(17)]), expected, limits, clock);
  assert.equal(request.wireBytes, wire.byteLength);
  assert.deepEqual(request.body, encode("{}"));
});

const responseConnection = (): HttpEgressConnection => Object.freeze({
  request: source([]),
  write: async () => {},
  close: async () => Object.freeze({ state: "closed" as const, receiptDigest: "closed" }),
});

const responseError = async (
  chunks: readonly Uint8Array[],
  responseLimits: HttpEgressLimits,
  expectedKind: StrictHttpResponseError["kind"],
  expectedBytes: number,
): Promise<void> => {
  await assert.rejects(
    forwardStrictHttpResponse(source(chunks), responseConnection(), responseLimits, clock),
    error => {
      assert.ok(error instanceof StrictHttpResponseError);
      assert.equal(error.kind, expectedKind);
      assert.equal(error.upstreamBytes, expectedBytes);
      assert.equal(Number.isSafeInteger(error.upstreamBytes), true);
      assert.ok(error.upstreamBytes >= 0);
      return true;
    },
  );
};

test("response oversized-first-chunk and max-wire failures count the rejected yielded chunk", async () => {
  const wire = encode("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
  await responseError([wire], { ...limits, maxBufferedBytes: wire.byteLength - 1 }, "oversized", wire.byteLength);
  await responseError([wire.slice(0, 16), wire.slice(16)], {
    ...limits, maxUpstreamWireBytes: wire.byteLength - 1,
  }, "oversized", wire.byteLength);
});

test("a malformed response head counts body bytes yielded in the same chunk", async () => {
  const wire = encode("HTTP/1.0 200 OK\r\nContent-Length: 4\r\n\r\nbody");
  await responseError([wire], limits, "malformed", wire.byteLength);
});

test("response evidence preserves prior chunks after a partial stream failure", async () => {
  const partial = encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx");
  const crashing: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      yield partial;
      throw new Error("synthetic upstream failure");
    },
  };
  await assert.rejects(forwardStrictHttpResponse(crashing, responseConnection(), limits, clock), error => {
    assert.ok(error instanceof StrictHttpResponseError);
    assert.equal(error.kind, "stalled");
    assert.equal(error.upstreamBytes, partial.byteLength);
    return true;
  });
});

test("a valid response stream retains exact upstream byte evidence", async () => {
  const wire = encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
  const result = await forwardStrictHttpResponse(
    source([wire.slice(0, 11), wire.slice(11)]), responseConnection(), limits, clock,
  );
  assert.equal(result.status, 200);
  assert.equal(result.upstreamBytes, wire.byteLength);
});
