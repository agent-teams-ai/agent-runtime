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
  ContainedTurnCommandId,
  ContainedTurnEffectId,
  ContainedTurnEvidenceId,
  ContainedTurnOperationId,
  ContainedTurnWorkspaceId,
} from "./contained-turn-identities.js";
import { containedTurnInvariant as invariant } from "./contained-turn-invariant.js";
import type { ContainedTurnKernelOperation, ContainedTurnKernelOutputChunk } from "./contained-turn-kernel-model.js";
import type { ContainedTurnSchemaVersion } from "./contained-turn-limits.js";
import type { ContainedTurnProof } from "./contained-turn-proofs.js";
import { validateContainedTurnOperation } from "./contained-turn-validation.js";

export interface CreateContainedTurnOperationInput {
  readonly acceptanceProof: Extract<ContainedTurnProof, { readonly kind: "acceptance" }>;
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
  const operation: ContainedTurnKernelOperation = Object.freeze({
    acceptedAuthorityVector: input.acceptedAuthorityVector,
    acceptedAuthorityVectorDigest: containedTurnAuthorityVectorDigest(input.acceptedAuthorityVector),
    adapterSnapshot: input.adapterSnapshot,
    admissionFence: Object.freeze({ kind: "open" }),
    cancellation: Object.freeze({ kind: "open" }),
    capabilityManifest: input.capabilityManifest,
    commandFingerprint: containedTurnCommandFingerprint({ intent: input.intent, provider: input.adapterSnapshot.provider, scope: input.scope }),
    commandId: input.commandId,
    containment: Object.freeze({ kind: "not_requested" }),
    dispatch: Object.freeze({ kind: "unclaimed" }),
    effect: Object.freeze({ kind: "unresolved" }),
    effectId: input.effectId,
    intent: input.intent,
    operationId: input.operationId,
    output: Object.freeze({ chunks: Object.freeze([]), fence: Object.freeze({ kind: "open" }) }),
    proofs: Object.freeze([input.acceptanceProof]),
    providerAccessSnapshot: input.providerAccessSnapshot,
    providerProcessStart: Object.freeze({ kind: "unobserved" }),
    providerAcceptance: Object.freeze({ kind: "unobserved" }),
    providerExecution: Object.freeze({ kind: "not_started" }),
    reconciliation: Object.freeze({ kind: "clear" }),
    revision: 0,
    schemaVersion: input.schemaVersion,
    scope: input.scope,
    terminal: Object.freeze({ kind: "open" }),
  });
  validateContainedTurnOperation(operation);
  return operation;
};

export type ContainedTurnKernelMutation =
  | { readonly kind: "append_output"; readonly output: ContainedTurnKernelOutputChunk }
  | { readonly kind: "bind_workspace"; readonly workspaceId: ContainedTurnWorkspaceId }
  | { readonly kind: "record_ambiguity"; readonly evidenceId: ContainedTurnEvidenceId }
  | { readonly kind: "record_process_start"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "provider_process_start" }> }
  | { readonly kind: "record_process_no_start"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "provider_process_no_start" }> }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "record_process_start_unknown" }
  | {
    readonly command: ContainedTurnCancellationCommand;
    readonly cutoffProof: Extract<ContainedTurnProof, { readonly kind: "cutoff" }>;
    readonly kind: "request_cancellation";
    readonly proof: Extract<ContainedTurnProof, { readonly kind: "cancellation" }>;
  };

// The count is the closed mutation vocabulary over orthogonal axes, not a lifecycle state machine.
// oxlint-disable-next-line complexity
export const mutateContainedTurnOperation = (
  operation: ContainedTurnKernelOperation,
  mutation: ContainedTurnKernelMutation,
): ContainedTurnKernelOperation => {
  let candidate: ContainedTurnKernelOperation;
  switch (mutation.kind) {
    case "append_output":
      candidate = { ...operation, output: { chunks: [...operation.output.chunks, mutation.output], fence: operation.output.fence }, revision: operation.revision + 1 };
      break;
    case "bind_workspace":
      candidate = { ...operation, revision: operation.revision + 1, workspaceId: mutation.workspaceId };
      break;
    case "record_ambiguity":
      invariant(operation.dispatch.kind === "claimed", "provider ambiguity requires an existing dispatch claim");
      candidate = {
        ...operation,
        containment: { evidenceId: mutation.evidenceId, kind: "uncertain" },
        effect: { evidenceId: mutation.evidenceId, kind: "ambiguous" },
        output: { chunks: operation.output.chunks, fence: { finalCursor: operation.output.chunks.length, kind: "fenced" } },
        providerExecution: { evidenceId: mutation.evidenceId, kind: "unknown" },
        providerAcceptance: { evidenceId: mutation.evidenceId, kind: "unknown" },
        reconciliation: { evidenceIds: [mutation.evidenceId], kind: "required" },
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
      invariant(
        mutation.command.operationId === operation.operationId &&
          mutation.command.scopeDigest === containedTurnScopeDigest(operation.scope) &&
          mutation.command.fingerprint === containedTurnCancellationFingerprint(mutation.command),
        "cancellation command subject or canonical fingerprint mismatch",
      );
      if (operation.cancellation.kind === "requested") {
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
  return Object.freeze(candidate);
};
