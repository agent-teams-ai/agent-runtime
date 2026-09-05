import type {
  ContainedTurnCancellationCommand,
  ContainedTurnScope,
} from "../../../domain/contained-turn-authority.js";
import type {
  ContainedTurnCanonicalDigest,
  ContainedTurnCommandFingerprint,
} from "../../../domain/contained-turn-codecs.js";
import type {
  ContainedTurnConsumedGrantReceipt,
  ContainedTurnConsumedGrantReceipts,
  ContainedTurnDispatchGrantSubject,
} from "../../../domain/contained-turn-dispatch-authority.js";
import type {
  ContainedTurnCleanupPermit,
  ContainedTurnDispatchPreparation,
  ContainedTurnPreparationClosureProof,
} from "../../../domain/contained-turn-dispatch-preparation.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnCommandId,
  ContainedTurnCustodyId,
  ContainedTurnEffectId,
  ContainedTurnEvidenceId,
  ContainedTurnExecutionGenerationId,
  ContainedTurnOperationId,
  ContainedTurnPreparationToken,
  ContainedTurnProofId,
  ContainedTurnWriterFence,
} from "../../../domain/contained-turn-identities.js";
import type {
  ContainedTurnKernelOperation,
  ContainedTurnKernelOutputChunk,
} from "../../../domain/contained-turn-kernel.js";
import type { ContainedTurnOutputWriteAuthority } from "../../../domain/contained-turn-output-authority.js";
import type { ContainedTurnProof } from "../../../domain/contained-turn-proofs.js";
import type { ContainedTurnKernelMutation } from "../../../domain/contained-turn-transitions.js";
import type { CommittedDispatchProofV1 } from "../../../domain/committed-dispatch-proof-v1.js";
import type { ContainedTurnPreventionCommand, ContainedTurnPreventionReceipt } from "../../../domain/contained-turn-intent-guard.js";

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
  | {
    /** COMMIT may have accepted this exact candidate, but bounded observation could not prove durable truth. */
    readonly candidateOperation: ContainedTurnKernelOperation;
    readonly evidenceId: ContainedTurnEvidenceId;
    readonly kind: "potential_acceptance";
  }
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
  /**
   * Atomically proves every operation-scoped preparation is cleanup_closed at
   * the exact revision and closed fence. No kind filter or pagination applies.
   * The same fence must reject all subsequent preparation creation. Undefined
   * (including stale, partial, over-budget, or unavailable state) is not proof.
   */
  proveDispatchPreparationClosure?(input: Readonly<{
    authority: ContainedTurnOwnerStoreAuthority;
    expectedOperationCutoffRevision: number;
    expectedOperationRevision: number;
  }>): Promise<ContainedTurnPreparationClosureProof | undefined>;
  /** Same transactional authority as acceptance and claim. Exact replay recovers a lost receipt. */
  preventIntent(input: Readonly<{
    command: ContainedTurnPreventionCommand;
    /** Independently authenticated scope, never copied from the command. */
    scope: ContainedTurnScope;
  }>): Promise<
    | { readonly kind: "committed"; readonly receipt: ContainedTurnPreventionReceipt }
    | { readonly kind: "conflict" | "denied" | "indeterminate" }
  >;
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
      providerAccessConsumptionReceipt?: ContainedTurnConsumedGrantReceipt<"provider_access">;
      providerAccessGrantRequestId?: string;
      runtimeSecurityConsumptionReceipt?: ContainedTurnConsumedGrantReceipt<"runtime_security">;
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
    | { readonly committedDispatchProof: CommittedDispatchProofV1; readonly kind: "claimed"; readonly operation: ContainedTurnKernelOperation }
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
