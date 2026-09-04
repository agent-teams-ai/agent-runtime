import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import type { HttpEgressRoute } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import { bytes, createEgressFixture, defaultRoute } from "./http-egress-test-fixture.ts";

const executeHeaders = async (headers: string, route: HttpEgressRoute = defaultRoute) => {
  const fixture = createEgressFixture({ route, request: [
    `POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 2\r\n${headers}\r\n{}`,
  ] });
  const ports = { ...fixture.ports, evidence: { ...fixture.ports.evidence, digest: (parts: readonly Uint8Array[]) => {
    const hash = createHash("sha256");
    for (const part of parts) {hash.update(part);}
    return hash.digest("hex");
  } } };
  const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
  return { receipt, fixture, request: new TextDecoder().decode(fixture.observations.dispatchedRequests[0]) };
};

test("only trusted route header names are forwarded", async () => {
  const result = await executeHeaders("Content-Type: application/json\r\nAccept: text/event-stream\r\n"
    + "Api-Key: child-key\r\nCookie: user-session\r\nX-Remote-Authority: ignored\r\nAccept-Encoding: gzip\r\n");
  assert.equal(result.receipt.outcome, "completed");
  assert.match(result.request, /content-type: application\/json\r\n/);
  assert.match(result.request, /accept: text\/event-stream\r\n/);
  assert.doesNotMatch(result.request, /child-key|user-session|ignored|gzip|Cookie|Api-Key|X-Remote-Authority/i);
});

test("the actual forwarded header set is bound into the request digest", async () => {
  const json = await executeHeaders("Content-Type: application/json\r\n");
  const plain = await executeHeaders("Content-Type: text/plain\r\n");
  assert.equal(json.receipt.outcome, "completed");
  assert.equal(plain.receipt.outcome, "completed");
  assert.notEqual(json.receipt.requestDigest, plain.receipt.requestDigest);
  assert.notEqual(json.request, plain.request);
});

test("canonical header order and stripped credentials cannot change the emitted identity", async () => {
  const first = await executeHeaders("Accept: text/event-stream\r\nContent-Type: application/json\r\nCookie: first\r\n");
  const reordered = await executeHeaders("Content-Type: application/json\r\nCookie: second\r\nAccept: text/event-stream\r\n");
  assert.equal(first.receipt.requestDigest, reordered.receipt.requestDigest);
  assert.equal(first.request, reordered.request);
});

test("custom presentation headers require explicit route admission and remain digest-bound", async () => {
  const route = { ...defaultRoute, forwardedRequestHeaderNames: ["x-presentation"] };
  const first = await executeHeaders("X-Presentation: first\r\n", route);
  const second = await executeHeaders("X-Presentation: second\r\n", route);
  assert.match(first.request, /x-presentation: first/);
  assert.notEqual(first.receipt.requestDigest, second.receipt.requestDigest);
});

for (const names of [["authorization"], ["api-key"], ["cookie"], ["accept-encoding"],
  ["host"], ["content-length"], ["connection"], ["Content-Type"], ["content-type", "content-type"],
  ["x-bad\r\nInjected"], Array.from({ length: 33 }, (_, index) => `x-field-${index}`)]) {
  test("unsafe route header allowlists are rejected before transport or credential use", async () => {
    const result = await executeHeaders("Content-Type: application/json\r\n", {
      ...defaultRoute, forwardedRequestHeaderNames: names,
    });
    assert.equal(result.receipt.outcome, "denied");
    assert.equal(result.fixture.observations.opens, 0);
    assert.equal(result.fixture.observations.renders, 0);
    assert.equal(result.fixture.observations.order.includes("resolve"), false);
  });
}

test("duplicate forwarded presentation headers have no ambiguous interpretation", async () => {
  const result = await executeHeaders("Content-Type: application/json\r\nContent-Type: text/plain\r\n");
  assert.equal(result.receipt.outcome, "denied");
  assert.equal(result.fixture.observations.opens, 0);
  assert.equal(result.fixture.observations.renders, 0);
});

test("Host credential materialization is separate and bound to operation, attempt, and receipt", async () => {
  const fixture = createEgressFixture();
  let binding: unknown;
  const ports = { ...fixture.ports, credentialCustody: { renderAuthorization: async (input: unknown) => {
    binding = input;
    return bytes("Bearer synthetic-host-only");
  } } };
  const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
  assert.equal(receipt.outcome, "completed");
  assert.equal("renderAuthorization" in ports.routeAuthority, false);
  assert.equal("credential" in defaultRoute, false);
  assert.deepEqual(binding, {
    operationId: fixture.operation.operationId,
    attemptId: fixture.operation.attemptId,
    materializationReceiptDigest: defaultRoute.materializationReceiptDigest,
  });
  assert.doesNotMatch(JSON.stringify(receipt), /synthetic-host-only/);
});
