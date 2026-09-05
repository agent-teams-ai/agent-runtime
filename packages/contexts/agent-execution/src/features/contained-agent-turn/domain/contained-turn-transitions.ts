import {
  containedTurnCancellationFingerprint,
  containedTurnScopeDigest,
} from "./contained-turn-authority.js";
import {
  containedTurnClosureRequest,
  isContainedTurnClosureStageCompleted,
  type ContainedTurnClosureRecovery,
  type ContainedTurnClosureStage,
} from "./contained-turn-closure-recovery.js";
import { containedTurnInvariant as invariant } from "./contained-turn-invariant.js";
import type { ContainedTurnKernelOperation } from "./contained-turn-kernel-model.js";
import {
  validateContainedTurnKernelMutationShape,
  type ContainedTurnKernelMutation,
} from "./contained-turn-kernel-mutations.js";
import { nextContainedTurnOperationCutoffRevision } from "./contained-turn-output-authority.js";
import { closeOperationCutoffForContinuity } from "./contained-turn-output-transitions.js";
import { validateContainedTurnProofBinding } from "./contained-turn-proof-validation.js";
import {
  assertContainedTurnExactRecord,
  detachAndFreezeContainedTurnValue,
} from "./contained-turn-record.js";
import { containedTurnSatisfactionDigest } from "./contained-turn-satisfaction.js";
import { validateContainedTurnOperation } from "./contained-turn-validation.js";

export type { ContainedTurnKernelMutation } from "./contained-turn-kernel-mutations.js";

type PendingClosure = Extract<ContainedTurnClosureRecovery, { readonly kind: "required" }>;

const requireMatchingClosureRequest = (
  operation: ContainedTurnKernelOperation,
  request: PendingClosure,
  stage: ContainedTurnClosureStage,
): void => {
  invariant(operation.closureRecovery.kind === "required", "closure completion requires durable stage debt");
  if (operation.closureRecovery.kind !== "required") {return;}
  invariant(
    operation.closureRecovery.stage === stage &&
      operation.closureRecovery.debtId === request.debtId &&
      operation.closureRecovery.requestId === request.requestId &&
      operation.closureRecovery.requestDigest === request.requestDigest,
    "closure proof/request substitution rejected",
  );
};

type MutationByKind = {
  [Kind in ContainedTurnKernelMutation["kind"]]: Extract<ContainedTurnKernelMutation, { readonly kind: Kind }>;
};
type MutationHandler<Kind extends keyof MutationByKind> = (
  operation: ContainedTurnKernelOperation,
  mutation: MutationByKind[Kind],
) => ContainedTurnKernelOperation;

const bindWorkspace: MutationHandler<"bind_workspace"> = (operation, mutation) => {
  return { ...operation, revision: operation.revision + 1, workspaceId: mutation.workspaceId };
};

const beginClosureStage: MutationHandler<"begin_closure_stage"> = (operation, mutation) => {
  if (isContainedTurnClosureStageCompleted(operation, mutation.stage)) {return operation;}
  if (operation.closureRecovery.kind === "required") {
    invariant(operation.closureRecovery.stage === mutation.stage, "only one exact closure stage may be pending");
    return operation;
  }
  return { ...operation, closureRecovery: containedTurnClosureRequest(operation, mutation.stage), revision: operation.revision + 1 };
};

const noteClosureStageUnknown: MutationHandler<"note_closure_stage_unknown"> = (operation, mutation) => {
  requireMatchingClosureRequest(operation, mutation.request, mutation.request.stage);
  invariant(operation.closureRecovery.kind === "required", "unknown closure outcome retains exact debt");
  return {
    ...operation,
    closureRecovery: operation.closureRecovery.kind === "required" ? {
      ...operation.closureRecovery,
      evidenceIds: [...new Set([...operation.closureRecovery.evidenceIds, mutation.evidenceId])],
    } : operation.closureRecovery,
    revision: operation.revision + 1,
  };
};

const refreshContainmentAttestationRequest: MutationHandler<"refresh_containment_attestation_request"> = (operation, mutation) => {
  requireMatchingClosureRequest(operation, mutation.request, "containment_attestation");
  const refreshed = containedTurnClosureRequest(operation, "containment_attestation");
  return { ...operation, closureRecovery: refreshed, revision: operation.revision + 1 };
};

const completePhysicalContainment: MutationHandler<"complete_physical_containment"> = (operation, mutation) => {
  requireMatchingClosureRequest(operation, mutation.request, "physical_containment");
  invariant(operation.dispatch.kind === "claimed", "physical containment requires claimed dispatch");
  return { ...operation, closureRecovery: { kind: "clear" }, physicalContainment: {
    kind: "contained", proofId: mutation.proof.proofId,
  }, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1 };
};

const completeArtifactSeal: MutationHandler<"complete_artifact_seal"> = (operation, mutation) => {
  requireMatchingClosureRequest(operation, mutation.request, "artifact_seal");
  invariant(operation.workspaceId !== undefined && operation.output.fence.kind === "fenced" && operation.artifactManifestRef === undefined && operation.resultRef === undefined, "artifact/result closure commits once after output fence");
  return { ...operation, artifactManifestRef: mutation.artifactManifestRef, closureRecovery: { kind: "clear" }, proofs: [...operation.proofs, mutation.artifactProof, mutation.resultProof], resultRef: mutation.resultRef, revision: operation.revision + 1 };
};

const completeWorkspaceClose: MutationHandler<"complete_workspace_close"> = (operation, mutation) => {
  requireMatchingClosureRequest(operation, mutation.request, "workspace_close");
  invariant(operation.workspaceId !== undefined && operation.resultRef !== undefined, "workspace closure follows result publication");
  return { ...operation, closureRecovery: { kind: "clear" }, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1 };
};

const completeContainmentAttestation: MutationHandler<"complete_containment_attestation"> = (operation, mutation) => {
  requireMatchingClosureRequest(operation, mutation.request, "containment_attestation");
  invariant(operation.containment.kind === "pending" && operation.physicalContainment.kind === "contained", "containment attestation follows physical containment");
  return { ...operation, closureRecovery: { kind: "clear" }, containment: { kind: "contained", proofId: mutation.proof.proofId }, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1 };
};

const claimDispatch: MutationHandler<"claim_dispatch"> = (operation, mutation) => {
  invariant(
    operation.dispatch.kind === "unclaimed" && operation.workspaceId !== undefined &&
      operation.cancellation.kind === "open" && operation.operationCutoff.kind === "open",
    "dispatch claim requires one uncancelled, cutoff-current, workspace-bound operation",
  );
  return {
    ...operation,
    admissionFence: { kind: "fenced", proofId: mutation.cutoffProof.proofId },
    containment: { attemptId: mutation.attemptId, kind: "pending" },
    custodyId: mutation.custodyId,
    dispatch: {
      attemptId: mutation.attemptId,
      claimProofId: mutation.claimProof.proofId,
      executionGenerationId: mutation.executionGenerationId,
      grantReceipts: mutation.consumedGrantReceipts,
      kind: "claimed",
      operationCutoffRevision: operation.operationCutoff.revision,
      preparationToken: mutation.preparationToken,
      providerAccessDispatchProofId: mutation.providerAccessDispatchProof.proofId,
      runtimeSecurityDispatchProofId: mutation.runtimeSecurityDispatchProof.proofId,
      writerFence: mutation.writerFence,
    },
    hostBootId: mutation.hostBootId,
    hostInstanceId: mutation.hostInstanceId,
    physicalContainment: { attemptId: mutation.attemptId, kind: "pending" },
    proofs: [...operation.proofs, mutation.providerAccessDispatchProof, mutation.runtimeSecurityDispatchProof, mutation.cutoffProof, mutation.claimProof, mutation.hostCustodyProof],
    providerProcessStart: { attemptId: mutation.attemptId, kind: "pending" },
    revision: operation.revision + 1,
  };
};

const preventDispatch: MutationHandler<"prevent_dispatch"> = (operation, mutation) => {
  invariant(operation.dispatch.kind === "unclaimed", "dispatch prevention must atomically win before claim");
  return {
    ...operation,
    admissionFence: operation.admissionFence.kind === "fenced"
      ? operation.admissionFence
      : { kind: "fenced", proofId: mutation.cutoffProof.proofId },
    containment: { kind: "qualified_not_required", proofId: mutation.containmentProof.proofId },
    dispatch: { kind: "prevented", noDispatchProofId: mutation.noDispatchProof.proofId },
    effect: { disposition: "not_committed", kind: "resolved", proofId: mutation.effectProof.proofId },
    operationCutoff: operation.operationCutoff.kind === "open"
      ? {
        kind: "closed",
        proofId: mutation.cutoffProof.proofId,
        reason: "prevention",
        revision: nextContainedTurnOperationCutoffRevision(operation.operationCutoff.revision),
      }
      : operation.operationCutoff,
    output: { chunks: operation.output.chunks, fence: { finalCursor: 0, kind: "fenced", proofId: mutation.outputProof.proofId } },
    proofs: [
      ...operation.proofs,
      ...(operation.proofs.some(proof => proof.proofId === mutation.cutoffProof.proofId) ? [] : [mutation.cutoffProof]),
      mutation.noDispatchProof, mutation.hostCustodyProof, mutation.executionProof, mutation.providerProof,
      mutation.outputProof, mutation.containmentProof, mutation.effectProof,
    ],
    providerAcceptance: { kind: "not_accepted", proofId: mutation.providerProof.proofId },
    providerExecution: { kind: "closed", outcome: operation.cancellation.kind === "requested" ? "cancelled" : "failed", proofId: mutation.executionProof.proofId },
    revision: operation.revision + 1,
  };
};

const recordProviderAcceptance: MutationHandler<"record_provider_acceptance"> = (operation, mutation) => {
  invariant(operation.providerProcessStart.kind === "execution_started" && operation.providerAcceptance.kind === "unobserved", "provider acceptance follows exact process start once");
  return { ...operation, proofs: [...operation.proofs, mutation.proof], providerAcceptance: { kind: mutation.proof.binding.disposition, proofId: mutation.proof.proofId }, revision: operation.revision + 1 };
};

const closeProviderExecution: MutationHandler<"close_provider_execution"> = (operation, mutation) => {
  invariant(operation.providerExecution.kind === "active" && operation.providerAcceptance.kind !== "unobserved", "provider closure follows active, acceptance-observed execution");
  invariant(mutation.executionProof.binding.outcome === mutation.terminalObservationProof.binding.outcome, "execution and provider terminal outcomes must agree");
  return { ...operation, proofs: [...operation.proofs, mutation.executionProof, mutation.terminalObservationProof], providerExecution: { kind: "closed", outcome: mutation.executionProof.binding.outcome, proofId: mutation.executionProof.proofId }, revision: operation.revision + 1 };
};

const drainOutput: MutationHandler<"drain_output"> = (operation, mutation) => {
  invariant(
    operation.providerExecution.kind === "closed" &&
      (operation.output.fence.kind === "open" || operation.output.fence.proofId === undefined),
    "output drains once after provider closure without reopening a cutoff fence",
  );
  return { ...operation, output: { chunks: operation.output.chunks, fence: { finalCursor: operation.output.chunks.length, kind: "fenced", proofId: mutation.proof.proofId } }, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1 };
};

const resolveEffect: MutationHandler<"resolve_effect"> = (operation, mutation) => {
  invariant(operation.providerExecution.kind === "closed" && operation.effect.kind === "unresolved", "effect resolves once after execution closure");
  return { ...operation, effect: { disposition: mutation.proof.binding.disposition, kind: "resolved", proofId: mutation.proof.proofId }, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1 };
};

const sealArtifact: MutationHandler<"seal_artifact"> = (operation, mutation) => {
  invariant(
    operation.workspaceId !== undefined && operation.output.fence.kind === "fenced" &&
      operation.artifactManifestRef === undefined &&
      (operation.physicalContainment.kind === "contained" || operation.containment.kind === "qualified_not_required"),
    "artifact seals once after output drain and the physical-containment barrier",
  );
  return { ...operation, artifactManifestRef: mutation.artifactManifestRef, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1 };
};

const publishResult: MutationHandler<"publish_result"> = (operation, mutation) => {
  invariant(operation.artifactManifestRef !== undefined && operation.resultRef === undefined, "result publishes once after artifact seal");
  return { ...operation, proofs: [...operation.proofs, mutation.proof], resultRef: mutation.resultRef, revision: operation.revision + 1 };
};

const closeWorkspace: MutationHandler<"close_workspace"> = (operation, mutation) => {
  invariant(operation.workspaceId !== undefined && operation.resultRef !== undefined, "workspace closure follows result publication");
  return { ...operation, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1 };
};

const recordContainment: MutationHandler<"record_containment"> = (operation, mutation) => {
  invariant(
    operation.containment.kind === "pending" && operation.physicalContainment.kind === "contained" &&
      mutation.proof.binding.physicalContainmentProofId === operation.physicalContainment.proofId,
    "composite containment closure requires the earlier exact physical-containment barrier",
  );
  return { ...operation, containment: { kind: "contained", proofId: mutation.proof.proofId }, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1 };
};

const recordPhysicalContainment: MutationHandler<"record_physical_containment"> = (operation, mutation) => {
  invariant(
    (operation.physicalContainment.kind === "pending" || operation.physicalContainment.kind === "uncertain") &&
      operation.dispatch.kind === "claimed",
    "physical containment applies once to the sole claimed V1 attempt",
  );
  return {
    ...operation,
    physicalContainment: {
      kind: "contained",
      proofId: mutation.proof.proofId,
    },
    proofs: [...operation.proofs, mutation.proof],
    revision: operation.revision + 1,
  };
};

const recordPhysicalContainmentUnknown: MutationHandler<"record_physical_containment_unknown"> = (operation, mutation) => {
  invariant(operation.dispatch.kind === "claimed", "physical-containment ambiguity requires a dispatch claim");
  return {
    ...operation,
    containment: { evidenceId: mutation.evidenceId, kind: "uncertain" },
    operationCutoff: closeOperationCutoffForContinuity(operation, mutation.evidenceId),
    output: operation.output.fence.kind === "open"
      ? { chunks: operation.output.chunks, fence: { finalCursor: operation.output.chunks.length, kind: "fenced" } }
      : operation.output,
    physicalContainment: { evidenceId: mutation.evidenceId, kind: "uncertain" },
    reconciliation: {
      evidenceIds: operation.reconciliation.kind === "required"
        ? [...new Set([...operation.reconciliation.evidenceIds, mutation.evidenceId])]
        : [mutation.evidenceId],
      kind: "required",
    },
    revision: operation.revision + 1,
  };
};

const finalize: MutationHandler<"finalize"> = (operation, mutation) => {
  invariant(operation.terminal.kind === "open" && operation.providerExecution.kind === "closed", "terminal truth closes once after execution closure");
  const digest = containedTurnSatisfactionDigest(operation);
  invariant(
    mutation.proof.binding.satisfactionDigest === digest &&
      mutation.proof.binding.terminalOutcome === operation.providerExecution.outcome &&
      mutation.proof.binding.requiredReceiptSetDigest === operation.requiredReceiptSetDigest &&
      mutation.proof.binding.requiredReceiptSetVersion === operation.requiredReceiptSet.setVersion,
    "terminal proof must bind the recomputed satisfaction and frozen receipt-set authority",
  );
  return { ...operation, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1, terminal: { kind: "final", outcome: operation.providerExecution.outcome, satisfactionDigest: digest, terminalProofId: mutation.proof.proofId } };
};

const recordAmbiguity: MutationHandler<"record_ambiguity"> = (operation, mutation) => {
  invariant(operation.dispatch.kind === "claimed", "provider ambiguity requires an existing dispatch claim");
  return {
    ...operation,
    containment: operation.containment.kind === "uncertain"
      ? operation.containment
      : { evidenceId: mutation.evidenceId, kind: "uncertain" },
    effect: { evidenceId: mutation.evidenceId, kind: "ambiguous" },
    operationCutoff: closeOperationCutoffForContinuity(operation, mutation.evidenceId),
    output: { chunks: operation.output.chunks, fence: { finalCursor: operation.output.chunks.length, kind: "fenced" } },
    providerExecution: { evidenceId: mutation.evidenceId, kind: "unknown" },
    providerAcceptance: { evidenceId: mutation.evidenceId, kind: "unknown" },
    reconciliation: {
      evidenceIds: operation.reconciliation.kind === "required"
        ? [...new Set([...operation.reconciliation.evidenceIds, mutation.evidenceId])]
        : [mutation.evidenceId],
      kind: "required",
    },
    revision: operation.revision + 1,
  };
};

const recordReconciliationDebt: MutationHandler<"record_reconciliation_debt"> = (operation, mutation) => {
  invariant(operation.terminal.kind === "open", "reconciliation debt cannot rewrite terminal truth");
  return {
    ...operation,
    containment: mutation.source === "containment" && operation.containment.kind === "pending"
      ? { evidenceId: mutation.evidenceId, kind: "uncertain" }
      : operation.containment,
    operationCutoff: closeOperationCutoffForContinuity(operation, mutation.evidenceId),
    output: operation.output.fence.kind === "open"
      ? { chunks: operation.output.chunks, fence: { finalCursor: operation.output.chunks.length, kind: "fenced" } }
      : operation.output,
    reconciliation: {
      evidenceIds: operation.reconciliation.kind === "required"
        ? [...new Set([...operation.reconciliation.evidenceIds, mutation.evidenceId])]
        : [mutation.evidenceId],
      kind: "required",
    },
    revision: operation.revision + 1,
  };
};

const recordProcessStart: MutationHandler<"record_process_start"> = (operation, mutation) => {
  invariant(operation.dispatch.kind === "claimed" && operation.providerProcessStart.kind === "pending" && operation.providerExecution.kind === "not_started", "only one pending custody reservation can record actual process start");
  return {
    ...operation,
    proofs: [...operation.proofs, mutation.proof],
    providerExecution: { attemptId: operation.dispatch.attemptId, kind: "active" },
    providerProcessStart: { kind: "execution_started", proofId: mutation.proof.proofId },
    revision: operation.revision + 1,
  };
};

const recordProcessNoStart: MutationHandler<"record_process_no_start"> = (operation, mutation) => {
  invariant(operation.dispatch.kind === "claimed" && operation.providerProcessStart.kind === "pending" && operation.providerExecution.kind === "not_started", "proved no-start applies only to the one pending custody reservation");
  return {
    ...operation,
    proofs: [...operation.proofs, mutation.proof],
    providerProcessStart: { kind: "proved_no_start", proofId: mutation.proof.proofId },
    revision: operation.revision + 1,
  };
};

const closeProcessNoStart: MutationHandler<"close_process_no_start"> = (operation, mutation) => {
  invariant(
    operation.dispatch.kind === "claimed" && operation.providerProcessStart.kind === "proved_no_start" &&
      operation.providerExecution.kind === "not_started" && operation.providerAcceptance.kind === "unobserved" &&
      operation.output.fence.kind === "open" && operation.effect.kind === "unresolved" &&
      operation.containment.kind === "pending",
    "proved process no-start closes its remaining axes exactly once",
  );
  return {
    ...operation,
    containment: { kind: "qualified_not_required", proofId: mutation.containmentProof.proofId },
    effect: { disposition: "not_committed", kind: "resolved", proofId: mutation.effectProof.proofId },
    output: {
      chunks: operation.output.chunks,
      fence: { finalCursor: operation.output.chunks.length, kind: "fenced", proofId: mutation.outputProof.proofId },
    },
    proofs: [
      ...operation.proofs,
      mutation.executionProof,
      mutation.providerProof,
      mutation.outputProof,
      mutation.containmentProof,
      mutation.effectProof,
    ],
    providerAcceptance: { kind: "not_accepted", proofId: mutation.providerProof.proofId },
    providerExecution: {
      kind: "closed",
      outcome: operation.cancellation.kind === "requested" ? "cancelled" : "failed",
      proofId: mutation.executionProof.proofId,
    },
    revision: operation.revision + 1,
  };
};

const recordProcessStartUnknown: MutationHandler<"record_process_start_unknown"> = (operation, mutation) => {
  invariant(operation.dispatch.kind === "claimed" && operation.providerProcessStart.kind === "pending" && operation.providerExecution.kind === "not_started", "unknown start applies only to the one pending custody reservation");
  return {
    ...operation,
    output: { chunks: operation.output.chunks, fence: { finalCursor: operation.output.chunks.length, kind: "fenced" } },
    operationCutoff: closeOperationCutoffForContinuity(operation, mutation.evidenceId),
    physicalContainment: { evidenceId: mutation.evidenceId, kind: "uncertain" },
    providerProcessStart: { evidenceId: mutation.evidenceId, kind: "unknown" },
    reconciliation: { evidenceIds: [mutation.evidenceId], kind: "required" },
    revision: operation.revision + 1,
  };
};

const requestCancellation: MutationHandler<"request_cancellation"> = (operation, mutation) => {
  assertContainedTurnExactRecord("cancellation command", mutation.command, [
    "cancellationCommandId", "fingerprint", "operationId", "scopeDigest",
  ]);
  invariant(
    mutation.command.operationId === operation.operationId &&
      mutation.command.scopeDigest === containedTurnScopeDigest(operation.scope) &&
      mutation.command.fingerprint === containedTurnCancellationFingerprint(mutation.command),
    "cancellation command subject or canonical fingerprint mismatch",
  );
  if (operation.cancellation.kind === "requested") {
    validateContainedTurnProofBinding(operation, mutation.proof);
    validateContainedTurnProofBinding(operation, mutation.cutoffProof);
    invariant(
        operation.cancellation.command.cancellationCommandId === mutation.command.cancellationCommandId &&
        operation.cancellation.command.fingerprint === mutation.command.fingerprint &&
        operation.cancellation.proofId === mutation.proof.proofId && operation.operationCutoff.kind === "closed" &&
        operation.operationCutoff.reason === "cancellation" &&
        operation.operationCutoff.proofId === mutation.cutoffProof.proofId,
      "cancellation replay requires exact command and proof identity",
    );
    return operation;
  }
  invariant(
    mutation.cutoffProof.binding.cancellationCommandId === mutation.command.cancellationCommandId &&
      !operation.proofs.some(proof => proof.proofId === mutation.cutoffProof.proofId),
    "cancellation must append a fresh cutoff proof bound to the exact cancellation command",
  );
  return {
    ...operation,
    admissionFence: operation.admissionFence.kind === "fenced"
      ? operation.admissionFence
      : { kind: "fenced", proofId: mutation.cutoffProof.proofId },
    cancellation: { command: mutation.command, kind: "requested", proofId: mutation.proof.proofId },
    operationCutoff: {
      kind: "closed",
      proofId: mutation.cutoffProof.proofId,
      reason: "cancellation",
      revision: nextContainedTurnOperationCutoffRevision(operation.operationCutoff.revision),
    },
    output: operation.output.fence.kind === "open"
      ? { chunks: operation.output.chunks, fence: { finalCursor: operation.output.chunks.length, kind: "fenced" } }
      : operation.output,
    proofs: [...operation.proofs, mutation.proof, mutation.cutoffProof],
    revision: operation.revision + 1,
  };
};

// Each handler owns one atomic mutation; validation below remains the shared authority.
const mutationHandlers: { readonly [Kind in keyof MutationByKind]: MutationHandler<Kind> } = {
  bind_workspace: bindWorkspace,
  begin_closure_stage: beginClosureStage,
  note_closure_stage_unknown: noteClosureStageUnknown,
  refresh_containment_attestation_request: refreshContainmentAttestationRequest,
  complete_physical_containment: completePhysicalContainment,
  complete_artifact_seal: completeArtifactSeal,
  complete_workspace_close: completeWorkspaceClose,
  complete_containment_attestation: completeContainmentAttestation,
  claim_dispatch: claimDispatch,
  prevent_dispatch: preventDispatch,
  record_provider_acceptance: recordProviderAcceptance,
  close_provider_execution: closeProviderExecution,
  drain_output: drainOutput,
  resolve_effect: resolveEffect,
  seal_artifact: sealArtifact,
  publish_result: publishResult,
  close_workspace: closeWorkspace,
  record_containment: recordContainment,
  record_physical_containment: recordPhysicalContainment,
  record_physical_containment_unknown: recordPhysicalContainmentUnknown,
  finalize: finalize,
  record_ambiguity: recordAmbiguity,
  record_reconciliation_debt: recordReconciliationDebt,
  record_process_start: recordProcessStart,
  record_process_no_start: recordProcessNoStart,
  close_process_no_start: closeProcessNoStart,
  record_process_start_unknown: recordProcessStartUnknown,
  request_cancellation: requestCancellation,
};

const applyMutation = <Kind extends keyof MutationByKind>(
  operation: ContainedTurnKernelOperation,
  kind: Kind,
  mutation: MutationByKind[Kind],
): ContainedTurnKernelOperation => mutationHandlers[kind](operation, mutation);

export const mutateContainedTurnOperation = (
  operation: ContainedTurnKernelOperation,
  mutation: ContainedTurnKernelMutation,
): ContainedTurnKernelOperation => {
  validateContainedTurnKernelMutationShape(mutation);
  const candidate = applyMutation(operation, mutation.kind, mutation);
  if (candidate === operation) {return operation;}
  validateContainedTurnOperation(candidate, { previous: operation });
  return detachAndFreezeContainedTurnValue(candidate);
};
