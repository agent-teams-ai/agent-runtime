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
});
