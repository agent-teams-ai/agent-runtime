import assert from "node:assert/strict";
import { test } from "node:test";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { bytes, createEgressFixture } from "./http-egress-test-fixture.ts";

test("broker preserves rejected inbound byte evidence before any external request", async () => {
  const requests = [
    "POST /invoke HTTP/1.0\r\nHost: broker.invalid\r\nContent-Length: 2\r\n\r\n{}",
    "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 2\r\n\r\nx",
    "x".repeat(3_073),
  ];
  for (const request of requests) {
    const fixture = createEgressFixture({ request: [request] });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "rejected");
    assert.equal(receipt.inboundRequestBytes, bytes(request).byteLength);
    assert.equal(receipt.firstByteState, "not_sent");
    assert.equal(fixture.observations.opens, 0);
    assert.equal(fixture.observations.dispatches, 0);
    assert.equal(fixture.observations.renders, 0);
  }
});
