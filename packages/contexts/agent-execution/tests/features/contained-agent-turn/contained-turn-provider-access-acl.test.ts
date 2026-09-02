import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createContainedTurnProviderAccessPort } from "../../../dist/features/contained-agent-turn/composition/provider-access-anti-corruption.js";
import { digestContainedTurnCanonicalValue } from "../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {
  completeContainedTurnDispatchGrantSubject,
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
    resolve: Object.freeze({ async execute() { return { binding, evidence: evidence("acceptance"), kind: "resolved" as const }; } }),
    revalidate: Object.freeze({ async execute(input) {
      dispatchedBinding = input.binding as typeof binding;
      return { binding, evidence: evidence("dispatch"), kind: "valid" as const };
    } }),
  }));

  const accepted = await port.resolveForAcceptance({
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
    resolve: Object.freeze({ async execute() { return { evidence: evidence("acceptance"), kind: "unavailable" as const, reason: "revoked" }; } }),
    revalidate: Object.freeze({ async execute() { return { evidence: evidence("dispatch"), kind: "rejected" as const, reason: "revoked" }; } }),
  }));
  const outcome = await port.resolveForAcceptance({
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
  const scopeDigest = digestContainedTurnCanonicalValue({ scope });
  const subject = completeContainedTurnDispatchGrantSubject({
    attemptId: containedTurnIdentity("attempt", "attempt:provider-access-correlation"),
    custodyId: containedTurnIdentity("custody", "custody:provider-access-correlation"),
    effectId: containedTurnIdentity("effect", "effect:provider-access-correlation"),
    executionGenerationId: containedTurnIdentity("execution_generation", "execution-generation:provider-access-correlation"),
    hostBootId: containedTurnIdentity("host_boot", "host-boot:provider-access-correlation"),
    hostInstanceId: containedTurnIdentity("host_instance", "host-instance:provider-access-correlation"),
    operationCutoffRevision: 0, operationId: containedTurnIdentity("operation", "operation:provider-access-correlation"),
    preparationToken: containedTurnIdentity("preparation", "preparation:provider-access-correlation"),
    provider: "codex",
    providerAccessExpectation: {
      acceptedAuthorityDigest: "accepted-authority:one", accessRef: binding.accessRef, authorityHeadDigest: "authority-head:one",
      bindingDigest: "binding-digest:one", bindingRevision: binding.revision, credentialBindingDigest: "credential-digest:one",
      credentialBindingRef: binding.credentialBindingRef, credentialGeneration: binding.credentialGeneration,
      providerAccountRef: binding.providerAccountRef, providerRouteRef: binding.providerRouteRef,
    },
    purpose: "contained_turn_provider_start_v1",
    runtimeSecurityExpectation: {
      acceptedAuthorityDigest: "security-accepted:one", authorityGeneration: "security-generation:one",
      authorityHeadDigest: "security-head:one", authorityRevision: "security-revision:one",
      constraintsDigest: "constraints:one", containmentPolicyDigest: "containment:one",
      providerBindingDigest: "provider-binding:one", providerId: "codex",
    },
    scope, scopeDigest, workspaceId: containedTurnIdentity("workspace", "workspace:provider-access-correlation"),
  });
  const calls: string[] = [];
  const ownerReceipt = {
    ...subject.providerAccessExpectation, authorityHeadDigestAtConsumption: subject.providerAccessExpectation.authorityHeadDigest,
    claimBeforeControlTime: 100, claimBindingDigest: subject.providerAccessRequest.claimBindingDigest,
    consumedAtControlTime: 50, consumptionDigest: "provider-consumption:one",
    grantRequestId: subject.providerAccessRequest.grantRequestId, opaqueOwnerEvidenceRef: "provider-evidence:one",
    operationId: subject.operationId, provider: subject.provider, purpose: "contained-turn.provider-dispatch/v1" as const,
    requestDigest: subject.providerAccessRequest.requestDigest, scope: { ...scope, scopeDigest },
  };
  const port = createContainedTurnProviderAccessPort(Object.freeze({
    dispatchConsumptionV1: Object.freeze({
      async consumeForDispatch() {calls.push("consume"); return { kind: "indeterminate" as const };},
      async observeDispatchConsumption() {calls.push("observe"); return { kind: "consumed" as const, receipt: ownerReceipt };},
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
  const consumed = await port.consumeForDispatch({ grantRequestId: subject.providerAccessRequest.grantRequestId, subject });
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
