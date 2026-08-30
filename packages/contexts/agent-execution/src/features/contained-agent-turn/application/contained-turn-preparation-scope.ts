import { containedTurnScopeDigest } from "../domain/contained-turn-authority.js";
import type { ContainedTurnDispatchGrantSubject } from "../domain/contained-turn-dispatch-authority.js";
import type {
  ContainedTurnCleanupPermit,
  ContainedTurnDispatchPreparation,
} from "../domain/contained-turn-dispatch-preparation.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import type { ContainedTurnOwnerStoreAuthority } from "./ports/outbound/contained-turn-ports.js";
import { containedTurnOwnerStoreAuthorityMatches } from "./contained-turn-store-authority.js";

const cleanupPermitMatchesPreparation = (
  permit: ContainedTurnCleanupPermit,
  preparation: ContainedTurnDispatchPreparation,
): boolean => permit.operationId === preparation.operationId &&
  permit.preparationToken === preparation.preparationToken &&
  permit.attemptId === preparation.attemptId && permit.custodyId === preparation.custodyId &&
  permit.workspaceId === preparation.workspaceId &&
  permit.preparedOperationRevision === preparation.preparedOperationRevision &&
  permit.operationCutoffRevision === preparation.operationCutoffRevision;

/** Exact operation and dispatch-owner predicate for prepared claim outcomes. */
export const isContainedTurnPreparedClaimOperation = (
  authority: ContainedTurnOwnerStoreAuthority,
  subject: ContainedTurnDispatchGrantSubject,
  operation: ContainedTurnKernelOperation,
): boolean => containedTurnOwnerStoreAuthorityMatches(authority, operation) &&
  subject.scopeDigest === containedTurnScopeDigest(authority.scope) &&
  operation.dispatch.kind === "claimed" &&
  operation.dispatch.attemptId === subject.attemptId &&
  operation.dispatch.executionGenerationId === subject.executionGenerationId &&
  operation.dispatch.operationCutoffRevision === subject.operationCutoffRevision &&
  operation.dispatch.preparationToken === subject.preparationToken &&
  operation.custodyId === subject.custodyId && operation.effectId === subject.effectId &&
  operation.hostBootId === subject.hostBootId && operation.hostInstanceId === subject.hostInstanceId &&
  operation.operationId === subject.operationId && operation.workspaceId === subject.workspaceId;

/** Exact operation owner and preparation identity for a retirement claim winner. */
export const isContainedTurnClaimedPreparation = (
  authority: ContainedTurnOwnerStoreAuthority,
  owner: ContainedTurnDispatchGrantSubject,
  actual: ContainedTurnKernelOperation,
): boolean => isContainedTurnPreparedClaimOperation(authority, owner, actual);

/** Exact owner predicate for an operation returned by retirement reconciliation. */
export const isContainedTurnRetirementCurrent = (
  authority: ContainedTurnOwnerStoreAuthority,
  expected: ContainedTurnKernelOperation,
  owner: ContainedTurnDispatchGrantSubject,
  actual: ContainedTurnKernelOperation,
): boolean => containedTurnOwnerStoreAuthorityMatches(authority, actual) &&
  actual.workspaceId === expected.workspaceId &&
  (actual.dispatch.kind !== "claimed" ||
    isContainedTurnPreparedClaimOperation(authority, owner, actual));

/** Exact operation/preparation-owner predicate for retirement outcomes. */
export const isContainedTurnRetiredPreparation = (
  authority: ContainedTurnOwnerStoreAuthority,
  operation: ContainedTurnKernelOperation,
  owner: ContainedTurnDispatchGrantSubject,
  preparation: ContainedTurnDispatchPreparation,
): preparation is Extract<ContainedTurnDispatchPreparation, { readonly kind: "cleanup_pending" }> =>
  containedTurnOwnerStoreAuthorityMatches(authority, operation) &&
  preparation.kind === "cleanup_pending" && operation.workspaceId !== undefined &&
  preparation.operationId === operation.operationId && preparation.operationId === owner.operationId &&
  preparation.preparationToken === owner.preparationToken &&
  preparation.attemptId === owner.attemptId && preparation.custodyId === owner.custodyId &&
  preparation.workspaceId === operation.workspaceId && preparation.workspaceId === owner.workspaceId &&
  preparation.preparedOperationRevision === operation.revision &&
  preparation.operationCutoffRevision === operation.operationCutoff.revision &&
  preparation.operationCutoffRevision === owner.operationCutoffRevision &&
  cleanupPermitMatchesPreparation(preparation.cleanupPermit, preparation);

/** Exact permit and owner identities for each cleanup-store continuation. */
export const isContainedTurnPreparationCleanupContinuation = (
  expected: ContainedTurnDispatchPreparation,
  actual: ContainedTurnDispatchPreparation,
): boolean => (expected.kind === "cleanup_pending" || expected.kind === "cleanup_closed") &&
  (actual.kind === "cleanup_pending" || actual.kind === "cleanup_closed") &&
  actual.operationId === expected.operationId &&
  actual.preparationToken === expected.preparationToken && actual.attemptId === expected.attemptId &&
  actual.custodyId === expected.custodyId && actual.workspaceId === expected.workspaceId &&
  actual.preparedOperationRevision === expected.preparedOperationRevision &&
  actual.operationCutoffRevision === expected.operationCutoffRevision &&
  actual.providerAccessGrantRequestId === expected.providerAccessGrantRequestId &&
  actual.runtimeSecurityGrantRequestId === expected.runtimeSecurityGrantRequestId &&
  (expected.kind === "cleanup_closed"
    ? actual.kind === "cleanup_closed" && actual.cleanupPermitId === expected.cleanupPermitId
    : actual.kind === "cleanup_pending"
      ? actual.cleanupPermit.permitId === expected.cleanupPermit.permitId &&
        actual.cleanupPermit.permitDigest === expected.cleanupPermit.permitDigest &&
        cleanupPermitMatchesPreparation(actual.cleanupPermit, actual)
      : actual.cleanupPermitId === expected.cleanupPermit.permitId);
