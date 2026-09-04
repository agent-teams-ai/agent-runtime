import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import type { HttpEgressTransportBinding } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { bytes, createEgressFixture } from "./http-egress-test-fixture.ts";

const allZero = (value: Uint8Array): boolean => {
  for (let index = 0; index < value.byteLength; index += 1) {
    if (value[index] !== 0) {return false;}
  }
  return true;
};

const overrideByteMethods = (
  value: Uint8Array,
  behavior: "no-op" | "throw",
): Readonly<{ calls: () => number }> => {
  let calls = 0;
  const invoked = (): never | undefined => {
    calls += 1;
    if (behavior === "throw") {throw new Error("synthetic byte override invoked");}
  };
  Object.defineProperties(value, {
    every: { configurable: true, value: () => {invoked(); return true;} },
    includes: { configurable: true, value: () => {invoked(); return false;} },
    fill: { configurable: true, value: () => {invoked(); return value;} },
  });
  return Object.freeze({ calls: () => calls });
};

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
      if (calls === 1) {adoptedBody = parts.at(-1);}
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
      materializer: Object.freeze({render: async () => {
        fixture.observations.renders += 1;
        return [Object.freeze({name: "authorization", valueBytes: authorization})];
      }}),
      ...(failure === "authorization" ? { runtimeSecurity: Object.freeze({...fixture.ports.runtimeSecurity,
        authorizeFirstApplicationByte: async () => {throw new Error("synthetic authorization failure");},
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
            Object.defineProperty(malformed, "observedSni", {get: () => "must-not-run"});
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
  const beginOpen = fixture.ports.transport.beginOpen;
  const transport = Object.freeze({beginOpen: (input: Parameters<typeof beginOpen>[0]) => {
    const attempt = beginOpen(input); return Object.freeze({...attempt,
    ready: async () => {const session = await attempt.ready(); return Object.freeze({...session,
      dispatch: async (consume: () => Uint8Array | undefined) => {
        retained = consume();
        return Object.freeze({status: "failed" as const, acceptedRequestBytes: "unknown" as const,
          acknowledgement: "lost" as const});
      },
    });}});}});
  await createStrictHttpEgressBroker({...fixture.ports, transport}).execute(fixture.operation);
  assert.ok(retained !== undefined && allZero(retained));
});

for (const scenario of [
  { name: "CR in Uint8Array with no-op overrides", authorization: new Uint8Array([66, 101, 97, 114, 101, 114, 13]), behavior: "no-op" },
  { name: "LF in Buffer with throwing overrides", authorization: Buffer.from([66, 101, 97, 114, 101, 114, 10]), behavior: "throw" },
  { name: "NUL in Uint8Array with throwing overrides", authorization: new Uint8Array([66, 101, 97, 114, 101, 114, 0]), behavior: "throw" },
] as const) {
  test(`authorization validation rejects ${scenario.name} before final authorization`, async () => {
    const fixture = createEgressFixture();
    const overrides = overrideByteMethods(scenario.authorization, scenario.behavior);
    const receipt = await createStrictHttpEgressBroker({
      ...fixture.ports,
      materializer: Object.freeze({ render: async () => [Object.freeze({name: "authorization",
        valueBytes: scenario.authorization})] }),
    }).execute(fixture.operation);
    assert.notEqual(receipt.outcome, "completed");
    assert.equal(fixture.observations.order.includes("final"), false);
    assert.equal(fixture.observations.dispatches, 0);
    assert.equal(allZero(scenario.authorization), true);
    assert.equal(overrides.calls(), 0);
    assert.equal(fixture.observations.closes, 0);
    assert.equal(fixture.observations.order.filter(value => value === "inbound-close").length, 1);
    assert.equal(fixture.observations.receipts.length, 1);
  });
}

test("valid Buffer authorization bypasses throwing own methods and its original storage is cleared", async () => {
  const fixture = createEgressFixture({ final: "timeout" });
  const authorization = Buffer.from("Bearer synthetic-valid-marker", "ascii");
  const overrides = overrideByteMethods(authorization, "throw");
  await createStrictHttpEgressBroker({
    ...fixture.ports,
    materializer: Object.freeze({ render: async () => [Object.freeze({name: "authorization",
      valueBytes: authorization})] }),
  }).execute(fixture.operation);
  assert.equal(fixture.observations.order.includes("final"), true);
  assert.equal(allZero(authorization), true);
  assert.equal(overrides.calls(), 0);
  assert.equal(fixture.observations.closes, 1);
  assert.equal(fixture.observations.receipts.length, 1);
});

test("a detached authorization view fails safely before final authorization", async () => {
  const fixture = createEgressFixture();
  const authorization = bytes("Bearer synthetic-detached-marker");
  structuredClone(authorization, { transfer: [authorization.buffer] });
  const receipt = await createStrictHttpEgressBroker({
    ...fixture.ports,
    materializer: Object.freeze({ render: async () => [Object.freeze({name: "authorization",
      valueBytes: authorization})] }),
  }).execute(fixture.operation);
  assert.notEqual(receipt.outcome, "completed");
  assert.equal(fixture.observations.order.includes("final"), false);
  assert.equal(fixture.observations.dispatches, 0);
  assert.equal(fixture.observations.closes, 0);
  assert.equal(fixture.observations.receipts.length, 1);
});

test("throwing own fill on the prepared request cannot interrupt one-time closure and settlement", async () => {
  const fixture = createEgressFixture();
  const beginOpen = fixture.ports.transport.beginOpen;
  let retained: Uint8Array | undefined;
  let overrides: Readonly<{ calls: () => number }> | undefined;
  const transport = Object.freeze({ beginOpen: (input: Parameters<typeof beginOpen>[0]) => {
    const attempt = beginOpen(input);
    return Object.freeze({
      ...attempt,
      ready: async () => {
        const session = await attempt.ready();
        return Object.freeze({
          ...session,
          dispatch: async (consume: () => Uint8Array | undefined) => {
            retained = consume();
            assert.ok(retained !== undefined);
            overrides = overrideByteMethods(retained, "throw");
            throw new Error("synthetic prepared request write failure");
          },
        });
      },
    });
  } });
  const receipt = await createStrictHttpEgressBroker({ ...fixture.ports, transport }).execute(fixture.operation);
  assert.notEqual(receipt.outcome, "completed");
  assert.ok(retained !== undefined && allZero(retained));
  assert.equal(overrides?.calls(), 0);
  assert.equal(fixture.observations.closes, 1);
  assert.equal(fixture.observations.order.filter(value => value === "inbound-close").length, 1);
  assert.equal(fixture.observations.receipts.length, 1);
});

for (const failure of [
  { name: "downstream head", writeCall: 1, behavior: "no-op" },
  { name: "downstream body", writeCall: 2, behavior: "throw" },
] as const) {
  test(`${failure.name} is cleared through own fill overrides after write failure`, async () => {
    const fixture = createEgressFixture({ response: ["HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx"] });
    let writes = 0;
    let retained: Uint8Array | undefined;
    let overrides: Readonly<{ calls: () => number }> | undefined;
    const operation = Object.freeze({ ...fixture.operation, connection: Object.freeze({
      ...fixture.operation.connection,
      write: async (value: Uint8Array) => {
        writes += 1;
        if (writes !== failure.writeCall) {return;}
        retained = value;
        overrides = overrideByteMethods(value, failure.behavior);
        throw new Error("synthetic downstream write failure");
      },
    }) });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(operation);
    assert.equal(receipt.anomalyCode, "output_backpressure_failed");
    assert.ok(retained !== undefined && allZero(retained));
    assert.equal(overrides?.calls(), 0);
    assert.equal(fixture.observations.closes, 1);
    assert.equal(fixture.observations.receipts.length, 1);
  });
}
