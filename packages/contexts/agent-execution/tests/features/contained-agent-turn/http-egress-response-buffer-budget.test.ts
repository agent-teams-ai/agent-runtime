import assert from "node:assert/strict";
import { test } from "node:test";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { bytes, createEgressFixture } from "./http-egress-test-fixture.ts";

const head = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nX-Fill: abcdef\r\n\r\n";

for (const split of [1, 20, head.length - 1]) {
  test(`fragmented response head split at ${split} enforces aggregate buffer cap`, async () => {
    const fixture = createEgressFixture({ response: [head.slice(0, split), head.slice(split)] });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({ ...fixture.operation,
      limits: { ...fixture.operation.limits, maxBufferedBytes: head.length - 1 },
    });
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(receipt.anomalyCode, "output_oversized");
    assert.equal(receipt.upstreamResponseBytes, bytes(head).byteLength);
    assert.equal(receipt.outboundResponseBytes, 0);
    assert.equal(fixture.observations.outboundWrites.length, 0);
    assert.equal(fixture.observations.dispatches, 1);
    assert.equal(fixture.observations.closes, 1);
    assert.equal(receipt.upstreamClosure, "closed");
    assert.equal(receipt.inboundClosure, "closed");
    assert.equal(fixture.ports.guard.snapshot().state, "closed");
    assert.deepEqual(fixture.observations.receipts, [receipt]);
  });
}

test("an unterminated fragmented header is bounded before pulling another chunk", async () => {
  let pulls = 0;
  async function* response(): AsyncIterable<Uint8Array> {
    for (const part of ["HTTP/1.1 200 OK\r\nX-Fill: ", "a".repeat(30), "b".repeat(30), "\r\nContent-Length: 0\r\n\r\n"]) {
      pulls += 1;
      yield bytes(part);
    }
  }
  const fixture = createEgressFixture({ responseSource: response() });
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({ ...fixture.operation,
    limits: { ...fixture.operation.limits, maxBufferedBytes: 64 },
  });
  assert.equal(receipt.anomalyCode, "output_oversized");
  assert.equal(pulls, 3);
  assert.equal(receipt.upstreamResponseBytes, bytes("HTTP/1.1 200 OK\r\nX-Fill: ").byteLength + 60);
  assert.equal(fixture.observations.outboundWrites.length, 0);
});

test("a fragmented response exactly at the aggregate cap completes", async () => {
  const fixture = createEgressFixture({ response: [...head].map(char => bytes(char)) });
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({ ...fixture.operation,
    limits: { ...fixture.operation.limits, maxBufferedBytes: head.length },
  });
  assert.equal(receipt.outcome, "completed");
  assert.equal(receipt.upstreamResponseBytes, bytes(head).byteLength);
  assert.equal(fixture.ports.guard.snapshot().state, "available");
});

test("a streaming response can exceed the buffer cap over time after consumed bytes are released", async () => {
  const parts = ["HTTP/1.1 200 OK\r\nContent-Length: 180\r\n\r\n", "x".repeat(60), "y".repeat(60), "z".repeat(60)];
  const fixture = createEgressFixture({ response: parts });
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({ ...fixture.operation,
    limits: { ...fixture.operation.limits, maxBufferedBytes: 64 },
  });
  assert.equal(receipt.outcome, "completed");
  assert.equal(receipt.upstreamResponseBytes, bytes(parts.join("")).byteLength);
  assert.equal(fixture.observations.outboundWrites.length, 4);
  assert.equal(fixture.ports.guard.snapshot().state, "available");
});
