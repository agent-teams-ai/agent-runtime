import {
  evaluateAcceptanceTransition,
  evaluateRootRequestLifecycle,
  retentionObligationSetIsExact,
} from "./runtime-operation-root-lifecycle-oracle.ts";

export const BINARY_RETENTION_FACTS = [
  "binary_revision_root_established",
  "provider_or_effect_work_requested",
  "session_assignment_release_requested",
  "operation_nonterminal",
  "effect_reconciliation_required",
  "terminal_projection_requires_revision",
  "transcript_projection_requires_revision",
  "terminal_write_once",
  "effect_closure_write_once",
  "durable_revision_independent_projection",
  "release_outcome_unknown",
  "release_exact_replay",
  "semantic_root_retained",
  "gc_requested",
  "zero_semantic_roots",
  "shared_effect",
  "attempting_operation_roots_complete",
  "attempting_operation_root_missing",
  "operation_acceptance_intent_persisted",
  "operation_acceptance_committed",
  "operation_acceptance_revision_pending",
  "operation_acceptance_state_accepted",
  "operation_acceptance_state_aborted",
  "operation_acceptance_accept_requested",
  "operation_acceptance_abort_requested",
  "operation_acceptance_accept_cas_won",
  "operation_acceptance_abort_cas_won",
  "operation_acceptance_transaction_complete",
  "operation_abort_transaction_complete",
  "operation_acceptance_exact_replay",
  "operation_abort_exact_replay",
  "root_request_id_stable",
  "root_request_state_pending",
  "root_request_state_established",
  "root_request_state_establishment_forbidden",
  "ensure_semantic_retention_requested",
  "root_abort_release_requested",
  "root_abort_release_cas_won",
  "establishment_forbidden_tombstone_durable",
  "root_request_exact_replay",
  "root_request_generation_current",
  "root_request_generation_stale",
  "root_establishment_receipt_durable",
  "same_revision_root_and_abort_cas_both_won",
  "root_establishment_rejected_receipt_durable",
  "retention_receipt_exact_current",
  "root_receipt_exact_replay_or_query",
  "retention_obligation_set_pinned",
  "retention_obligation_schema_revision_pinned",
  "retention_obligation_policy_revision_pinned",
  "retention_obligation_capability_revision_pinned",
  "retention_obligation_set_digest_exact",
  "retention_obligation_set_digest_wrong",
  "retention_obligation_set_weaker",
  "dynamic_obligation_arose",
  "dynamic_obligation_reserved_before_use",
  "dynamic_obligation_revision_digest_advanced",
  "retention_obligation_reserve_cas_won",
  "retention_obligation_seal_cas_won",
  "retention_obligation_final_digest_durable",
  "retention_obligation_seal_receipt_durable",
  "same_revision_reserve_and_seal_cas_both_won",
  "retention_obligation_set_open",
  "retention_obligation_set_sealed",
  "execution_authority_present",
  "root_cas_won",
  "collection_or_tombstone_cas_won",
  "existing_gc_blockers_clear",
  "host_custody_collection_cas_won",
  "contradictory_zero_and_retained_roots",
  "durable_gc_deletion_intent_claim",
  "deletion_set_digest_exact",
  "deletion_set_digest_wrong",
  "store_level_deletion_reference_fence_exact",
  "store_level_deletion_reference_fence_stale",
  "deletion_completed_receipt_durable",
  "predelete_tombstone_durable",
  "final_deleted_state_durable",
  "shared_store_reference_active",
  "physical_absence_observed",
  "physical_deletion_preclaim_requested",
  "deletion_claim_wrong_scope",
  "owner_release_receipt_durable",
  "root_receipt_ack_lost",
  "acceptance_outcome_unknown",
  "operation_acceptance_aborted_receipt_exact",
  "operation_acceptance_aborted_receipt_stale",
  "operation_acceptance_aborted_receipt_wrong_scope",
  "operation_acceptance_aborted_receipt_unknown",
  "abandon_release_exact_replay",
  "owner_abandon_release_receipt_durable",
  "ttl_elapsed",
  "release_manifest_identity_binding_complete",
  "release_manifest_retention_obligation_digest",
  "release_manifest_terminal_satisfaction_digests",
  "release_manifest_effect_closure_receipts",
  "release_manifest_projection_independence_receipts",
  "release_manifest_typed_non_applicability_complete",
  "release_obligation_final_digest_exact",
  "release_obligation_set_digest_wrong",
  "release_obligation_set_weaker",
  "release_manifest_incomplete",
  "release_manifest_stale",
  "release_manifest_wrong_scope",
  "release_manifest_unknown",
  "release_manifest_duplicate_evidence",
  "release_manifest_digest_conflict",
  "physical_deletion_started",
  "physical_deletion_crash",
  "physical_deletion_partial",
  "physical_deletion_unknown",
  "physical_deletion_completed",
  "physical_deletion_exact_replay",
] as const;

export const BINARY_RETENTION_RESULT_CODES = [
  "semantic_root_required",
  "semantic_root_establishment_race",
  "semantic_root_retained",
  "semantic_root_released",
  "binary_revision_gc_allowed",
  "binary_revision_gc_blocked",
  "root_not_execution_authority",
  "retention_receipt_replayed",
  "release_manifest_conflict",
  "physical_deletion_replayed",
  "deletion_reconciliation_required",
  "operation_acceptance_required",
  "retention_receipt_reconciliation_required",
  "abandon_release_replayed",
  "operation_acceptance_aborted",
  "operation_acceptance_replayed",
  "operation_abort_replayed",
  "operation_acceptance_stale_current_receipt",
  "operation_acceptance_winner_committed_current_receipt",
  "operation_acceptance_integrity_contradiction",
  "retention_obligation_set_required",
  "retention_obligation_mismatch",
  "retention_obligation_reservation_required",
  "physical_deletion_completed",
  "deletion_integrity_contradiction",
  "root_establishment_forbidden_current_receipt",
  "root_establishment_receipt_replayed",
  "root_lifecycle_integrity_contradiction",
  "retention_obligation_integrity_contradiction",
] as const;

export const BINARY_RETENTION_ALLOWED_FACTS = [
  ...BINARY_RETENTION_FACTS,
  "dispatch_requested",
] as const;

type BinaryRetentionResult =
  | (typeof BINARY_RETENTION_RESULT_CODES)[number]
  | "accepted";

const has = (facts: ReadonlySet<string>, fact: string): boolean => facts.has(fact);


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

const evaluateAuthorizedWork = (
  facts: ReadonlySet<string>,
): BinaryRetentionResult => {
  const exactRoot = has(facts, "operation_acceptance_intent_persisted") &&
    has(facts, "binary_revision_root_established") &&
    has(facts, "retention_receipt_exact_current");
  if (!exactRoot) {
    return has(facts, "session_assignment_release_requested")
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
  if (!retentionObligationSetIsExact(facts)) {
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

const evaluateRelease = (facts: ReadonlySet<string>): BinaryRetentionResult => {
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
  const invalidAbort = has(facts, "operation_acceptance_aborted_receipt_stale") ||
    has(facts, "operation_acceptance_aborted_receipt_wrong_scope") ||
    has(facts, "operation_acceptance_aborted_receipt_unknown");
  if (has(facts, "operation_acceptance_aborted_receipt_exact") && !invalidAbort) {
    return "semantic_root_released";
  }
  if (mustRemain(facts)) {
    return "semantic_root_retained";
  }
  const safelyClosed = has(facts, "terminal_write_once") &&
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
  const sideEffectObserved = [
    "physical_deletion_started",
    "physical_deletion_crash",
    "physical_deletion_partial",
    "physical_deletion_unknown",
    "physical_deletion_completed",
    "physical_absence_observed",
    "deletion_completed_receipt_durable",
    "final_deleted_state_durable",
  ].some((fact) => has(facts, fact));
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
): BinaryRetentionResult => {
  if (has(facts, "same_revision_reserve_and_seal_cas_both_won") ||
      (has(facts, "retention_obligation_set_open") &&
        has(facts, "retention_obligation_set_sealed"))) {
    return "retention_obligation_integrity_contradiction";
  }
  const acceptanceTransition = evaluateAcceptanceTransition(facts);
  if (acceptanceTransition !== undefined) {
    return acceptanceTransition;
  }
  const rootRequestLifecycle = evaluateRootRequestLifecycle(facts);
  if (rootRequestLifecycle !== undefined) {
    return rootRequestLifecycle;
  }
  if ([
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
  ].some((fact) => has(facts, fact))) {
    return evaluatePhysicalDeletion(facts);
  }
  if (has(facts, "gc_requested")) {
    return evaluateGc(facts);
  }
  if (has(facts, "collection_or_tombstone_cas_won")) {
    return "semantic_root_establishment_race";
  }
  if (has(facts, "provider_or_effect_work_requested") || has(facts, "dispatch_requested")) {
    const authorization = evaluateAuthorizedWork(facts);
    if (authorization !== "accepted") {
      return authorization;
    }
    if (has(facts, "shared_effect") &&
        (has(facts, "attempting_operation_root_missing") ||
          !has(facts, "attempting_operation_roots_complete"))) {
      return "semantic_root_required";
    }
    return "accepted";
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
