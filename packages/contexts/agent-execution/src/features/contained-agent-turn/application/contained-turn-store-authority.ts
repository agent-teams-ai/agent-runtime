import type { ContainedTurnScope } from "../domain/contained-turn-authority.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import type {
  ContainedTurnCommandId,
  ContainedTurnOperationId,
} from "../domain/contained-turn-identities.js";
import { assertContainedTurnExactRecord } from "../domain/contained-turn-record.js";
import type {
  AcceptContainedTurnKernelOperationOutcome,
  CommitContainedTurnKernelOperationOutcome,
  ContainedTurnOwnerStoreAuthority,
  IdentifyContainedTurnAcceptanceOutcome,
} from "./ports/outbound/contained-turn-ports.js";

export interface ContainedTurnAcceptanceOwnerKey {
  readonly commandId: ContainedTurnCommandId;
  readonly projectId: string;
  readonly tenantId: string;
}

export const containedTurnScopesEqual = (
  left: ContainedTurnScope,
  right: ContainedTurnScope,
): boolean => left.projectId === right.projectId && left.tenantId === right.tenantId;

/** Composite acceptance namespace; a command ID is never globally identifying. */
export const containedTurnAcceptanceOwnerKey = (input: Readonly<{
  commandId: ContainedTurnCommandId;
  scope: ContainedTurnScope;
}>): ContainedTurnAcceptanceOwnerKey => {
  assertContainedTurnExactRecord("acceptance owner key input", input, ["commandId", "scope"]);
  assertContainedTurnExactRecord("acceptance owner scope", input.scope, ["projectId", "tenantId"]);
  return Object.freeze({
    commandId: input.commandId,
    projectId: input.scope.projectId,
    tenantId: input.scope.tenantId,
  });
};

export const containedTurnOwnerStoreAuthority = (
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): ContainedTurnOwnerStoreAuthority => {
  if (!containedTurnScopesEqual(operation.scope, trustedScope)) {
    throw new TypeError("owner-store authority scope does not own the operation");
  }
  return Object.freeze({
    commandId: operation.commandId,
    effectId: operation.effectId,
    operationId: operation.operationId,
    scope: Object.freeze({ projectId: trustedScope.projectId, tenantId: trustedScope.tenantId }),
  });
};

export const containedTurnOwnerStoreAuthorityMatches = (
  authority: ContainedTurnOwnerStoreAuthority,
  operation: ContainedTurnKernelOperation,
): boolean => containedTurnScopesEqual(authority.scope, operation.scope) &&
  authority.operationId === operation.operationId && authority.commandId === operation.commandId &&
  authority.effectId === operation.effectId;

const isOwnedOperation = (
  operation: ContainedTurnKernelOperation,
  operationId: ContainedTurnOperationId,
  scope: ContainedTurnScope,
): boolean => containedTurnScopesEqual(operation.scope, scope) && operation.operationId === operationId;

/** Scope and subject selection for owner-store reads; mismatch is absence. */
export const selectContainedTurnOwnerStoreRead = (input: Readonly<{
  current: ContainedTurnKernelOperation | undefined;
  operationId: ContainedTurnOperationId;
  scope: ContainedTurnScope;
}>): ContainedTurnKernelOperation | undefined => {
  assertContainedTurnExactRecord("owner-store read predicate", input, ["current", "operationId", "scope"]);
  return input.current !== undefined && isOwnedOperation(input.current, input.operationId, input.scope)
    ? input.current
    : undefined;
};

export type ContainedTurnOwnerStoreWritePredicate =
  | { readonly kind: "current"; readonly operation: ContainedTurnKernelOperation }
  | { readonly kind: "not_found" }
  | { readonly current: ContainedTurnKernelOperation; readonly kind: "stale" };

/**
 * Shared scope-first CAS predicate. Store implementations must call this only
 * inside the transaction holding the current owner row.
 */
export const classifyContainedTurnOwnerStoreWrite = (input: Readonly<{
  current: ContainedTurnKernelOperation | undefined;
  expectedRevision: number;
  operationId: ContainedTurnOperationId;
  scope: ContainedTurnScope;
}>): ContainedTurnOwnerStoreWritePredicate => {
  assertContainedTurnExactRecord("owner-store write predicate", input, [
    "current", "expectedRevision", "operationId", "scope",
  ]);
  const current = selectContainedTurnOwnerStoreRead({
    current: input.current,
    operationId: input.operationId,
    scope: input.scope,
  });
  if (current === undefined) {return Object.freeze({ kind: "not_found" });}
  return current.revision === input.expectedRevision
    ? Object.freeze({ kind: "current", operation: current })
    : Object.freeze({ current, kind: "stale" });
};

/** Defense-in-depth against a misrouted store leaking foreign stale/current rows. */
export const sanitizeContainedTurnOwnerStoreOutcome = (input: Readonly<{
  authority: ContainedTurnOwnerStoreAuthority;
  outcome: CommitContainedTurnKernelOperationOutcome;
}>): CommitContainedTurnKernelOperationOutcome => {
  assertContainedTurnExactRecord("owner-store outcome sanitizer", input, ["authority", "outcome"]);
  const operation = input.outcome.kind === "applied"
    ? input.outcome.operation
    : input.outcome.kind === "indeterminate"
      ? input.outcome.debtOperation
      : input.outcome.kind === "stale"
        ? input.outcome.current
        : undefined;
  return operation === undefined || containedTurnOwnerStoreAuthorityMatches(input.authority, operation)
    ? input.outcome
    : Object.freeze({ kind: "not_found" });
};

export const sanitizeContainedTurnAcceptanceOutcome = (input: Readonly<{
  candidate: ContainedTurnKernelOperation;
  outcome: AcceptContainedTurnKernelOperationOutcome;
  scope: ContainedTurnScope;
}>): AcceptContainedTurnKernelOperationOutcome => {
  assertContainedTurnExactRecord("acceptance outcome sanitizer", input, ["candidate", "outcome", "scope"]);
  if (!containedTurnScopesEqual(input.candidate.scope, input.scope)) {
    return Object.freeze({ kind: "not_found" });
  }
  if (input.outcome.kind === "accepted") {
    const operation = input.outcome.operation;
    return isOwnedOperation(operation, input.candidate.operationId, input.scope) &&
        operation.commandId === input.candidate.commandId &&
        operation.commandFingerprint === input.candidate.commandFingerprint &&
        operation.effectId === input.candidate.effectId
      ? input.outcome
      : Object.freeze({ kind: "not_found" });
  }
  if (input.outcome.kind === "replayed") {
    const winner = input.outcome.operation;
    return containedTurnScopesEqual(winner.scope, input.scope) &&
        winner.commandId === input.candidate.commandId &&
        winner.commandFingerprint === input.candidate.commandFingerprint
      ? input.outcome
      : Object.freeze({ kind: "not_found" });
  }
  if (input.outcome.kind === "potential_acceptance") {
    const potential = input.outcome.candidateOperation;
    return isOwnedOperation(potential, input.candidate.operationId, input.scope) &&
        potential.commandId === input.candidate.commandId &&
        potential.commandFingerprint === input.candidate.commandFingerprint &&
        potential.effectId === input.candidate.effectId
      ? input.outcome
      : Object.freeze({ kind: "not_found" });
  }
  return input.outcome;
};

export const sanitizeContainedTurnIdentificationOutcome = (input: Readonly<{
  commandId: ContainedTurnCommandId;
  outcome: IdentifyContainedTurnAcceptanceOutcome;
  scope: ContainedTurnScope;
}>): IdentifyContainedTurnAcceptanceOutcome => {
  assertContainedTurnExactRecord("identification outcome sanitizer", input, ["commandId", "outcome", "scope"]);
  if (input.outcome.kind !== "replayed") {return input.outcome;}
  return containedTurnScopesEqual(input.outcome.operation.scope, input.scope) &&
      input.outcome.operation.commandId === input.commandId
    ? input.outcome
    : Object.freeze({ kind: "not_found" });
};
