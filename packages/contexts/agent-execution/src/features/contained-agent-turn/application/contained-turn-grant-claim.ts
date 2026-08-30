import { containedTurnScopeDigest, type ContainedTurnScope } from "../domain/contained-turn-authority.js";
import { validateContainedTurnConsumedGrantReceipts, type ContainedTurnDispatchGrantSubject } from "../domain/contained-turn-dispatch-authority.js";
import type { ContainedTurnEvidenceId, ContainedTurnPreparationToken, ContainedTurnProofId } from "../domain/contained-turn-identities.js";
import { validateContainedTurnIdentity } from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import { CONTAINED_TURN_LIMITS, validateContainedTurnText } from "../domain/contained-turn-limits.js";
import { assertContainedTurnExactRecord } from "../domain/contained-turn-record.js";
import { containedTurnOwnerStoreAuthority } from "./contained-turn-store-authority.js";
import {
  isContainedTurnPreparedClaimOperation,
  cloneContainedTurnPortValue,
  snapshotContainedTurnOwnedOperation,
} from "./contained-turn-preparation-scope.js";
import { retireAndCleanupContainedTurnPreparation } from "./contained-turn-preparation-cleanup.js";
import type { ContainedTurnKernelDependencies } from "./ports/outbound/contained-turn-ports.js";

export type ClaimContainedTurnWithConsumedGrantsOutcome =
  | { readonly kind: "claimed"; readonly operation: ContainedTurnKernelOperation; readonly startAuthority: string }
  | { readonly kind: "observed_claim"; readonly operation: ContainedTurnKernelOperation }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  | { readonly kind: "prevented"; readonly preventionProofId: ContainedTurnProofId }
  | { readonly kind: "unavailable" };

const projectGrantOwnerOutcome = <Outcome extends { readonly kind: string }>(outcome: Outcome): Outcome => {
  const safeOutcome = cloneContainedTurnPortValue(outcome);
  if (safeOutcome.kind === "consumed") {
    assertContainedTurnExactRecord("consumed grant outcome", safeOutcome, ["kind", "receipt"]);
    return Object.freeze({ kind: "consumed", receipt: (safeOutcome as Outcome & { readonly receipt: unknown }).receipt }) as unknown as Outcome;
  }
  if (safeOutcome.kind === "prevented") {
    assertContainedTurnExactRecord("prevented grant outcome", safeOutcome, ["kind", "preventionProofId"]);
    const prevented = safeOutcome as Outcome & { readonly preventionProofId: string };
    return Object.freeze({
      kind: "prevented",
      preventionProofId: validateContainedTurnIdentity("proof", prevented.preventionProofId),
    }) as unknown as Outcome;
  }
  if (safeOutcome.kind === "indeterminate") {
    assertContainedTurnExactRecord("indeterminate grant outcome", safeOutcome, ["evidenceId", "kind"]);
    const indeterminate = safeOutcome as Outcome & { readonly evidenceId: string };
    return Object.freeze({
      evidenceId: validateContainedTurnIdentity("evidence", indeterminate.evidenceId),
      kind: "indeterminate",
    }) as unknown as Outcome;
  }
  throw new TypeError("unknown grant owner outcome");
};

type ClaimOwnerOutcome = Awaited<ReturnType<NonNullable<
  ContainedTurnKernelDependencies["operationStore"]["claimPreparedDispatch"]
>>>;

const projectClaimOwnerOutcome = (outcome: ClaimOwnerOutcome): ClaimOwnerOutcome => {
  const safeOutcome = cloneContainedTurnPortValue(outcome);
  if (safeOutcome.kind === "claimed") {
    assertContainedTurnExactRecord("claimed dispatch outcome", safeOutcome, ["kind", "operation", "startAuthority"]);
    validateContainedTurnText(
      "dispatch start authority",
      safeOutcome.startAuthority,
      CONTAINED_TURN_LIMITS.text.identifier,
    );
    return Object.freeze({
      kind: "claimed",
      operation: snapshotContainedTurnOwnedOperation(safeOutcome.operation),
      startAuthority: safeOutcome.startAuthority,
    });
  }
  if (safeOutcome.kind === "observed_claim") {
    assertContainedTurnExactRecord("observed claim outcome", safeOutcome, ["kind", "operation"]);
    return Object.freeze({
      kind: "observed_claim",
      operation: snapshotContainedTurnOwnedOperation(safeOutcome.operation),
    });
  }
  if (safeOutcome.kind === "stale") {
    assertContainedTurnExactRecord("stale claim outcome", safeOutcome, ["current", "kind"]);
    return Object.freeze({ current: snapshotContainedTurnOwnedOperation(safeOutcome.current), kind: "stale" });
  }
  if (safeOutcome.kind === "indeterminate") {
    assertContainedTurnExactRecord("indeterminate claim outcome", safeOutcome, ["evidenceId", "kind"]);
    return Object.freeze({
      evidenceId: validateContainedTurnIdentity("evidence", safeOutcome.evidenceId),
      kind: "indeterminate",
    });
  }
  if (safeOutcome.kind === "not_found") {
    assertContainedTurnExactRecord("not-found claim outcome", safeOutcome, ["kind"]);
    return Object.freeze({ kind: "not_found" });
  }
  throw new TypeError("unknown claim owner outcome");
};

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
): Promise<ClaimContainedTurnWithConsumedGrantsOutcome> => {
  const providerAccessConsume = dependencies.providerAccess.consumeForDispatch;
  const runtimeSecurityConsume = dependencies.security.consumeForDispatch;
  const claim = dependencies.operationStore.claimPreparedDispatch;
  if (providerAccessConsume === undefined || runtimeSecurityConsume === undefined || claim === undefined) {
    return { kind: "unavailable" };
  }
  let providerAccess: Awaited<ReturnType<typeof providerAccessConsume>>;
  let runtimeSecurity: Awaited<ReturnType<typeof runtimeSecurityConsume>>;
  try {
    const outcomes = await Promise.all([
      providerAccessConsume({ subject }),
      runtimeSecurityConsume({ subject }),
    ]);
    providerAccess = projectGrantOwnerOutcome(outcomes[0]);
    runtimeSecurity = projectGrantOwnerOutcome(outcomes[1]);
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
    const authority = containedTurnOwnerStoreAuthority(operation, trustedScope);
    const outcome = projectClaimOwnerOutcome(await claim({
      authority,
      consumedGrantReceipts: receipts,
      expectedOperationRevision: operation.revision,
      subject,
    }));
    if (outcome.kind === "claimed" || outcome.kind === "observed_claim") {
      if (!isContainedTurnPreparedClaimOperation(authority, subject, outcome.operation)) {
        return Object.freeze({ kind: "unavailable" });
      }
      if (outcome.kind === "claimed") {
        return Object.freeze({
          kind: "claimed",
          operation: outcome.operation,
          startAuthority: outcome.startAuthority,
        });
      }
      return Object.freeze({ kind: "observed_claim", operation: outcome.operation });
    }
    if (outcome.kind === "stale") {
      if (!isContainedTurnPreparedClaimOperation(authority, subject, outcome.current)) {
        return Object.freeze({ kind: "unavailable" });
      }
    }
    if (outcome.kind === "indeterminate") {
      return Object.freeze({
        evidenceId: validateContainedTurnIdentity("evidence", outcome.evidenceId),
        kind: "indeterminate",
      });
    }
    return Object.freeze({ kind: "unavailable" });
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
  const subject = Object.freeze({
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
  });
  const claim = await claimContainedTurnWithConsumedGrants(dependencies, operation, trustedScope, subject);
  if (claim.kind === "claimed") {return claim;}
  if (claim.kind === "observed_claim") {
    return { kind: "observed", operation: claim.operation };
  }
  const cleanup = await retireAndCleanupContainedTurnPreparation(
    dependencies, operation, trustedScope, subject,
    claim.kind === "prevented" ? "prevention" : "reconciliation",
  );
  if (cleanup.kind === "claimed") {return { kind: "observed", operation: cleanup.operation };}
  return claim.kind === "prevented"
    ? { kind: "prevented", operation: cleanup.operation, preventionProofId: claim.preventionProofId }
    : { kind: "stopped", operation: cleanup.operation };
};
