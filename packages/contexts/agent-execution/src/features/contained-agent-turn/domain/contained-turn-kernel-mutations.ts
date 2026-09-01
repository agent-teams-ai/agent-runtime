import type { ContainedTurnCancellationCommand } from "./contained-turn-authority.js";
import type {
  ContainedTurnClosureRecovery,
  ContainedTurnClosureStage,
} from "./contained-turn-closure-recovery.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnCustodyId,
  ContainedTurnEvidenceId,
  ContainedTurnExecutionGenerationId,
  ContainedTurnHostBootId,
  ContainedTurnHostInstanceId,
  ContainedTurnPreparationToken,
  ContainedTurnWorkspaceId,
  ContainedTurnWriterFence,
} from "./contained-turn-identities.js";
import type { ContainedTurnProof } from "./contained-turn-proofs.js";
import { assertContainedTurnExactRecord } from "./contained-turn-record.js";

type PendingClosure = Extract<ContainedTurnClosureRecovery, { readonly kind: "required" }>;

export type ContainedTurnKernelMutation =
  | { readonly kind: "bind_workspace"; readonly workspaceId: ContainedTurnWorkspaceId }
  | { readonly kind: "begin_closure_stage"; readonly stage: ContainedTurnClosureStage }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "note_closure_stage_unknown"; readonly request: PendingClosure }
  | { readonly kind: "refresh_containment_attestation_request"; readonly request: PendingClosure }
  | { readonly kind: "complete_physical_containment"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "physical_containment" }>; readonly request: PendingClosure }
  | { readonly artifactManifestRef: string; readonly artifactProof: Extract<ContainedTurnProof, { readonly kind: "artifact_manifest_seal" }>; readonly kind: "complete_artifact_seal"; readonly request: PendingClosure; readonly resultProof: Extract<ContainedTurnProof, { readonly kind: "result_publication" }>; readonly resultRef: string }
  | { readonly kind: "complete_workspace_close"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "workspace_closure" }>; readonly request: PendingClosure }
  | { readonly kind: "complete_containment_attestation"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "containment" }>; readonly request: PendingClosure }
  | {
    readonly attemptId: ContainedTurnAttemptId; readonly custodyId: ContainedTurnCustodyId;
    readonly claimProof: Extract<ContainedTurnProof, { readonly kind: "dispatch_claim" }>;
    readonly cutoffProof: Extract<ContainedTurnProof, { readonly kind: "cutoff" }>;
    readonly executionGenerationId: ContainedTurnExecutionGenerationId; readonly hostBootId: ContainedTurnHostBootId;
    readonly hostCustodyProof: Extract<ContainedTurnProof, { readonly kind: "host_custody" }>; readonly hostInstanceId: ContainedTurnHostInstanceId;
    readonly kind: "claim_dispatch";
    readonly preparationToken: ContainedTurnPreparationToken; readonly writerFence: ContainedTurnWriterFence;
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
  | { readonly executionProof: Extract<ContainedTurnProof, { readonly kind: "execution_closure" }>; readonly kind: "close_provider_execution"; readonly terminalObservationProof: Extract<ContainedTurnProof, { readonly kind: "provider_terminal_observation" }> }
  | { readonly kind: "drain_output"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "output_drain" }> }
  | { readonly kind: "resolve_effect"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "effect_resolution" }> }
  | { readonly artifactManifestRef: string; readonly kind: "seal_artifact"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "artifact_manifest_seal" }> }
  | { readonly kind: "publish_result"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "result_publication" }>; readonly resultRef: string }
  | { readonly kind: "close_workspace"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "workspace_closure" }> }
  | { readonly kind: "record_containment"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "containment" }> }
  | { readonly kind: "finalize"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "terminal_truth" }> }
  | { readonly kind: "record_ambiguity"; readonly evidenceId: ContainedTurnEvidenceId }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "record_reconciliation_debt"; readonly source: "artifact" | "containment" | "dispatch_authority" | "store_commit" | "workspace" }
  | { readonly kind: "record_process_start"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "provider_process_start" }> }
  | { readonly kind: "record_process_no_start"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "provider_process_no_start" }> }
  | { readonly kind: "record_physical_containment"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "physical_containment" }> }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "record_physical_containment_unknown" }
  | {
    readonly containmentProof: Extract<ContainedTurnProof, { readonly kind: "containment_not_required" }>;
    readonly effectProof: Extract<ContainedTurnProof, { readonly kind: "effect_no_start" }>;
    readonly executionProof: Extract<ContainedTurnProof, { readonly kind: "no_start" }>;
    readonly kind: "close_process_no_start";
    readonly outputProof: Extract<ContainedTurnProof, { readonly kind: "output_no_start_drain" }>;
    readonly providerProof: Extract<ContainedTurnProof, { readonly kind: "provider_not_started" }>;
  }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "record_process_start_unknown" }
  | { readonly command: ContainedTurnCancellationCommand; readonly cutoffProof: Extract<ContainedTurnProof, { readonly kind: "cutoff" }>; readonly kind: "request_cancellation"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "cancellation" }> };

export const validateContainedTurnKernelMutationShape = (mutation: ContainedTurnKernelMutation): void => {
  const fieldsByKind: Readonly<Record<ContainedTurnKernelMutation["kind"], readonly string[]>> = {
    bind_workspace: ["kind", "workspaceId"],
    begin_closure_stage: ["kind", "stage"],
    note_closure_stage_unknown: ["evidenceId", "kind", "request"],
    refresh_containment_attestation_request: ["kind", "request"],
    complete_physical_containment: ["kind", "proof", "request"],
    complete_artifact_seal: ["artifactManifestRef", "artifactProof", "kind", "request", "resultProof", "resultRef"],
    complete_workspace_close: ["kind", "proof", "request"],
    complete_containment_attestation: ["kind", "proof", "request"],
    claim_dispatch: ["attemptId", "claimProof", "custodyId", "cutoffProof", "executionGenerationId", "hostBootId", "hostCustodyProof", "hostInstanceId", "kind", "preparationToken", "providerAccessDispatchProof", "runtimeSecurityDispatchProof", "writerFence"],
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
    record_physical_containment: ["kind", "proof"],
    record_physical_containment_unknown: ["evidenceId", "kind"],
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
