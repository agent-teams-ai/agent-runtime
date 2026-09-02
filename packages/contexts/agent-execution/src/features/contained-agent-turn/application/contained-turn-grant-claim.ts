import { containedTurnProviderAccessSnapshotDigest, containedTurnScopeDigest, type ContainedTurnScope } from "../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";
import {
  completeContainedTurnDispatchGrantSubject,
  containedTurnDispatchClaimBindingDigest,
  containedTurnDispatchGrantRequestId,
  containedTurnGrantSettlementRequestId,
  validateContainedTurnConsumedGrantReceipts,
  type ContainedTurnDispatchGrantSubject,
} from "../domain/contained-turn-dispatch-authority.js";
import type { ContainedTurnEvidenceId, ContainedTurnPreparationToken, ContainedTurnProofId } from "../domain/contained-turn-identities.js";
import { containedTurnIdentity, validateContainedTurnIdentity } from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import { containedTurnOwnerStoreAuthority } from "./contained-turn-store-authority.js";
import { isContainedTurnPreparedClaimOperation } from "./contained-turn-preparation-scope.js";
import { retireAndCleanupContainedTurnPreparation } from "./contained-turn-preparation-cleanup.js";
import { recordContainedTurnRejectedDebt } from "./contained-turn-closure.js";
import type { ContainedTurnKernelDependencies } from "./ports/outbound/contained-turn-ports.js";

type ConsumedGrantRequestIds = Readonly<{
  providerAccessConsumptionReceipt?: import("../domain/contained-turn-dispatch-authority.js").ContainedTurnConsumedGrantReceipt<"provider_access">;
  providerAccessGrantRequestId?: string;
  runtimeSecurityConsumptionReceipt?: import("../domain/contained-turn-dispatch-authority.js").ContainedTurnConsumedGrantReceipt<"runtime_security">;
  runtimeSecurityGrantRequestId?: string;
}>;

type ConsumptionEvidenceIds = Readonly<{
  providerAccessEvidenceId?: ContainedTurnEvidenceId;
  runtimeSecurityEvidenceId?: ContainedTurnEvidenceId;
}>;

type UnclaimedGrantOutcomeEvidence = Readonly<{
  consumedGrantReceipts: Readonly<{
    providerAccess?: import("../domain/contained-turn-dispatch-authority.js").ContainedTurnConsumedGrantReceipt<"provider_access">;
    runtimeSecurity?: import("../domain/contained-turn-dispatch-authority.js").ContainedTurnConsumedGrantReceipt<"runtime_security">;
  }>;
  consumedGrantRequestIds: ConsumedGrantRequestIds;
  consumptionEvidenceIds: ConsumptionEvidenceIds;
}>;

const unavailableGrantConsumptionEvidenceId = (
  owner: "provider_access" | "runtime_security",
  subject: ContainedTurnDispatchGrantSubject,
): ContainedTurnEvidenceId => containedTurnIdentity(
  "evidence",
  `evidence:grant-consumption-unavailable:${digestContainedTurnCanonicalValue({
    claimBindingDigest: containedTurnDispatchClaimBindingDigest(subject),
    owner,
    purpose: "contained_turn_grant_consumption_unavailable_v1",
  })}`,
);

export type ClaimContainedTurnWithConsumedGrantsOutcome =
  | { readonly kind: "claimed"; readonly operation: ContainedTurnKernelOperation; readonly startAuthority: string }
  | (UnclaimedGrantOutcomeEvidence & { readonly kind: "observed_claim"; readonly operation: ContainedTurnKernelOperation })
  | (UnclaimedGrantOutcomeEvidence & { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" })
  | (UnclaimedGrantOutcomeEvidence & { readonly kind: "prevented"; readonly preventionProofId: ContainedTurnProofId })
  | (UnclaimedGrantOutcomeEvidence & { readonly kind: "unavailable" });

const settleConsumedGrantReceipts = async (
  dependencies: ContainedTurnKernelDependencies,
  receipts: UnclaimedGrantOutcomeEvidence["consumedGrantReceipts"],
  disposition: "abandoned_without_claim" | "claim_committed",
): Promise<boolean> => {
  const effects: Promise<unknown>[] = [];
  if (receipts.providerAccess !== undefined) {effects.push(dependencies.providerAccess.settleConsumedGrant({
    disposition, receipt: receipts.providerAccess,
    settlementRequestId: containedTurnGrantSettlementRequestId(receipts.providerAccess, disposition),
  }));}
  if (receipts.runtimeSecurity !== undefined) {effects.push(dependencies.security.settleConsumedGrant({
    disposition, receipt: receipts.runtimeSecurity,
    settlementRequestId: containedTurnGrantSettlementRequestId(receipts.runtimeSecurity, disposition),
  }));}
  const results = await Promise.allSettled(effects);
  return results.some(result => { if (result.status === "rejected") return true; const kind = (result.value as { readonly kind?: string }).kind; return kind !== "settled" && kind !== "already_settled"; });
};

/**
 * Consumes one grant per owner and submits the exact pair to the final local
 * claim. A read/replay/lost acknowledgement never manufactures start
 * authority; only the store's known `claimed` response can carry it.
 */
// oxlint-disable-next-line complexity -- the ordered owner outcomes are intentionally fail-closed.
export const claimContainedTurnWithConsumedGrants = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  subject: ContainedTurnDispatchGrantSubject,
  hostCustodyProof: Extract<Awaited<ReturnType<ContainedTurnKernelDependencies["custody"]["open"]>>["hostCustodyProof"], { readonly kind: "host_custody" }>,
): Promise<ClaimContainedTurnWithConsumedGrantsOutcome> => {
  const providerAccessConsume = dependencies.providerAccess.consumeForDispatch;
  const runtimeSecurityConsume = dependencies.security.consumeForDispatch;
  const claim = dependencies.operationStore.claimPreparedDispatch;
  const providerAccessGrantRequestId = containedTurnDispatchGrantRequestId(
    "provider_access", subject,
  );
  const [providerAccessResult, runtimeSecurityResult] = await Promise.allSettled([
    providerAccessConsume.call(dependencies.providerAccess, { grantRequestId: providerAccessGrantRequestId, subject }),
    runtimeSecurityConsume.call(dependencies.security, { subject }),
  ]);
  const providerAccess = providerAccessResult.status === "fulfilled"
    ? providerAccessResult.value : undefined;
  const runtimeSecurity = runtimeSecurityResult.status === "fulfilled"
    ? runtimeSecurityResult.value : undefined;
  const consumedGrantRequestIds: ConsumedGrantRequestIds = Object.freeze({
    ...(providerAccess?.kind === "consumed"
      ? { providerAccessConsumptionReceipt: providerAccess.receipt, providerAccessGrantRequestId: providerAccess.receipt.grantRequestId }
      : providerAccessResult.status === "rejected" || providerAccess?.kind === "indeterminate"
        ? { providerAccessGrantRequestId }
        : {}),
    ...(runtimeSecurity?.kind === "consumed"
      ? { runtimeSecurityConsumptionReceipt: runtimeSecurity.receipt, runtimeSecurityGrantRequestId: runtimeSecurity.receipt.grantRequestId } : {}),
  });
  const consumptionEvidenceIds: ConsumptionEvidenceIds = Object.freeze({
    ...(providerAccessResult.status === "rejected"
      ? { providerAccessEvidenceId: unavailableGrantConsumptionEvidenceId("provider_access", subject) }
      : providerAccess?.kind === "indeterminate"
        ? { providerAccessEvidenceId: validateContainedTurnIdentity("evidence", providerAccess.evidenceId) }
        : {}),
    ...(runtimeSecurityResult.status === "rejected"
      ? { runtimeSecurityEvidenceId: unavailableGrantConsumptionEvidenceId("runtime_security", subject) }
      : runtimeSecurity?.kind === "indeterminate"
        ? { runtimeSecurityEvidenceId: validateContainedTurnIdentity("evidence", runtimeSecurity.evidenceId) }
        : {}),
  });
  const consumedGrantReceipts = Object.freeze({
    ...(providerAccess?.kind === "consumed" ? { providerAccess: providerAccess.receipt } : {}),
    ...(runtimeSecurity?.kind === "consumed" ? { runtimeSecurity: runtimeSecurity.receipt } : {}),
  });
  const unclaimedEvidence = Object.freeze({ consumedGrantReceipts, consumedGrantRequestIds, consumptionEvidenceIds });
  if (providerAccess === undefined || runtimeSecurity === undefined) {
    return { ...unclaimedEvidence, kind: "unavailable" };
  }
  if (providerAccess.kind === "prevented") {
    return { ...providerAccess, ...unclaimedEvidence };
  }
  if (runtimeSecurity.kind === "prevented") {
    return { ...runtimeSecurity, ...unclaimedEvidence };
  }
  if (providerAccess.kind === "indeterminate") {
    return { ...providerAccess, ...unclaimedEvidence };
  }
  if (runtimeSecurity.kind === "indeterminate") {
    return { ...runtimeSecurity, ...unclaimedEvidence };
  }
  const receipts = validateContainedTurnConsumedGrantReceipts(subject, [
    providerAccess.receipt,
    runtimeSecurity.receipt,
  ]);
  try {
    const authority = containedTurnOwnerStoreAuthority(operation, trustedScope);
    const outcome = await claim.call(dependencies.operationStore, {
      authority,
      consumedGrantReceipts: receipts,
      expectedOperationRevision: operation.revision,
      hostCustodyProof,
      subject,
    });
    if (outcome.kind === "claimed" || outcome.kind === "observed_claim") {
      if (!isContainedTurnPreparedClaimOperation(authority, subject, outcome.operation)) {
        return Object.freeze({ ...unclaimedEvidence, kind: "unavailable" });
      }
      if (outcome.kind === "claimed") {
        if (await settleConsumedGrantReceipts(dependencies, consumedGrantReceipts, "claim_committed")) { await recordContainedTurnRejectedDebt(dependencies, outcome.operation, trustedScope, "grant_settlement_rejected", "dispatch_authority"); }
        return Object.freeze({
          kind: "claimed",
          operation: outcome.operation,
          startAuthority: outcome.startAuthority,
        });
      }
      if (await settleConsumedGrantReceipts(dependencies, consumedGrantReceipts, "claim_committed")) { await recordContainedTurnRejectedDebt(dependencies, outcome.operation, trustedScope, "grant_settlement_rejected", "dispatch_authority"); }
      return Object.freeze({ ...unclaimedEvidence, kind: "observed_claim", operation: outcome.operation });
    }
    if (outcome.kind === "stale") {
      if (!isContainedTurnPreparedClaimOperation(authority, subject, outcome.current)) {
        return Object.freeze({ ...unclaimedEvidence, kind: "unavailable" });
      if (await settleConsumedGrantReceipts(dependencies, consumedGrantReceipts, "claim_committed")) { await recordContainedTurnRejectedDebt(dependencies, outcome.current, trustedScope, "grant_settlement_rejected", "dispatch_authority"); }
      if (await settleConsumedGrantReceipts(dependencies, consumedGrantReceipts, "claim_committed")) { await recordContainedTurnRejectedDebt(dependencies, outcome.operation, trustedScope, "grant_settlement_rejected", "dispatch_authority"); }
      return Object.freeze({ ...unclaimedEvidence, kind: "observed_claim", operation: outcome.current });
    }
    if (outcome.kind === "indeterminate") {
      return Object.freeze({
        ...unclaimedEvidence,
        evidenceId: validateContainedTurnIdentity("evidence", outcome.evidenceId),
        kind: "indeterminate",
      });
    }
    return Object.freeze({ ...unclaimedEvidence, kind: "unavailable" });
  } catch {
    // A lost claim acknowledgement is deliberately not recoverable into start.
    return { ...unclaimedEvidence, kind: "unavailable" };
  }
};

export type ClaimPreparedContainedTurnOutcome =
  | { readonly kind: "claimed"; readonly operation: ContainedTurnKernelOperation; readonly startAuthority: string }
  | { readonly kind: "observed"; readonly operation: ContainedTurnKernelOperation }
  | { readonly kind: "prevented"; readonly operation: ContainedTurnKernelOperation; readonly preventionProofId: ContainedTurnProofId }
  | { readonly kind: "stopped"; readonly operation: ContainedTurnKernelOperation };

/** Runs the new consumed-grant path through retirement, without legacy revalidation. */
export const claimPreparedContainedTurn = async (input: Readonly<{
  custody: Awaited<ReturnType<ContainedTurnKernelDependencies["custody"]["open"]>>;
  dependencies: ContainedTurnKernelDependencies;
  operation: ContainedTurnKernelOperation;
  preparation: Awaited<ReturnType<ContainedTurnKernelDependencies["operationStore"]["prepareDispatch"]>>;
  preparationToken: ContainedTurnPreparationToken;
  trustedScope: ContainedTurnScope;
}>): Promise<ClaimPreparedContainedTurnOutcome> => {
  const { custody, dependencies, operation, preparation, preparationToken, trustedScope } = input;
  if (operation.workspaceId === undefined) {return { kind: "stopped", operation };}
  const providerAccess = operation.providerAccessSnapshot;
  const providerBindingDigest = containedTurnProviderAccessSnapshotDigest(providerAccess);
  const subject: ContainedTurnDispatchGrantSubject = completeContainedTurnDispatchGrantSubject(Object.freeze({
    attemptId: preparation.attemptId, custodyId: preparation.custodyId, effectId: operation.effectId,
    executionGenerationId: preparation.executionGenerationId, hostBootId: custody.hostBootId,
    hostInstanceId: custody.hostInstanceId, operationCutoffRevision: operation.operationCutoff.revision,
    operationId: operation.operationId, preparationToken, provider: operation.adapterSnapshot.provider,
    providerAccessExpectation: Object.freeze({
      acceptedAuthorityDigest: operation.acceptedAuthorityVectorDigest, accessRef: providerAccess.accessRef,
      authorityHeadDigest: providerAccess.ownerAuthorityDigest, bindingDigest: providerBindingDigest,
      bindingRevision: providerAccess.revision, credentialBindingDigest: providerAccess.credentialBindingDigest,
      credentialBindingRef: providerAccess.credentialBindingRef, credentialGeneration: providerAccess.credentialGeneration,
      providerAccountRef: providerAccess.providerAccountRef, providerRouteRef: providerAccess.providerRouteRef,
    }),
    purpose: "contained_turn_provider_start_v1",
    runtimeSecurityExpectation: Object.freeze({
      acceptedAuthorityDigest: operation.acceptedAuthorityVector.securityDecisionDigest,
      authorityGeneration: operation.acceptedAuthorityVector.operationAuthorityRevision,
      authorityHeadDigest: operation.acceptedAuthorityVector.securityDecisionDigest,
      authorityRevision: operation.acceptedAuthorityVector.securityAuthorityRevision,
      constraintsDigest: digestContainedTurnCanonicalValue({
        adapterSnapshot: operation.adapterSnapshot, capabilityManifest: operation.capabilityManifest,
        intentMode: operation.intent.mode,
      } as never),
      containmentPolicyDigest: operation.acceptedAuthorityVector.containmentPolicyDigest,
      providerBindingDigest, providerId: operation.adapterSnapshot.provider,
    }),
    scope: trustedScope, scopeDigest: containedTurnScopeDigest(trustedScope), workspaceId: operation.workspaceId,
  }));
  const claim = await claimContainedTurnWithConsumedGrants(
    dependencies, operation, trustedScope, subject, custody.hostCustodyProof,
  );
  if (claim.kind === "claimed") {return claim;}
  if (claim.kind === "observed_claim") {
    const cleanup = await retireAndCleanupContainedTurnPreparation(
      dependencies, operation, trustedScope, subject, "claim_lost", claim.consumedGrantRequestIds,
      claim.consumptionEvidenceIds,
    );
    return { kind: "observed", operation: cleanup.kind === "claimed" ? cleanup.operation : claim.operation };
  }
  const cleanup = await retireAndCleanupContainedTurnPreparation(
    dependencies, operation, trustedScope, subject,
    claim.kind === "prevented" ? "prevention" : "reconciliation",
    claim.consumedGrantRequestIds,
    claim.consumptionEvidenceIds,
  );
  if (cleanup.kind === "claimed") {
    if (await settleConsumedGrantReceipts(dependencies, claim.consumedGrantReceipts, "claim_committed")) { await recordContainedTurnRejectedDebt(dependencies, cleanup.operation, trustedScope, "grant_settlement_rejected", "dispatch_authority"); }
    return { kind: "observed", operation: cleanup.operation };
  }
  if (claim.kind === "prevented") {
    return { kind: "prevented", operation: cleanup.operation, preventionProofId: claim.preventionProofId };
  }
  const reconciled = cleanup.operation.reconciliation.kind === "required"
    ? cleanup.operation
    : await recordContainedTurnRejectedDebt(
      dependencies, cleanup.operation, trustedScope, "dispatch_claim_rejected", "dispatch_authority",
    );
  return { kind: "stopped", operation: reconciled };
};
