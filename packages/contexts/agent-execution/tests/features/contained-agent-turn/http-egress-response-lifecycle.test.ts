import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HttpEgressDispatch } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { bytes, createEgressFixture, outputText, SECRET_MARKER } from "./http-egress-test-fixture.ts";

async function* stalledResponse(): AsyncIterable<Uint8Array> {
  yield bytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx");
  throw new Error("synthetic upstream crash");
}

describe("strict upstream response and lifecycle", () => {
  for (const [status, anomaly] of [
    [401, "upstream_auth_rejected"],
    [403, "upstream_auth_rejected"],
    [429, "upstream_rate_limited"],
    [500, "upstream_server_error"],
    [503, "upstream_server_error"],
  ] as const) {
    test(`closes before exposing retry-triggering HTTP ${status}`, async () => {
      const fixture = createEgressFixture({ response: [`HTTP/1.1 ${status} Synthetic\r\nContent-Length: 0\r\n\r\n`] });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.outcome, "denied");
      assert.equal(receipt.anomalyCode, anomaly);
      assert.equal(receipt.attemptCount, 1);
      assert.equal(fixture.observations.dispatches, 1);
      assert.equal(outputText(fixture), "");
    });
  }

  for (const status of [300, 301, 302, 307, 308] as const) {
    test(`rejects redirect ${status} without following it`, async () => {
      const fixture = createEgressFixture({ response: [`HTTP/1.1 ${status} Redirect\r\nContent-Length: 0\r\nLocation: https://evil.invalid/\r\n\r\n`] });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.outcome, "denied");
      assert.equal(receipt.anomalyCode, "redirect_rejected");
      assert.equal(fixture.observations.dispatches, 1);
      assert.equal(fixture.observations.opens, 1);
      assert.equal(outputText(fixture), "");
    });
  }

  const invalidResponses = [
    { name: "malformed status", wire: "HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n", anomaly: "upstream_malformed" },
    { name: "interim response", wire: "HTTP/1.1 100 Continue\r\nContent-Length: 0\r\n\r\n", anomaly: "upstream_malformed" },
    { name: "CL plus TE", wire: "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n", anomaly: "upstream_malformed" },
    { name: "duplicate CL", wire: "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n", anomaly: "upstream_malformed" },
    { name: "unsupported TE", wire: "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n", anomaly: "upstream_malformed" },
    { name: "EOF framing", wire: "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nbody", anomaly: "upstream_malformed" },
    { name: "truncated fixed body", wire: "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nxx", anomaly: "upstream_truncated" },
    { name: "truncated chunk", wire: "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nxx", anomaly: "upstream_truncated" },
    { name: "chunk extension", wire: "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1;x=y\r\na\r\n0\r\n\r\n", anomaly: "upstream_malformed" },
    { name: "response trailers", wire: "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Foo: x\r\n\r\n", anomaly: "upstream_malformed" },
  ] as const;

  for (const scenario of invalidResponses) {
    test(`fails closed for ${scenario.name} after exactly one attempt`, async () => {
      const fixture = createEgressFixture({ response: [scenario.wire] });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.outcome, "reconcile_required");
      assert.equal(receipt.anomalyCode, scenario.anomaly);
      assert.equal(fixture.observations.dispatches, 1);
      assert.equal(fixture.observations.opens, 1);
    });
  }

  test("rejects declared oversized output before downstream headers", async () => {
    const fixture = createEgressFixture({ response: ["HTTP/1.1 200 OK\r\nContent-Length: 4097\r\n\r\n"] });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.anomalyCode, "output_oversized");
    assert.equal(receipt.outboundResponseBytes, 0);
    assert.equal(outputText(fixture), "");
  });

  test("bounds a chunked stream after downstream headers", async () => {
    const fixture = createEgressFixture({
      response: [`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1001\r\n${"x".repeat(4097)}\r\n0\r\n\r\n`],
    });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(receipt.anomalyCode, "output_oversized");
  });

  test("maps a stalled or crashed upstream iterator to reconciliation", async () => {
    const fixture = createEgressFixture({ responseSource: stalledResponse() });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(receipt.anomalyCode, "upstream_stalled");
    assert.equal(fixture.observations.dispatches, 1);
  });

  test("maps downstream backpressure failure after headers to reconciliation", async () => {
    const fixture = createEgressFixture({ connectionWriteThrows: true });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(receipt.anomalyCode, "output_backpressure_failed");
  });

  test("cancellation before parsing closes inbound with zero attempts", async () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = createEgressFixture({ signal: controller.signal });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "cancelled");
    assert.equal(receipt.anomalyCode, "inbound_cancelled");
    assert.equal(receipt.upstreamRequestBytes, 0);
    assert.equal(fixture.observations.opens, 0);
  });

  test("cancellation racing dispatch never retries and remains uncertain", async () => {
    const controller = new AbortController();
    const fixture = createEgressFixture({ signal: controller.signal, abortOnDispatch: controller, dispatch: "throw" });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(receipt.firstByteState, "uncertain");
    assert.equal(receipt.anomalyCode, "inbound_cancelled");
    assert.equal(fixture.observations.dispatches, 1);
    assert.equal(receipt.upstreamClosure, "closed");
    assert.equal(receipt.inboundClosure, "closed");
  });

  test("cancellation after an accepted request byte closes both flows and reconciles", async () => {
    const controller = new AbortController();
    async function* response(): AsyncIterable<Uint8Array> {
      yield bytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx");
      controller.abort();
      yield bytes("y");
    }
    const fixture = createEgressFixture({ signal: controller.signal, responseSource: response() });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(receipt.anomalyCode, "inbound_cancelled");
    assert.equal(receipt.firstByteState, "sent");
    assert.equal(receipt.upstreamClosure, "closed");
    assert.equal(receipt.inboundClosure, "closed");
  });

  for (const dispatch of [
    Object.freeze({ status: "failed", acceptedRequestBytes: 0, acknowledgement: "acknowledged" }),
    Object.freeze({ status: "failed", acceptedRequestBytes: 17, acknowledgement: "acknowledged" }),
    Object.freeze({ status: "failed", acceptedRequestBytes: "unknown", acknowledgement: "lost" }),
    Object.freeze({ status: "failed", acceptedRequestBytes: 17, acknowledgement: "lost" }),
  ] satisfies readonly HttpEgressDispatch[]) {
    test(`never retries a failed dispatch with byte state ${dispatch.acceptedRequestBytes}`, async () => {
      const fixture = createEgressFixture({ dispatch });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(fixture.observations.dispatches, 1);
      assert.equal(fixture.observations.opens, 1);
      assert.equal(receipt.outcome, dispatch.acceptedRequestBytes === 0 ? "denied" : "reconcile_required");
    });
  }

  for (const evidence of ["conflict", "unknown", "throw"] as const) {
    test(`does not invent success after evidence ${evidence}`, async () => {
      const fixture = createEgressFixture({ evidence });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.outcome, "reconcile_required");
      assert.equal(receipt.anomalyCode, evidence === "conflict" ? "conflicting_replay" : "evidence_ack_lost");
      assert.equal(fixture.observations.dispatches, 1);
    });
  }

  test("unknown closure evidence forces reconciliation", async () => {
    const fixture = createEgressFixture({ upstreamClosure: "unknown" });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(receipt.anomalyCode, "closure_unproved");
  });

  test("canonical evidence and diagnostics contain no credential, body, path, header, or provider output", async () => {
    const fixture = createEgressFixture({
      request: ["POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nX-Synthetic: private-header-marker\r\nContent-Length: 21\r\n\r\nprivate-body-marker!!"],
    });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    const evidence = JSON.stringify({ receipt, recorded: fixture.observations.receipts });
    assert.doesNotMatch(evidence, new RegExp(`${SECRET_MARKER}|private-body-marker|private-header-marker|fixed-provider-route|/invoke|Content-Length:|Authorization:|data:`));
    assert.equal(fixture.observations.renders, 1);
    assert.equal(Object.isFrozen(receipt), true);
  });
});
