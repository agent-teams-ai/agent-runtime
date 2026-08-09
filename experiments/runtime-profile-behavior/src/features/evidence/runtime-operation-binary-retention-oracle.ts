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
  "retention_receipt_exact_current",
  "root_receipt_exact_replay_or_query",
  "execution_authority_present",
  "root_cas_won",
  "collection_or_tombstone_cas_won",
  "existing_gc_blockers_clear",
  "host_custody_collection_cas_won",
  "contradictory_zero_and_retained_roots",
  "durable_gc_deletion_intent_claim",
  "deletion_claim_wrong_scope",
  "owner_release_receipt_durable",
  "orphan_root_after_crash",
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
  "release_manifest_incomplete",
  "release_manifest_stale",
  "release_manifest_wrong_scope",
  "release_manifest_unknown",
  "release_manifest_duplicate_evidence",
  "release_manifest_digest_conflict",
  "physical_deletion_started",
  "physical_deletion_crash",
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
  if (!has(facts, "operation_acceptance_committed")) {
    return "operation_acceptance_required";
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
  if (mustRemain(facts)) {
    return "semantic_root_retained";
  }
  if (has(facts, "operation_acceptance_aborted_receipt_exact")) {
    return has(facts, "orphan_root_after_crash")
      ? "semantic_root_released"
      : "semantic_root_retained";
  }
  const safelyClosed = has(facts, "terminal_write_once") &&
    has(facts, "effect_closure_write_once") &&
    has(facts, "durable_revision_independent_projection") &&
    has(facts, "release_manifest_identity_binding_complete") &&
    has(facts, "release_manifest_retention_obligation_digest") &&
    has(facts, "release_manifest_terminal_satisfaction_digests") &&
    has(facts, "release_manifest_effect_closure_receipts") &&
    has(facts, "release_manifest_projection_independence_receipts") &&
    has(facts, "release_manifest_typed_non_applicability_complete");
  return safelyClosed ? "semantic_root_released" : "semantic_root_retained";
};

const evaluatePhysicalDeletion = (
  facts: ReadonlySet<string>,
): BinaryRetentionResult => {
  const contradictoryRoot = has(facts, "binary_revision_root_established") ||
    has(facts, "semantic_root_retained");
  const claimed = has(facts, "zero_semantic_roots") &&
    has(facts, "existing_gc_blockers_clear") &&
    has(facts, "host_custody_collection_cas_won") &&
    has(facts, "durable_gc_deletion_intent_claim");
  if (contradictoryRoot || has(facts, "deletion_claim_wrong_scope") || !claimed) {
    return "binary_revision_gc_blocked";
  }
  if (has(facts, "physical_deletion_exact_replay")) {
    return "physical_deletion_replayed";
  }
  return has(facts, "physical_deletion_started") && has(facts, "physical_deletion_crash")
    ? "deletion_reconciliation_required"
    : "binary_revision_gc_blocked";
};

export const evaluateBinaryRevisionRetention = (
  facts: ReadonlySet<string>,
): BinaryRetentionResult => {
  if (has(facts, "physical_deletion_crash") || has(facts, "physical_deletion_exact_replay")) {
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
    return has(facts, "attempting_operation_roots_complete")
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
