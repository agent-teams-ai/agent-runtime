import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpDispatchBoundary } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-dispatch-boundary.js";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { bytes, chunks, createEgressFixture, defaultRoute } from "./http-egress-test-fixture.ts";

test("HTTP byte handoff validates at consumption and is available only once", () => {
  let current = false;
  const denied = createHttpDispatchBoundary(bytes("secret"), () => current);
  assert.equal(denied.consume(), undefined);
  current = true;
  assert.equal(denied.consume(), undefined);
  assert.equal(denied.wasConsumed(), false);
  const source = bytes("secret");
  const allowed = createHttpDispatchBoundary(source, () => current);
  assert.equal(allowed.consume(), source);
  assert.equal(allowed.consume(), undefined);
  allowed.seal();
  assert.ok(source.every(byte => byte === 0));
  assert.equal(allowed.consume(), undefined);
});

test("late or throwing validation never reveals request bytes", () => {
  const late = createHttpDispatchBoundary(bytes("secret"), () => true);
  late.seal();
  assert.equal(late.consume(), undefined);
  const throwing = createHttpDispatchBoundary(bytes("secret"), () => { throw new Error("synthetic authority error"); });
  assert.equal(throwing.consume(), undefined);
  assert.equal(throwing.wasConsumed(), false);
});

for (const change of [
  { status: "revoked" as const }, { policyGeneration: "new" }, { keyGeneration: "new" },
  { routeGeneration: "new" }, { credentialGeneration: "new" }, { materializationReceiptDigest: "new" },
]) {
  test("authority changes after preparation deny byte handoff without retry", async () => {
    const fixture = createEgressFixture({ generationAtFirstByte: {
      status: "current", policyGeneration: defaultRoute.policyGeneration,
      keyGeneration: defaultRoute.keyGeneration, routeGeneration: defaultRoute.routeGeneration,
      credentialGeneration: defaultRoute.credentialGeneration,
      materializationReceiptDigest: defaultRoute.materializationReceiptDigest, ...change,
    } });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "denied");
    assert.equal(receipt.anomalyCode, "provider_generation_drift");
    assert.equal(receipt.firstByteState, "not_sent");
    assert.equal(fixture.observations.opens, 1);
    assert.equal(fixture.observations.dispatches, 0);
    assert.equal(fixture.observations.order.includes("final"), true);
  });
}

test("expiry after the async preparation does not survive a queued dispatch", async () => {
  const fixture = createEgressFixture();
  let now = 0;
  const ports = { ...fixture.ports, clock: { ...fixture.ports.clock, now: () => now }, transport: {
    beginOpen: (input: Parameters<typeof fixture.ports.transport.beginOpen>[0]) => {
      const attempt = fixture.ports.transport.beginOpen(input);
      return { ...attempt, ready: async () => {
        const session = await attempt.ready();
        return { ...session, dispatch: async (consume: () => Uint8Array | undefined) => {
          await Promise.resolve();
          now = 901;
          return await session.dispatch(consume);
        } };
      } };
    },
  } };
  const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
  assert.equal(receipt.outcome, "denied");
  assert.equal(receipt.anomalyCode, "final_denied");
  assert.equal(fixture.observations.dispatches, 0);
});

test("dispatch cannot retain the callback after a failed attempt while closure is awaiting", async () => {
  const fixture = createEgressFixture();
  let retained: (() => Uint8Array | undefined) | undefined;
  let lateValue: Uint8Array | undefined;
  const ports = { ...fixture.ports, transport: { beginOpen: (input: Parameters<typeof fixture.ports.transport.beginOpen>[0]) => {
    const attempt = fixture.ports.transport.beginOpen(input);
    return { ...attempt,
      ready: async () => {
        const session = await attempt.ready();
        return { ...session,
          dispatch: async (consume: () => Uint8Array | undefined): Promise<never> => {
            retained = consume;
            throw new Error("synthetic dispatch failure before consuming request");
          },
        };
      },
      close: async () => {
        await Promise.resolve();
        lateValue = retained?.();
        return await attempt.close();
      },
    };
  } } };
  const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
  assert.equal(receipt.firstByteState, "not_sent");
  assert.equal(lateValue, undefined);
  assert.equal(retained?.(), undefined);
  assert.equal(fixture.observations.dispatches, 0);
});

test("a transport response without consuming authorization cannot claim success", async () => {
  const fixture = createEgressFixture();
  const ports = { ...fixture.ports, transport: { beginOpen: (input: Parameters<typeof fixture.ports.transport.beginOpen>[0]) => {
    const attempt = fixture.ports.transport.beginOpen(input);
    return { ...attempt, ready: async () => {
      const session = await attempt.ready();
      return { ...session, dispatch: async () => ({
        status: "response" as const, acceptedRequestBytes: 20, acknowledgement: "acknowledged" as const,
        response: chunks(["HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"]),
      }) };
    } };
  } } };
  const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
  assert.equal(receipt.outcome, "reconcile_required");
  assert.equal(receipt.firstByteState, "uncertain");
  assert.equal(fixture.observations.outboundWrites.length, 0);
});
