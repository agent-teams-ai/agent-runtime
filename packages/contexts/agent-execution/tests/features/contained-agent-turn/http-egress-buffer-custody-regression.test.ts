import assert from "node:assert/strict";
import { test } from "node:test";
import type { HttpEgressTransportBinding } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { bytes, createEgressFixture } from "./http-egress-test-fixture.ts";

const allZero = (value: Uint8Array): boolean => value.every(byte => byte === 0);

test("a first evidence digest failure remains managed by inbound close", async () => {
  const fixture = createEgressFixture();
  let calls = 0;
  const ports = Object.freeze({ ...fixture.ports, evidence: Object.freeze({
    ...fixture.ports.evidence,
    digest: (parts: readonly Uint8Array[]) => {
      calls += 1;
      if (calls === 1) {throw new Error("synthetic first digest failure");}
      return fixture.ports.evidence.digest(parts);
    },
  }) });
  const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
  assert.notEqual(receipt.outcome, "completed");
  assert.equal(receipt.requestDigest, "");
  assert.equal(receipt.inboundClosure, "closed");
  assert.equal(fixture.observations.order.includes("inbound-close"), true);
  assert.equal(fixture.observations.opens, 0);
});

test("request parsing never mutates caller chunks and broker clears its adopted body copy", async () => {
  const wire = bytes("POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 2\r\n\r\n{}");
  const original = wire.slice();
  const fixture = createEgressFixture({ request: [wire], final: "timeout" });
  let adoptedBody: Uint8Array | undefined;
  let calls = 0;
  const ports = Object.freeze({ ...fixture.ports, evidence: Object.freeze({
    ...fixture.ports.evidence,
    digest: (parts: readonly Uint8Array[]) => {
      calls += 1;
      if (calls === 2) {adoptedBody = parts.at(-1);}
      return fixture.ports.evidence.digest(parts);
    },
  }) });
  await createStrictHttpEgressBroker(ports).execute(fixture.operation);
  assert.deepEqual(wire, original);
  assert.ok(adoptedBody !== undefined && allZero(adoptedBody));
});

for (const failure of ["binding", "digest", "clock", "authorization"] as const) {
  test(`${failure} failure after credential rendering clears every retained credential buffer`, async () => {
    const fixture = createEgressFixture();
    const authorization = bytes(`Bearer retained-${failure}-secret`);
    let digestCalls = 0;
    let clockFailureInjected = false;
    const binding = fixture.ports.transport.beginOpen;
    const ports = {
      ...fixture.ports,
      credentialCustody: Object.freeze({renderAuthorization: async () => {
        fixture.observations.renders += 1;
        return authorization;
      }}),
      ...(failure === "authorization" ? { finalAuthorization: Object.freeze({
        authorize: async () => {throw new Error("synthetic authorization failure");},
      }) } : {}),
      ...(failure === "digest" ? { evidence: Object.freeze({
        ...fixture.ports.evidence,
        digest: (parts: readonly Uint8Array[]) => {
          digestCalls += 1;
          if (digestCalls === 3) {throw new Error("synthetic binding digest failure");}
          return fixture.ports.evidence.digest(parts);
        },
      }) } : {}),
      ...(failure === "clock" ? { clock: Object.freeze({
        ...fixture.ports.clock,
        now: () => {
          if (fixture.observations.renders > 0) {
            clockFailureInjected = true;
            throw new Error("synthetic post-render clock failure");
          }
          return 0;
        },
      }) } : {}),
      ...(failure === "binding" ? { transport: Object.freeze({
        beginOpen: (input: Parameters<typeof binding>[0]) => {
          const attempt = binding(input);
          return Object.freeze({ ...attempt, ready: async () => {
            const session = await attempt.ready();
            const malformed = { ...session.binding };
            Object.defineProperty(malformed, "sniDigest", {get: () => "must-not-run"});
            let reads = 0;
            return Object.freeze({
              get binding(): HttpEgressTransportBinding {
                reads += 1;
                return reads === 1 ? session.binding : malformed as HttpEgressTransportBinding;
              },
              dispatch: session.dispatch,
            });
          } });
        },
      }) } : {}),
    };
    const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
    assert.notEqual(receipt.outcome, "completed");
    assert.equal(allZero(authorization), true);
    assert.equal(fixture.observations.dispatches, 0);
    if (failure === "clock") {assert.equal(clockFailureInjected, true);}
  });
}

test("a parser failure clears broker copies without mutating the supplied wire", async () => {
  const wire = bytes("POST /invoke HTTP/1.0\r\nHost: broker.invalid\r\nContent-Length: 0\r\n\r\n");
  const original = wire.slice();
  const fixture = createEgressFixture({request: [wire]});
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
  assert.equal(receipt.anomalyCode, "inbound_malformed");
  assert.deepEqual(wire, original);
  assert.equal(fixture.observations.opens, 0);
});

test("one-shot dispatch sealing clears a transport-retained request reference", async () => {
  const fixture = createEgressFixture();
  let retained: Uint8Array | undefined;
  const transport = Object.freeze({beginOpen: () => Object.freeze({
    ready: async () => Object.freeze({
      binding: Object.freeze({peerAddress: "93.184.216.34", peerPort: 443, tlsProtocol: "TLSv1.3" as const,
        sni: "provider.example", sniDigest: "sni-digest", certificateDigest: "certificate-digest",
        pinDigest: "pin-digest", alpn: "http/1.1" as const}),
      dispatch: async (consume: () => Uint8Array | undefined) => {
        retained = consume();
        return Object.freeze({status: "failed" as const, acceptedRequestBytes: "unknown" as const,
          acknowledgement: "lost" as const});
      },
    }),
    close: async () => Object.freeze({state: "closed" as const, receiptDigest: "closed"}),
  })});
  await createStrictHttpEgressBroker({...fixture.ports, transport}).execute(fixture.operation);
  assert.ok(retained !== undefined && allZero(retained));
});
