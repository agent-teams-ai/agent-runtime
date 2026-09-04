import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HttpEgressLimits } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-contracts.js";
import { HttpEgressLimitsError } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-limits.js";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { bytes, chunks, createEgressFixture, defaultRoute } from "./http-egress-test-fixture.ts";

describe("HTTP egress bounded evidence regressions", () => {
  for (const field of ["maxInboundHeaderBytes", "maxInboundBodyBytes", "maxUpstreamHeaderBytes",
    "maxOutputBytes", "maxBufferedBytes", "maxUpstreamWireBytes"] as const) {
    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      test(`rejects invalid ${field} ${value} before accepting connection ownership`, async () => {
        const fixture = createEgressFixture();
        await assert.rejects(createStrictHttpEgressBroker(fixture.ports).execute({
          ...fixture.operation, limits: { ...fixture.operation.limits, [field]: value },
        }), HttpEgressLimitsError);
        assert.deepEqual(fixture.observations.order, []);
      });
    }
  }

  const invalidLimits: readonly Partial<HttpEgressLimits>[] = [
    { maxBufferedBytes: 0 }, { maxInboundHeaderBytes: 0 }, { maxUpstreamHeaderBytes: 0 },
    { maxUpstreamWireBytes: 0 }, { deadline: Number.NaN }, { deadline: -1 },
    { deadline: Number.POSITIVE_INFINITY }, { closureDeadline: Number.NaN },
    { closureDeadline: Number.POSITIVE_INFINITY }, { closureDeadline: 999 },
    { deadline: 0.5 }, { closureDeadline: 1_100.5 },
    { deadline: Number.MAX_SAFE_INTEGER + 1 }, { closureDeadline: Number.MAX_SAFE_INTEGER + 1 },
    { maxInboundHeaderBytes: Number.MAX_SAFE_INTEGER, maxInboundBodyBytes: 1 },
  ];
  for (const limits of invalidLimits) {
    test("invalid closure, zero progress, or overflowing budgets cannot start work", async () => {
      const fixture = createEgressFixture();
      await assert.rejects(createStrictHttpEgressBroker(fixture.ports).execute({
        ...fixture.operation, limits: { ...fixture.operation.limits, ...limits },
      }), HttpEgressLimitsError);
      assert.equal(fixture.observations.opens, 0);
    });
  }

  test("captures limits before the first asynchronous operation", async () => {
    const fixture = createEgressFixture();
    const limits = { ...fixture.operation.limits };
    const execution = createStrictHttpEgressBroker(fixture.ports).execute({ ...fixture.operation, limits });
    limits.maxBufferedBytes = 0;
    limits.maxOutputBytes = 0;
    assert.equal((await execution).outcome, "completed");
  });

  for (const acceptedRequestBytes of [0, 1, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 999_999]) {
    test(`a response cannot hide incomplete or invalid request acknowledgement ${acceptedRequestBytes}`, async () => {
      const fixture = createEgressFixture({ dispatch: {
        status: "response", acceptedRequestBytes, acknowledgement: "acknowledged",
        response: chunks(["HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"]),
      } });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.outcome, "reconcile_required");
      assert.equal(receipt.anomalyCode, "upstream_write_failed");
      assert.equal(fixture.observations.dispatches, 1);
      assert.equal(fixture.observations.outboundWrites.length, 0);
      assert.equal(Number.isSafeInteger(receipt.upstreamRequestBytes), true);
      assert.ok(receipt.upstreamRequestBytes >= 0);
    });
  }

  test("enforces the response header limit even with its delimiter in the same chunk", async () => {
    const wire = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nX-Fill: abcdef\r\n\r\n";
    for (const limit of [wire.length - 1, wire.length]) {
      const fixture = createEgressFixture({ response: [wire] });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({
        ...fixture.operation, limits: { ...fixture.operation.limits, maxUpstreamHeaderBytes: limit },
      });
      assert.equal(receipt.outcome, limit === wire.length ? "completed" : "reconcile_required");
      if (limit < wire.length) {
        assert.equal(receipt.anomalyCode, "output_oversized");
        assert.equal(fixture.observations.outboundWrites.length, 0);
      }
    }
  });

  test("oversized terminated chunk-size lines are rejected with confirmed output preserved", async () => {
    const fixture = createEgressFixture({ response: [
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${"0".repeat(33)}\r\n\r\n`,
    ] });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.anomalyCode, "output_oversized");
    assert.equal(receipt.outboundResponseBytes, fixture.observations.outboundWrites[0]?.byteLength);
    assert.ok(receipt.outboundResponseBytes > 0);
  });

  for (const ending of ["throw", "extra", "truncated"] as const) {
    test(`preserves confirmed response bytes when the stream ends with ${ending}`, async () => {
      async function* response(): AsyncIterable<Uint8Array> {
        yield bytes(`HTTP/1.1 200 OK\r\nContent-Length: ${ending === "extra" ? 1 : 2}\r\n\r\nx`);
        if (ending === "throw") {throw new Error("synthetic interrupted response");}
        if (ending === "extra") {yield bytes("unrequested");}
      }
      const fixture = createEgressFixture({ responseSource: response() });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.outcome, "reconcile_required");
      assert.equal(receipt.outboundResponseBytes,
        fixture.observations.outboundWrites.reduce((sum, part) => sum + part.byteLength, 0));
      assert.ok(receipt.outboundResponseBytes > 0);
      assert.equal(receipt.outboundResponseWriteUncertain, false);
    });
  }

  test("failed downstream writes retain byte uncertainty instead of claiming no write", async () => {
    const fixture = createEgressFixture();
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({
      ...fixture.operation, connection: { ...fixture.operation.connection, write: async () => {
        // A sink can accept a prefix and then reject without acknowledging its length.
        throw new Error("synthetic partial write");
      } },
    });
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(receipt.outboundResponseBytes, 0);
    assert.equal(receipt.outboundResponseWriteUncertain, true);
  });

  test("does not forward encoded response bytes after dropping their encoding header", async () => {
    const fixture = createEgressFixture({ response: [
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Encoding: gzip\r\n\r\nxx",
    ] });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.anomalyCode, "upstream_malformed");
    assert.equal(fixture.observations.outboundWrites.length, 0);
  });

  for (const upstreamPath of ["/x\r\nX-Injected: yes", "/x y", "/x\t", "/x\u0001", "/x\u00e9"]) {
    test("rejects unsafe route bytes before DNS, credentials, or transport", async () => {
      const fixture = createEgressFixture({ route: { ...defaultRoute, upstreamPath } });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.outcome, "denied");
      assert.equal(receipt.attemptCount, 0);
      assert.equal(fixture.observations.opens, 0);
      assert.equal(fixture.observations.renders, 0);
      assert.equal(fixture.observations.order.includes("resolve"), false);
    });
  }

  test("cancellation during Provider Access authorization remains cancellation", async () => {
    const controller = new AbortController();
    const fixture = createEgressFixture({ signal: controller.signal });
    const ports = { ...fixture.ports, providerAccess: { ...fixture.ports.providerAccess, authorize: async () => {
      controller.abort();
      throw new Error("synthetic interrupted observation");
    } } };
    const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "cancelled");
    assert.equal(receipt.anomalyCode, "inbound_cancelled");
    assert.equal(fixture.observations.opens, 0);
  });
});
