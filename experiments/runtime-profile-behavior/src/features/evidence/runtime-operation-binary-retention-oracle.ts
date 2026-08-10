import {
  evaluateAcceptanceTransition,
  evaluateRootRequestLifecycle,
  retentionObligationSetIsOpenAndExact,
} from "./runtime-operation-root-lifecycle-oracle.ts";

import type { ResultCode } from "../../../fixtures/proof-artifacts/runtime-operation-oracle/runtime-operation-oracle-types.generated.ts";

type BinaryRetentionResult = ResultCode;
type BinaryRetentionFactRoles = Readonly<Record<string, "command_intent" | "work_intent" | "evidence">>;

const has = (facts: ReadonlySet<string>, fact: string): boolean => facts.has(fact);

const workRequested = (facts: ReadonlySet<string>): boolean =>
  has(facts, "provider_or_effect_work_requested") || has(facts, "dispatch_requested");

const physicalDeletionSideEffectObserved = (facts: ReadonlySet<string>): boolean => [
  "physical_deletion_started",
  "physical_deletion_crash",
  "physical_deletion_partial",
  "physical_deletion_unknown",
  "physical_deletion_completed",
  "physical_absence_observed",
  "deletion_completed_receipt_durable",
  "final_deleted_state_durable",
].some((fact) => has(facts, fact));

const evaluateAcceptanceDurableIntegrity = (
  facts: ReadonlySet<string>,
): BinaryRetentionResult | undefined => {
  const accepted = has(facts, "operation_acceptance_state_accepted");
  const aborted = has(facts, "operation_acceptance_state_aborted");
  if ((accepted && aborted) ||
      (accepted && has(facts, "operation_acceptance_abort_cas_won")) ||
      (aborted && has(facts, "operation_acceptance_accept_cas_won")) ||
      (accepted && has(facts, "operation_acceptance_aborted_receipt_exact")) ||
      (aborted && has(facts, "operation_acceptance_committed")) ||
      (has(facts, "operation_acceptance_accept_cas_won") &&
        has(facts, "operation_acceptance_abort_cas_won"))) {
    return "operation_acceptance_integrity_contradiction";
  }
  return undefined;
};

const evaluateLifecycleDurableIntegrity = (
  facts: ReadonlySet<string>,
): BinaryRetentionResult | undefined => {
  if (has(facts, "same_revision_root_and_abort_cas_both_won")) {
    return "root_lifecycle_integrity_contradiction";
  }
  if (has(facts, "same_revision_reserve_and_seal_cas_both_won") ||
      (has(facts, "retention_obligation_set_open") &&
        has(facts, "retention_obligation_set_sealed"))) {
    return "retention_obligation_integrity_contradiction";
  }
  return undefined;
};

const evaluateDeletionDurableIntegrity = (
  facts: ReadonlySet<string>,
): BinaryRetentionResult | undefined => {
  const completionReceipt = has(facts, "deletion_completed_receipt_durable");
  const finalDeletedState = has(facts, "final_deleted_state_durable");
  if (completionReceipt !== finalDeletedState) {
    return "deletion_integrity_contradiction";
  }
  if (!physicalDeletionSideEffectObserved(facts)) {
    return undefined;
  }
  const contradictoryRoot = has(facts, "binary_revision_root_established") ||
    has(facts, "semantic_root_retained") || has(facts, "root_cas_won") ||
    has(facts, "contradictory_zero_and_retained_roots");
  const invalidClaim = has(facts, "deletion_claim_wrong_scope") ||
    has(facts, "deletion_set_digest_wrong") ||
    has(facts, "store_level_deletion_reference_fence_stale") ||
    has(facts, "shared_store_reference_active");
  const completeClaim = has(facts, "zero_semantic_roots") &&
    has(facts, "existing_gc_blockers_clear") &&
    has(facts, "host_custody_collection_cas_won") &&
    has(facts, "durable_gc_deletion_intent_claim") &&
    has(facts, "deletion_set_digest_exact") &&
    has(facts, "store_level_deletion_reference_fence_exact") &&
    has(facts, "predelete_tombstone_durable");
  return contradictoryRoot || invalidClaim || !completeClaim
    ? "deletion_integrity_contradiction"
    : undefined;
};

const evaluateDurableIntegrity = (
  facts: ReadonlySet<string>,
): BinaryRetentionResult | undefined =>
  evaluateAcceptanceDurableIntegrity(facts) ??
  evaluateLifecycleDurableIntegrity(facts) ??
  evaluateDeletionDurableIntegrity(facts);

export const binaryRetentionHasMixedCommandIntent = (
  facts: ReadonlySet<string>,
  factRoles: BinaryRetentionFactRoles,
): boolean => Object.entries(factRoles).some(([fact, role]) =>
  role === "command_intent" && has(facts, fact),
);


const evaluateGc = (facts: ReadonlySet<string>): BinaryRetentionResult => {
  const contradictory = has(facts, "contradictory_zero_and_retained_roots") ||
    (has(facts, "zero_semantic_roots") && has(facts, "semantic_root_retained"));
  const rootExists = has(facts, "binary_revision_root_established") ||
    has(facts, "root_cas_won") || has(facts, "semantic_root_retained");
  if (contradictory || rootExists) {
    return "binary_revision_gc_blocked";
  }
  return has(facts, "zero_semantic_roots") &&
    has(facts, "existing_gc_blockers_clear") &&
    has(facts, "host_custody_collection_cas_won")
    ? "binary_revision_gc_allowed"
    : "binary_revision_gc_blocked";
};

const evaluateAuthorizedWorkWinnerFence = (
  facts: ReadonlySet<string>,
  exactRoot: boolean,
  currentAcceptedRoot: boolean,
): BinaryRetentionResult | undefined => {
  if (has(facts, "root_abort_release_cas_won")) {
    return currentAcceptedRoot
      ? "root_lifecycle_integrity_contradiction"
      : "semantic_root_required";
  }
  if (has(facts, "retention_obligation_seal_cas_won")) {
    return exactRoot && has(facts, "retention_obligation_set_open")
      ? "retention_obligation_integrity_contradiction"
      : "retention_obligation_set_required";
  }
  return has(facts, "collection_or_tombstone_cas_won") ||
      has(facts, "host_custody_collection_cas_won")
    ? "semantic_root_establishment_race"
    : undefined;
};

const evaluateAuthorizedWork = (
  facts: ReadonlySet<string>,
): BinaryRetentionResult => {
  if (has(facts, "shared_effect") &&
      (has(facts, "attempting_operation_root_missing") ||
        !has(facts, "attempting_operation_roots_complete"))) {
    return "semantic_root_required";
  }
  const exactRoot = has(facts, "operation_acceptance_intent_persisted") &&
    has(facts, "binary_revision_root_established") &&
    has(facts, "retention_receipt_exact_current");
  const currentAcceptedRoot = exactRoot &&
    has(facts, "operation_acceptance_committed") &&
    has(facts, "operation_acceptance_state_accepted") &&
    has(facts, "operation_acceptance_transaction_complete");
  const winnerFence = evaluateAuthorizedWorkWinnerFence(
    facts,
    exactRoot,
    currentAcceptedRoot,
  );
  if (winnerFence !== undefined) {
    return winnerFence;
  }
  if (!exactRoot) {
    return has(facts, "session_assignment_release_requested") ||
      has(facts, "collection_or_tombstone_cas_won")
      ? "semantic_root_establishment_race"
      : "semantic_root_required";
  }
  if (!has(facts, "operation_acceptance_committed") ||
      !has(facts, "operation_acceptance_state_accepted") ||
      !has(facts, "operation_acceptance_transaction_complete")) {
    return "operation_acceptance_required";
  }
  if (has(facts, "retention_obligation_set_digest_wrong") ||
      has(facts, "retention_obligation_set_weaker")) {
    return "retention_obligation_mismatch";
  }
  if (!retentionObligationSetIsOpenAndExact(facts)) {
    return "retention_obligation_set_required";
  }
  if (has(facts, "dynamic_obligation_arose") &&
      (!has(facts, "dynamic_obligation_reserved_before_use") ||
        !has(facts, "dynamic_obligation_revision_digest_advanced") ||
        !has(facts, "retention_obligation_reserve_cas_won") ||
        !has(facts, "retention_obligation_set_open"))) {
    return "retention_obligation_reservation_required";
  }
  return has(facts, "execution_authority_present")
    ? "accepted"
    : "root_not_execution_authority";
};

const mustRemain = (facts: ReadonlySet<string>): boolean => [
  "release_outcome_unknown",
  "operation_nonterminal",
  "effect_reconciliation_required",
  "terminal_projection_requires_revision",
  "transcript_projection_requires_revision",
  "acceptance_outcome_unknown",
  "operation_acceptance_aborted_receipt_stale",
  "operation_acceptance_aborted_receipt_wrong_scope",
  "operation_acceptance_aborted_receipt_unknown",
  "ttl_elapsed",
  "release_manifest_incomplete",
  "release_manifest_stale",
  "release_manifest_wrong_scope",
  "release_manifest_unknown",
  "release_manifest_duplicate_evidence",
  "release_obligation_set_digest_wrong",
  "release_obligation_set_weaker",
].some((fact) => has(facts, fact));

const releaseReplayEvidenceIsInvalid = (facts: ReadonlySet<string>): boolean => [
  "release_manifest_incomplete",
  "release_manifest_stale",
  "release_manifest_wrong_scope",
  "release_manifest_unknown",
  "release_manifest_duplicate_evidence",
  "release_obligation_set_digest_wrong",
  "release_obligation_set_weaker",
].some((fact) => has(facts, fact));

const abortReceiptIsInvalid = (facts: ReadonlySet<string>): boolean => [
  "operation_acceptance_aborted_receipt_stale",
  "operation_acceptance_aborted_receipt_wrong_scope",
  "operation_acceptance_aborted_receipt_unknown",
].some((fact) => has(facts, fact));

const isHistoricalReplay = (facts: ReadonlySet<string>): boolean =>
  has(facts, "release_exact_replay") || has(facts, "abandon_release_exact_replay");

const evaluateHistoricalReplayContradiction = (
  facts: ReadonlySet<string>,
): BinaryRetentionResult | undefined => {
  if (!isHistoricalReplay(facts)) {
    return undefined;
  }
  if (has(facts, "release_manifest_digest_conflict") ||
      releaseReplayEvidenceIsInvalid(facts)) {
    return "release_manifest_conflict";
  }
  return abortReceiptIsInvalid(facts)
    ? "operation_acceptance_stale_current_receipt"
    : undefined;
};

const evaluateRelease = (facts: ReadonlySet<string>): BinaryRetentionResult => {
  const replayContradiction = evaluateHistoricalReplayContradiction(facts);
  if (replayContradiction !== undefined) {
    return replayContradiction;
  }
  if (has(facts, "release_manifest_digest_conflict")) {
    return "release_manifest_conflict";
  }
  if (has(facts, "release_exact_replay") && has(facts, "owner_release_receipt_durable")) {
    return "semantic_root_released";
  }
  if (has(facts, "abandon_release_exact_replay") &&
      has(facts, "owner_abandon_release_receipt_durable")) {
    return "abandon_release_replayed";
  }
  if (!has(facts, "binary_revision_root_established")) {
    return "semantic_root_required";
  }
  if (has(facts, "operation_acceptance_aborted_receipt_exact") &&
      !abortReceiptIsInvalid(facts)) {
    return "semantic_root_released";
  }
  if (mustRemain(facts)) {
    return "semantic_root_retained";
  }
  const safelyClosed = has(facts, "terminal_write_once") &&
    has(facts, "semantic_root_release_requested") &&
    has(facts, "retention_obligation_seal_requested") &&
    has(facts, "effect_closure_write_once") &&
    has(facts, "durable_revision_independent_projection") &&
    has(facts, "release_manifest_identity_binding_complete") &&
    has(facts, "release_manifest_retention_obligation_digest") &&
    has(facts, "release_manifest_terminal_satisfaction_digests") &&
    has(facts, "release_manifest_effect_closure_receipts") &&
    has(facts, "release_manifest_projection_independence_receipts") &&
    has(facts, "release_manifest_typed_non_applicability_complete") &&
    has(facts, "retention_obligation_set_sealed") &&
    has(facts, "retention_obligation_seal_cas_won") &&
    has(facts, "retention_obligation_final_digest_durable") &&
    has(facts, "retention_obligation_seal_receipt_durable") &&
    has(facts, "release_obligation_final_digest_exact");
  return safelyClosed ? "semantic_root_released" : "semantic_root_retained";
};

const evaluatePhysicalDeletion = (
  facts: ReadonlySet<string>,
): BinaryRetentionResult => {
  const contradictoryRoot = has(facts, "binary_revision_root_established") ||
    has(facts, "semantic_root_retained") || has(facts, "root_cas_won") ||
    has(facts, "contradictory_zero_and_retained_roots");
  const claimed = has(facts, "zero_semantic_roots") &&
    has(facts, "existing_gc_blockers_clear") &&
    has(facts, "host_custody_collection_cas_won") &&
    has(facts, "durable_gc_deletion_intent_claim") &&
    has(facts, "deletion_set_digest_exact") &&
    has(facts, "store_level_deletion_reference_fence_exact") &&
    has(facts, "predelete_tombstone_durable");
  const invalidClaim = has(facts, "deletion_claim_wrong_scope") ||
    has(facts, "deletion_set_digest_wrong") ||
    has(facts, "store_level_deletion_reference_fence_stale") ||
    has(facts, "shared_store_reference_active");
  const sideEffectObserved = physicalDeletionSideEffectObserved(facts);
  const completionReceipt = has(facts, "deletion_completed_receipt_durable");
  const finalDeletedState = has(facts, "final_deleted_state_durable");
  if (completionReceipt !== finalDeletedState) {
    return "deletion_integrity_contradiction";
  }
  if (contradictoryRoot || invalidClaim || !claimed) {
    return sideEffectObserved
      ? "deletion_integrity_contradiction"
      : "binary_revision_gc_blocked";
  }
  if (has(facts, "physical_deletion_exact_replay") &&
      has(facts, "deletion_completed_receipt_durable") &&
      has(facts, "final_deleted_state_durable")) {
    return "physical_deletion_replayed";
  }
  if (has(facts, "physical_deletion_completed") &&
      has(facts, "deletion_completed_receipt_durable") &&
      has(facts, "final_deleted_state_durable")) {
    return "physical_deletion_completed";
  }
  return [
    "physical_deletion_started",
    "physical_deletion_crash",
    "physical_deletion_partial",
    "physical_deletion_unknown",
    "physical_deletion_completed",
    "physical_absence_observed",
    "physical_deletion_exact_replay",
  ].some((fact) => has(facts, fact))
    ? "deletion_reconciliation_required"
    : "binary_revision_gc_blocked";
};

export const evaluateBinaryRevisionRetention = (
  facts: ReadonlySet<string>,
  factRoles: BinaryRetentionFactRoles,
): BinaryRetentionResult => {
  const durableIntegrity = evaluateDurableIntegrity(facts);
  if (durableIntegrity !== undefined) {
    return durableIntegrity;
  }
  const replayContradiction = evaluateHistoricalReplayContradiction(facts);
  if (replayContradiction !== undefined) {
    return replayContradiction;
  }
  if (workRequested(facts)) {
    const authorization = evaluateAuthorizedWork(facts);
    if (authorization !== "accepted") {
      return authorization;
    }
    if (binaryRetentionHasMixedCommandIntent(facts, factRoles)) {
      return "mixed_command_intent_forbidden";
    }
    return "accepted";
  }
  const acceptanceTransition = evaluateAcceptanceTransition(facts);
  if (acceptanceTransition === "operation_acceptance_integrity_contradiction") {
    return acceptanceTransition;
  }
  const rootRequestLifecycle = evaluateRootRequestLifecycle(facts);
  if (rootRequestLifecycle === "root_lifecycle_integrity_contradiction") {
    return rootRequestLifecycle;
  }
  const physicalDeletionRequested = [
    "physical_deletion_started",
    "physical_deletion_crash",
    "physical_deletion_partial",
    "physical_deletion_unknown",
    "physical_deletion_completed",
    "physical_deletion_exact_replay",
    "physical_absence_observed",
    "physical_deletion_preclaim_requested",
    "final_deleted_state_durable",
    "deletion_completed_receipt_durable",
  ].some((fact) => has(facts, fact));
  const physicalDeletion = physicalDeletionRequested
    ? evaluatePhysicalDeletion(facts)
    : undefined;
  if (physicalDeletion === "deletion_integrity_contradiction") {
    return physicalDeletion;
  }
  if (acceptanceTransition !== undefined) {
    return acceptanceTransition;
  }
  if (rootRequestLifecycle !== undefined) {
    return rootRequestLifecycle;
  }
  if (physicalDeletion !== undefined) {
    return physicalDeletion;
  }
  if (has(facts, "gc_requested")) {
    return evaluateGc(facts);
  }
  if (has(facts, "collection_or_tombstone_cas_won")) {
    return "semantic_root_establishment_race";
  }
  if (has(facts, "shared_effect")) {
    return has(facts, "attempting_operation_roots_complete") &&
      !has(facts, "attempting_operation_root_missing")
      ? "accepted"
      : "semantic_root_required";
  }
  if (has(facts, "root_receipt_ack_lost")) {
    return has(facts, "binary_revision_root_established") &&
      has(facts, "root_receipt_exact_replay_or_query")
      ? "retention_receipt_replayed"
      : "retention_receipt_reconciliation_required";
  }
  return evaluateRelease(facts);
};
