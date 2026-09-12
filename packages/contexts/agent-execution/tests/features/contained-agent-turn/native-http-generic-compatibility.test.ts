import assert from "node:assert/strict";
import { test } from "node:test";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { createEgressFixture } from "./http-egress-test-fixture.ts";

const request = (discarded: string): string =>
  `POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Type: application/json\r\n${discarded}Content-Length: 2\r\n\r\n{}`;

for (const [label, discarded] of [
  ["large discarded value", `Cookie: ${"a".repeat(16_385)}\r\n`],
  ["long discarded name", `${"x".repeat(129)}: discarded\r\n`],
  ["many discarded fields", "X-Ignored: a\r\n".repeat(1_025)],
] as const) {
  test(`generic route preserves configured ingress budget: ${label}`, async () => {
    const fixture = createEgressFixture({request: [request(discarded)]});
    const operation = {...fixture.operation, limits: {...fixture.operation.limits, maxInboundHeaderBytes: 32_768}};
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(operation);
    assert.equal(receipt.outcome, "completed");
    assert.equal(fixture.observations.dispatches, 1);
    const control = createEgressFixture();
    assert.equal((await createStrictHttpEgressBroker(control.ports).execute(control.operation)).outcome, "completed");
    assert.deepEqual(fixture.observations.dispatchedRequests, control.observations.dispatchedRequests);
    assert.equal(receipt.inboundRequestBytes, Buffer.byteLength(request(discarded)));
  });
}

test("generic discarded fields still obey the strict parser's total ingress budget", async () => {
  const fixture = createEgressFixture({request: [request(`Cookie: ${"a".repeat(16_385)}\r\n`)]});
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
  assert.equal(receipt.outcome, "rejected");
  assert.equal(receipt.firstByteState, "not_sent");
  assert.equal(fixture.observations.renders, 0);
  assert.equal(fixture.observations.dispatches, 0);
});
