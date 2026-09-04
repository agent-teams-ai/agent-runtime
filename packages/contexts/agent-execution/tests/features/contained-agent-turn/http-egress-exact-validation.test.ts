import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { normalizeHttpEgressResolution } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/public-address-policy.js";
import { createEgressFixture, defaultRoute } from "./http-egress-test-fixture.ts";
import { routeWith } from "./http-egress-exact-validation-test-fixture.ts";

describe("HTTP exact boundary validation", () => {
  test("rejects a sparse resolver array before dial or dispatch", async () => {
    const fixture = createEgressFixture();
    const sparse: string[] = [];
    sparse[0] = "93.184.216.34";
    sparse.length = 2;
    const ports = Object.freeze({
      ...fixture.ports,
      resolver: Object.freeze({
        resolve: async () => Object.freeze({ addresses: sparse, selectedAddress: "93.184.216.34" }),
      }),
    });
    const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
    assert.equal(receipt.anomalyCode, "resolution_denied");
    assert.equal(fixture.observations.opens, 0);
    assert.equal(fixture.observations.dispatches, 0);
  });

  test("rejects array accessors without executing them", () => {
    let getterCalls = 0;
    const addresses: string[] = ["93.184.216.34"];
    Object.defineProperty(addresses, 0, {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "93.184.216.34";
      },
    });
    assert.equal(normalizeHttpEgressResolution(addresses, "93.184.216.34"), undefined);
    assert.equal(getterCalls, 0);
  });

  for (const [name, field, value] of [
    ["empty route receipt", "routeReceiptDigest", ""],
    ["surrogate route receipt", "routeReceiptDigest", "receipt-\ud800"],
    ["oversized materialization receipt", "materializationReceiptDigest", "m".repeat(513)],
    ["surrogate SNI digest", "sniDigest", "sni-\udc00"],
  ] as const) {
    test(`rejects ${name} with zero dispatch`, async () => {
      const fixture = createEgressFixture({ route: routeWith(defaultRoute, field, value) });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.outcome, "denied");
      assert.equal(receipt.firstByteState, "not_sent");
      assert.equal(receipt.upstreamRequestBytes, 0);
      assert.equal(fixture.observations.dispatches, 0);
    });
  }

  test("rejects an oversized route before request hashing, provisional authorization, DNS, or open", async () => {
    const fixture = createEgressFixture({ route: routeWith(defaultRoute, "upstreamPath", `/${"x".repeat(20_000)}`) });
    let digests = 0;
    const ports = Object.freeze({ ...fixture.ports, evidence: Object.freeze({
      ...fixture.ports.evidence,
      digest: (parts: readonly Uint8Array[]) => {digests += 1; return fixture.ports.evidence.digest(parts);},
    }) });
    const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
    assert.equal(receipt.anomalyCode, "provider_access_denied");
    assert.equal(digests, 1, "only the pre-parse unavailable digest is permitted");
    assert.equal(fixture.observations.order.includes("provisional"), false);
    assert.equal(fixture.observations.order.includes("resolve"), false);
    assert.equal(fixture.observations.opens, 0);
    assert.equal(fixture.observations.renders, 0);
  });

  test("rejects route accessors without invoking them", async () => {
    let reads = 0;
    const route = { ...defaultRoute };
    Object.defineProperty(route, "routeReceiptDigest", {get: () => {reads += 1; return "route";}});
    const fixture = createEgressFixture({ route: route as never });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.anomalyCode, "provider_access_denied");
    assert.equal(reads, 0);
    assert.equal(fixture.observations.opens, 0);
  });

  for (const cut of ["asynchronous", "synchronous"] as const) {
    test(`rejects unknown generation fields at the ${cut} generation cut`, async () => {
      const fixture = createEgressFixture();
      const generation = {
        status: "current" as const, policyGeneration: defaultRoute.policyGeneration,
        keyGeneration: defaultRoute.keyGeneration, routeGeneration: defaultRoute.routeGeneration,
        credentialGeneration: defaultRoute.credentialGeneration,
        materializationReceiptDigest: defaultRoute.materializationReceiptDigest,
        unknown: true,
      };
      const ports = Object.freeze({ ...fixture.ports, routeAuthority: Object.freeze({
        ...fixture.ports.routeAuthority,
        ...(cut === "asynchronous" ? {revalidate: async () => generation as never} : {
          revalidateAtFirstByte: () => generation as never,
        }),
      }) });
      const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "provider_generation_drift");
      assert.equal(fixture.observations.dispatches, 0);
      if (cut === "asynchronous") {assert.equal(fixture.observations.renders, 0);}
    });
  }

  test("rejects malformed operation identity before hashing or accepting connection custody", async () => {
    const fixture = createEgressFixture();
    let requestIdReads = 0;
    const expected = { ...fixture.operation.expectedRequest };
    Object.defineProperty(expected, "requestId", {get: () => {requestIdReads += 1; return "request";}});
    await assert.rejects(createStrictHttpEgressBroker(fixture.ports).execute({
      ...fixture.operation, expectedRequest: expected,
    } as never));
    assert.equal(requestIdReads, 0);
    assert.deepEqual(fixture.observations.order, []);

    await assert.rejects(createStrictHttpEgressBroker(fixture.ports).execute({
      ...fixture.operation,
      expectedRequest: { ...fixture.operation.expectedRequest, requestId: "request-\ud800" },
    }));
    assert.deepEqual(fixture.observations.order, []);
  });
});
