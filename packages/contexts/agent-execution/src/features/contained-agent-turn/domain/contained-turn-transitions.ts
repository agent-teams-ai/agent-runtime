import {
  containedTurnAuthorityVectorDigest,
  containedTurnCancellationFingerprint,
  containedTurnCommandFingerprint,
  containedTurnScopeDigest,
  type ContainedTurnAuthorityVector,
  type ContainedTurnCancellationCommand,
  type ContainedTurnCapabilityManifest,
  type ContainedTurnIntent,
  type ContainedTurnProviderAccessSnapshot,
  type ContainedTurnProviderAdapterSnapshot,
  type ContainedTurnScope,
} from "./contained-turn-authority.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnCommandId,
  ContainedTurnCustodyId,
  ContainedTurnEffectId,
  ContainedTurnEvidenceId,
  ContainedTurnOperationId,
  ContainedTurnHostBootId,
  ContainedTurnHostInstanceId,
  ContainedTurnWorkspaceId,
} from "./contained-turn-identities.js";
import { containedTurnInvariant as invariant } from "./contained-turn-invariant.js";
import type { ContainedTurnKernelOperation, ContainedTurnKernelOutputChunk } from "./contained-turn-kernel-model.js";
import type { ContainedTurnSchemaVersion } from "./contained-turn-limits.js";
import type { ContainedTurnProof } from "./contained-turn-proofs.js";
import { assertContainedTurnExactRecord, detachAndFreezeContainedTurnValue } from "./contained-turn-record.js";
import { containedTurnSatisfactionDigest } from "./contained-turn-satisfaction.js";
import { validateContainedTurnProofBinding } from "./contained-turn-proof-validation.js";
import { validateContainedTurnOperation } from "./contained-turn-validation.js";

export interface CreateContainedTurnOperationInput {
  readonly acceptanceProof: Extract<ContainedTurnProof, { readonly kind: "acceptance" }>;
  readonly providerAccessAcceptanceProof: Extract<ContainedTurnProof, { readonly kind: "provider_access_acceptance" }>;
  readonly runtimeSecurityAcceptanceProof: Extract<ContainedTurnProof, { readonly kind: "runtime_security_acceptance" }>;
  readonly acceptedAuthorityVector: ContainedTurnAuthorityVector;
  readonly adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
  readonly capabilityManifest: ContainedTurnCapabilityManifest;
  readonly commandId: ContainedTurnCommandId;
  readonly effectId: ContainedTurnEffectId;
  readonly intent: ContainedTurnIntent;
  readonly operationId: ContainedTurnOperationId;
  readonly providerAccessSnapshot: ContainedTurnProviderAccessSnapshot;
  readonly schemaVersion: ContainedTurnSchemaVersion;
  readonly scope: ContainedTurnScope;
}

export const createContainedTurnOperation = (input: CreateContainedTurnOperationInput): ContainedTurnKernelOperation => {
  assertContainedTurnExactRecord("contained-turn acceptance input", input, [
    "acceptanceProof", "acceptedAuthorityVector", "adapterSnapshot", "capabilityManifest", "commandId",
    "effectId", "intent", "operationId", "providerAccessAcceptanceProof", "providerAccessSnapshot",
    "runtimeSecurityAcceptanceProof", "schemaVersion", "scope",
  ]);
  const detached = detachAndFreezeContainedTurnValue(input);
  const operation: ContainedTurnKernelOperation = {
    acceptedAuthorityVector: detached.acceptedAuthorityVector,
    acceptedAuthorityVectorDigest: containedTurnAuthorityVectorDigest(detached.acceptedAuthorityVector),
    adapterSnapshot: detached.adapterSnapshot,
    admissionFence: Object.freeze({ kind: "open" }),
    cancellation: Object.freeze({ kind: "open" }),
    capabilityManifest: detached.capabilityManifest,
    commandFingerprint: containedTurnCommandFingerprint({ intent: detached.intent, provider: detached.adapterSnapshot.provider, scope: detached.scope }),
    commandId: detached.commandId,
    containment: Object.freeze({ kind: "not_requested" }),
    dispatch: Object.freeze({ kind: "unclaimed" }),
    effect: Object.freeze({ kind: "unresolved" }),
    effectId: detached.effectId,
    intent: detached.intent,
    operationId: detached.operationId,
    output: Object.freeze({ chunks: Object.freeze([]), fence: Object.freeze({ kind: "open" }) }),
    proofs: Object.freeze([detached.acceptanceProof, detached.providerAccessAcceptanceProof, detached.runtimeSecurityAcceptanceProof]),
    providerAccessSnapshot: detached.providerAccessSnapshot,
    providerProcessStart: Object.freeze({ kind: "unobserved" }),
    providerAcceptance: Object.freeze({ kind: "unobserved" }),
    providerExecution: Object.freeze({ kind: "not_started" }),
    reconciliation: Object.freeze({ kind: "clear" }),
    revision: 0,
    schemaVersion: detached.schemaVersion,
    scope: detached.scope,
    terminal: Object.freeze({ kind: "open" }),
  };
  validateContainedTurnOperation(operation);
  return detachAndFreezeContainedTurnValue(operation);
};

export type ContainedTurnKernelMutation =
  | { readonly kind: "append_output"; readonly output: ContainedTurnKernelOutputChunk }
  | { readonly kind: "bind_workspace"; readonly workspaceId: ContainedTurnWorkspaceId }
  | {
    readonly attemptId: ContainedTurnAttemptId;
    readonly claimProof: Extract<ContainedTurnProof, { readonly kind: "dispatch_claim" }>;
    readonly custodyId: ContainedTurnCustodyId;
    readonly cutoffProof: Extract<ContainedTurnProof, { readonly kind: "cutoff" }>;
    readonly hostBootId: ContainedTurnHostBootId;
    readonly hostCustodyProof: Extract<ContainedTurnProof, { readonly kind: "host_custody" }>;
    readonly hostInstanceId: ContainedTurnHostInstanceId;
    readonly kind: "claim_dispatch";
    readonly providerAccessDispatchProof: Extract<ContainedTurnProof, { readonly kind: "provider_access_dispatch" }>;
    readonly runtimeSecurityDispatchProof: Extract<ContainedTurnProof, { readonly kind: "runtime_security_dispatch" }>;
  }
  | {
    readonly containmentProof: Extract<ContainedTurnProof, { readonly kind: "containment_not_required" }>;
    readonly cutoffProof: Extract<ContainedTurnProof, { readonly kind: "cutoff" }>;
    readonly effectProof: Extract<ContainedTurnProof, { readonly kind: "effect_no_start" }>;
    readonly executionProof: Extract<ContainedTurnProof, { readonly kind: "no_start" }>;
    readonly hostCustodyProof: Extract<ContainedTurnProof, { readonly kind: "host_custody_no_start" }>;
    readonly kind: "prevent_dispatch";
    readonly noDispatchProof: Extract<ContainedTurnProof, { readonly kind: "no_dispatch" }>;
    readonly outputProof: Extract<ContainedTurnProof, { readonly kind: "output_no_start_drain" }>;
    readonly providerProof: Extract<ContainedTurnProof, { readonly kind: "provider_not_started" }>;
  }
  | { readonly kind: "record_provider_acceptance"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "provider_acceptance" }> }
  | {
    readonly executionProof: Extract<ContainedTurnProof, { readonly kind: "execution_closure" }>;
    readonly kind: "close_provider_execution";
    readonly terminalObservationProof: Extract<ContainedTurnProof, { readonly kind: "provider_terminal_observation" }>;
  }
  | { readonly kind: "drain_output"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "output_drain" }> }
  | { readonly kind: "resolve_effect"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "effect_resolution" }> }
  | { readonly artifactManifestRef: string; readonly kind: "seal_artifact"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "artifact_manifest_seal" }> }
  | { readonly kind: "publish_result"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "result_publication" }>; readonly resultRef: string }
  | { readonly kind: "close_workspace"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "workspace_closure" }> }
  | { readonly kind: "record_containment"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "containment" }> }
  | { readonly kind: "finalize"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "terminal_truth" }> }
  | { readonly kind: "record_ambiguity"; readonly evidenceId: ContainedTurnEvidenceId }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "record_reconciliation_debt"; readonly source: "artifact" | "containment" | "store_commit" | "workspace" }
  | { readonly kind: "record_process_start"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "provider_process_start" }> }
  | { readonly kind: "record_process_no_start"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "provider_process_no_start" }> }
  | {
    readonly containmentProof: Extract<ContainedTurnProof, { readonly kind: "containment_not_required" }>;
    readonly effectProof: Extract<ContainedTurnProof, { readonly kind: "effect_no_start" }>;
    readonly executionProof: Extract<ContainedTurnProof, { readonly kind: "no_start" }>;
    readonly kind: "close_process_no_start";
    readonly outputProof: Extract<ContainedTurnProof, { readonly kind: "output_no_start_drain" }>;
    readonly providerProof: Extract<ContainedTurnProof, { readonly kind: "provider_not_started" }>;
  }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "record_process_start_unknown" }
  | {
    readonly command: ContainedTurnCancellationCommand;
    readonly cutoffProof: Extract<ContainedTurnProof, { readonly kind: "cutoff" }>;
    readonly kind: "request_cancellation";
    readonly proof: Extract<ContainedTurnProof, { readonly kind: "cancellation" }>;
  };

const validateMutationShape = (mutation: ContainedTurnKernelMutation): void => {
  const fieldsByKind: Readonly<Record<ContainedTurnKernelMutation["kind"], readonly string[]>> = {
    append_output: ["kind", "output"],
    bind_workspace: ["kind", "workspaceId"],
    claim_dispatch: ["attemptId", "claimProof", "custodyId", "cutoffProof", "hostBootId", "hostCustodyProof", "hostInstanceId", "kind", "providerAccessDispatchProof", "runtimeSecurityDispatchProof"],
    close_process_no_start: ["containmentProof", "effectProof", "executionProof", "kind", "outputProof", "providerProof"],
    close_provider_execution: ["executionProof", "kind", "terminalObservationProof"],
    close_workspace: ["kind", "proof"],
    drain_output: ["kind", "proof"],
    finalize: ["kind", "proof"],
    prevent_dispatch: ["containmentProof", "cutoffProof", "effectProof", "executionProof", "hostCustodyProof", "kind", "noDispatchProof", "outputProof", "providerProof"],
    publish_result: ["kind", "proof", "resultRef"],
    record_ambiguity: ["evidenceId", "kind"],
    record_reconciliation_debt: ["evidenceId", "kind", "source"],
    record_containment: ["kind", "proof"],
    record_process_no_start: ["kind", "proof"],
    record_process_start: ["kind", "proof"],
    record_process_start_unknown: ["evidenceId", "kind"],
    record_provider_acceptance: ["kind", "proof"],
    request_cancellation: ["command", "cutoffProof", "kind", "proof"],
    resolve_effect: ["kind", "proof"],
    seal_artifact: ["artifactManifestRef", "kind", "proof"],
  };
  assertContainedTurnExactRecord("contained-turn transition", mutation, fieldsByKind[mutation.kind]);
};

// The count is the closed mutation vocabulary over orthogonal axes, not a lifecycle state machine.
// oxlint-disable-next-line complexity, max-lines-per-function
export const mutateContainedTurnOperation = (
  operation: ContainedTurnKernelOperation,
  mutation: ContainedTurnKernelMutation,
): ContainedTurnKernelOperation => {
  validateMutationShape(mutation);
  let candidate: ContainedTurnKernelOperation;
  switch (mutation.kind) {
    case "append_output":
      candidate = { ...operation, output: { chunks: [...operation.output.chunks, mutation.output], fence: operation.output.fence }, revision: operation.revision + 1 };
      break;
    case "bind_workspace":
      candidate = { ...operation, revision: operation.revision + 1, workspaceId: mutation.workspaceId };
      break;
    case "claim_dispatch":
      invariant(operation.dispatch.kind === "unclaimed" && operation.workspaceId !== undefined && operation.cancellation.kind === "open", "dispatch claim requires one uncancelled, workspace-bound operation");
      candidate = {
        ...operation,
        admissionFence: { kind: "fenced", proofId: mutation.cutoffProof.proofId },
        containment: { attemptId: mutation.attemptId, kind: "pending" },
        custodyId: mutation.custodyId,
        dispatch: {
          attemptId: mutation.attemptId,
          claimProofId: mutation.claimProof.proofId,
          kind: "claimed",
          providerAccessDispatchProofId: mutation.providerAccessDispatchProof.proofId,
          runtimeSecurityDispatchProofId: mutation.runtimeSecurityDispatchProof.proofId,
        },
        hostBootId: mutation.hostBootId,
        hostInstanceId: mutation.hostInstanceId,
        proofs: [...operation.proofs, mutation.providerAccessDispatchProof, mutation.runtimeSecurityDispatchProof, mutation.cutoffProof, mutation.claimProof, mutation.hostCustodyProof],
        providerProcessStart: { attemptId: mutation.attemptId, kind: "pending" },
        revision: operation.revision + 1,
      };
      break;
    case "prevent_dispatch":
      invariant(operation.dispatch.kind === "unclaimed", "dispatch prevention must atomically win before claim");
      candidate = {
        ...operation,
        admissionFence: { kind: "fenced", proofId: mutation.cutoffProof.proofId },
        containment: { kind: "qualified_not_required", proofId: mutation.containmentProof.proofId },
        dispatch: { kind: "prevented", noDispatchProofId: mutation.noDispatchProof.proofId },
        effect: { disposition: "not_committed", kind: "resolved", proofId: mutation.effectProof.proofId },
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
      break;
    case "record_provider_acceptance":
      invariant(operation.providerProcessStart.kind === "execution_started" && operation.providerAcceptance.kind === "unobserved", "provider acceptance follows exact process start once");
      candidate = { ...operation, proofs: [...operation.proofs, mutation.proof], providerAcceptance: { kind: mutation.proof.binding.disposition, proofId: mutation.proof.proofId }, revision: operation.revision + 1 };
      break;
    case "close_provider_execution":
      invariant(operation.providerExecution.kind === "active" && operation.providerAcceptance.kind !== "unobserved", "provider closure follows active, acceptance-observed execution");
      invariant(mutation.executionProof.binding.outcome === mutation.terminalObservationProof.binding.outcome, "execution and provider terminal outcomes must agree");
      candidate = { ...operation, proofs: [...operation.proofs, mutation.executionProof, mutation.terminalObservationProof], providerExecution: { kind: "closed", outcome: mutation.executionProof.binding.outcome, proofId: mutation.executionProof.proofId }, revision: operation.revision + 1 };
      break;
    case "drain_output":
      invariant(operation.providerExecution.kind === "closed" && operation.output.fence.kind === "open", "output drains once after provider closure");
      candidate = { ...operation, output: { chunks: operation.output.chunks, fence: { finalCursor: operation.output.chunks.length, kind: "fenced", proofId: mutation.proof.proofId } }, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1 };
      break;
    case "resolve_effect":
      invariant(operation.providerExecution.kind === "closed" && operation.effect.kind === "unresolved", "effect resolves once after execution closure");
      candidate = { ...operation, effect: { disposition: mutation.proof.binding.disposition, kind: "resolved", proofId: mutation.proof.proofId }, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1 };
      break;
    case "seal_artifact":
      invariant(operation.workspaceId !== undefined && operation.output.fence.kind === "fenced" && operation.artifactManifestRef === undefined, "artifact seals once after output drain");
      candidate = { ...operation, artifactManifestRef: mutation.artifactManifestRef, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1 };
      break;
    case "publish_result":
      invariant(operation.artifactManifestRef !== undefined && operation.resultRef === undefined, "result publishes once after artifact seal");
      candidate = { ...operation, proofs: [...operation.proofs, mutation.proof], resultRef: mutation.resultRef, revision: operation.revision + 1 };
      break;
    case "close_workspace":
      invariant(operation.workspaceId !== undefined && operation.resultRef !== undefined, "workspace closure follows result publication");
      candidate = { ...operation, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1 };
      break;
    case "record_containment":
      invariant(operation.containment.kind === "pending", "containment closure records independently exactly once");
      candidate = { ...operation, containment: { kind: "contained", proofId: mutation.proof.proofId }, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1 };
      break;
    case "finalize": {
      invariant(operation.terminal.kind === "open" && operation.providerExecution.kind === "closed", "terminal truth closes once after execution closure");
      const digest = containedTurnSatisfactionDigest(operation);
      invariant(mutation.proof.binding.satisfactionDigest === digest && mutation.proof.binding.terminalOutcome === operation.providerExecution.outcome, "terminal proof must bind the recomputed satisfaction state");
      candidate = { ...operation, proofs: [...operation.proofs, mutation.proof], revision: operation.revision + 1, terminal: { kind: "final", outcome: operation.providerExecution.outcome, satisfactionDigest: digest, terminalProofId: mutation.proof.proofId } };
      break;
    }
    case "record_ambiguity":
      invariant(operation.dispatch.kind === "claimed", "provider ambiguity requires an existing dispatch claim");
      candidate = {
        ...operation,
        containment: operation.containment.kind === "uncertain"
          ? operation.containment
          : { evidenceId: mutation.evidenceId, kind: "uncertain" },
        effect: { evidenceId: mutation.evidenceId, kind: "ambiguous" },
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
      break;
    case "record_reconciliation_debt":
      invariant(operation.terminal.kind === "open", "reconciliation debt cannot rewrite terminal truth");
      candidate = {
        ...operation,
        containment: mutation.source === "containment" && operation.containment.kind === "pending"
          ? { evidenceId: mutation.evidenceId, kind: "uncertain" }
          : operation.containment,
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
      break;
    case "record_process_start":
      invariant(operation.dispatch.kind === "claimed" && operation.providerProcessStart.kind === "pending" && operation.providerExecution.kind === "not_started", "only one pending custody reservation can record actual process start");
      candidate = {
        ...operation,
        proofs: [...operation.proofs, mutation.proof],
        providerExecution: { attemptId: operation.dispatch.attemptId, kind: "active" },
        providerProcessStart: { kind: "execution_started", proofId: mutation.proof.proofId },
        revision: operation.revision + 1,
      };
      break;
    case "record_process_no_start":
      invariant(operation.dispatch.kind === "claimed" && operation.providerProcessStart.kind === "pending" && operation.providerExecution.kind === "not_started", "proved no-start applies only to the one pending custody reservation");
      candidate = {
        ...operation,
        proofs: [...operation.proofs, mutation.proof],
        providerProcessStart: { kind: "proved_no_start", proofId: mutation.proof.proofId },
        revision: operation.revision + 1,
      };
      break;
    case "close_process_no_start":
      invariant(
        operation.dispatch.kind === "claimed" && operation.providerProcessStart.kind === "proved_no_start" &&
          operation.providerExecution.kind === "not_started" && operation.providerAcceptance.kind === "unobserved" &&
          operation.output.fence.kind === "open" && operation.effect.kind === "unresolved" &&
          operation.containment.kind === "pending",
        "proved process no-start closes its remaining axes exactly once",
      );
      candidate = {
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
      break;
    case "record_process_start_unknown":
      invariant(operation.dispatch.kind === "claimed" && operation.providerProcessStart.kind === "pending" && operation.providerExecution.kind === "not_started", "unknown start applies only to the one pending custody reservation");
      candidate = {
        ...operation,
        output: { chunks: operation.output.chunks, fence: { finalCursor: operation.output.chunks.length, kind: "fenced" } },
        providerProcessStart: { evidenceId: mutation.evidenceId, kind: "unknown" },
        reconciliation: { evidenceIds: [mutation.evidenceId], kind: "required" },
        revision: operation.revision + 1,
      };
      break;
    case "request_cancellation":
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
            operation.cancellation.proofId === mutation.proof.proofId && operation.admissionFence.kind === "fenced" &&
            operation.admissionFence.proofId === mutation.cutoffProof.proofId,
          "cancellation replay requires exact command and proof identity",
        );
        return operation;
      }
      if (operation.admissionFence.kind === "fenced") {
        invariant(
          operation.admissionFence.proofId === mutation.cutoffProof.proofId &&
            operation.proofs.some(proof => proof.kind === "cutoff" && proof.proofId === mutation.cutoffProof.proofId),
          "post-dispatch cancellation must preserve the exact persisted admission fence",
        );
      } else {
        invariant(
          mutation.cutoffProof.binding.cancellationCommandId === mutation.command.cancellationCommandId,
          "a cancellation-created cutoff must bind the exact cancellation command",
        );
      }
      candidate = {
        ...operation,
        admissionFence: operation.admissionFence.kind === "fenced"
          ? operation.admissionFence
          : { kind: "fenced", proofId: mutation.cutoffProof.proofId },
        cancellation: { command: mutation.command, kind: "requested", proofId: mutation.proof.proofId },
        proofs: operation.admissionFence.kind === "fenced"
          ? [...operation.proofs, mutation.proof]
          : [...operation.proofs, mutation.proof, mutation.cutoffProof],
        revision: operation.revision + 1,
      };
      break;
  }
  validateContainedTurnOperation(candidate, { previous: operation });
  return detachAndFreezeContainedTurnValue(candidate);
};
