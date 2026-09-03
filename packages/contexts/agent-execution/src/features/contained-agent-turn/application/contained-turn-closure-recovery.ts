import type { ContainedTurnScope } from "../domain/contained-turn-authority.js";
import type { ContainedTurnClosureRecovery, ContainedTurnClosureStage } from "../domain/contained-turn-closure-recovery.js";
import { containedTurnNoWorkspaceClosureFact } from "../domain/contained-turn-closure-recovery.js";
import { digestContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../domain/contained-turn-identities.js";
import type { ContainedTurnEvidenceId, ContainedTurnProofId } from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import { mutateContainedTurnOperation, type ContainedTurnKernelMutation } from "../domain/contained-turn-transitions.js";
import { containedTurnOwnerStoreAuthority, sanitizeContainedTurnOwnerStoreOutcome } from "./contained-turn-store-authority.js";
import type { ContainedTurnKernelDependencies, EnsureContainedTurnClosureOutcome } from "./ports/outbound/contained-turn-ports.js";

const MAX_LOCAL_CLOSURE_CAS_ATTEMPTS = 3;
type PendingClosure = Extract<ContainedTurnClosureRecovery, { readonly kind: "required" }>;

export type ResumeContainedTurnClosureOutcome =
  | { readonly kind: "completed"; readonly operation: ContainedTurnKernelOperation }
  | { readonly kind: "debt"; readonly operation: ContainedTurnKernelOperation; readonly reason: "cas_exhausted" | "identity_conflict" | "indeterminate" };

interface ClosureStageDriver<Proof> {
  readonly complete: (request: PendingClosure, proof: Proof) => ContainedTurnKernelMutation;
  readonly ensure: (request: PendingClosure, operation: ContainedTurnKernelOperation) => Promise<EnsureContainedTurnClosureOutcome<Proof>>;
  readonly proofIds: (proof: Proof) => readonly ContainedTurnProofId[];
  readonly query?: (request: PendingClosure, operation: ContainedTurnKernelOperation) => Promise<EnsureContainedTurnClosureOutcome<Proof>>;
  readonly stage: ContainedTurnClosureStage;
}

const hasProofIds = (operation: ContainedTurnKernelOperation, proofIds: readonly ContainedTurnProofId[]): boolean =>
  proofIds.every(proofId => operation.proofs.some(proof => proof.proofId === proofId));

interface ClosureCommitOutcome {
  readonly applied: boolean;
  readonly operation: ContainedTurnKernelOperation;
}

const commitCandidate = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  candidate: ContainedTurnKernelOperation,
): Promise<ClosureCommitOutcome | undefined> => {
  let outcome: ReturnType<typeof sanitizeContainedTurnOwnerStoreOutcome>;
  try {
    outcome = sanitizeContainedTurnOwnerStoreOutcome({
      authority: containedTurnOwnerStoreAuthority(operation, trustedScope),
      outcome: await dependencies.operationStore.commit({
        authority: containedTurnOwnerStoreAuthority(operation, trustedScope),
        candidate,
        expectedRevision: operation.revision,
      }),
    });
  } catch {
    return undefined;
  }
  if (outcome.kind === "applied") {return { applied: true, operation: outcome.operation };}
  if (outcome.kind === "stale") {return { applied: false, operation: outcome.current };}
  if (outcome.kind === "indeterminate") {return { applied: false, operation: outcome.debtOperation };}
  return undefined;
};

const commitMutation = (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  mutation: ContainedTurnKernelMutation,
): Promise<ClosureCommitOutcome | undefined> => commitCandidate(
  dependencies, operation, trustedScope, mutateContainedTurnOperation(operation, mutation),
);

const ensureDurableStageDebt = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  stage: ContainedTurnClosureStage,
): Promise<Readonly<{ operation: ContainedTurnKernelOperation; useQuery: boolean }>> => {
  let current = initial;
  for (let attempt = 0; attempt < MAX_LOCAL_CLOSURE_CAS_ATTEMPTS; attempt += 1) {
    if (current.closureRecovery.kind === "proved_no_workspace") {
      return { operation: current, useQuery: true };
    }
    if (current.closureRecovery.kind === "required") {
      if (current.closureRecovery.stage !== stage) {
        throw new TypeError("another serialized closure stage is already pending");
      }
      return { operation: current, useQuery: true };
    }
    const committed = await commitMutation(dependencies, current, trustedScope, {
      kind: "begin_closure_stage",
      stage,
    });
    if (committed === undefined) {return { operation: current, useQuery: true };}
    current = committed.operation;
    if (committed.applied) {return { operation: current, useQuery: false };}
  }
  return { operation: current, useQuery: true };
};

const retainUnknownClosureDebt = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  evidenceId: ContainedTurnEvidenceId,
): Promise<ContainedTurnKernelOperation> => {
  let current = operation;
  for (let attempt = 0; attempt < MAX_LOCAL_CLOSURE_CAS_ATTEMPTS; attempt += 1) {
    if (current.closureRecovery.kind !== "required") {return current;}
    const committed = await commitMutation(dependencies, current, trustedScope, {
      evidenceId,
      kind: "note_closure_stage_unknown",
      request: current.closureRecovery,
    });
    if (committed === undefined) {return current;}
    current = committed.operation;
    if (current.closureRecovery.kind === "required" && current.closureRecovery.evidenceIds.includes(evidenceId)) {
      return current;
    }
  }
  return current;
};

const closureUnknownEvidenceId = (
  operation: ContainedTurnKernelOperation,
  request: PendingClosure,
  reason: "missing_observer" | "observer_threw",
): ContainedTurnEvidenceId => containedTurnIdentity("evidence", `evidence:closure:${digestContainedTurnCanonicalValue({
  operationId: operation.operationId,
  reason,
  requestDigest: request.requestDigest,
  requestId: request.requestId,
})}`);

/** Persists the exact authority-bound non-applicability fact before readiness. */
export const closeContainedTurnNoWorkspaceObligations = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation> => {
  const stage = await ensureDurableStageDebt(dependencies, initial, trustedScope, "no_workspace");
  let current = stage.operation;
  for (let attempt = 0; attempt < MAX_LOCAL_CLOSURE_CAS_ATTEMPTS; attempt += 1) {
    if (current.closureRecovery.kind === "proved_no_workspace") {return current;}
    if (current.closureRecovery.kind !== "required" || current.closureRecovery.stage !== "no_workspace") {return current;}
    const fact = containedTurnNoWorkspaceClosureFact(current);
    if (fact === undefined) {
      return retainUnknownClosureDebt(
        dependencies,
        current,
        trustedScope,
        closureUnknownEvidenceId(current, current.closureRecovery, "missing_observer"),
      );
    }
    const committed = await commitCandidate(dependencies, current, trustedScope, {
      ...current,
      closureRecovery: { fact, kind: "proved_no_workspace" },
      revision: current.revision + 1,
    });
    if (committed === undefined) {return current;}
    current = committed.operation;
  }
  return current;
};

/**
 * Runs one closed stage. It begins deterministic debt before the external
 * call, makes at most one ensure call, and bounds all local CAS adoption.
 */
export const resumeContainedTurnClosureStage = async <Proof>(
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  driver: ClosureStageDriver<Proof>,
): Promise<ResumeContainedTurnClosureOutcome> => {
  const staged = await ensureDurableStageDebt(dependencies, initial, trustedScope, driver.stage);
  let current = staged.operation;
  if (current.closureRecovery.kind !== "required" || current.closureRecovery.stage !== driver.stage) {
    return { kind: "debt", operation: current, reason: "cas_exhausted" };
  }
  const request = current.closureRecovery;
  let outcome: EnsureContainedTurnClosureOutcome<Proof>;
  try {
    const observer = staged.useQuery ? driver.query : driver.ensure;
    if (observer === undefined) {
      current = await retainUnknownClosureDebt(
        dependencies, current, trustedScope, closureUnknownEvidenceId(current, request, "missing_observer"),
      );
      return { kind: "debt", operation: current, reason: "indeterminate" };
    }
    outcome = await observer(request, current);
  } catch {
    current = await retainUnknownClosureDebt(
      dependencies, current, trustedScope, closureUnknownEvidenceId(current, request, "observer_threw"),
    );
    return { kind: "debt", operation: current, reason: "indeterminate" };
  }
  if (outcome.kind !== "proved") {
    current = await retainUnknownClosureDebt(dependencies, current, trustedScope, outcome.evidenceId);
    return { kind: "debt", operation: current, reason: outcome.kind };
  }
  if (outcome.requestId !== request.requestId || outcome.requestDigest !== request.requestDigest) {
    throw new TypeError("closure ensure outcome substituted request identity or digest");
  }
  const proofIds = driver.proofIds(outcome.proof);
  for (let attempt = 0; attempt < MAX_LOCAL_CLOSURE_CAS_ATTEMPTS; attempt += 1) {
    if (current.closureRecovery.kind !== "required") {
      if (hasProofIds(current, proofIds)) {return { kind: "completed", operation: current };}
      return { kind: "debt", operation: current, reason: "identity_conflict" };
    }
    if (current.closureRecovery.stage !== driver.stage || current.closureRecovery.debtId !== request.debtId ||
        current.closureRecovery.requestId !== request.requestId || current.closureRecovery.requestDigest !== request.requestDigest) {
      return { kind: "debt", operation: current, reason: "identity_conflict" };
    }
    const committed = await commitMutation(
      dependencies,
      current,
      trustedScope,
      driver.complete(current.closureRecovery, outcome.proof),
    );
    if (committed === undefined) {return { kind: "debt", operation: current, reason: "indeterminate" };}
    current = committed.operation;
  }
  return current.closureRecovery.kind !== "required" && hasProofIds(current, proofIds)
    ? { kind: "completed", operation: current }
    : { kind: "debt", operation: current, reason: "cas_exhausted" };
};

export { MAX_LOCAL_CLOSURE_CAS_ATTEMPTS };
