import type { ContainedTurnClosureRequestId } from "../../../domain/contained-turn-closure-recovery.js";
import type { ContainedTurnCanonicalDigest } from "../../../domain/contained-turn-codecs.js";
import type {
  ContainedTurnEvidenceId,
  ContainedTurnOperationId,
  ContainedTurnWorkspaceId,
} from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOutputChunk } from "../../../domain/contained-turn-kernel.js";
import type { ContainedTurnProof } from "../../../domain/contained-turn-proofs.js";

export interface ContainedTurnClosureRequest {
  readonly authorityVectorDigest: ContainedTurnCanonicalDigest;
  readonly requestDigest: ContainedTurnCanonicalDigest;
  readonly requestId: ContainedTurnClosureRequestId;
}

export type EnsureContainedTurnClosureOutcome<Proof> =
  | { readonly kind: "proved"; readonly proof: Proof; readonly requestDigest: ContainedTurnCanonicalDigest; readonly requestId: ContainedTurnClosureRequestId }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "identity_conflict" };

export interface ContainedTurnKernelArtifactPort {
  ensureSealed(input: Readonly<ContainedTurnClosureRequest & {
    operationId: ContainedTurnOperationId;
    output: readonly ContainedTurnKernelOutputChunk[];
    workspaceId: ContainedTurnWorkspaceId;
  }>): Promise<EnsureContainedTurnClosureOutcome<Readonly<{
    artifactProof: Extract<ContainedTurnProof, { readonly kind: "artifact_manifest_seal" }>;
    resultProof: Extract<ContainedTurnProof, { readonly kind: "result_publication" }>;
  }>>>;
  querySeal(input: Readonly<ContainedTurnClosureRequest & { operationId: ContainedTurnOperationId; workspaceId: ContainedTurnWorkspaceId }>): Promise<EnsureContainedTurnClosureOutcome<Readonly<{
    artifactProof: Extract<ContainedTurnProof, { readonly kind: "artifact_manifest_seal" }>;
    resultProof: Extract<ContainedTurnProof, { readonly kind: "result_publication" }>;
  }>>>;
  seal(input: Readonly<{
    operationId: ContainedTurnOperationId;
    output: readonly ContainedTurnKernelOutputChunk[];
    workspaceId: ContainedTurnWorkspaceId;
  }>): Promise<Readonly<{
    artifactProof: Extract<ContainedTurnProof, { readonly kind: "artifact_manifest_seal" }>;
    kind: "sealed";
    resultProof: Extract<ContainedTurnProof, { readonly kind: "result_publication" }>;
  }> | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }>;
}
