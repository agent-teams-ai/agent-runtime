import assert from "node:assert/strict";
import { test } from "node:test";
import type { HttpEgressClock } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { bytes, createEgressFixture, outputText } from "./http-egress-test-fixture.ts";

const fixedHead = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n";
const chunkHead = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
const downstreamHead = "HTTP/1.1 200 Upstream\r\nConnection: close\r\n\r\n";

// The peer never supplies EOF. Only the transport owner can close it.
const persistentSource = (parts: readonly string[]) => {
  let pulls = 0;
  let returns = 0;
  let closed = false;
  const pending = Promise.withResolvers<IteratorResult<Uint8Array>>();
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const part = parts[pulls++];
        return part === undefined ? pending.promise : { done: false, value: bytes(part) };
      },
      return: async () => { returns += 1; return { done: true, value: undefined }; },
    }),
  };
  return { source, get pulls() { return pulls; }, get returns() { return returns; },
    get closed() { return closed; }, close: () => {
      closed = true;
      pending.resolve({ done: true, value: undefined });
    } };
};

const boundedClock: HttpEgressClock = {
  now: () => 0,
  within: async <T>(_deadline: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("synthetic deadline")), 100);
      })]);
    } finally { clearTimeout(timer); }
  },
};

const persistentFixture = (parts: readonly string[], upstreamClosure: "closed" | "unknown" = "closed") => {
  const peer = persistentSource(parts);
  const fixture = createEgressFixture({ responseSource: peer.source, upstreamClosure });
  const ports = { ...fixture.ports, clock: boundedClock, transport: {
    beginOpen: (input: Parameters<typeof fixture.ports.transport.beginOpen>[0]) => {
      const attempt = fixture.ports.transport.beginOpen(input);
      return { ready: attempt.ready, close: async () => {
        peer.close();
        return await attempt.close();
      } };
    },
  } };
  return { peer, fixture, ports };
};

for (const [name, parts, body] of [
  ["Content-Length", [fixedHead + "ok"], "ok"],
  ["fragmented Content-Length", [fixedHead.slice(0, 17), fixedHead.slice(17), "o", "k"], "ok"],
  ["zero Content-Length", ["HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"], ""],
  ["terminal chunk", [chunkHead + "2\r\nok\r\n0\r\n\r\n"], "ok"],
  ["fragmented terminal chunk", [chunkHead, "2\r", "\nok\r", "\n0", "\r", "\n", "\r", "\n"], "ok"],
  ["empty chunked body", [chunkHead, "0\r\n\r\n"], ""],
  ["bodyless status", ["HTTP/1.1 204 No Content\r\n\r\n"], ""],
] as const) {
  test(`${name} completes on a persistent connection before EOF`, async () => {
    const { peer, fixture, ports } = persistentFixture(parts);
    const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.anomalyCode, "none");
    assert.equal(peer.pulls, parts.length);
    assert.equal(peer.returns, 0, "parser must not acquire transport cleanup ownership");
    assert.equal(peer.closed, true);
    assert.equal(fixture.observations.closes, 1);
    assert.equal(receipt.upstreamClosure, "closed");
    assert.equal(receipt.inboundClosure, "closed");
    assert.equal(receipt.upstreamResponseBytes, bytes(parts.join("")).byteLength);
    assert.equal(receipt.outboundResponseBytes, bytes(outputText(fixture)).byteLength);
    assert.equal(receipt.outboundResponseWriteUncertain, false);
    assert.equal(outputText(fixture), downstreamHead.replace("200", name === "bodyless status" ? "204" : "200") + body);
    assert.deepEqual(fixture.observations.order.slice(-3), ["upstream-close", "inbound-close", "record-evidence"]);
    assert.equal(ports.guard.snapshot().state, "available");
  });
}

for (const parts of [[fixedHead + "ok"], [chunkHead + "2\r\nok\r\n0\r\n\r\n"]]) {
  test(`persistent completion still reconciles ambiguous closure: ${parts[0]}`, async () => {
    const { fixture, ports, peer } = persistentFixture(parts, "unknown");
    const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(receipt.anomalyCode, "closure_unproved");
    assert.equal(receipt.upstreamClosure, "unknown");
    assert.equal(peer.pulls, parts.length);
    assert.equal(ports.guard.snapshot().state, "closed");
  });
}

for (const [name, wire, anomaly] of [
  ["short Content-Length", fixedHead + "o", "upstream_stalled"],
  ["missing terminal chunk", chunkHead + "2\r\nok\r\n", "upstream_stalled"],
  ["incomplete terminal delimiter", chunkHead + "0\r\n\r", "upstream_stalled"],
  ["fixed surplus", fixedHead + "okx", "upstream_malformed"],
  ["chunked surplus", chunkHead + "0\r\n\r\nx", "upstream_malformed"],
  ["trailer", chunkHead + "0\r\nX-Trailer: no\r\n\r\n", "upstream_malformed"],
] as const) {
  test(`persistent ${name} cannot settle successfully`, async () => {
    const { fixture, ports, peer } = persistentFixture([wire]);
    const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(receipt.anomalyCode, anomaly);
    assert.equal(receipt.upstreamResponseBytes, bytes(wire).byteLength);
    assert.equal(peer.closed, true);
    assert.equal(peer.returns, 0);
    assert.equal(ports.guard.snapshot().state, "closed");
  });
}

for (const disposition of ["drain", "fail", "cancel"] as const) {
  test(`final body write must ${disposition} before persistent response settlement`, async () => {
    const { fixture, ports, peer } = persistentFixture([fixedHead + "ok"]);
    const entered = Promise.withResolvers<void>();
    const drain = Promise.withResolvers<void>();
    const controller = new AbortController();
    const operation = { ...fixture.operation, signal: controller.signal, connection: {
      ...fixture.operation.connection,
      write: async (chunk: Uint8Array) => {
        if (new TextDecoder().decode(chunk) === "ok") {
          entered.resolve();
          await drain.promise;
        }
        await fixture.operation.connection.write(chunk);
      },
    } };
    let settled = false;
    const result = createStrictHttpEgressBroker(ports).execute(operation).then(receipt => {
      settled = true;
      return receipt;
    });
    await entered.promise;
    assert.equal(settled, false);
    assert.equal(peer.closed, false);
    assert.equal(fixture.observations.receipts.length, 0);
    assert.equal(ports.guard.snapshot().state, "active");
    if (disposition === "cancel") { controller.abort(); }
    if (disposition === "fail") { drain.reject(new Error("synthetic write failure")); }
    else { drain.resolve(); }
    const receipt = await result;
    assert.equal(receipt.outcome, disposition === "drain" ? "completed" : "reconcile_required");
    assert.equal(receipt.anomalyCode, disposition === "drain" ? "none"
      : disposition === "fail" ? "output_backpressure_failed" : "inbound_cancelled");
    assert.equal(receipt.outboundResponseWriteUncertain, disposition === "fail");
    assert.equal(receipt.outboundResponseBytes, bytes(downstreamHead).byteLength + (disposition === "fail" ? 0 : 2));
    assert.equal(peer.closed, true);
    assert.equal(peer.pulls, 1);
  });
}

test("Host Custody waits for transport closure before inbound completion and evidence", async () => {
  const { fixture, ports, peer } = persistentFixture([fixedHead + "ok"]);
  const closing = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const gatedPorts = { ...ports, transport: {
    beginOpen: (input: Parameters<typeof ports.transport.beginOpen>[0]) => {
      const attempt = ports.transport.beginOpen(input);
      return { ready: attempt.ready, close: async () => {
        closing.resolve();
        await closed.promise;
        return await attempt.close();
      } };
    },
  } };
  let settled = false;
  const result = createStrictHttpEgressBroker(gatedPorts).execute(fixture.operation).then(receipt => {
    settled = true;
    return receipt;
  });
  await closing.promise;
  assert.equal(outputText(fixture), downstreamHead + "ok");
  assert.equal(peer.closed, false);
  assert.equal(settled, false);
  assert.equal(fixture.observations.order.includes("inbound-close"), false);
  assert.equal(fixture.observations.receipts.length, 0);
  assert.equal(ports.guard.snapshot().state, "active");
  closed.resolve();
  assert.equal((await result).outcome, "completed");
  assert.equal(peer.closed, true);
  assert.deepEqual(fixture.observations.order.slice(-3), ["upstream-close", "inbound-close", "record-evidence"]);
});

for (const [name, head, body] of [
  ["fixed", fixedHead, "ok"],
  ["chunked", chunkHead, "2\r\nok\r\n0\r\n\r\n"],
] as const) {
  for (const limit of ["exact", "header", "output", "wire", "buffer"] as const) {
    test(`${name} persistent response preserves ${limit} byte limits`, async () => {
      const wire = head + body;
      const { fixture, ports } = persistentFixture([wire]);
      const receipt = await createStrictHttpEgressBroker(ports).execute({ ...fixture.operation, limits: {
        ...fixture.operation.limits,
        maxUpstreamHeaderBytes: bytes(head).byteLength - (limit === "header" ? 1 : 0),
        maxOutputBytes: limit === "output" ? 1 : 2,
        maxUpstreamWireBytes: bytes(wire).byteLength - (limit === "wire" ? 1 : 0),
        maxBufferedBytes: bytes(wire).byteLength - (limit === "buffer" ? 1 : 0),
      } });
      assert.equal(receipt.outcome, limit === "exact" ? "completed" : "reconcile_required");
      assert.equal(receipt.anomalyCode, limit === "exact" ? "none" : "output_oversized");
      assert.equal(receipt.upstreamResponseBytes, bytes(wire).byteLength);
    });
  }
}
