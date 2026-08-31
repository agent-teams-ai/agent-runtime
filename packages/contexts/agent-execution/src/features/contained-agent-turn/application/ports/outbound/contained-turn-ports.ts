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
import type { ContainedTurnOutputWriteAuthority } from "../../../domain/contained-turn-output-authority.js";
import type { ContainedTurnProof } from "../../../domain/contained-turn-proofs.js";
import type { ContainedTurnKernelMutation } from "../../../domain/contained-turn-transitions.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnCommandId,
  ContainedTurnCustodyId,
  ContainedTurnEffectId,
  ContainedTurnEvidenceId,
  ContainedTurnExecutionGenerationId,
  ContainedTurnHostBootId,
  ContainedTurnHostInstanceId,
  ContainedTurnOperationId,
  ContainedTurnPreparationToken,
  ContainedTurnProofId,
  ContainedTurnWorkspaceId,
  ContainedTurnWriterFence,
} from "../../../domain/contained-turn-identities.js";
import { assertContainedTurnExactRecord } from "../../../domain/contained-turn-record.js";
import type { ContainedTurnClosureRequestId } from "../../../domain/contained-turn-closure-recovery.js";
import type { ContainedTurnCleanupPermit, ContainedTurnDispatchPreparation } from "../../../domain/contained-turn-dispatch-preparation.js";
import type { ContainedTurnConsumedGrantReceipt, ContainedTurnConsumedGrantReceipts, ContainedTurnDispatchGrantSubject } from "../../../domain/contained-turn-dispatch-authority.js";

export interface ContainedTurnClosureRequest {
  readonly authorityVectorDigest: ContainedTurnCanonicalDigest;
  readonly requestDigest: ContainedTurnCanonicalDigest;
  readonly requestId: ContainedTurnClosureRequestId;
}

export type EnsureContainedTurnClosureOutcome<Proof> =
  | { readonly kind: "proved"; readonly proof: Proof; readonly requestDigest: ContainedTurnCanonicalDigest; readonly requestId: ContainedTurnClosureRequestId }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "identity_conflict" };

export type SettleContainedTurnConsumedGrantInput = Readonly<{
  cleanupPermit: ContainedTurnCleanupPermit;
} & (
  | { readonly grantRequestId: string; readonly consumptionEvidenceId?: never }
  | { readonly consumptionEvidenceId: ContainedTurnEvidenceId; readonly grantRequestId?: never }
)>;

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
  consumeForDispatch(input: Readonly<{ subject: ContainedTurnDispatchGrantSubject }>): Promise<
    | { readonly kind: "consumed"; readonly receipt: ContainedTurnConsumedGrantReceipt<"provider_access"> }
    | { readonly kind: "prevented"; readonly preventionProofId: ContainedTurnProofId }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  settleConsumedGrant(input: SettleContainedTurnConsumedGrantInput): Promise<
    | { readonly kind: "settled" }
    | { readonly kind: "already_settled" }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
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

export type IdentifyContainedTurnAcceptanceOutcome =
  | {
    readonly acceptanceProofId: ContainedTurnProofId;
    readonly effectId: ContainedTurnEffectId;
    readonly kind: "available";
    readonly operationId: ContainedTurnOperationId;
    readonly operationAuthorityRevision: string;
  }
  | { readonly kind: "fingerprint_conflict" }
  | { readonly kind: "not_found" }
  | { readonly kind: "replayed"; readonly operation: ContainedTurnKernelOperation };

export type AcceptContainedTurnKernelOperationOutcome =
  | { readonly kind: "accepted"; readonly operation: ContainedTurnKernelOperation }
  | { readonly kind: "replayed"; readonly operation: ContainedTurnKernelOperation }
  | { readonly kind: "fingerprint_conflict" }
  | { readonly kind: "not_found" };

export type AppendContainedTurnKernelOutputOutcome = CommitContainedTurnKernelOperationOutcome;

/** Exact owner-store namespace for an already accepted operation. */
export interface ContainedTurnOwnerStoreAuthority {
  readonly commandId: ContainedTurnCommandId;
  readonly effectId: ContainedTurnEffectId;
  readonly operationId: ContainedTurnOperationId;
  readonly scope: ContainedTurnScope;
}

export interface ContainedTurnKernelOperationStore {
  /** Restart-safe enumeration for owner reconciliation; production durable stores implement it. */
  listDispatchPreparations?(input: Readonly<{
    kinds?: readonly ("active" | "cleanup_pending")[];
    limit?: number;
    scope: ContainedTurnScope;
  }>): Promise<readonly Readonly<{
    operation: ContainedTurnKernelOperation;
    preparation: ContainedTurnDispatchPreparation;
  }>[]>;
  retireDispatchPreparation(input: Readonly<{
    authority: ContainedTurnOwnerStoreAuthority;
    consumedGrantRequestIds?: Readonly<{
      providerAccessGrantRequestId?: string;
      runtimeSecurityGrantRequestId?: string;
    }>;
    consumptionEvidenceIds?: Readonly<{
      providerAccessEvidenceId?: ContainedTurnEvidenceId;
      runtimeSecurityEvidenceId?: ContainedTurnEvidenceId;
    }>;
    expectedOperationCutoffRevision: number;
    expectedOperationRevision: number;
    preparationToken: ContainedTurnPreparationToken;
    reason: "claim_lost" | "open_failed" | "prevention" | "reconciliation";
  }>): Promise<
    | { readonly kind: "retired"; readonly preparation: Extract<ContainedTurnDispatchPreparation, { readonly kind: "cleanup_pending" }> }
    | { readonly kind: "claimed"; readonly operation: ContainedTurnKernelOperation }
    | { readonly current: ContainedTurnKernelOperation; readonly kind: "stale" }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  recordDispatchPreparationCleanup(input: Readonly<{
    authority: ContainedTurnOwnerStoreAuthority;
    evidenceId?: ContainedTurnEvidenceId;
    permit: ContainedTurnCleanupPermit;
    target: "custody" | "provider_access" | "runtime_security";
  }>): Promise<ContainedTurnDispatchPreparation>;
  claimPreparedDispatch(input: Readonly<{
    authority: ContainedTurnOwnerStoreAuthority;
    consumedGrantReceipts: ContainedTurnConsumedGrantReceipts;
    expectedOperationRevision: number;
    hostCustodyProof: Extract<ContainedTurnProof, { readonly kind: "host_custody" }>;
    subject: ContainedTurnDispatchGrantSubject;
  }>): Promise<
    | { readonly kind: "claimed"; readonly operation: ContainedTurnKernelOperation; readonly startAuthority: string }
    | { readonly kind: "observed_claim"; readonly operation: ContainedTurnKernelOperation }
    | { readonly current: ContainedTurnKernelOperation; readonly kind: "stale" }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
    | { readonly kind: "not_found" }
  >;
  identifyAcceptance(input: Readonly<{
    commandFingerprint: ContainedTurnCommandFingerprint;
    commandId: ContainedTurnCommandId;
    /** Independently trusted owner scope; never derive it from a stored or candidate operation. */
    scope: ContainedTurnScope;
  }>): Promise<IdentifyContainedTurnAcceptanceOutcome>;
  prepareDispatch(input: Readonly<{
    authority: ContainedTurnOwnerStoreAuthority;
    operation: ContainedTurnKernelOperation;
  }>): Promise<Readonly<{
    attemptId: ContainedTurnAttemptId;
    claimProofId: ContainedTurnProofId;
    custodyId: ContainedTurnCustodyId;
    cutoffProofId: ContainedTurnProofId;
    executionGenerationId: ContainedTurnExecutionGenerationId;
    writerFence: ContainedTurnWriterFence;
  }>>;
  proofsForPrevention(input: Readonly<{
    authority: ContainedTurnOwnerStoreAuthority;
    operation: ContainedTurnKernelOperation;
    preventionProofId: ContainedTurnProofId;
  }>): Promise<Omit<Extract<ContainedTurnKernelMutation, { readonly kind: "prevent_dispatch" }>, "kind">>;
  proofsForProcessNoStart(input: Readonly<{
    authority: ContainedTurnOwnerStoreAuthority;
    operation: ContainedTurnKernelOperation;
  }>): Promise<
    Omit<Extract<ContainedTurnKernelMutation, { readonly kind: "close_process_no_start" }>, "kind">
  >;
  proofsForAcceptedEffect(input: Readonly<{
    authority: ContainedTurnOwnerStoreAuthority;
    operation: ContainedTurnKernelOperation;
  }>): Promise<Readonly<{
    kind: "proved";
    acceptanceProof: Extract<ContainedTurnProof, { readonly kind: "provider_acceptance" }>;
    effectProof: Extract<ContainedTurnProof, { readonly kind: "effect_resolution" }>;
  }> | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }>;
  terminalProof(input: Readonly<{
    authority: ContainedTurnOwnerStoreAuthority;
    operation: ContainedTurnKernelOperation;
    satisfactionDigest: ContainedTurnCanonicalDigest;
  }>): Promise<Extract<ContainedTurnProof, { readonly kind: "terminal_truth" }>>;
  prepareCancellation(input: Readonly<{
    authority: ContainedTurnOwnerStoreAuthority;
    operation: ContainedTurnKernelOperation;
  }>): Promise<Readonly<{
    command: ContainedTurnCancellationCommand;
    cutoffProof: Extract<ContainedTurnProof, { readonly kind: "cutoff" }>;
    preventionProofId: ContainedTurnProofId;
    proof: Extract<ContainedTurnProof, { readonly kind: "cancellation" }>;
  }>>;
  accept(
    candidate: ContainedTurnKernelOperation,
    /** Independently assembled namespace; candidate fields are untrusted request data here. */
    authority: ContainedTurnOwnerStoreAuthority,
  ): Promise<AcceptContainedTurnKernelOperationOutcome>;
  commit(input: Readonly<{
    authority: ContainedTurnOwnerStoreAuthority;
    candidate: ContainedTurnKernelOperation;
    expectedRevision: number;
  }>): Promise<CommitContainedTurnKernelOperationOutcome>;
  /** A scope mismatch is represented exactly like an absent operation. */
  read(input: Readonly<{
    operationId: ContainedTurnOperationId;
    scope: ContainedTurnScope;
  }>): Promise<ContainedTurnKernelOperation | undefined>;
  requestCancellation(input: Readonly<{
    authority: ContainedTurnOwnerStoreAuthority;
    candidate: ContainedTurnKernelOperation;
    command: ContainedTurnCancellationCommand;
    expectedRevision: number;
  }>): Promise<CommitContainedTurnKernelOperationOutcome>;
  /**
   * The sole canonical-output write path. The owner store must evaluate scope
   * before revision or writer-authority predicates and append atomically.
   */
  appendOutput(input: Readonly<{
    authority: ContainedTurnOwnerStoreAuthority;
    expectedCursor: number;
    expectedRevision: number;
    outputAuthority: ContainedTurnOutputWriteAuthority;
    output: ContainedTurnKernelOutputChunk;
  }>): Promise<AppendContainedTurnKernelOutputOutcome>;
}

export interface ContainedTurnKernelSecurityPort {
  consumeForDispatch(input: Readonly<{ subject: ContainedTurnDispatchGrantSubject }>): Promise<
    | { readonly kind: "consumed"; readonly receipt: ContainedTurnConsumedGrantReceipt<"runtime_security"> }
    | { readonly kind: "prevented"; readonly preventionProofId: ContainedTurnProofId }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  settleConsumedGrant(input: SettleContainedTurnConsumedGrantInput): Promise<
    | { readonly kind: "settled" }
    | { readonly kind: "already_settled" }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
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
  ensureClosed(input: Readonly<ContainedTurnClosureRequest & { operationId: ContainedTurnOperationId; workspaceId: ContainedTurnWorkspaceId }>): Promise<EnsureContainedTurnClosureOutcome<Extract<ContainedTurnProof, { readonly kind: "workspace_closure" }>>>;
  queryClosure(input: Readonly<ContainedTurnClosureRequest & { operationId: ContainedTurnOperationId; workspaceId: ContainedTurnWorkspaceId }>): Promise<EnsureContainedTurnClosureOutcome<Extract<ContainedTurnProof, { readonly kind: "workspace_closure" }>>>;
  close(input: Readonly<{ operationId: ContainedTurnOperationId; workspaceId: ContainedTurnWorkspaceId }>): Promise<
    | { readonly kind: "closed"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "workspace_closure" }> }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  create(input: Readonly<{ operationId: ContainedTurnOperationId; scope: ContainedTurnScope }>): Promise<{ readonly workspaceId: ContainedTurnWorkspaceId }>;
  /** Idempotently quarantines only the exact losing operation-scoped workspace. */
  quarantine(input: Readonly<{
    evidenceId: ContainedTurnEvidenceId;
    operationId: ContainedTurnOperationId;
    workspaceId: ContainedTurnWorkspaceId;
  }>): Promise<void>;
}

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

export type ContainedTurnKernelProviderObservation =
  | {
    readonly kind: "completed";
    readonly outcome: "cancelled" | "failed" | "succeeded";
  }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" };

export type ContainedTurnKernelProcessStartObservation =
  | {
    readonly kind: "execution_started";
    readonly proof: Extract<ContainedTurnProof, { readonly kind: "provider_process_start" }>;
  }
  | {
    readonly kind: "proved_no_start";
    readonly proof: Extract<ContainedTurnProof, { readonly kind: "provider_process_no_start" }>;
  }
  | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" };

/**
 * Host-owned wrapper installed as the provider SDK's process-creation hook.
 * The generic return keeps the provider's private process type inside its
 * adapter while Host Custody invokes the exact creator under its reservation.
 */
export interface ContainedTurnKernelDelegatedStart {
  readonly observation: Promise<ContainedTurnKernelProcessStartObservation>;
  createProcess<Process>(createProcess: () => Process): Process;
}

export interface ContainedTurnKernelCustodyPort {
  releaseRetiredReservation(input: Readonly<{ cleanupPermit: ContainedTurnCleanupPermit }>): Promise<
    | { readonly kind: "released" }
    | { readonly kind: "already_released" }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  ensurePhysicalContainment(input: Readonly<ContainedTurnClosureRequest & { attemptId: ContainedTurnAttemptId; custodyId: ContainedTurnCustodyId; operationId: ContainedTurnOperationId }>): Promise<EnsureContainedTurnClosureOutcome<Extract<ContainedTurnProof, { readonly kind: "physical_containment" }>>>;
  queryPhysicalContainment(input: Readonly<ContainedTurnClosureRequest & { attemptId: ContainedTurnAttemptId; custodyId: ContainedTurnCustodyId; operationId: ContainedTurnOperationId }>): Promise<EnsureContainedTurnClosureOutcome<Extract<ContainedTurnProof, { readonly kind: "physical_containment" }>>>;
  attestContainment(input: Readonly<ContainedTurnClosureRequest & { attemptId: ContainedTurnAttemptId; binding: Extract<ContainedTurnProof, { readonly kind: "containment" }>["binding"]; custodyId: ContainedTurnCustodyId; operationId: ContainedTurnOperationId }>): Promise<EnsureContainedTurnClosureOutcome<Extract<ContainedTurnProof, { readonly kind: "containment" }>>>;
  queryContainmentAttestation(input: Readonly<ContainedTurnClosureRequest & { attemptId: ContainedTurnAttemptId; binding: Extract<ContainedTurnProof, { readonly kind: "containment" }>["binding"]; custodyId: ContainedTurnCustodyId; operationId: ContainedTurnOperationId }>): Promise<EnsureContainedTurnClosureOutcome<Extract<ContainedTurnProof, { readonly kind: "containment" }>>>;
  /** Host-owned, independently observed execution, drain, and terminal closure. */
  attestExecutionClosure(input: Readonly<{
    attemptId: ContainedTurnAttemptId;
    custodyId: ContainedTurnCustodyId;
    finalCursor: number;
    operationId: ContainedTurnOperationId;
  }>): Promise<Readonly<{
    executionClosureProof: Extract<ContainedTurnProof, { readonly kind: "execution_closure" }>;
    kind: "proved";
    outputDrainProof: Extract<ContainedTurnProof, { readonly kind: "output_drain" }>;
    terminalObservationProof: Extract<ContainedTurnProof, { readonly kind: "provider_terminal_observation" }>;
  }> | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }>;
  /**
   * Owner-controlled completion boundary used to race both custody start and
   * provider execution. Releasing it must synchronously clear its timer and
   * detach any cancellation listener.
   */
  completionBoundary(input: Readonly<{
    attemptId: ContainedTurnAttemptId;
    custodyId: ContainedTurnCustodyId;
    operationId: ContainedTurnOperationId;
    phase: "execution" | "start";
  }>): Readonly<{
    expiration: Promise<Readonly<{ evidenceId: ContainedTurnEvidenceId; kind: "expired" }>>;
    release(): void;
  }>;
  /** Reserves sole-attempt custody. Reservation is not evidence of process start. */
  open(input: Readonly<{
    adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
    attemptId: ContainedTurnAttemptId;
    authorityVectorDigest: ContainedTurnCanonicalDigest;
    custodyId: ContainedTurnCustodyId;
    effectId: ContainedTurnEffectId;
    operationId: ContainedTurnOperationId;
    providerAccessSnapshot: ContainedTurnProviderAccessSnapshot;
    workspaceId: ContainedTurnWorkspaceId;
  }>): Promise<Readonly<{
    custodyId: ContainedTurnCustodyId;
    hostCustodyProof: Extract<ContainedTurnProof, { readonly kind: "host_custody" }>;
    hostBootId: ContainedTurnHostBootId;
    hostInstanceId: ContainedTurnHostInstanceId;
  }>>;
  /** Idempotent, identity-bound cleanup for a reservation that never won claim. */
  releaseReservation(input: Readonly<{
    attemptId: ContainedTurnAttemptId;
    custodyId: ContainedTurnCustodyId;
    operationId: ContainedTurnOperationId;
    reason: "claim_lost" | "open_failed" | "prevention" | "revalidation_failed";
    workspaceId: ContainedTurnWorkspaceId;
  }>): Promise<void>;
  /**
   * Runs provider execution with a Host-owned process-creation wrapper. The
   * provider SDK supplies its actual creator only when its selected intent is
   * ready to spawn. Only `execution_started` exposes the still-single execution
   * promise; an unknown result requires reconciliation and never another try.
   */
  start(input: Readonly<{
    attemptId: ContainedTurnAttemptId;
    custodyId: ContainedTurnCustodyId;
    execute: (start: ContainedTurnKernelDelegatedStart) => Promise<ContainedTurnKernelProviderObservation>;
    intent: ContainedTurnIntent;
    operationId: ContainedTurnOperationId;
    /** Exact one-use authority returned only by the final prepared-dispatch CAS. */
    startAuthority: string;
    workspaceId: ContainedTurnWorkspaceId;
  }>): Promise<
    | {
      readonly execution: Promise<ContainedTurnKernelProviderObservation>;
      readonly kind: "execution_started";
      readonly proof: Extract<ContainedTurnProof, { readonly kind: "provider_process_start" }>;
    }
    | {
      readonly kind: "proved_no_start";
      readonly proof: Extract<ContainedTurnProof, { readonly kind: "provider_process_no_start" }>;
    }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  /** Proves process/descendant closure before any canonical artifact capture. */
  requestPhysicalContainment(input: Readonly<{
    attemptId: ContainedTurnAttemptId;
    custodyId: ContainedTurnCustodyId;
    operationId: ContainedTurnOperationId;
  }>): Promise<
    | { readonly kind: "contained"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "physical_containment" }> }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  /** Builds the composite closure proof after physical closure and artifact sealing. */
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
    start: ContainedTurnKernelDelegatedStart;
    workspaceId: ContainedTurnWorkspaceId;
  }>): Promise<ContainedTurnKernelProviderObservation>;
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
  const requiredMethods = Object.freeze({
    artifacts: ["ensureSealed", "querySeal"],
    custody: ["attestContainment", "ensurePhysicalContainment", "queryContainmentAttestation", "queryPhysicalContainment", "releaseRetiredReservation"],
    operationStore: ["claimPreparedDispatch", "recordDispatchPreparationCleanup", "retireDispatchPreparation"],
    providerAccess: ["consumeForDispatch", "settleConsumedGrant"],
    security: ["consumeForDispatch", "settleConsumedGrant"],
    workspace: ["ensureClosed", "queryClosure"],
  } as const);
  for (const [owner, methods] of Object.entries(requiredMethods)) {
    const port = dependencies[owner as keyof typeof requiredMethods];
    for (const method of methods) {
      if (typeof (port as unknown as Readonly<Record<string, unknown>>)[method] !== "function") {
        throw new TypeError(`contained-turn production dependency ${owner}.${method} is mandatory`);
      }
    }
  }
};
