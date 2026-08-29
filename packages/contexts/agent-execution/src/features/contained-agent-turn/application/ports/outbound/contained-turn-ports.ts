import type {
  ContainedTurnCancellationCommand,
  ContainedTurnProviderAdapterSnapshot,
  ContainedTurnCapabilityManifest,
  ContainedTurnIntent,
  ContainedTurnProvider,
  ContainedTurnProviderAccessSnapshot,
  ContainedTurnScope,
} from "../../../domain/contained-turn-authority.js";
import type {
  ContainedTurnCanonicalDigest,
  ContainedTurnCommandFingerprint,
} from "../../../domain/contained-turn-codecs.js";
import type {
  ContainedTurnKernelOperation,
  ContainedTurnKernelOutputChunk,
} from "../../../domain/contained-turn-kernel.js";
import type { ContainedTurnProof } from "../../../domain/contained-turn-proofs.js";
import type { ContainedTurnKernelMutation } from "../../../domain/contained-turn-transitions.js";
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
} from "../../../domain/contained-turn-identities.js";
import { assertContainedTurnExactRecord } from "../../../domain/contained-turn-record.js";

export type ResolveContainedTurnProviderAccessOutcome =
  | {
    readonly acceptanceResolutionDigest: ContainedTurnCanonicalDigest;
    readonly acceptanceProofId: ContainedTurnProofId;
    readonly kind: "resolved";
    readonly snapshot: ContainedTurnProviderAccessSnapshot;
  }
  | {
    readonly kind: "prevented";
    readonly preventionProofId: ContainedTurnProofId;
    readonly reason: "access_denied" | "credential_unavailable" | "route_unavailable";
  }
  | {
    readonly evidenceId: ContainedTurnEvidenceId;
    readonly kind: "indeterminate";
    readonly reason: "authority_unavailable" | "authority_unknown";
  };

export type RevalidateContainedTurnProviderAccessOutcome =
  | {
    readonly dispatchResolutionDigest: ContainedTurnCanonicalDigest;
    readonly dispatchProofId: ContainedTurnProofId;
    readonly kind: "current";
    readonly snapshot: ContainedTurnProviderAccessSnapshot;
  }
  | {
    readonly kind: "prevented";
    readonly preventionProofId: ContainedTurnProofId;
    readonly reason: "access_revoked" | "credential_changed" | "route_changed";
  }
  | {
    readonly evidenceId: ContainedTurnEvidenceId;
    readonly kind: "indeterminate";
    readonly reason: "authority_unavailable" | "authority_unknown";
  };

export interface ContainedTurnProviderAccessPort {
  resolveForAcceptance(input: Readonly<{
    intent: ContainedTurnIntent;
    provider: ContainedTurnProvider;
    scope: ContainedTurnScope;
  }>): Promise<ResolveContainedTurnProviderAccessOutcome>;
  revalidateForDispatch(input: Readonly<{
    acceptedSnapshot: ContainedTurnProviderAccessSnapshot;
    operationId: ContainedTurnOperationId;
    scope: ContainedTurnScope;
  }>): Promise<RevalidateContainedTurnProviderAccessOutcome>;
}

export type CommitContainedTurnKernelOperationOutcome =
  | { readonly kind: "applied"; readonly operation: ContainedTurnKernelOperation }
  /** The acknowledgement was lost; this is the separately committed durable debt state, never the uncertain candidate. */
  | { readonly debtOperation: ContainedTurnKernelOperation; readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  | { readonly kind: "not_found" }
  | { readonly current: ContainedTurnKernelOperation; readonly kind: "stale" };

export interface ContainedTurnDispatchAuthorityPrecondition {
  readonly acceptedProviderAccessSnapshotDigest: ContainedTurnCanonicalDigest;
  readonly acceptedSecurityDecisionDigest: ContainedTurnCanonicalDigest;
  readonly providerAccessDispatchProofId: ContainedTurnProofId;
  readonly providerAccessRevision: number;
  readonly runtimeSecurityDispatchProofId: ContainedTurnProofId;
  readonly securityAuthorityRevision: string;
}

export interface ContainedTurnKernelOperationStore {
  identifyAcceptance(input: Readonly<{
    commandFingerprint: ContainedTurnCommandFingerprint;
    commandId: ContainedTurnCommandId;
  }>): Promise<
    | {
      readonly acceptanceProofId: ContainedTurnProofId;
      readonly effectId: ContainedTurnEffectId;
      readonly kind: "available";
      readonly operationId: ContainedTurnOperationId;
      readonly operationAuthorityRevision: string;
    }
    | { readonly kind: "fingerprint_conflict" }
    | { readonly kind: "replayed"; readonly operation: ContainedTurnKernelOperation }
  >;
  prepareDispatch(operation: ContainedTurnKernelOperation): Promise<Readonly<{
    attemptId: ContainedTurnAttemptId;
    claimProofId: ContainedTurnProofId;
    custodyId: ContainedTurnCustodyId;
    cutoffProofId: ContainedTurnProofId;
  }>>;
  proofsForPrevention(input: Readonly<{
    operation: ContainedTurnKernelOperation;
    preventionProofId: ContainedTurnProofId;
  }>): Promise<Omit<Extract<ContainedTurnKernelMutation, { readonly kind: "prevent_dispatch" }>, "kind">>;
  proofsForProcessNoStart(operation: ContainedTurnKernelOperation): Promise<
    Omit<Extract<ContainedTurnKernelMutation, { readonly kind: "close_process_no_start" }>, "kind">
  >;
  terminalProof(input: Readonly<{
    operation: ContainedTurnKernelOperation;
    satisfactionDigest: ContainedTurnCanonicalDigest;
  }>): Promise<Extract<ContainedTurnProof, { readonly kind: "terminal_truth" }>>;
  prepareCancellation(operation: ContainedTurnKernelOperation): Promise<Readonly<{
    command: ContainedTurnCancellationCommand;
    cutoffProof: Extract<ContainedTurnProof, { readonly kind: "cutoff" }>;
    proof: Extract<ContainedTurnProof, { readonly kind: "cancellation" }>;
  }>>;
  accept(candidate: ContainedTurnKernelOperation): Promise<
    | { readonly kind: "accepted"; readonly operation: ContainedTurnKernelOperation }
    | { readonly kind: "replayed"; readonly operation: ContainedTurnKernelOperation }
    | { readonly kind: "fingerprint_conflict" }
  >;
  commit(input: Readonly<{
    candidate: ContainedTurnKernelOperation;
    expectedRevision: number;
    operationId: ContainedTurnOperationId;
  }>): Promise<CommitContainedTurnKernelOperationOutcome>;
  /** Final owner-store CAS: validates operation and cross-context authority fences while claiming dispatch. */
  claimDispatch(input: Readonly<{
    authority: ContainedTurnDispatchAuthorityPrecondition;
    candidate: ContainedTurnKernelOperation;
    expectedRevision: number;
    operationId: ContainedTurnOperationId;
  }>): Promise<CommitContainedTurnKernelOperationOutcome>;
  read(operationId: ContainedTurnOperationId): Promise<ContainedTurnKernelOperation | undefined>;
  requestCancellation(input: Readonly<{
    candidate: ContainedTurnKernelOperation;
    command: ContainedTurnCancellationCommand;
    expectedRevision: number;
  }>): Promise<CommitContainedTurnKernelOperationOutcome>;
}

export interface ContainedTurnKernelSecurityPort {
  authorizeForAcceptance(input: Readonly<{
    intent: ContainedTurnIntent;
    provider: ContainedTurnProvider;
    scope: ContainedTurnScope;
  }>): Promise<
    | { readonly acceptanceProofId: ContainedTurnProofId; readonly authorityRevision: string; readonly containmentPolicyDigest: ContainedTurnCanonicalDigest; readonly decisionDigest: ContainedTurnCanonicalDigest; readonly kind: "allowed" }
    | { readonly kind: "denied" }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  revalidateForDispatch(input: Readonly<{
    decisionDigest: ContainedTurnCanonicalDigest;
    operationId: ContainedTurnOperationId;
    securityAuthorityRevision: string;
    scope: ContainedTurnScope;
  }>): Promise<
    | { readonly dispatchDecisionDigest: ContainedTurnCanonicalDigest; readonly kind: "current"; readonly proofId: ContainedTurnProofId }
    | { readonly kind: "prevented"; readonly preventionProofId: ContainedTurnProofId }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
}

export interface ContainedTurnKernelWorkspacePort {
  close(input: Readonly<{ operationId: ContainedTurnOperationId; workspaceId: ContainedTurnWorkspaceId }>): Promise<
    | { readonly kind: "closed"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "workspace_closure" }> }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  create(input: Readonly<{ operationId: ContainedTurnOperationId; scope: ContainedTurnScope }>): Promise<{ readonly workspaceId: ContainedTurnWorkspaceId }>;
  quarantine(input: Readonly<{ evidenceId: ContainedTurnEvidenceId; workspaceId: ContainedTurnWorkspaceId }>): Promise<void>;
}

export interface ContainedTurnKernelArtifactPort {
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

export interface ContainedTurnKernelCustodyPort {
  /** Reserves sole-attempt custody. Reservation is not evidence of process start. */
  open(input: Readonly<{
    adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
    attemptId: ContainedTurnAttemptId;
    authorityVectorDigest: ContainedTurnCanonicalDigest;
    custodyId: ContainedTurnCustodyId;
    operationId: ContainedTurnOperationId;
    providerAccessSnapshot: ContainedTurnProviderAccessSnapshot;
    workspaceId: ContainedTurnWorkspaceId;
  }>): Promise<Readonly<{
    custodyId: ContainedTurnCustodyId;
    hostCustodyProof: Extract<ContainedTurnProof, { readonly kind: "host_custody" }>;
    hostBootId: ContainedTurnHostBootId;
    hostInstanceId: ContainedTurnHostInstanceId;
  }>>;
  /**
   * Materializes the reserved process/session. Only `execution_started` permits
   * the kernel to activate provider execution; an unknown result requires
   * reconciliation and never permits another attempt.
   */
  start(input: Readonly<{
    attemptId: ContainedTurnAttemptId;
    custodyId: ContainedTurnCustodyId;
    operationId: ContainedTurnOperationId;
  }>): Promise<
    | {
      readonly kind: "execution_started";
      readonly proof: Extract<ContainedTurnProof, { readonly kind: "provider_process_start" }>;
    }
    | {
      readonly kind: "proved_no_start";
      readonly proof: Extract<ContainedTurnProof, { readonly kind: "provider_process_no_start" }>;
    }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  requestContainment(input: Readonly<{
    attemptId: ContainedTurnAttemptId;
    custodyId: ContainedTurnCustodyId;
    operationId: ContainedTurnOperationId;
  }>): Promise<
    | { readonly kind: "contained"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "containment" }> }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
}

/** Frozen provider-facing kernel port; provider-specific protocols remain outside the application. */
export interface ContainedTurnKernelProviderPort {
  readonly adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
  readonly manifest: ContainedTurnCapabilityManifest;
  execute(input: Readonly<{
    adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
    attemptId: ContainedTurnAttemptId;
    authorityVectorDigest: ContainedTurnCanonicalDigest;
    custodyId: ContainedTurnCustodyId;
    effectId: ContainedTurnEffectId;
    emit: (chunk: ContainedTurnKernelOutputChunk) => Promise<void>;
    intent: ContainedTurnIntent;
    isCancellationRequested: () => Promise<boolean>;
    operationId: ContainedTurnOperationId;
    providerAccessSnapshot: ContainedTurnProviderAccessSnapshot;
    startProofId: ContainedTurnProofId;
    workspaceId: ContainedTurnWorkspaceId;
  }>): Promise<
    | {
      readonly acceptanceProof: Extract<ContainedTurnProof, { readonly kind: "provider_acceptance" }>;
      readonly effectProof: Extract<ContainedTurnProof, { readonly kind: "effect_resolution" }>;
      readonly executionClosureProof: Extract<ContainedTurnProof, { readonly kind: "execution_closure" }>;
      readonly kind: "completed";
      readonly outcome: "cancelled" | "failed" | "succeeded";
      readonly outputDrainProof: Extract<ContainedTurnProof, { readonly kind: "output_drain" }>;
      readonly terminalObservationProof: Extract<ContainedTurnProof, { readonly kind: "provider_terminal_observation" }>;
    }
    | {
      readonly acceptanceProof: Extract<ContainedTurnProof, { readonly kind: "provider_acceptance" }>;
      readonly effectProof: Extract<ContainedTurnProof, { readonly kind: "effect_resolution" }>;
      readonly executionClosureProof: Extract<ContainedTurnProof, { readonly kind: "execution_closure" }>;
      readonly kind: "not_accepted";
      readonly outputDrainProof: Extract<ContainedTurnProof, { readonly kind: "output_drain" }>;
      readonly terminalObservationProof: Extract<ContainedTurnProof, { readonly kind: "provider_terminal_observation" }>;
    }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
}

export interface ContainedTurnKernelDependencies {
  readonly operationStore: ContainedTurnKernelOperationStore;
  readonly security: ContainedTurnKernelSecurityPort;
  readonly providerAccess: ContainedTurnProviderAccessPort;
  readonly workspace: ContainedTurnKernelWorkspacePort;
  readonly artifacts: ContainedTurnKernelArtifactPort;
  readonly custody: ContainedTurnKernelCustodyPort;
  readonly provider: ContainedTurnKernelProviderPort;
}

export const CONTAINED_TURN_DEPENDENCY_NAMES = Object.freeze([
  "operationStore",
  "security",
  "providerAccess",
  "workspace",
  "artifacts",
  "custody",
  "provider",
] as const satisfies readonly (keyof ContainedTurnKernelDependencies)[]);

/** Runtime guard used by the Pure DI factory to reject dependency bags and hidden authorities. */
export const validateContainedTurnKernelDependencies = (
  dependencies: ContainedTurnKernelDependencies,
): void => {
  assertContainedTurnExactRecord(
    "contained-turn composition dependencies",
    dependencies,
    CONTAINED_TURN_DEPENDENCY_NAMES,
  );
};
