import type {
  ContainedTurnAuthorityVector,
  ContainedTurnCancellationCommand,
  ContainedTurnCapabilityManifest,
  ContainedTurnIntent,
  ContainedTurnProviderAccessSnapshot,
  ContainedTurnProviderAdapterSnapshot,
  ContainedTurnScope,
} from "./contained-turn-authority.js";
import type {
  ContainedTurnCanonicalDigest,
  ContainedTurnCommandFingerprint,
} from "./contained-turn-codecs.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnCommandId,
  ContainedTurnCustodyId,
  ContainedTurnEffectId,
  ContainedTurnEvidenceId,
  ContainedTurnHostBootId,
  ContainedTurnHostInstanceId,
  ContainedTurnOperationId,
  ContainedTurnProofId,
  ContainedTurnWorkspaceId,
} from "./contained-turn-identities.js";
import type { ContainedTurnSchemaVersion } from "./contained-turn-limits.js";
import type { ContainedTurnProof } from "./contained-turn-proofs.js";

export type ContainedTurnKernelOutputKind = "assistant" | "diagnostic" | "progress";

export interface ContainedTurnKernelOutputChunk {
  readonly cursor: number;
  readonly kind: ContainedTurnKernelOutputKind;
  readonly text: string;
}

export interface ContainedTurnKernelOperation {
  readonly acceptedAuthorityVector: ContainedTurnAuthorityVector;
  readonly acceptedAuthorityVectorDigest: ContainedTurnCanonicalDigest;
  readonly adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
  readonly admissionFence:
    | { readonly kind: "open" }
    | { readonly kind: "fenced"; readonly proofId: ContainedTurnProofId };
  readonly artifactManifestRef?: string;
  readonly cancellation:
    | { readonly kind: "open" }
    | { readonly command: ContainedTurnCancellationCommand; readonly kind: "requested"; readonly proofId: ContainedTurnProofId };
  readonly capabilityManifest: ContainedTurnCapabilityManifest;
  readonly commandFingerprint: ContainedTurnCommandFingerprint;
  readonly commandId: ContainedTurnCommandId;
  readonly containment:
    | { readonly kind: "not_requested" }
    | { readonly attemptId: ContainedTurnAttemptId; readonly kind: "pending" }
    | { readonly kind: "contained"; readonly proofId: ContainedTurnProofId }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "uncertain" }
    | { readonly kind: "qualified_not_required"; readonly proofId: ContainedTurnProofId };
  readonly custodyId?: ContainedTurnCustodyId;
  readonly dispatch:
    | { readonly kind: "unclaimed" }
    | {
      readonly attemptId: ContainedTurnAttemptId;
      readonly claimProofId: ContainedTurnProofId;
      readonly kind: "claimed";
      readonly providerAccessDispatchProofId: ContainedTurnProofId;
      readonly runtimeSecurityDispatchProofId: ContainedTurnProofId;
    }
    | { readonly noDispatchProofId: ContainedTurnProofId; readonly kind: "prevented" };
  readonly effect:
    | { readonly kind: "unresolved" }
    | { readonly disposition: "committed" | "not_committed"; readonly kind: "resolved"; readonly proofId: ContainedTurnProofId }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "ambiguous" };
  readonly effectId: ContainedTurnEffectId;
  readonly hostBootId?: ContainedTurnHostBootId;
  readonly hostInstanceId?: ContainedTurnHostInstanceId;
  readonly intent: ContainedTurnIntent;
  readonly operationId: ContainedTurnOperationId;
  readonly output: Readonly<{
    chunks: readonly ContainedTurnKernelOutputChunk[];
    fence: { readonly kind: "open" } | { readonly finalCursor: number; readonly kind: "fenced"; readonly proofId?: ContainedTurnProofId };
  }>;
  readonly proofs: readonly ContainedTurnProof[];
  readonly providerAccessSnapshot: ContainedTurnProviderAccessSnapshot;
  /**
   * Host Custody's provider-neutral observation of the sole process/session
   * start. A dispatch claim reserves one attempt; it does not imply start.
   */
  readonly providerProcessStart:
    | { readonly kind: "unobserved" }
    | { readonly attemptId: ContainedTurnAttemptId; readonly kind: "pending" }
    | { readonly kind: "execution_started"; readonly proofId: ContainedTurnProofId }
    | { readonly kind: "proved_no_start"; readonly proofId: ContainedTurnProofId }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "unknown" };
  readonly providerAcceptance:
    | { readonly kind: "unobserved" }
    | { readonly kind: "accepted"; readonly proofId: ContainedTurnProofId }
    | { readonly kind: "not_accepted"; readonly proofId: ContainedTurnProofId }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "unknown" };
  readonly providerExecution:
    | { readonly kind: "not_started" }
    | { readonly attemptId: ContainedTurnAttemptId; readonly kind: "active" }
    | { readonly kind: "closed"; readonly outcome: "cancelled" | "failed" | "succeeded"; readonly proofId: ContainedTurnProofId }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "unknown" };
  readonly reconciliation:
    | { readonly kind: "clear" }
    | { readonly evidenceIds: readonly ContainedTurnEvidenceId[]; readonly kind: "required" };
  readonly resultRef?: string;
  readonly revision: number;
  readonly schemaVersion: ContainedTurnSchemaVersion;
  readonly scope: ContainedTurnScope;
  readonly terminal:
    | { readonly kind: "open" }
    | {
      readonly kind: "final";
      readonly outcome: "cancelled" | "failed" | "succeeded";
      readonly satisfactionDigest: ContainedTurnCanonicalDigest;
      readonly terminalProofId: ContainedTurnProofId;
    };
  readonly workspaceId?: ContainedTurnWorkspaceId;
}
