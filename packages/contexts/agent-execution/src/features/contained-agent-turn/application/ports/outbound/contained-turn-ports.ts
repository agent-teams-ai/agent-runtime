import type {
  ContainedTurnOutputKind,
  ContainedTurnProviderBinding,
  ContainedTurnMutation,
  ContainedTurnOperation,
} from "../../../domain/contained-turn-operation.js";
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
} from "../../../domain/contained-turn-codecs.js";
import type {
  ContainedTurnKernelOperation,
  ContainedTurnKernelOutputChunk,
} from "../../../domain/contained-turn-kernel.js";
import type { ContainedTurnProof } from "../../../domain/contained-turn-proofs.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnCustodyId,
  ContainedTurnEffectId,
  ContainedTurnEvidenceId,
  ContainedTurnHostBootId,
  ContainedTurnHostInstanceId,
  ContainedTurnOperationId,
  ContainedTurnProofId,
  ContainedTurnWorkspaceId,
} from "../../../domain/contained-turn-identities.js";

export type ResolveContainedTurnProviderAccessOutcome =
  | {
    readonly acceptanceResolutionDigest: ContainedTurnCanonicalDigest;
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
  | { readonly kind: "not_found" }
  | { readonly current: ContainedTurnKernelOperation; readonly kind: "stale" };

export interface ContainedTurnKernelOperationStore {
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
  read(operationId: ContainedTurnOperationId): Promise<ContainedTurnKernelOperation | undefined>;
  requestCancellation(input: Readonly<{
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
    | { readonly authorityRevision: string; readonly decisionDigest: ContainedTurnCanonicalDigest; readonly kind: "allowed" }
    | { readonly kind: "denied" }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  revalidateForDispatch(input: Readonly<{
    decisionDigest: ContainedTurnCanonicalDigest;
    operationId: ContainedTurnOperationId;
    securityAuthorityRevision: string;
    scope: ContainedTurnScope;
  }>): Promise<
    | { readonly kind: "current"; readonly proofId: ContainedTurnProofId }
    | { readonly kind: "prevented"; readonly preventionProofId: ContainedTurnProofId }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
}

export interface ContainedTurnKernelWorkspacePort {
  close(input: Readonly<{ operationId: ContainedTurnOperationId; workspaceId: ContainedTurnWorkspaceId }>): Promise<
    Extract<ContainedTurnProof, { readonly kind: "workspace_closure" }>
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
    resultProof: Extract<ContainedTurnProof, { readonly kind: "result_publication" }>;
  }>>;
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

export interface AcceptContainedTurnCommandInput {
  readonly commandId: string;
  readonly intent: ContainedTurnOperation["intent"];
  readonly providerBinding: ContainedTurnProviderBinding;
  readonly scope: ContainedTurnScope;
  readonly securityDecision: ContainedTurnOperation["securityDecision"];
}

export type AcceptContainedTurnCommandOutcome =
  | { readonly kind: "accepted"; readonly operation: ContainedTurnOperation }
  | { readonly kind: "replayed"; readonly operation: ContainedTurnOperation }
  | { readonly kind: "conflict" };

export type CompareAndSetContainedTurnOutcome =
  | { readonly kind: "applied"; readonly operation: ContainedTurnOperation }
  | { readonly kind: "not_found" }
  | { readonly current: ContainedTurnOperation; readonly kind: "stale" };

export type ClaimContainedTurnDispatchOutcome =
  | { readonly kind: "claimed"; readonly operation: ContainedTurnOperation }
  | { readonly kind: "not_found" }
  | { readonly current: ContainedTurnOperation; readonly kind: "stale" };

export interface ContainedTurnOperationStore {
  accept(input: AcceptContainedTurnCommandInput): Promise<AcceptContainedTurnCommandOutcome>;
  claimDispatch(input: {
    readonly cutoffReceiptRef: string;
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<ClaimContainedTurnDispatchOutcome>;
  compareAndSet(input: {
    readonly expectedRevision: number;
    readonly mutation: ContainedTurnMutation;
    readonly operationId: string;
  }): Promise<CompareAndSetContainedTurnOutcome>;
  preventDispatch(input: {
    readonly expectedRevision: number;
    readonly operationId: string;
    readonly proofRef: string;
  }): Promise<CompareAndSetContainedTurnOutcome>;
  read(operationId: string): Promise<ContainedTurnOperation | undefined>;
  requestCancellation(input: {
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<CompareAndSetContainedTurnOutcome>;
  terminalize(input: {
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<CompareAndSetContainedTurnOutcome>;
}

export interface ContainedTurnSecurityPort {
  authorize(input: {
    readonly intent: ContainedTurnOperation["intent"];
    readonly provider: ContainedTurnProvider;
    readonly scope: ContainedTurnScope;
  }): Promise<
    | { readonly kind: "allowed"; readonly authorityRevision: string; readonly decisionDigest: string }
    | { readonly kind: "denied" }
  >;
  revalidate(input: {
    readonly authorityRevision: string;
    readonly decisionDigest: string;
    readonly operationId: string;
    readonly scope: ContainedTurnScope;
  }): Promise<
    | { readonly kind: "allowed"; readonly proofRef: string }
    | { readonly kind: "prevented"; readonly proofRef: string }
  >;
}

export interface ContainedTurnWorkspacePort {
  close(workspaceRef: string): Promise<{ readonly receiptRef: string }>;
  create(input: {
    readonly operationId: string;
    readonly scope: ContainedTurnScope;
  }): Promise<{ readonly workspaceRef: string }>;
  quarantine(input: {
    readonly evidenceRef: string;
    readonly workspaceRef: string;
  }): Promise<void>;
}

export interface ContainedTurnArtifactPort {
  seal(input: {
    readonly operationId: string;
    readonly output: readonly { readonly cursor: number; readonly kind: ContainedTurnOutputKind; readonly text: string }[];
    readonly workspaceRef: string;
  }): Promise<{
    readonly manifestReceiptRef: string;
    readonly manifestRef: string;
    readonly resultReceiptRef: string;
    readonly resultRef: string;
  }>;
}

export interface ContainedTurnCustodyHandle {
  readonly custodyRef: string;
}

export interface ProviderProcessCustodyPort {
  open(input: {
    readonly attemptId: string;
    readonly operationId: string;
    readonly providerBinding: ContainedTurnProviderBinding;
    readonly workspaceRef: string;
  }): Promise<ContainedTurnCustodyHandle>;
  requestContainment(input: {
    readonly attemptId: string;
    readonly custodyRef?: string;
    readonly operationId: string;
  }): Promise<
    | { readonly kind: "contained"; readonly receiptRef: string }
    | { readonly evidenceRef: string; readonly kind: "unproven" }
  >;
}

export interface ContainedTurnAdapterCapabilityManifest {
  readonly effectClass: "contained_unmediated_effect";
  readonly providerBinding: ContainedTurnProviderBinding;
  readonly supportedModes: readonly ("analysis" | "workspace-write")[];
}

export type ContainedTurnProviderExecutionOutcome =
  | {
      readonly acceptanceReceiptRef: string;
      readonly effectDisposition: "committed" | "not_committed";
      readonly effectReceiptRef: string;
      readonly executionReceiptRef: string;
      readonly kind: "completed";
      readonly outcome: "cancelled" | "failed" | "succeeded";
      readonly outputDrainReceiptRef: string;
    }
  | {
      readonly effectReceiptRef: string;
      readonly executionReceiptRef: string;
      readonly kind: "not_accepted";
      readonly outputDrainReceiptRef: string;
      readonly providerReceiptRef: string;
    }
  | { readonly evidenceRef: string; readonly kind: "ambiguous" };

export interface ContainedTurnProviderPort {
  readonly manifest: ContainedTurnAdapterCapabilityManifest;
  execute(input: {
    readonly attemptId: string;
    readonly custody: ContainedTurnCustodyHandle;
    readonly effectId: string;
    readonly intent: ContainedTurnOperation["intent"];
    readonly operationId: string;
    readonly workspaceRef: string;
    readonly isCancellationRequested: () => Promise<boolean>;
    readonly emit: (chunk: {
      readonly cursor: number;
      readonly kind: ContainedTurnOutputKind;
      readonly text: string;
    }) => Promise<void>;
  }): Promise<ContainedTurnProviderExecutionOutcome>;
}

/** Frozen provider-facing kernel port. Legacy engine wiring migrates to this surface separately. */
export interface ContainedTurnKernelProviderPort {
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
      readonly acceptanceEvidenceId: ContainedTurnEvidenceId;
      readonly effectDisposition: "committed" | "not_committed";
      readonly effectEvidenceId: ContainedTurnEvidenceId;
      readonly executionClosureEvidenceId: ContainedTurnEvidenceId;
      readonly kind: "completed";
      readonly outcome: "cancelled" | "failed" | "succeeded";
      readonly outputDrainEvidenceId: ContainedTurnEvidenceId;
      readonly terminalObservationEvidenceId: ContainedTurnEvidenceId;
    }
    | {
      readonly executionClosureEvidenceId: ContainedTurnEvidenceId;
      readonly kind: "not_accepted";
      readonly noEffectEvidenceId: ContainedTurnEvidenceId;
      readonly outputDrainEvidenceId: ContainedTurnEvidenceId;
      readonly providerNonAcceptanceEvidenceId: ContainedTurnEvidenceId;
      readonly terminalObservationEvidenceId: ContainedTurnEvidenceId;
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

/** Runtime guard used by the future Pure DI factory to reject dependency bags and hidden authorities. */
export const validateContainedTurnKernelDependencies = (
  dependencies: ContainedTurnKernelDependencies,
): void => {
  const actual = Object.keys(dependencies).toSorted();
  const expected = [...CONTAINED_TURN_DEPENDENCY_NAMES].toSorted();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new TypeError("contained-turn composition requires the exact closed seven dependencies");
  }
};
