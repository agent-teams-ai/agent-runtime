import assert from "node:assert/strict";
import test from "node:test";
import type {HostHttpGrant, HostHttpMaterializationReceipt, HostHttpProvisionalDecision,
  HttpEgressBrokerPorts} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import {dispatchGrantIsCurrent, retainHttpEgressClock, verifiedProvisional} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-runtime-security-v2.js";
import {createStrictHttpEgressBroker} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import {createEgressFixture} from "./http-egress-test-fixture.ts";

type SamplingCase = Readonly<{
  name: string; times: readonly [number, number, number, number?]; accepted?: boolean;
  authorityId?: string; epoch?: string; status?: "current" | "revoked" | "unknown";
  finalAuthorityId?: string; finalEpoch?: string; finalStatus?: "current" | "revoked" | "unknown";
  notBefore?: number; deadline?: number;
}>;

// Capture real fixture decisions and bindings through the existing synthetic
// broker. Only the injected time observations vary at the V2 verification seam.
const verificationFixture = async () => {
  let decision: HostHttpProvisionalDecision | undefined; let grant: HostHttpGrant | undefined;
  let receipt: HostHttpMaterializationReceipt | undefined;
  const f = createEgressFixture({mutateProvisional: value => {decision = value; return value;},
    mutateGrant: value => {grant = value; return value;}});
  const ports = {...f.ports, providerAccess: {...f.ports.providerAccess, async authorize(input) {
    const result = await f.ports.providerAccess.authorize(input);
    if (result.kind === "authorized") {receipt = result.receipt;} return result;
  }}} satisfies HttpEgressBrokerPorts;
  assert.equal((await createStrictHttpEgressBroker(ports).execute(f.operation)).outcome, "completed");
  assert.ok(decision); assert.ok(grant); assert.ok(receipt);
  assert.ok(ports.guard.acquire());
  return {ports, decision, grant, receipt};
};

for (const boundary of ["provisional", "dispatch"] as const) {
  test(`${boundary} accepts advancing same-domain samples only within their fresh bracket`, async t => {
    const f = await verificationFixture();
    const cases: readonly SamplingCase[] = [
      {name: "equal", times: [3, 3, 3], accepted: true},
      {name: "advancing", times: [3, 4, 5], accepted: true},
      {name: "lower endpoint", times: [3, 3, 5], accepted: true},
      {name: "upper endpoint", times: [3, 5, 5], accepted: true},
      {name: "final cut advances", times: [3, 4, 5, 6], accepted: true},
      {name: "final cut regresses", times: [3, 4, 5, 4]},
      {name: "final authority changes", times: [3, 4, 5], finalAuthorityId: "foreign"},
      {name: "final epoch changes", times: [3, 4, 5], finalEpoch: "foreign"},
      {name: "final cut revoked", times: [3, 4, 5], finalStatus: "revoked"},
      {name: "final cut unknown", times: [3, 4, 5], finalStatus: "unknown"},
      {name: "stale cut", times: [4, 3, 5]},
      {name: "future cut", times: [3, 5, 4]},
      {name: "regressing clock", times: [5, 4, 3]},
      {name: "foreign authority", times: [3, 4, 5], authorityId: "foreign"},
      {name: "foreign epoch", times: [3, 4, 5], epoch: "foreign"},
      {name: "revoked", times: [3, 4, 5], status: "revoked"},
      {name: "unknown", times: [3, 4, 5], status: "unknown"},
      {name: "before signed not-before", times: [0, 1, 2], notBefore: 3},
      {name: "latest reaches signed not-before", times: [0, 1, 2], notBefore: 2, accepted: true},
      {name: "latest reaches signed expiry", times: [898, 899, 900]},
      {name: "final cut reaches signed expiry", times: [897, 898, 899, 900]},
      {name: "final cut reaches signed not-before", times: [3, 4, 5, 6], notBefore: 6, accepted: true},
      {name: "final cut precedes signed not-before", times: [3, 4, 5, 6], notBefore: 7},
      ...(boundary === "dispatch" ? [
        {name: "latest reaches dispatch deadline", times: [3, 4, 5] as const, deadline: 5},
        {name: "final cut reaches dispatch deadline", times: [3, 4, 5, 6] as const, deadline: 6},
      ] : []),
      ...[-1, -0, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].flatMap(invalid =>
        [0, 1, 2, 3].map(index => ({name: `invalid ${Object.is(invalid, -0) ? "-0" : invalid} at ${index}`,
          times: [index === 0 ? invalid : 3, index === 1 ? invalid : 3,
            index === 2 ? invalid : 3, index === 3 ? invalid : 3] as const}))),
    ];
    for (const scenario of cases) {
      await t.test(scenario.name, () => {
        let sample = 0; let cuts = 0; const order: string[] = [];
        const ports: HttpEgressBrokerPorts = {...f.ports,
          clock: retainHttpEgressClock({...f.ports.clock, now() {
            order.push("clock"); return scenario.times[sample++ === 0 ? 0 : 2]!;
          }}), localAuthorityCut: {read() {
            order.push("cut"); const final = cuts++ > 0;
            return {status: (final ? scenario.finalStatus : undefined) ?? scenario.status ?? "current",
              authorityId: (final ? scenario.finalAuthorityId : undefined) ?? scenario.authorityId ?? "clock-authority",
              epoch: (final ? scenario.finalEpoch : undefined) ?? scenario.epoch ?? "epoch-1",
              controlTime: final ? scenario.times[3] ?? scenario.times[2] : scenario.times[1]};
          }}};
        const notBefore = scenario.notBefore ?? 0;
        const decision = {...f.decision, time: {...f.decision.time, controlTime: notBefore}};
        const grant = {...f.grant, payload: {...f.grant.payload,
          time: {...f.grant.payload.time, authorizedAtControlTime: notBefore}}};
        const result = boundary === "provisional" ? verifiedProvisional({decision, ports,
          verifier: ports.verifier, expectedKey: ports.verifier.signingKey,
          authorizationRequestId: decision.authorizationRequestId, request: decision.request, receipt: f.receipt})
          : dispatchGrantIsCurrent(ports, grant, scenario.deadline ?? 1000);
        assert.equal(result, scenario.accepted ?? false);
        assert.deepEqual(order, ["clock", "cut", "clock", "cut"]);
      });
    }
  });
}

for (const boundary of ["provisional", "dispatch"] as const) {
  for (const closeAt of ["closing clock", "final cut"] as const) {
    test(`${boundary} checks the final guard after cancellation at ${closeAt}`, async () => {
      const f = await verificationFixture(); let clocks = 0; let cuts = 0;
      const ports: HttpEgressBrokerPorts = {...f.ports, clock: {...f.ports.clock, now() {
        if (++clocks === 2 && closeAt === "closing clock") {f.ports.guard.close();}
        return 0;
      }}, localAuthorityCut: {read() {
        if (++cuts === 2 && closeAt === "final cut") {f.ports.guard.close();}
        return {status: "current", authorityId: "clock-authority", epoch: "epoch-1", controlTime: 0};
      }}};
      const result = boundary === "provisional" ? verifiedProvisional({decision: f.decision, ports,
        verifier: ports.verifier, expectedKey: ports.verifier.signingKey,
        authorizationRequestId: f.decision.authorizationRequestId, request: f.decision.request, receipt: f.receipt})
        : dispatchGrantIsCurrent(ports, f.grant);
      assert.equal(clocks, 2); assert.equal(cuts, 2);
      assert.equal(result, false); assert.equal(ports.guard.snapshot().state, "closed");
    });
  }
}
