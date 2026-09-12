import assert from "node:assert/strict";
import {describe, test} from "node:test";
import type {HostHttpGrant, HostHttpProvisionalDecision} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import {createStrictHttpEgressBroker} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import {snapshotHttpClosureDecision} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-receipt-validation.js";
import {createEgressFixture, defaultRoute, denyDecision} from "./http-egress-test-fixture.ts";

describe("HTTP signed authority ingress", () => {
  test("rejects unknown string and symbol keys on closed signed proofs", async () => {
    for (const mutateProvisional of [
      (value: HostHttpProvisionalDecision) => Object.freeze({...value, unknown: true}) as HostHttpProvisionalDecision,
      (value: HostHttpProvisionalDecision) => Object.freeze({...value, [Symbol("unknown")]: true}) as HostHttpProvisionalDecision,
    ]) {
      const fixture = createEgressFixture({mutateProvisional});
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "provisional_denied"); assert.equal(fixture.observations.opens, 0);
    }
    for (const mutateGrant of [
      (value: HostHttpGrant) => Object.freeze({...value, unknown: true}) as HostHttpGrant,
      (value: HostHttpGrant) => Object.freeze({...value, [Symbol("unknown")]: true}) as HostHttpGrant,
    ]) {
      const fixture = createEgressFixture({mutateGrant});
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "final_denied"); assert.equal(fixture.observations.dispatches, 0);
    }
  });

  for (const [name, decisionDigest] of [["empty", ""], ["oversized", "r".repeat(513)],
    ["unpaired surrogate", "receipt-\ud800"]] as const) {
    test(`rejects a ${name} provisional decision digest before resolution`, async () => {
      const fixture = createEgressFixture({mutateProvisional: value => Object.freeze({...value, decisionDigest})});
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "provisional_denied");
      assert.equal(receipt.provisionalAuthorizationReceiptDigest, "");
      assert.equal(fixture.observations.opens, 0);
    });

    test(`rejects a ${name} final authorization digest without releasing bytes`, async () => {
      const fixture = createEgressFixture({mutateGrant: value => Object.freeze({...value, finalAuthorizationDigest: decisionDigest})});
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "final_denied");
      assert.equal(receipt.finalAuthorizationReceiptDigest, "");
      assert.equal(receipt.firstByteState, "not_sent");
      assert.equal(fixture.observations.dispatches, 0);
    });
  }

  for (const stage of ["provisional", "final"] as const) {
    test(`rejects an accessor-backed ${stage} proof without reading the accessor`, async () => {
      let reads = 0;
      const options = stage === "provisional" ? {mutateProvisional: (value: HostHttpProvisionalDecision) => {
        const changed = {...value}; Object.defineProperty(changed, "decisionDigest", {get: () => {reads += 1; return "getter";}});
        return changed as HostHttpProvisionalDecision;
      }} : {mutateGrant: (value: HostHttpGrant) => {const changed = {...value};
        Object.defineProperty(changed, "finalAuthorizationDigest", {get: () => {reads += 1; return "getter";}});
        return changed as HostHttpGrant;}};
      const fixture = createEgressFixture(options);
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, stage === "provisional" ? "provisional_denied" : "final_denied");
      assert.equal(reads, 0); assert.equal(fixture.observations.dispatches, 0);
    });

    test(`rejects a Proxy ${stage} proof before reading authority fields`, async () => {
      let reads = 0;
      const options = stage === "provisional" ? {mutateProvisional: (value: HostHttpProvisionalDecision) => new Proxy(value, {
        get: (target, key, receiver) => {if (key === "decisionDigest") {reads += 1;} return Reflect.get(target, key, receiver);},
      })} : {mutateGrant: (value: HostHttpGrant) => new Proxy(value, {get: (target, key, receiver) => {
        if (key === "finalAuthorizationDigest") {reads += 1;} return Reflect.get(target, key, receiver);}})};
      const fixture = createEgressFixture(options);
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, stage === "provisional" ? "provisional_denied" : "final_denied");
      assert.equal(reads, 0); assert.equal(fixture.observations.dispatches, 0);
    });
  }

  test("rejects accessor-backed Provider Access receipts without invoking them", async () => {
    const fixture = createEgressFixture(); let reads = 0;
    const providerAccess = Object.freeze({...fixture.ports.providerAccess, authorize: async (input: Record<string, unknown>) => {
      const receipt = {...input, decision: "authorized", rejectionReason: null};
      Object.defineProperty(receipt, "credentialBindingDigest", {get: () => {reads += 1; return "getter";}});
      return Object.freeze({kind: "authorized" as const, receipt: receipt as never});
    }});
    const receipt = await createStrictHttpEgressBroker({...fixture.ports, providerAccess}).execute(fixture.operation);
    assert.equal(receipt.anomalyCode, "provider_access_denied"); assert.equal(reads, 0);
    assert.equal(fixture.observations.renders, 0);
  });

  test("retains bounded opaque signed decision digests without imposing a hex format", async () => {
    const provisionalDigest = "provisional/id:合法-🙂"; const finalDigest = "final/id:合法-🙂";
    const fixture = createEgressFixture({mutateProvisional: value => Object.freeze({...value,
      decisionDigest: provisionalDigest}), mutateGrant: value => Object.freeze({...value,
      payload: Object.freeze({...value.payload, provisionalDecisionDigest: provisionalDigest}),
      finalAuthorizationDigest: finalDigest, evidence: Object.freeze({...value.evidence,
        decisionDigest: provisionalDigest, finalAuthorizationDigest: finalDigest})})});
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.provisionalAuthorizationReceiptDigest, provisionalDigest);
    assert.equal(receipt.finalAuthorizationReceiptDigest, finalDigest);
  });

  for (const stage of ["provisional", "final"] as const) {
    test(`retains the signed-stage denial while releasing no request bytes at ${stage}`, async () => {
      const denied = denyDecision(defaultRoute, `${stage}-denial`);
      const fixture = createEgressFixture(stage === "provisional" ? {provisional: denied} : {final: denied});
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, stage === "provisional" ? "provisional_denied" : "final_denied");
      assert.equal(receipt.firstByteState, "not_sent"); assert.equal(fixture.observations.dispatches, 0);
    });
  }
});

describe("HTTP closure receipt ingress", () => {
  test("rejects unknown own string and symbol keys on closure receipts", () => {
    assert.equal(snapshotHttpClosureDecision({state: "closed", receiptDigest: "receipt", unknown: true}), undefined);
    assert.equal(snapshotHttpClosureDecision({state: "closed", receiptDigest: "receipt", [Symbol("unknown")]: true}), undefined);
  });

  for (const [name, closure] of [["empty digest", {state: "closed", receiptDigest: ""}],
    ["oversized digest", {state: "closed", receiptDigest: "c".repeat(513)}],
    ["surrogate digest", {state: "closed", receiptDigest: "closure-\udc00"}],
    ["invalid state", {state: "complete", receiptDigest: "closure-receipt"}]] as const) {
    test(`does not establish inbound closure from a ${name}`, async () => {
      const fixture = createEgressFixture();
      const connection = Object.freeze({...fixture.operation.connection, close: async () => Object.freeze(closure) as never});
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({...fixture.operation, connection});
      assert.equal(receipt.outcome, "reconcile_required"); assert.equal(receipt.anomalyCode, "closure_unproved");
      assert.equal(receipt.inboundClosure, "unknown"); assert.equal(receipt.inboundClosureReceiptDigest, "");
    });
  }

  test("does not invoke a closure receipt accessor", async () => {
    let reads = 0; const closure = {state: "closed"};
    Object.defineProperty(closure, "receiptDigest", {get: () => {reads += 1; return "getter";}});
    const fixture = createEgressFixture(); const connection = Object.freeze({...fixture.operation.connection,
      close: async () => closure as never});
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({...fixture.operation, connection});
    assert.equal(receipt.inboundClosure, "unknown"); assert.equal(reads, 0);
  });
});
