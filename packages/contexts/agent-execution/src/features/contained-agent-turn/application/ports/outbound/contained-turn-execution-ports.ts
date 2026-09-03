import type {
  ContainedTurnCapabilityManifest,
  ContainedTurnIntent,
  ContainedTurnProviderAdapterSnapshot,
  ContainedTurnProviderAccessSnapshot,
} from "../../../domain/contained-turn-authority.js";
import type { ContainedTurnCanonicalDigest } from "../../../domain/contained-turn-codecs.js";
import type { ContainedTurnCleanupPermit } from "../../../domain/contained-turn-dispatch-preparation.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnCustodyId,
  ContainedTurnEffectId,
  ContainedTurnEvidenceId,
  ContainedTurnHostBootId,
  ContainedTurnHostInstanceId,
  ContainedTurnOperationId,
  ContainedTurnWorkspaceId,
} from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOutputChunk } from "../../../domain/contained-turn-kernel.js";
import type { ContainedTurnProof } from "../../../domain/contained-turn-proofs.js";
import type {
  ContainedTurnClosureRequest,
  EnsureContainedTurnClosureOutcome,
} from "./contained-turn-closure-ports.js";

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
    effectId: ContainedTurnEffectId; intentMode: "analysis" | "workspace-write";
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
