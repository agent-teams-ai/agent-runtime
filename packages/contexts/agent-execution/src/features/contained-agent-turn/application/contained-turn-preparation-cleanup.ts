import type { ContainedTurnScope } from "../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnCustodyId,
  ContainedTurnEvidenceId,
  ContainedTurnOperationId,
  ContainedTurnPreparationToken,
  ContainedTurnWorkspaceId,
} from "../domain/contained-turn-identities.js";
import { containedTurnIdentity } from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import {
  readContainedTurnOwnedOperation,
  recordContainedTurnRejectedDebt,
  redactedContainedTurnEvidenceId,
} from "./contained-turn-closure.js";
import {
  advanceContainedTurn,
  ContainedTurnCasLostError,
  ContainedTurnIndeterminateCommitError,
} from "./contained-turn-committer.js";
import type { ContainedTurnKernelDependencies } from "./ports/outbound/contained-turn-ports.js";
import { containedTurnOwnerStoreAuthority } from "./contained-turn-store-authority.js";
import type { ContainedTurnDispatchPreparation } from "../domain/contained-turn-dispatch-preparation.js";

export const containedTurnPreparationToken = (input: Readonly<{
  attemptId: ContainedTurnAttemptId;
  custodyId: ContainedTurnCustodyId;
  operationId: ContainedTurnOperationId;
}>): ContainedTurnPreparationToken => containedTurnIdentity(
  "preparation",
  `preparation:${digestContainedTurnCanonicalValue({
    attemptId: input.attemptId,
    custodyId: input.custodyId,
    operationId: input.operationId,
    purpose: "dispatch_preparation",
  })}`,
);

export type RetireContainedTurnPreparationOutcome =
  | { readonly kind: "claimed"; readonly operation: ContainedTurnKernelOperation }
  | { readonly kind: "cleanup_pending"; readonly operation: ContainedTurnKernelOperation; readonly preparation?: ContainedTurnDispatchPreparation }
  | { readonly kind: "cleanup_closed"; readonly operation: ContainedTurnKernelOperation; readonly preparation: ContainedTurnDispatchPreparation };

/**
 * The authority-safe cleanup path. Retirement is the only decision point: it
 * atomically makes claim impossible and returns the one permit accepted by
 * custody and both grant owners. Unknown outcomes remain preparation debt.
 */
export const retireAndCleanupContainedTurnPreparation = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  preparationToken: ContainedTurnPreparationToken,
  reason: "claim_lost" | "open_failed" | "prevention" | "reconciliation",
): Promise<RetireContainedTurnPreparationOutcome> => {
  const retire = dependencies.operationStore.retireDispatchPreparation;
  const record = dependencies.operationStore.recordDispatchPreparationCleanup;
  if (retire === undefined || record === undefined) {
    return { kind: "cleanup_pending", operation };
  }
  const authority = containedTurnOwnerStoreAuthority(operation, trustedScope);
  let retirement: Awaited<ReturnType<typeof retire>>;
  try {
    retirement = await retire({
      authority,
      expectedOperationCutoffRevision: operation.operationCutoff.revision,
      expectedOperationRevision: operation.revision,
      preparationToken,
      reason,
    });
  } catch {
    return { kind: "cleanup_pending", operation };
  }
  if (retirement.kind === "claimed") {
    return { kind: "claimed", operation: retirement.operation };
  }
  if (retirement.kind !== "retired") {
    return { kind: "cleanup_pending", operation: retirement.kind === "stale" ? retirement.current : operation };
  }
  const pending = retirement.preparation;
  const permit = pending.cleanupPermit;
  let current: ContainedTurnDispatchPreparation = pending;
  const cleanup = async (
    target: "custody" | "provider_access" | "runtime_security",
    effect: (() => Promise<{ readonly kind: string; readonly evidenceId?: ContainedTurnEvidenceId }>) | undefined,
    grantRequestId?: string,
  ): Promise<void> => {
    if (effect === undefined) {return;}
    let outcome: { readonly kind: string; readonly evidenceId?: ContainedTurnEvidenceId };
    try {outcome = await effect();} catch {return;}
    if (outcome.kind !== "released" && outcome.kind !== "already_released" &&
        outcome.kind !== "settled" && outcome.kind !== "already_settled") {
      if (outcome.evidenceId === undefined) {return;}
      try {
        current = await record({ authority, evidenceId: outcome.evidenceId, permit, target });
      } catch {}
      return;
    }
    try {
      current = await record({ authority, permit, target });
    } catch {}
    void grantRequestId;
  };
  await cleanup("custody", dependencies.custody.releaseRetiredReservation === undefined
    ? undefined
    : () => dependencies.custody.releaseRetiredReservation!({ cleanupPermit: permit }));
  await cleanup("provider_access", dependencies.providerAccess.settleConsumedGrant === undefined
    ? undefined
    : () => dependencies.providerAccess.settleConsumedGrant!({ cleanupPermit: permit, grantRequestId: pending.providerAccessGrantRequestId }));
  await cleanup("runtime_security", dependencies.security.settleConsumedGrant === undefined
    ? undefined
    : () => dependencies.security.settleConsumedGrant!({ cleanupPermit: permit, grantRequestId: pending.runtimeSecurityGrantRequestId }));
  const finalPreparation = current as ContainedTurnDispatchPreparation;
  return finalPreparation.kind === "cleanup_closed"
    ? { kind: "cleanup_closed", operation, preparation: finalPreparation }
    : { kind: "cleanup_pending", operation, preparation: finalPreparation };
};

export const quarantineLosingContainedTurnWorkspace = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  workspaceId: ContainedTurnWorkspaceId,
): Promise<ContainedTurnKernelOperation> => {
  let current = operation;
  try {
    current = await readContainedTurnOwnedOperation(dependencies, operation.operationId, trustedScope) ?? operation;
    if (current.workspaceId === workspaceId) {return current;}
    await dependencies.workspace.quarantine({
      evidenceId: redactedContainedTurnEvidenceId(operation, "workspace_bind_lost"),
      operationId: operation.operationId,
      workspaceId,
    });
    return current;
  } catch {
    try {
      await dependencies.workspace.quarantine({
        evidenceId: redactedContainedTurnEvidenceId(operation, "workspace_bind_lost"),
        operationId: operation.operationId,
        workspaceId,
      });
    } catch {}
    return recordContainedTurnRejectedDebt(
      dependencies, current, trustedScope, "workspace_cleanup_rejected", "workspace",
    );
  }
};

export const bindContainedTurnCancellationWorkspace = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation> => {
  const workspace = await dependencies.workspace.create({ operationId: operation.operationId, scope: trustedScope });
  try {
    return await advanceContainedTurn(dependencies, operation, trustedScope, {
      kind: "bind_workspace",
      workspaceId: workspace.workspaceId,
    });
  } catch (error) {
    const current = await quarantineLosingContainedTurnWorkspace(
      dependencies,
      error instanceof ContainedTurnIndeterminateCommitError ? error.operation : operation,
      trustedScope,
      workspace.workspaceId,
    );
    return error instanceof ContainedTurnCasLostError || error instanceof ContainedTurnIndeterminateCommitError
      ? current
      : recordContainedTurnRejectedDebt(
        dependencies, current, trustedScope, "workspace_bind_rejected", "workspace",
      );
  }
};

export const releaseLosingContainedTurnCustody = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  reservation: Readonly<{
    attemptId: ContainedTurnAttemptId;
    custodyId: ContainedTurnCustodyId;
    reason: "claim_lost" | "open_failed" | "prevention" | "revalidation_failed";
    workspaceId: ContainedTurnWorkspaceId;
  }>,
): Promise<ContainedTurnKernelOperation> => {
  try {
    await dependencies.custody.releaseReservation({
      ...reservation,
      operationId: operation.operationId,
    });
    return operation;
  } catch {
    return recordContainedTurnRejectedDebt(
      dependencies, operation, trustedScope, "custody_release_rejected", "containment",
    );
  }
};

/**
 * A failed or stale claim acknowledgement is not negative ownership evidence.
 * Only a fresh owner-store read can prove that this exact preparation did not
 * become the live claim; otherwise its custody remains reserved under debt.
 */
export const reconcileContainedTurnClaimPreparation = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  reservation: Readonly<{
    attemptId: ContainedTurnAttemptId;
    custodyId: ContainedTurnCustodyId;
    preparationToken: ContainedTurnPreparationToken;
    workspaceId: ContainedTurnWorkspaceId;
  }>,
  durableFallback?: ContainedTurnKernelOperation,
): Promise<Readonly<{ operation: ContainedTurnKernelOperation; startPermitted: false }>> => {
  let current: ContainedTurnKernelOperation | undefined;
  try {
    current = await readContainedTurnOwnedOperation(
      dependencies, operation.operationId, trustedScope,
    );
  } catch {}

  if (current !== undefined && !(
    current.dispatch.kind === "claimed" &&
    current.dispatch.preparationToken === reservation.preparationToken
  )) {
    return Object.freeze({
      operation: await releaseLosingContainedTurnCustody(
        dependencies, current, trustedScope, { ...reservation, reason: "claim_lost" },
      ),
      startPermitted: false as const,
    });
  }

  const debtBase = current ?? durableFallback ?? operation;
  if (debtBase.reconciliation.kind === "required") {
    return Object.freeze({ operation: debtBase, startPermitted: false as const });
  }
  try {
    return Object.freeze({
      operation: await recordContainedTurnRejectedDebt(
        dependencies, debtBase, trustedScope, "dispatch_claim_rejected", "dispatch_authority",
      ),
      startPermitted: false as const,
    });
  } catch {
    // The exact reservation remains retained even if the debt write itself is unavailable.
    return Object.freeze({ operation: debtBase, startPermitted: false as const });
  }
};
