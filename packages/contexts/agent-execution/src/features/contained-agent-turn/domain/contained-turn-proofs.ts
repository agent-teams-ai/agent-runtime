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
  | "provider_process_no_start"
  | "provider_process_start"
  | "provider_not_started"
  | "provider_acceptance"
  | "provider_terminal_observation"
  | "result_publication"
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
    readonly providerRouteRef: string;
    readonly terminalObservationProofId: ContainedTurnProofId;
    readonly workspaceId: ContainedTurnWorkspaceId;
  }; readonly kind: "containment"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly effectId: ContainedTurnEffectId }; readonly kind: "containment_not_required"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly cancellationCommandId?: ContainedTurnCancellationCommandId }; readonly kind: "cutoff"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding; readonly kind: "dispatch_claim"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly disposition: "committed" | "not_committed" }; readonly kind: "effect_resolution"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly disposition: "not_committed"; readonly effectId: ContainedTurnEffectId }; readonly kind: "effect_no_start"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly outcome: "cancelled" | "failed" | "succeeded" }; readonly kind: "execution_closure"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly custodyId: ContainedTurnCustodyId }; readonly kind: "host_custody"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly effectId: ContainedTurnEffectId }; readonly kind: "host_custody_no_start"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly effectId: ContainedTurnEffectId }; readonly kind: "no_dispatch"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly effectId: ContainedTurnEffectId }; readonly kind: "no_start"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly finalCursor: number }; readonly kind: "output_drain"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly finalCursor: number }; readonly kind: "output_no_start_drain"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly custodyId: ContainedTurnCustodyId; readonly hostBootId: ContainedTurnHostBootId; readonly hostInstanceId: ContainedTurnHostInstanceId }; readonly kind: "provider_process_no_start"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly custodyId: ContainedTurnCustodyId; readonly hostBootId: ContainedTurnHostBootId; readonly hostInstanceId: ContainedTurnHostInstanceId }; readonly kind: "provider_process_start"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly effectId: ContainedTurnEffectId }; readonly kind: "provider_not_started"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly disposition: "accepted" | "not_accepted" }; readonly kind: "provider_acceptance"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnAttemptProofBinding & { readonly outcome: "cancelled" | "failed" | "succeeded" }; readonly kind: "provider_terminal_observation"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly resultRef: string }; readonly kind: "result_publication"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly satisfactionDigest: ContainedTurnCanonicalDigest; readonly terminalOutcome: "cancelled" | "failed" | "succeeded" }; readonly kind: "terminal_truth"; readonly proofId: ContainedTurnProofId }
  | { readonly binding: ContainedTurnOperationProofBinding & { readonly workspaceId: ContainedTurnWorkspaceId }; readonly kind: "workspace_closure"; readonly proofId: ContainedTurnProofId };

export const CONTAINED_TURN_PROOF_KINDS = Object.freeze([
  "acceptance", "artifact_manifest_seal", "cancellation", "containment", "containment_not_required", "cutoff",
  "dispatch_claim", "effect_no_start", "effect_resolution", "execution_closure", "host_custody", "host_custody_no_start",
  "no_dispatch", "no_start", "output_drain", "output_no_start_drain", "provider_acceptance", "provider_not_started",
  "provider_process_no_start", "provider_process_start",
  "provider_terminal_observation", "result_publication",
  "terminal_truth", "workspace_closure",
] as const satisfies readonly ContainedTurnProofKind[]);

const REQUIRED_KIND_BY_PROOF_KIND = Object.freeze({
  acceptance: "command_acceptance",
  artifact_manifest_seal: "artifact_manifest_seal",
  cancellation: "cancellation",
  containment: "containment_execution",
  containment_not_required: "containment_execution",
  cutoff: "cutoff_enforcement",
  dispatch_claim: "dispatch_authority",
  effect_no_start: "effect_resolution",
  effect_resolution: "effect_resolution",
  execution_closure: "execution_closure",
  host_custody: "host_custody",
  host_custody_no_start: "host_custody",
  no_dispatch: "dispatch_authority",
  no_start: "execution_closure",
  output_drain: "output_drain",
  output_no_start_drain: "output_drain",
  provider_process_no_start: "provider_process_start_observation",
  provider_process_start: "provider_process_start_observation",
  provider_acceptance: "provider_acceptance",
  provider_not_started: "provider_terminal_observation",
  provider_terminal_observation: "provider_terminal_observation",
  result_publication: "canonical_result_publication",
  terminal_truth: "terminal_truth",
  workspace_closure: "workspace_closure",
} as const satisfies Readonly<Record<ContainedTurnProofKind, string>>);

export const containedTurnRequiredKindForProof = (proof: ContainedTurnProof): string =>
  REQUIRED_KIND_BY_PROOF_KIND[proof.kind];
