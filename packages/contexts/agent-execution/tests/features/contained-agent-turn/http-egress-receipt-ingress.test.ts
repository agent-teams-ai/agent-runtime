import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  HttpEgressAuthorizationDecision,
  HttpEgressFinalAuthorization,
  HttpEgressFinalAuthorizationDecision,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { bytes, createEgressFixture, defaultRoute, denyDecision } from "./http-egress-test-fixture.ts";
import { snapshotHttpAuthorizationDecision, snapshotHttpClosureDecision,
  snapshotHttpFinalAuthorizationDecision } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-receipt-validation.js";

const malformedDecision = (receiptDigest: unknown): HttpEgressAuthorizationDecision => Object.freeze({
  decision: "allow",
  receiptDigest,
  validUntil: 900,
  policyGeneration: defaultRoute.policyGeneration,
  keyGeneration: defaultRoute.keyGeneration,
  routeGeneration: defaultRoute.routeGeneration,
  credentialGeneration: defaultRoute.credentialGeneration,
  materializationReceiptDigest: defaultRoute.materializationReceiptDigest,
}) as HttpEgressAuthorizationDecision;

const malformedReceipts = [
  ["empty", ""],
  ["oversized", "r".repeat(513)],
  ["unpaired surrogate", "receipt-\ud800"],
  ["non-string", 7],
] as const;

describe("HTTP authority receipt ingress", () => {
  test("rejects unknown own string and symbol keys on closed authority receipts", () => {
    const base = malformedDecision("receipt");
    assert.equal(snapshotHttpAuthorizationDecision({ ...base, unknown: true }), undefined);
    assert.equal(snapshotHttpFinalAuthorizationDecision({ ...base, bindingDigest: "binding", unknown: true }), undefined);
    assert.equal(snapshotHttpAuthorizationDecision({ ...base, [Symbol("unknown")]: true }), undefined);
    assert.equal(snapshotHttpAuthorizationDecision({ ...base, validUntil: 1.5 }), undefined);
    assert.equal(snapshotHttpAuthorizationDecision({ ...base, validUntil: Number.MAX_SAFE_INTEGER + 1 }), undefined);
  });
  for (const [name, receiptDigest] of malformedReceipts) {
    test(`rejects a ${name} provisional receipt before resolution or transport`, async () => {
      const fixture = createEgressFixture({ provisional: malformedDecision(receiptDigest) });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "provisional_denied");
      assert.equal(receipt.provisionalAuthorizationReceiptDigest, "");
      assert.equal(fixture.observations.order.includes("resolve"), false);
      assert.equal(fixture.observations.opens, 0);
      assert.equal(fixture.observations.dispatches, 0);
      assert.doesNotMatch(JSON.stringify(receipt), /receipt-\ufffd/u);
    });

    test(`rejects a ${name} final receipt and releases no request bytes`, async () => {
      const authorization = bytes("Bearer receipt-ingress-secret");
      const fixture = createEgressFixture({ final: malformedDecision(receiptDigest) });
      const ports = Object.freeze({
        ...fixture.ports,
        credentialCustody: Object.freeze({renderAuthorization: async () => authorization}),
      });
      const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "final_denied");
      assert.equal(receipt.finalAuthorizationReceiptDigest, "");
      assert.equal(receipt.upstreamRequestBytes, 0);
      assert.equal(receipt.firstByteState, "not_sent");
      assert.equal(fixture.observations.dispatches, 0);
      assert.equal(authorization.every(value => value === 0), true);
    });
  }

  for (const stage of ["provisional", "final"] as const) {
    test(`rejects an accessor-backed ${stage} decision without reading the receipt`, async () => {
      let getterCalls = 0;
      const decision = { ...malformedDecision("unused") };
      Object.defineProperty(decision, "receiptDigest", {get: () => {
        getterCalls += 1;
        return "getter-controlled-receipt";
      }});
      const fixture = createEgressFixture(stage === "provisional"
        ? { provisional: decision as HttpEgressAuthorizationDecision } : {});
      const ports = stage === "final" ? Object.freeze({
        ...fixture.ports,
        finalAuthorization: Object.freeze({authorize: async () => decision as HttpEgressFinalAuthorizationDecision}),
      }) : fixture.ports;
      const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, stage === "provisional" ? "provisional_denied" : "final_denied");
      assert.equal(getterCalls, 0);
      assert.equal(receipt[`${stage}AuthorizationReceiptDigest`], "");
      assert.equal(fixture.observations.dispatches, 0);
    });

    test(`rejects a Proxy ${stage} decision before reading authority fields`, async () => {
      let receiptReads = 0;
      const decision = new Proxy(malformedDecision("proxy-controlled-receipt"), {
        get: (target, key, receiver) => {
          if (key === "receiptDigest") {receiptReads += 1;}
          return Reflect.get(target, key, receiver);
        },
      });
      const fixture = createEgressFixture(stage === "provisional" ? { provisional: decision } : {});
      const ports = stage === "final" ? Object.freeze({
        ...fixture.ports,
        finalAuthorization: Object.freeze({authorize: async () => decision as HttpEgressFinalAuthorizationDecision}),
      }) : fixture.ports;
      const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, stage === "provisional" ? "provisional_denied" : "final_denied");
      assert.equal(receiptReads, 0);
      assert.equal(receipt[`${stage}AuthorizationReceiptDigest`], "");
      assert.equal(fixture.observations.dispatches, 0);
    });
  }

  test("retains bounded opaque allow receipts without imposing a hex format", async () => {
    const provisional = Object.freeze({
      ...malformedDecision("provisional-合法-🙂"),
      receiptDigest: "p".repeat(128) + "🙂".repeat(96),
    });
    const fixture = createEgressFixture({
      provisional,
      final: (input: HttpEgressFinalAuthorization): HttpEgressFinalAuthorizationDecision => Object.freeze({
        ...malformedDecision("final-opaque/id:合法"), bindingDigest: input.bindingDigest,
      }),
    });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.provisionalAuthorizationReceiptDigest, provisional.receiptDigest);
    assert.equal(receipt.finalAuthorizationReceiptDigest, "final-opaque/id:合法");
  });

  test("retains valid denial receipts while denying their stages", async () => {
    const provisional = createEgressFixture({ provisional: denyDecision(defaultRoute, "valid-provisional-denial") });
    const provisionalReceipt = await createStrictHttpEgressBroker(provisional.ports).execute(provisional.operation);
    assert.equal(provisionalReceipt.provisionalAuthorizationReceiptDigest, "valid-provisional-denial");
    assert.equal(provisionalReceipt.anomalyCode, "provisional_denied");
    assert.equal(provisional.observations.opens, 0);

    const final = createEgressFixture({ final: denyDecision(defaultRoute, "valid-final-denial") });
    const finalReceipt = await createStrictHttpEgressBroker(final.ports).execute(final.operation);
    assert.equal(finalReceipt.finalAuthorizationReceiptDigest, "valid-final-denial");
    assert.equal(finalReceipt.anomalyCode, "final_denied");
    assert.equal(final.observations.dispatches, 0);
  });
});

describe("HTTP closure receipt ingress", () => {
  test("rejects unknown own string and symbol keys on closed closure receipts", () => {
    assert.equal(snapshotHttpClosureDecision({state: "closed", receiptDigest: "receipt", unknown: true}), undefined);
    assert.equal(snapshotHttpClosureDecision({state: "closed", receiptDigest: "receipt", [Symbol("unknown")]: true}), undefined);
  });
  for (const [name, closure] of [
    ["empty digest", {state: "closed", receiptDigest: ""}],
    ["oversized digest", {state: "closed", receiptDigest: "c".repeat(513)}],
    ["surrogate digest", {state: "closed", receiptDigest: "closure-\udc00"}],
    ["non-string digest", {state: "closed", receiptDigest: 4}],
    ["invalid state", {state: "complete", receiptDigest: "closure-receipt"}],
  ] as const) {
    test(`does not establish inbound closure from a ${name}`, async () => {
      const fixture = createEgressFixture();
      const connection = Object.freeze({
        ...fixture.operation.connection,
        close: async () => Object.freeze(closure) as never,
      });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({
        ...fixture.operation, connection,
      });
      assert.equal(receipt.outcome, "reconcile_required");
      assert.equal(receipt.anomalyCode, "closure_unproved");
      assert.equal(receipt.inboundClosure, "unknown");
      assert.equal(receipt.inboundClosureReceiptDigest, "");
    });
  }

  test("does not invoke a closure receipt accessor", async () => {
    let getterCalls = 0;
    const closure = {state: "closed"};
    Object.defineProperty(closure, "receiptDigest", {get: () => {
      getterCalls += 1;
      return "getter-closure-receipt";
    }});
    const fixture = createEgressFixture();
    const connection = Object.freeze({
      ...fixture.operation.connection,
      close: async () => closure as never,
    });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({...fixture.operation, connection});
    assert.equal(receipt.inboundClosure, "unknown");
    assert.equal(receipt.inboundClosureReceiptDigest, "");
    assert.equal(getterCalls, 0);
  });

  test("malformed upstream closure evidence cannot establish a closed attempt", async () => {
    const fixture = createEgressFixture();
    const transport = Object.freeze({beginOpen: (input: Parameters<typeof fixture.ports.transport.beginOpen>[0]) => {
      const attempt = fixture.ports.transport.beginOpen(input);
      return Object.freeze({
        ready: attempt.ready,
        close: async () => {
          await attempt.close();
          return Object.freeze({state: "closed", receiptDigest: ""}) as never;
        },
      });
    }});
    const receipt = await createStrictHttpEgressBroker({...fixture.ports, transport}).execute(fixture.operation);
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(receipt.anomalyCode, "closure_unproved");
    assert.equal(receipt.upstreamClosure, "unknown");
    assert.equal(receipt.upstreamClosureReceiptDigest, "");
    assert.equal(fixture.observations.closes, 1);
  });
});
