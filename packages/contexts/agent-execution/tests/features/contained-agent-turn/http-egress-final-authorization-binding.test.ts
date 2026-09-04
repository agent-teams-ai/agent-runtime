import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import type {
  HttpEgressFinalAuthorization,
  HttpEgressFinalAuthorizationDecision,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import {
  canonicalFinalAuthorizationBindingParts,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-final-authorization-binding.js";
import type {
  HttpEgressFinalAuthorizationFacts,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-final-authorization-binding.js";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { createEgressFixture, defaultRoute, SECRET_MARKER } from "./http-egress-test-fixture.ts";

const digest = (parts: readonly Uint8Array[]): string => {
  const hash = createHash("sha256");
  for (const part of parts) {hash.update(part);}
  return hash.digest("hex");
};

const factsOf = (input: HttpEgressFinalAuthorization): HttpEgressFinalAuthorizationFacts => {
  const { bindingDigest: _bindingDigest, ...facts } = input;
  return facts;
};

const decisionFor = (
  input: HttpEgressFinalAuthorization,
  bindingDigest: string,
): HttpEgressFinalAuthorizationDecision => Object.freeze({
  decision: "allow",
  receiptDigest: "final-receipt-digest",
  validUntil: 900,
  policyGeneration: input.policyGeneration,
  keyGeneration: input.keyGeneration,
  routeGeneration: input.routeGeneration,
  credentialGeneration: input.credentialGeneration,
  materializationReceiptDigest: input.materializationReceiptDigest,
  bindingDigest,
});

const digestWith = (
  input: HttpEgressFinalAuthorization,
  changes: Partial<HttpEgressFinalAuthorizationFacts>,
): string => digest(canonicalFinalAuthorizationBindingParts(Object.freeze({ ...factsOf(input), ...changes })));

describe("HTTP final authorization binding", () => {
  test("the successful synthetic request presents the complete normalized semantic authority input", async () => {
    const fixture = createEgressFixture({
      addresses: ["2606:2800:0220:0001:0248:1893:25c8:1946", "93.184.216.34"],
    });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "completed");
    assert.equal(fixture.observations.dispatches, 1);
    assert.equal(fixture.observations.finalAuthorizationInputs.length, 1);
    const input = fixture.observations.finalAuthorizationInputs[0];
    assert.deepEqual(input, {
      operationId: fixture.operation.operationId,
      attemptId: fixture.operation.attemptId,
      requestId: fixture.operation.expectedRequest.requestId,
      requestMethod: fixture.operation.expectedRequest.method,
      requestPath: fixture.operation.expectedRequest.path,
      requestHost: fixture.operation.expectedRequest.host,
      requestDigest: receipt.requestDigest,
      routeReceiptDigest: defaultRoute.routeReceiptDigest,
      materializationReceiptDigest: defaultRoute.materializationReceiptDigest,
      redirectHop: 0,
      originHost: defaultRoute.originHost,
      originPort: defaultRoute.originPort,
      upstreamMethod: defaultRoute.upstreamMethod,
      upstreamPath: defaultRoute.upstreamPath,
      resolvedAddresses: ["2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34"],
      selectedAddress: "93.184.216.34",
      observedPeerAddress: "93.184.216.34",
      observedPeerPort: 443,
      tlsProtocol: "TLSv1.3",
      sni: defaultRoute.sni,
      sniDigest: defaultRoute.sniDigest,
      certificateDigest: defaultRoute.certificateDigest,
      pinDigest: defaultRoute.pinDigest,
      alpn: "http/1.1",
      policyGeneration: defaultRoute.policyGeneration,
      keyGeneration: defaultRoute.keyGeneration,
      routeGeneration: defaultRoute.routeGeneration,
      credentialGeneration: defaultRoute.credentialGeneration,
      limits: fixture.operation.limits,
      bindingDigest: input.bindingDigest,
    });
    assert.equal(input.bindingDigest, digest(canonicalFinalAuthorizationBindingParts(factsOf(input))));
  });

  test("every closed authorization fact changes the canonical correlation digest", async () => {
    const fixture = createEgressFixture({ addresses: ["93.184.216.35", "93.184.216.34"] });
    await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    const input = fixture.observations.finalAuthorizationInputs[0];
    const cases: readonly [string, Partial<HttpEgressFinalAuthorizationFacts>][] = [
      ["operation", { operationId: "operation-stale" }],
      ["attempt", { attemptId: "attempt-stale" }],
      ["request id", { requestId: "request-stale" }],
      ["request method", { requestMethod: "PUT" }],
      ["request path", { requestPath: "/other" }],
      ["request host", { requestHost: "other.invalid" }],
      ["request bytes", { requestDigest: "request-digest-stale" }],
      ["route receipt", { routeReceiptDigest: "route-stale" }],
      ["materialization", { materializationReceiptDigest: "materialization-stale" }],
      ["redirect", { redirectHop: 1 as never }],
      ["origin host", { originHost: "other.example" }],
      ["origin port", { originPort: 8443 }],
      ["upstream method", { upstreamMethod: "PUT" }],
      ["upstream path", { upstreamPath: "/other" }],
      ["address order", { resolvedAddresses: input.resolvedAddresses.toReversed() }],
      ["address addition", { resolvedAddresses: [...input.resolvedAddresses, "93.184.216.36"] }],
      ["selected address", { selectedAddress: "93.184.216.35" }],
      ["peer address", { observedPeerAddress: "93.184.216.35" }],
      ["peer port", { observedPeerPort: 8443 }],
      ["TLS protocol", { tlsProtocol: "TLSv1.2" }],
      ["SNI", { sni: "other.example" }],
      ["SNI digest", { sniDigest: "sni-stale" }],
      ["certificate", { certificateDigest: "certificate-stale" }],
      ["pin", { pinDigest: "pin-stale" }],
      ["ALPN", { alpn: "h2" as never }],
      ["policy generation", { policyGeneration: "policy-stale" }],
      ["key generation", { keyGeneration: "key-stale" }],
      ["route generation", { routeGeneration: "route-generation-stale" }],
      ["credential generation", { credentialGeneration: "credential-stale" }],
    ];
    for (const [name, changes] of cases) {
      assert.notEqual(digestWith(input, changes), input.bindingDigest, name);
    }
    for (const name of Object.keys(input.limits) as (keyof typeof input.limits)[]) {
      assert.notEqual(digestWith(input, { limits: { ...input.limits, [name]: input.limits[name] + 1 } }), input.bindingDigest, name);
    }
  });

  for (const scenario of [
    { name: "another operation", change: (input: HttpEgressFinalAuthorization) => ({ operationId: `${input.operationId}-stale` }) },
    { name: "another request", change: (input: HttpEgressFinalAuthorization) => ({ requestId: `${input.requestId}-stale` }) },
    { name: "an extra resolved address", change: (input: HttpEgressFinalAuthorization) => ({ resolvedAddresses: [...input.resolvedAddresses, "93.184.216.35"] }) },
    { name: "a different byte limit", change: (input: HttpEgressFinalAuthorization) => ({ limits: { ...input.limits, maxOutputBytes: input.limits.maxOutputBytes + 1 } }) },
  ] as const) {
    test(`rejects an allow decision bound to ${scenario.name} without releasing credential bytes`, async () => {
      const fixture = createEgressFixture({ final: input => decisionFor(input, digestWith(input, scenario.change(input))) });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "final_denied");
      assert.equal(receipt.upstreamRequestBytes, 0);
      assert.equal(fixture.observations.dispatches, 0);
      assert.doesNotMatch(JSON.stringify(fixture.observations.dispatchedRequests), new RegExp(SECRET_MARKER));
    });
  }

  for (const [name, bindingAtFirstByte] of [
    ["peer address", { peerAddress: "93.184.216.35" }],
    ["peer port", { peerPort: 8443 }],
    ["TLS protocol", { tlsProtocol: "TLSv1.2" }],
    ["SNI", { sni: "other.example" }],
    ["certificate", { certificateDigest: "certificate-stale" }],
    ["pin", { pinDigest: "pin-stale" }],
    ["ALPN", { alpn: "h2" }],
  ] as const) {
    test(`rejects ${name} transport drift at the final-byte handoff`, async () => {
      const fixture = createEgressFixture({ bindingAtFirstByte: bindingAtFirstByte as never });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "transport_binding_drift");
      assert.equal(receipt.firstByteState, "not_sent");
      assert.equal(fixture.observations.dispatches, 0);
    });
  }

  test("normalizes address-set order while rejecting duplicates and 6to4", async () => {
    const left = createEgressFixture({ addresses: ["93.184.216.35", "93.184.216.34"] });
    const right = createEgressFixture({ addresses: ["93.184.216.34", "93.184.216.35"] });
    await createStrictHttpEgressBroker(left.ports).execute(left.operation);
    await createStrictHttpEgressBroker(right.ports).execute(right.operation);
    assert.deepEqual(left.observations.finalAuthorizationInputs[0].resolvedAddresses,
      right.observations.finalAuthorizationInputs[0].resolvedAddresses);
    assert.equal(left.observations.finalAuthorizationInputs[0].bindingDigest,
      right.observations.finalAuthorizationInputs[0].bindingDigest);

    for (const addresses of [
      ["93.184.216.34", "93.184.216.34"],
      ["2606:2800:0220:0001:0248:1893:25c8:1946", "2606:2800:220:1:248:1893:25c8:1946"],
      ["2002:7f00:1::"],
    ]) {
      const fixture = createEgressFixture({ addresses, selectedAddress: addresses[0] });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "resolution_denied");
      assert.equal(fixture.observations.opens, 0);
    }
  });

  test("snapshots request identity and effective limits before asynchronous authorization", async () => {
    const sourceLimits = { ...createEgressFixture().operation.limits };
    const sourceRequest = { ...createEgressFixture().operation.expectedRequest };
    const fixture = createEgressFixture({ final: input => {
      sourceLimits.maxOutputBytes += 1;
      sourceRequest.requestId = "mutated-request";
      return decisionFor(input, input.bindingDigest);
    } });
    const operation = { ...fixture.operation, limits: sourceLimits, expectedRequest: sourceRequest };
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(operation);
    assert.equal(receipt.outcome, "completed");
    const input = fixture.observations.finalAuthorizationInputs[0];
    assert.equal(input.requestId, "request-egress-1");
    assert.equal(input.limits.maxOutputBytes, 4_096);
    assert.equal(Object.isFrozen(input.limits), true);
  });
});
