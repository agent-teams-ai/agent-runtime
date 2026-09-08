import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createContainedTurnProviderAccessPort } from "../../../dist/features/contained-agent-turn/composition/provider-access-anti-corruption.js";
import { acceptedAuthorityFixture } from "./support/accepted-authority-fixture.ts";
import {
  containedTurnGrantSettlementRequestId,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-authority.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";

const scope = Object.freeze({ projectId: "project:kernel", tenantId: "tenant:kernel" });
const binding = Object.freeze({
  accessRef: "access:one",
  credentialBindingDigest: "owner-issued-opaque-digest",
  credentialBindingRef: "credential-binding:one",
  credentialGeneration: 7,
  projectId: scope.projectId,
  provider: "codex" as const,
  providerAccountRef: "provider-account:one",
  providerRouteRef: "provider-route:one",
  revision: 11,
  tenantId: scope.tenantId,
});
const evidence = (purpose: "acceptance" | "dispatch") => Object.freeze({
  authorityDigest: `signed-canonical:${purpose}:${binding.credentialBindingDigest}`,
  bindingAuthorityDigest: binding.credentialBindingDigest,
  proofRef: `binding:access:one:revision:11:purpose:${purpose}`,
  purpose,
});
const unusedDispatch = Object.freeze({
  async consumeForDispatch() { return Object.freeze({ kind: "not_found" as const }); },
  async observeDispatchConsumption() { return Object.freeze({ kind: "not_found" as const }); },
  async settleDispatchConsumption() { return Object.freeze({ kind: "not_found" as const }); },
});

test("Provider Access ACL preserves owner evidence and binds the exact snapshot at acceptance and dispatch", async () => {
  let dispatchedBinding: typeof binding | undefined;
  const port = createContainedTurnProviderAccessPort(Object.freeze({
    dispatchConsumptionV1: unusedDispatch,
    resolve: Object.freeze({ async execute() { return Object.freeze({ binding, evidence: evidence("acceptance"), kind: "resolved" as const }); } }),
    revalidate: Object.freeze({ async execute(input) {
      dispatchedBinding = input.binding as typeof binding;
      return Object.freeze({ binding, evidence: evidence("dispatch"), kind: "valid" as const });
    } }),
  }));

  const accepted = await port.resolveForAcceptance({
    operationId: containedTurnIdentity("operation", "operation:one"),
    intent: { mode: "analysis", prompt: "Inspect the disposable workspace." },
    provider: "codex",
    scope,
  });
  assert.equal(accepted.kind, "resolved");
  if (accepted.kind !== "resolved") { return; }
  assert.equal(accepted.snapshot.ownerAuthorityDigest, binding.credentialBindingDigest);
  assert.match(accepted.snapshot.credentialBindingDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(accepted.snapshot.credentialBindingDigest, binding.credentialBindingDigest);

  const current = await port.revalidateForDispatch({
    acceptedSnapshot: accepted.snapshot,
    operationId: "operation:one",
    scope,
  });
  assert.equal(current.kind, "current");
  if (current.kind !== "current") { return; }
  assert.equal(dispatchedBinding?.credentialBindingDigest, binding.credentialBindingDigest);
  assert.deepEqual(current.snapshot, accepted.snapshot);
  assert.notEqual(current.dispatchResolutionDigest, accepted.acceptanceResolutionDigest);
  assert.notEqual(current.dispatchProofId, accepted.acceptanceProofId);
  assert.match(accepted.acceptanceProofId, /:acceptance:/u);
  assert.match(current.dispatchProofId, /:dispatch:/u);
});

test("Provider Access ACL maps owner rejection evidence without exposing owner reasons", async () => {
  const port = createContainedTurnProviderAccessPort(Object.freeze({
    dispatchConsumptionV1: unusedDispatch,
    resolve: Object.freeze({ async execute() { return Object.freeze({ evidence: evidence("acceptance"), kind: "unavailable" as const, reason: "revoked" }); } }),
    revalidate: Object.freeze({ async execute() { return Object.freeze({ evidence: evidence("dispatch"), kind: "rejected" as const, reason: "revoked" }); } }),
  }));
  const outcome = await port.resolveForAcceptance({
    operationId: containedTurnIdentity("operation", "operation:one"),
    intent: { mode: "analysis", prompt: "Inspect the disposable workspace." },
    provider: "codex",
    scope,
  });
  assert.equal(outcome.kind, "prevented");
  if (outcome.kind === "prevented") {
    assert.match(outcome.preventionProofId, /^proof:provider-access:acceptance:sha256:[0-9a-f]{64}$/u);
    assert.equal(outcome.reason, "access_denied");
  }
});

test("Provider Access ambiguous consumption is observed once and settled without a second consumption", async () => {
  const { accepted, subject } = await acceptedAuthorityFixture();
  const acceptedScope = subject.scope;
  const scopeDigest = subject.scopeDigest;
  const calls: string[] = [];
  const ownerReceipt = Object.freeze({
    ...subject.providerAccessExpectation, authorityHeadDigestAtConsumption: subject.providerAccessExpectation.authorityHeadDigest,
    claimBeforeControlTime: 100, claimBindingDigest: subject.providerAccessRequest.claimBindingDigest,
    consumedAtControlTime: 50, consumptionDigest: "provider-consumption:one",
    grantRequestId: subject.providerAccessRequest.grantRequestId, opaqueOwnerEvidenceRef: "provider-evidence:one",
    operationId: subject.operationId, provider: subject.provider, purpose: "contained-turn.provider-dispatch/v1" as const,
    requestDigest: subject.providerAccessRequest.requestDigest, scope: Object.freeze({ ...acceptedScope, scopeDigest }),
  });
  const port = createContainedTurnProviderAccessPort(Object.freeze({
    dispatchConsumptionV1: Object.freeze({
      async consumeForDispatch() {calls.push("consume"); return { kind: "indeterminate" as const };},
      async observeDispatchConsumption() {calls.push("observe"); return Object.freeze({ kind: "consumed" as const, receipt: ownerReceipt });},
      async settleDispatchConsumption(input) {
        calls.push(`settle:${input.disposition}`);
        return Object.freeze({
          kind: "settled" as const,
          receipt: Object.freeze({
            ...input,
            settledAtControlTime: 51,
            settlementDigest: "settlement-digest:one",
          }),
        });
      },
    }),
    resolve: Object.freeze({ async execute() {throw new Error("unused resolve");} }),
    revalidate: Object.freeze({ async execute() {throw new Error("unused revalidate");} }),
  }));
  const consumed = await port.consumeForDispatch({ accepted, grantRequestId: subject.providerAccessRequest.grantRequestId, subject });
  assert.equal(consumed.kind, "consumed");
  if (consumed.kind !== "consumed") {return;}
  assert.deepEqual(consumed.receipt.authorityFacts, subject.providerAccessExpectation);
  assert.deepEqual(await port.settleConsumedGrant({
    disposition: "claim_committed", receipt: consumed.receipt,
    settlementRequestId: containedTurnGrantSettlementRequestId(consumed.receipt, "claim_committed"),
  }), { kind: "settled" });
  assert.deepEqual(calls, ["consume", "observe", "settle:claim_committed"]);
});

test("production exports expose one kernel authority and isolate only non-authoritative legacy adapters", async () => {
  const [publicIndex, composition, manifest, dispatch] = await Promise.all([
    readFile(new URL("../../../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../src/composition.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    readFile(new URL("../../../src/features/contained-agent-turn/application/contained-turn-dispatch.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(publicIndex, /PostgresContainedTurn|ContainedTurnOperationStore|contained-turn-state/u);
  assert.doesNotMatch(manifest, /legacy-compatibility/u);
  assert.doesNotMatch(dispatch, /LegacyClaim|legacy-claim|claimDispatch\(/u);
  assert.match(composition, /createContainedTurnFeature/u);
  assert.match(composition, /createContainedTurnProviderAccessPort/u);
});

for (const metadata of ["name", "length"] as const) {
  test(`existing Provider Access capture preserves receiver and behavior with a ${metadata} getter`, async () => {
    let touched = 0; let calls = 0;
    const resolve = Object.seal({async execute() {
      assert.equal(this, resolve); calls++;
      return Object.freeze({binding, evidence: evidence("acceptance"), kind: "resolved" as const});
    }});
    const method = resolve.execute;
    const accessor = {configurable: true, get() {touched++; throw new Error("must not read metadata");}};
    Object.defineProperty(method, metadata, accessor);
    const port = createContainedTurnProviderAccessPort(Object.freeze({
      dispatchConsumptionV1: unusedDispatch, resolve,
      revalidate: Object.freeze({async execute() {throw new Error("unused revalidate");}}),
    }));
    assert.ok(Object.isFrozen(port)); assert.equal(port instanceof Promise, false);
    assert.equal(touched, 0); assert.equal(calls, 0);
    Object.defineProperties(method, {name: accessor, length: accessor, bind: accessor, apply: accessor});
    Object.freeze(method);
    resolve.execute = async () => {throw new Error("replacement must not be captured");};
    const input = {operationId: containedTurnIdentity("operation", "operation:metadata"),
      intent: {mode: "analysis" as const, prompt: "Synthetic capture check"}, provider: "codex" as const, scope};
    const outcome = await port.resolveForAcceptance(input);
    assert.equal(outcome.kind, "resolved");
    assert.deepEqual(await port.resolveForAcceptance(input), outcome);
    assert.equal(calls, 2); assert.equal(touched, 0);
  });
}
