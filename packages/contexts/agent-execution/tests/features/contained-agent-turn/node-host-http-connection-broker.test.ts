import assert from "node:assert/strict";
import { test } from "node:test";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import type { HttpEgressBrokerPorts } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import { createEgressFixture } from "./http-egress-test-fixture.ts";
import { defaults, encode, fixture, SyntheticSocket } from "./node-host-http-connection-fixture.ts";

const raw = encode("POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");

for (const phase of ["same chunk", "pending", "final grant", "after upstream effect", "complete"] as const) {
  test(`existing broker owns disposition with TCP custody: ${phase}`, async () => {
    const socket = new SyntheticSocket();
    let ingress: ReturnType<typeof fixture>;
    const egress = createEgressFixture({ responseSource: {
      async *[Symbol.asyncIterator]() {
        if (phase === "after upstream effect") {ingress.socket.feed(encode("surplus"));}
        yield encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
      },
    } });
    ingress = fixture({ ...defaults, expectedRequest: egress.operation.expectedRequest,
      limits: egress.operation.limits }, socket);
    // A synthetic peer waits for Host FIN; no live ingress authentication is implied.
    socket.on("finish", () => socket.peerEnd());
    const ports: HttpEgressBrokerPorts = { ...egress.ports, clock: ingress.clock,
      runtimeSecurity: { ...egress.ports.runtimeSecurity, authorizeFirstApplicationByte: async input => {
        const grant = await egress.ports.runtimeSecurity.authorizeFirstApplicationByte(input);
        if (phase === "final grant") {ingress.socket.feed(encode("surplus"));}
        return grant;
      } },
    };
    if (phase === "same chunk") {socket.feed(new Uint8Array([...raw, 120]));}
    else {
      socket.feed(raw, phase !== "pending");
      if (phase === "pending") {socket.feed(encode("surplus"), false);}
    }
    const broker = createStrictHttpEgressBroker(ports);
    const operation = { ...egress.operation, connection: ingress.connection, signal: ingress.signal };
    const receipt = await broker.execute(operation);
    if (phase === "complete") {
      assert.equal(receipt.outcome, "completed");
      assert.equal(receipt.firstByteState, "sent");
      assert.equal(receipt.inboundClosure, "closed");
      assert.equal(receipt.inboundRequestBytes, raw.length);
      assert.equal(egress.observations.dispatches, 1);
    } else if (phase === "after upstream effect") {
      assert.equal(receipt.outcome, "reconcile_required");
      assert.notEqual(receipt.firstByteState, "not_sent");
      assert.ok(receipt.upstreamRequestBytes > 0);
      assert.equal(receipt.inboundClosure, "unknown");
      assert.equal(egress.observations.dispatches, 1);
      assert.equal(egress.observations.closes, 1);
    } else {
      assert.equal(receipt.firstByteState, "not_sent");
      assert.equal(receipt.upstreamRequestBytes, 0);
      assert.equal(egress.observations.dispatches, 0);
      assert.equal(ingress.signal.aborted, true);
      if (phase !== "final grant") {
        assert.equal(egress.observations.renders, 0);
        assert.equal(egress.observations.finalAuthorizationInputs.length, 0);
      }
    }
    // Reusing this exact TCP connection cannot cause another effect.
    const dispatches = egress.observations.dispatches;
    await broker.execute(operation);
    assert.equal(egress.observations.dispatches, dispatches);
    assert.equal(ingress.clock.pending, 0);
  });
}
