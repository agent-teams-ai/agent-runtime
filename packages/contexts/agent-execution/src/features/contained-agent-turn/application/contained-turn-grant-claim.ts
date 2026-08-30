import { containedTurnScopeDigest, type ContainedTurnScope } from "../domain/contained-turn-authority.js";
import { validateContainedTurnConsumedGrantReceipts, type ContainedTurnDispatchGrantSubject } from "../domain/contained-turn-dispatch-authority.js";
import type { ContainedTurnEvidenceId, ContainedTurnPreparationToken, ContainedTurnProofId } from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import { containedTurnOwnerStoreAuthority } from "./contained-turn-store-authority.js";
import { retireAndCleanupContainedTurnPreparation } from "./contained-turn-preparation-cleanup.js";
import type { ContainedTurnKernelDependencies } from "./ports/outbound/contained-turn-ports.js";

export type ClaimContainedTurnWithConsumedGrantsOutcome =
  | { readonly kind: "claimed"; readonly operation: ContainedTurnKernelOperation; readonly startAuthority: string }
  | { readonly kind: "observed_claim"; readonly operation: ContainedTurnKernelOperation }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  | { readonly kind: "prevented"; readonly preventionProofId: ContainedTurnProofId }
  | { readonly kind: "unavailable" };

/**
 * Consumes one grant per owner and submits the exact pair to the final local
 * claim. A read/replay/lost acknowledgement never manufactures start
 * authority; only the store's known `claimed` response can carry it.
 */
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
  let providerAccess: Awaited<ReturnType<typeof providerAccessConsume>>;
  let runtimeSecurity: Awaited<ReturnType<typeof runtimeSecurityConsume>>;
  try {
    [providerAccess, runtimeSecurity] = await Promise.all([
      providerAccessConsume({ subject }),
      runtimeSecurityConsume({ subject }),
    ]);
  } catch {
    return { kind: "unavailable" };
  }
  if (providerAccess.kind === "prevented") {return providerAccess;}
  if (runtimeSecurity.kind === "prevented") {return runtimeSecurity;}
  if (providerAccess.kind === "indeterminate") {return providerAccess;}
  if (runtimeSecurity.kind === "indeterminate") {return runtimeSecurity;}
  const receipts = validateContainedTurnConsumedGrantReceipts(subject, [
    providerAccess.receipt,
    runtimeSecurity.receipt,
  ]);
  try {
    const outcome = await claim({
      authority: containedTurnOwnerStoreAuthority(operation, trustedScope),
      consumedGrantReceipts: receipts,
      expectedOperationRevision: operation.revision,
      hostCustodyProof,
      subject,
    });
    if (outcome.kind === "claimed" || outcome.kind === "observed_claim") {return outcome;}
    if (outcome.kind === "stale" && outcome.current.dispatch.kind === "claimed" &&
        outcome.current.dispatch.preparationToken === subject.preparationToken) {
      return { kind: "observed_claim", operation: outcome.current };
    }
    if (outcome.kind === "indeterminate") {return outcome;}
    return { kind: "unavailable" };
  } catch {
    // A lost claim acknowledgement is deliberately not recoverable into start.
    return { kind: "unavailable" };
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
  const claim = await claimContainedTurnWithConsumedGrants(dependencies, operation, trustedScope, {
    attemptId: preparation.attemptId,
    custodyId: preparation.custodyId,
    effectId: operation.effectId,
    executionGenerationId: preparation.executionGenerationId,
    hostBootId: custody.hostBootId,
    hostInstanceId: custody.hostInstanceId,
    operationCutoffRevision: operation.operationCutoff.revision,
    operationId: operation.operationId,
    preparationToken,
    purpose: "contained_turn_provider_start_v1",
    scopeDigest: containedTurnScopeDigest(trustedScope),
    workspaceId: operation.workspaceId,
  }, custody.hostCustodyProof);
  if (claim.kind === "claimed") {return claim;}
  if (claim.kind === "observed_claim") {
    return { kind: "observed", operation: claim.operation };
  }
  const cleanup = await retireAndCleanupContainedTurnPreparation(
    dependencies, operation, trustedScope, preparationToken,
    claim.kind === "prevented" ? "prevention" : "reconciliation",
  );
  if (cleanup.kind === "claimed") {return { kind: "observed", operation: cleanup.operation };}
  return claim.kind === "prevented"
    ? { kind: "prevented", operation: cleanup.operation, preventionProofId: claim.preventionProofId }
    : { kind: "stopped", operation: cleanup.operation };
};
