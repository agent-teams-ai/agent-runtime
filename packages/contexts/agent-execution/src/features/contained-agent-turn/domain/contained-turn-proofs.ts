import type {
  ContainedTurnCancellationFingerprint,
  ContainedTurnCanonicalDigest,
  ContainedTurnCommandFingerprint,
} from "./contained-turn-codecs.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnCancellationCommandId,
  ContainedTurnCommandId,
  ContainedTurnCustodyId,
  ContainedTurnEffectId,
  ContainedTurnHostBootId,
  ContainedTurnHostInstanceId,
  ContainedTurnOperationId,
  ContainedTurnProofId,
  ContainedTurnWorkspaceId,
} from "./contained-turn-identities.js";
import type { ContainedTurnRequiredReceiptSetVersion } from "./contained-turn-required-receipts.js";

export type ContainedTurnProofKind =
  | "acceptance"
  | "artifact_manifest_seal"
  | "cancellation"
  | "containment"
  | "containment_not_required"
  | "cutoff"
  | "dispatch_claim"
  | "effect_resolution"
  | "effect_no_start"
  | "execution_closure"
  | "host_custody"
  | "host_custody_no_start"
  | "no_dispatch"
  | "no_start"
  | "output_drain"
  | "output_no_start_drain"
  | "physical_containment"
  | "provider_process_no_start"
  | "provider_process_start"
  | "provider_access_acceptance"
  | "provider_access_dispatch"
  | "provider_not_started"
  | "provider_acceptance"
  | "provider_terminal_observation"
  | "result_publication"
  | "runtime_security_acceptance"
  | "runtime_security_dispatch"
  | "terminal_truth"
  | "workspace_closure";

interface ContainedTurnOperationProofBinding {
  readonly authorityVectorDigest: ContainedTurnCanonicalDigest;
  readonly operationId: ContainedTurnOperationId;
}

interface ContainedTurnAttemptProofBinding extends ContainedTurnOperationProofBinding {
  readonly attemptId: ContainedTurnAttemptId;
  readonly effectId: ContainedTurnEffectId;
}

export type ContainedTurnProof =
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly commandId: ContainedTurnCommandId; readonly commandFingerprint: ContainedTurnCommandFingerprint }; readonly kind: "acceptance"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly artifactManifestRef: string; readonly workspaceId: ContainedTurnWorkspaceId }; readonly kind: "artifact_manifest_seal"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly cancellationCommandId: ContainedTurnCancellationCommandId; readonly cancellationFingerprint: ContainedTurnCancellationFingerprint }; readonly kind: "cancellation"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & {
    readonly adapterRevision: string;
    readonly artifactManifestSealProofId: ContainedTurnProofId;
    readonly binaryRevision: string;
    readonly capabilityManifestRevision: string;
    readonly containmentPolicyDigest: ContainedTurnCanonicalDigest;
    readonly credentialBindingDigest: ContainedTurnCanonicalDigest;
    readonly custodyId: ContainedTurnCustodyId;
    readonly cutoffProofId: ContainedTurnProofId;
    readonly executionClosureProofId: ContainedTurnProofId;
    readonly finalCursor: number;
    readonly hostBootId: ContainedTurnHostBootId;
    readonly hostInstanceId: ContainedTurnHostInstanceId;
    readonly immutableScopeDigest: ContainedTurnCanonicalDigest;
    readonly outputDrainProofId: ContainedTurnProofId;
    readonly physicalContainmentProofId: ContainedTurnProofId;
    readonly providerRouteRef: string;
    readonly terminalObservationProofId: ContainedTurnProofId;
    readonly workspaceId: ContainedTurnWorkspaceId;
  }; readonly kind: "containment"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly effectId: ContainedTurnEffectId }; readonly kind: "containment_not_required"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly cancellationCommandId?: ContainedTurnCancellationCommandId }; readonly kind: "cutoff"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly providerAccessDispatchProofId: ContainedTurnProofId; readonly runtimeSecurityDispatchProofId: ContainedTurnProofId }; readonly kind: "dispatch_claim"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly disposition: "committed" | "not_committed" }; readonly kind: "effect_resolution"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly disposition: "not_committed"; readonly effectId: ContainedTurnEffectId }; readonly kind: "effect_no_start"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly outcome: "cancelled" | "failed" | "succeeded" }; readonly kind: "execution_closure"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly custodyId: ContainedTurnCustodyId }; readonly kind: "host_custody"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly effectId: ContainedTurnEffectId }; readonly kind: "host_custody_no_start"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly effectId: ContainedTurnEffectId }; readonly kind: "no_dispatch"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly effectId: ContainedTurnEffectId }; readonly kind: "no_start"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly finalCursor: number }; readonly kind: "output_drain"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly finalCursor: number }; readonly kind: "output_no_start_drain"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & {
    readonly custodyId: ContainedTurnCustodyId;
    readonly hostBootId: ContainedTurnHostBootId;
    readonly hostInstanceId: ContainedTurnHostInstanceId;
  }; readonly kind: "physical_containment"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly custodyId: ContainedTurnCustodyId; readonly hostBootId: ContainedTurnHostBootId; readonly hostInstanceId: ContainedTurnHostInstanceId }; readonly kind: "provider_process_no_start"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly custodyId: ContainedTurnCustodyId; readonly hostBootId: ContainedTurnHostBootId; readonly hostInstanceId: ContainedTurnHostInstanceId }; readonly kind: "provider_process_start"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly resolutionDigest: ContainedTurnCanonicalDigest; readonly snapshotDigest: ContainedTurnCanonicalDigest }; readonly kind: "provider_access_acceptance"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly acceptedSnapshotDigest: ContainedTurnCanonicalDigest; readonly resolutionDigest: ContainedTurnCanonicalDigest }; readonly kind: "provider_access_dispatch"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly effectId: ContainedTurnEffectId }; readonly kind: "provider_not_started"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly disposition: "accepted" | "not_accepted" }; readonly kind: "provider_acceptance"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly outcome: "cancelled" | "failed" | "succeeded" }; readonly kind: "provider_terminal_observation"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly resultRef: string }; readonly kind: "result_publication"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly securityAuthorityRevision: string; readonly securityDecisionDigest: ContainedTurnCanonicalDigest }; readonly kind: "runtime_security_acceptance"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly acceptedSecurityDecisionDigest: ContainedTurnCanonicalDigest; readonly currentSecurityDecisionDigest: ContainedTurnCanonicalDigest; readonly securityAuthorityRevision: string }; readonly kind: "runtime_security_dispatch"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & {
    readonly requiredReceiptSetDigest: ContainedTurnCanonicalDigest;
    readonly requiredReceiptSetVersion: ContainedTurnRequiredReceiptSetVersion;
    readonly satisfactionDigest: ContainedTurnCanonicalDigest;
    readonly terminalOutcome: "cancelled" | "failed" | "succeeded";
  }; readonly kind: "terminal_truth"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly workspaceId: ContainedTurnWorkspaceId }; readonly kind: "workspace_closure"; readonly proofId: ContainedTurnProofId };

export const CONTAINED_TURN_PROOF_KINDS = Object.freeze([
  "acceptance", "artifact_manifest_seal", "cancellation", "containment", "containment_not_required", "cutoff",
  "dispatch_claim", "effect_no_start", "effect_resolution", "execution_closure", "host_custody", "host_custody_no_start",
  "no_dispatch", "no_start", "output_drain", "output_no_start_drain", "physical_containment", "provider_acceptance", "provider_not_started",
  "provider_process_no_start", "provider_process_start", "provider_access_acceptance", "provider_access_dispatch",
  "provider_terminal_observation", "result_publication",
  "runtime_security_acceptance", "runtime_security_dispatch", "terminal_truth", "workspace_closure",
] as const satisfies readonly ContainedTurnProofKind[]);
