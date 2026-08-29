// Generated from ADR-0006 JSON authority. Do not edit.

/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "canonicalId".
 */
export type CanonicalId = string;
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "check".
 */
export type Check =
  | "output_terminal_order"
  | "dispatch_cutoff_race"
  | "requirement_closure_race"
  | "terminal_replay"
  | "indeterminate_evidence_race"
  | "outbox_recovery"
  | "dispatch_crash"
  | "provider_observation"
  | "lost_acknowledgement"
  | "effect_identity_claim"
  | "effect_fingerprint_conflict"
  | "distinct_external_identity"
  | "completed_effect_replay"
  | "retry_after_known_not_accepted"
  | "tombstone_restore"
  | "effect_cardinality"
  | "receipt_handling"
  | "stale_restore"
  | "model_invariants"
  | "cutoff_boundary_reuse"
  | "normal_provider_termination"
  | "zero_attempt_cutoff"
  | "post_seal_receipt"
  | "atomic_indeterminate_clear"
  | "deployment_continuity"
  | "manifest_coverage"
  | "cross_axis_transition"
  | "binary_revision_retention";
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "fact".
 */
export type Fact =
  | "append_committed_first"
  | "seal_committed_first"
  | "dispatch_claim_committed_first"
  | "operation_cutoff_committed_first"
  | "session_cutoff_committed_first"
  | "scope_cutoff_committed_first"
  | "reservation_committed_first"
  | "manifest_seal_committed_first"
  | "final_receipt_committed_first"
  | "terminal_command_committed_first"
  | "late_positive_committed_first"
  | "indeterminate_terminal_committed_first"
  | "seal_durable"
  | "outbox_unpublished"
  | "claim_durable"
  | "provider_bytes_absent"
  | "provider_bytes_or_action"
  | "provider_acceptance_unproven"
  | "new_claim_requested"
  | "provider_accepted"
  | "observation_not_durable"
  | "terminal_durable"
  | "acknowledgement_lost"
  | "exact_replay"
  | "conflicting_replay"
  | "same_external_identity"
  | "different_external_identity"
  | "same_fingerprint"
  | "different_fingerprint"
  | "same_payload"
  | "effect_completed"
  | "provider_call_requested"
  | "known_not_accepted_receipt"
  | "fresh_attempt_identity"
  | "stale_attempt_identity"
  | "permanent_tombstone"
  | "restore_or_compaction"
  | "zero_effects"
  | "one_coarse_effect"
  | "multiple_mediated_effects"
  | "invalid_effect_cardinality"
  | "receipt_delayed"
  | "receipt_reordered"
  | "receipt_duplicate_exact"
  | "receipt_conflicting"
  | "authority_reopen_requested"
  | "authority_monotonic"
  | "all_axis_invariants_hold"
  | "axis_invariant_violated"
  | "prior_cutoff_fences_exact"
  | "cursor_and_receipt_reused"
  | "cursor_or_receipt_advanced"
  | "provider_execution_terminated"
  | "containment_not_requested"
  | "containment_uncertain"
  | "effect_registered"
  | "zero_attempts"
  | "cutoff_fenced"
  | "manifest_sealed"
  | "receipt_bound_to_manifest_entry"
  | "receipt_unbound"
  | "all_tombstone_receipts_present"
  | "tombstone_receipt_missing"
  | "debt_clear_terminal_atomic"
  | "debt_cleared_separately"
  | "continuity_receipt_verified"
  | "continuity_receipt_missing"
  | "dispatch_requested"
  | "all_manifest_entries_satisfied"
  | "child_requirement_missing"
  | "transcript_requirement_missing"
  | "admission_fenced"
  | "output_fenced"
  | "reconciliation_clear"
  | "execution_not_started"
  | "execution_active"
  | "execution_terminated"
  | "containment_satisfied"
  | "transition_dispatch_unclaimed_claimed"
  | "transition_dispatch_claimed_unknown"
  | "transition_dispatch_claimed_not_accepted"
  | "transition_dispatch_claimed_accepted"
  | "transition_dispatch_unknown_not_accepted"
  | "transition_dispatch_unknown_accepted"
  | "transition_dispatch_not_accepted_claimed_fresh"
  | "transition_dispatch_accepted_claimed"
  | "transition_execution_not_started_active_with_claim"
  | "transition_execution_active_not_started_with_proof"
  | "transition_execution_active_terminated_with_receipt"
  | "transition_execution_terminated_active"
  | "transition_execution_start_without_claim"
  | "transition_execution_reset_without_not_accepted_proof"
  | "transition_execution_terminate_without_receipt"
  | "transition_containment_not_requested_pending"
  | "transition_containment_pending_contained"
  | "transition_containment_pending_uncertain"
  | "transition_containment_uncertain_pending_retry"
  | "transition_containment_uncertain_contained_late_proof"
  | "transition_containment_not_requested_qualified_not_required"
  | "containment_capability_evidence_immutable"
  | "containment_qualification_receipt_exact"
  | "transition_containment_contained_pending"
  | "transition_containment_qualified_not_required_pending"
  | "transition_cutoff_open_fenced"
  | "transition_cutoff_fenced_open"
  | "transition_manifest_open_sealed_with_fences"
  | "transition_manifest_open_sealed_open_admission"
  | "transition_manifest_open_sealed_open_output"
  | "transition_terminal_open_final_with_closure"
  | "transition_terminal_open_final_not_started_with_closure"
  | "transition_terminal_open_final_active_execution"
  | "transition_terminal_final_open"
  | "transition_claim_without_execution_activation"
  | "binary_revision_root_established"
  | "provider_or_effect_work_requested"
  | "session_assignment_release_requested"
  | "semantic_root_release_requested"
  | "operation_nonterminal"
  | "effect_reconciliation_required"
  | "terminal_projection_requires_revision"
  | "transcript_projection_requires_revision"
  | "terminal_write_once"
  | "effect_closure_write_once"
  | "durable_revision_independent_projection"
  | "release_outcome_unknown"
  | "release_exact_replay"
  | "semantic_root_retained"
  | "gc_requested"
  | "zero_semantic_roots"
  | "shared_effect"
  | "attempting_operation_roots_complete"
  | "attempting_operation_root_missing"
  | "operation_acceptance_intent_persisted"
  | "operation_acceptance_committed"
  | "operation_acceptance_revision_pending"
  | "operation_acceptance_state_accepted"
  | "operation_acceptance_state_aborted"
  | "operation_acceptance_accept_requested"
  | "operation_acceptance_abort_requested"
  | "operation_acceptance_accept_cas_won"
  | "operation_acceptance_abort_cas_won"
  | "operation_acceptance_transaction_complete"
  | "operation_abort_transaction_complete"
  | "operation_acceptance_exact_replay"
  | "operation_abort_exact_replay"
  | "root_request_id_stable"
  | "root_request_state_pending"
  | "root_request_state_established"
  | "root_request_state_establishment_forbidden"
  | "ensure_semantic_retention_requested"
  | "root_abort_release_requested"
  | "root_abort_release_cas_won"
  | "establishment_forbidden_tombstone_durable"
  | "root_request_exact_replay"
  | "root_request_generation_current"
  | "root_request_generation_stale"
  | "root_establishment_receipt_durable"
  | "same_revision_root_and_abort_cas_both_won"
  | "root_establishment_rejected_receipt_durable"
  | "retention_receipt_exact_current"
  | "root_receipt_exact_replay_or_query"
  | "retention_obligation_set_pinned"
  | "retention_obligation_schema_revision_pinned"
  | "retention_obligation_policy_revision_pinned"
  | "retention_obligation_capability_revision_pinned"
  | "retention_obligation_set_digest_exact"
  | "retention_obligation_set_digest_wrong"
  | "retention_obligation_set_weaker"
  | "dynamic_obligation_arose"
  | "dynamic_obligation_reserved_before_use"
  | "dynamic_obligation_revision_digest_advanced"
  | "retention_obligation_reserve_cas_won"
  | "retention_obligation_seal_requested"
  | "retention_obligation_seal_cas_won"
  | "retention_obligation_final_digest_durable"
  | "retention_obligation_seal_receipt_durable"
  | "same_revision_reserve_and_seal_cas_both_won"
  | "retention_obligation_set_open"
  | "retention_obligation_set_sealed"
  | "execution_authority_present"
  | "root_cas_won"
  | "collection_or_tombstone_cas_won"
  | "existing_gc_blockers_clear"
  | "host_custody_collection_cas_won"
  | "contradictory_zero_and_retained_roots"
  | "durable_gc_deletion_intent_claim"
  | "deletion_set_digest_exact"
  | "deletion_set_digest_wrong"
  | "store_level_deletion_reference_fence_exact"
  | "store_level_deletion_reference_fence_stale"
  | "deletion_completed_receipt_durable"
  | "predelete_tombstone_durable"
  | "final_deleted_state_durable"
  | "shared_store_reference_active"
  | "physical_absence_observed"
  | "physical_deletion_preclaim_requested"
  | "deletion_claim_wrong_scope"
  | "owner_release_receipt_durable"
  | "root_receipt_ack_lost"
  | "acceptance_outcome_unknown"
  | "operation_acceptance_aborted_receipt_exact"
  | "operation_acceptance_aborted_receipt_stale"
  | "operation_acceptance_aborted_receipt_wrong_scope"
  | "operation_acceptance_aborted_receipt_unknown"
  | "abandon_release_exact_replay"
  | "owner_abandon_release_receipt_durable"
  | "ttl_elapsed"
  | "release_manifest_identity_binding_complete"
  | "release_manifest_retention_obligation_digest"
  | "release_manifest_terminal_satisfaction_digests"
  | "release_manifest_effect_closure_receipts"
  | "release_manifest_projection_independence_receipts"
  | "release_manifest_typed_non_applicability_complete"
  | "release_obligation_final_digest_exact"
  | "release_obligation_set_digest_wrong"
  | "release_obligation_set_weaker"
  | "release_manifest_incomplete"
  | "release_manifest_stale"
  | "release_manifest_wrong_scope"
  | "release_manifest_unknown"
  | "release_manifest_duplicate_evidence"
  | "release_manifest_digest_conflict"
  | "physical_deletion_started"
  | "physical_deletion_crash"
  | "physical_deletion_partial"
  | "physical_deletion_unknown"
  | "physical_deletion_completed"
  | "physical_deletion_exact_replay";
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "resultCode".
 */
export type ResultCode =
  | "accepted"
  | "append_rejected_after_seal"
  | "dispatch_rejected_after_cutoff"
  | "reservation_rejected_after_seal"
  | "terminal_already_final"
  | "late_evidence_is_noncanonical"
  | "durable_recovery_required"
  | "provider_dispatch_not_authorized"
  | "new_claim_forbidden"
  | "reconciliation_required"
  | "acceptance_unknown_reconcile_required"
  | "replay_returns_original_receipt"
  | "idempotent_existing_effect"
  | "external_identity_conflict"
  | "distinct_effect_required"
  | "completed_result_replayed"
  | "fresh_attempt_required"
  | "retry_permanently_forbidden"
  | "invalid_effect_cardinality"
  | "conflicting_receipt"
  | "stale_authority"
  | "axis_invariant_violation"
  | "cutoff_boundary_conflict"
  | "containment_not_required"
  | "zero_attempt_effect_closed"
  | "receipt_not_bound"
  | "indeterminate_clear_not_atomic"
  | "continuity_unproven"
  | "manifest_incomplete"
  | "transition_forbidden"
  | "semantic_root_required"
  | "semantic_root_establishment_race"
  | "semantic_root_retained"
  | "semantic_root_released"
  | "binary_revision_gc_allowed"
  | "binary_revision_gc_blocked"
  | "root_not_execution_authority"
  | "retention_receipt_replayed"
  | "release_manifest_conflict"
  | "physical_deletion_replayed"
  | "deletion_reconciliation_required"
  | "operation_acceptance_required"
  | "retention_receipt_reconciliation_required"
  | "abandon_release_replayed"
  | "operation_acceptance_aborted"
  | "operation_acceptance_replayed"
  | "operation_abort_replayed"
  | "operation_acceptance_stale_current_receipt"
  | "operation_acceptance_winner_committed_current_receipt"
  | "operation_acceptance_integrity_contradiction"
  | "retention_obligation_set_required"
  | "retention_obligation_mismatch"
  | "retention_obligation_reservation_required"
  | "physical_deletion_completed"
  | "deletion_integrity_contradiction"
  | "root_establishment_forbidden_current_receipt"
  | "root_establishment_receipt_replayed"
  | "root_lifecycle_integrity_contradiction"
  | "retention_obligation_integrity_contradiction"
  | "mixed_command_intent_forbidden";
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "v1Disposition".
 */
export type V1Disposition = "required" | "deferred" | "not_applicable";
/**
 * @minItems 1
 *
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "nonEmptyUniqueStrings".
 */
export type NonEmptyUniqueStrings = [string, ...string[]];
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "caseFragment".
 */
export type CaseFragment = Case | ShardedCase;
/**
 * @minItems 1
 *
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "exampleFragment".
 */
export type ExampleFragment = [Example, ...Example[]];

export interface ADR0006RuntimeOperationOracle {
  $schema: "./schema.json";
  schemaVersion: 1;
  adr: "ADR-0006";
  /**
   * @minItems 28
   * @maxItems 28
   */
  cases: [
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case
  ];
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "case".
 */
export interface Case {
  id: CanonicalId;
  requirement: number;
  /**
   * @minItems 2
   */
  examples: [Example, Example, ...Example[]];
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "example".
 */
export interface Example {
  id: CanonicalId;
  check: Check;
  /**
   * @minItems 1
   */
  facts: [Fact, ...Fact[]];
  expected: {
    decision: "accept" | "reject";
    code: ResultCode;
  };
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "manifest".
 */
export interface Manifest {
  $schema: "./schema.json#/$defs/manifest";
  schemaVersion: 1;
  adr: "ADR-0006";
  catalog: "catalog.json";
  crossAxis: "cross-axis.json";
  containedTurnV1Disposition: "contained-turn-v1-disposition.json";
  containedTurnV1Contract: "contained-turn-v1-contract.json";
  /**
   * @minItems 28
   * @maxItems 28
   */
  cases: [
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    }
  ];
  expected: ValidationCounts;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "validationCounts".
 */
export interface ValidationCounts {
  caseCount: 28;
  exampleCount: 242;
  acceptedCount: 107;
  rejectedCount: 135;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "catalog".
 */
export interface Catalog {
  $schema: "./schema.json#/$defs/catalog";
  schemaVersion: 1;
  /**
   * @minItems 28
   * @maxItems 28
   */
  checks: [
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check
  ];
  /**
   * @minItems 1
   */
  facts: [Fact, ...Fact[]];
  /**
   * @minItems 1
   */
  resultCodes: [ResultCode, ...ResultCode[]];
  /**
   * @minItems 1
   */
  acceptedResultCodes: [ResultCode, ...ResultCode[]];
  allowedFactsByCheck: {
    /**
     * @minItems 1
     */
    [k: string]: [Fact, ...Fact[]];
  };
  binaryRetentionFactRoles: {
    [k: string]: "command_intent" | "work_intent" | "evidence";
  };
  stateProductAxes: StateProductAxes;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "stateProductAxes".
 */
export interface StateProductAxes {
  /**
   * @minItems 1
   */
  dispatch: [string, ...string[]];
  /**
   * @minItems 1
   */
  admission: [string, ...string[]];
  /**
   * @minItems 1
   */
  output: [string, ...string[]];
  /**
   * @minItems 1
   */
  execution: [string, ...string[]];
  /**
   * @minItems 1
   */
  containment: [string, ...string[]];
  /**
   * @minItems 1
   */
  reconciliation: [string, ...string[]];
  /**
   * @minItems 1
   */
  manifest: [string, ...string[]];
  /**
   * @minItems 1
   */
  satisfaction: [string, ...string[]];
  /**
   * @minItems 1
   */
  effectResolution: [string, ...string[]];
  /**
   * @minItems 1
   */
  terminal: [string, ...string[]];
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "crossAxis".
 */
export interface CrossAxis {
  $schema: "./schema.json#/$defs/crossAxis";
  schemaVersion: 1;
  requirement: 27;
  machineKind: "synthetic-verifier";
  initial: CrossAxisState;
  axes: CrossAxisAxes;
  /**
   * @minItems 1
   */
  transitions: [CrossAxisTransition, ...CrossAxisTransition[]];
  /**
   * @minItems 1
   */
  forbiddenTransitionFacts: [Fact, ...Fact[]];
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "crossAxisState".
 */
export interface CrossAxisState {
  [k: string]: string;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "crossAxisAxes".
 */
export interface CrossAxisAxes {
  /**
   * @minItems 1
   */
  [k: string]: [string, ...string[]];
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "crossAxisTransition".
 */
export interface CrossAxisTransition {
  fact: Fact;
  /**
   * @minItems 1
   */
  targets: [CrossAxisTarget, ...CrossAxisTarget[]];
  requiredState?: {
    /**
     * @minItems 1
     */
    [k: string]: [string, ...string[]];
  };
  /**
   * @minItems 1
   */
  requiredFacts?: [Fact, ...Fact[]];
  /**
   * @minItems 1
   */
  forbiddenFacts?: [Fact, ...Fact[]];
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "crossAxisTarget".
 */
export interface CrossAxisTarget {
  axis: string;
  from: string;
  to: string;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "v1DispositionCount".
 */
export interface V1DispositionCount {
  required: number;
  deferred: number;
  notApplicable: number;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "v1StateCount".
 */
export interface V1StateCount {
  total: number;
  valid: number;
  invalid: number;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "containedTurnV1Disposition".
 */
export interface ContainedTurnV1Disposition {
  $schema: "./schema.json#/$defs/containedTurnV1Disposition";
  schemaVersion: 1;
  adr: "ADR-0010";
  companionAdr: "ADR-0009";
  /**
   * @minItems 1
   */
  requirements: [V1RequirementDisposition, ...V1RequirementDisposition[]];
  /**
   * @minItems 1
   */
  examples: [V1ExampleDisposition, ...V1ExampleDisposition[]];
  /**
   * @minItems 3
   * @maxItems 3
   */
  stateCategories: [V1StateCategory, V1StateCategory, V1StateCategory];
  expected: V1DispositionExpected;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "v1RequirementDisposition".
 */
export interface V1RequirementDisposition {
  requirement: number;
  caseId: CanonicalId;
  disposition: V1Disposition;
  reason: string;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "v1ExampleDisposition".
 */
export interface V1ExampleDisposition {
  requirement: number;
  exampleId: CanonicalId;
  disposition: V1Disposition;
  reason: string;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "v1StateCategory".
 */
export interface V1StateCategory {
  id: CanonicalId;
  precedence: number;
  predicate:
    | "effect_resolution_none"
    | "effect_resolution_indeterminate_or_terminal_outcome_indeterminate"
    | "remaining_state_product";
  disposition: V1Disposition;
  reason: string;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "v1DispositionExpected".
 */
export interface V1DispositionExpected {
  requirementCount: 28;
  exampleCount: 242;
  stateCount: 48000;
  requirements: V1DispositionCount;
  examples: V1DispositionCount;
  states: {
    required: V1StateCount;
    deferred: V1StateCount;
    notApplicable: V1StateCount;
  };
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "containedTurnV1Contract".
 */
export interface ContainedTurnV1Contract {
  $schema: "./schema.json#/$defs/containedTurnV1Contract";
  schemaVersion: 2;
  /**
   * @minItems 3
   * @maxItems 3
   */
  adrs: [
    "ADR-0009" | "ADR-0010" | "ADR-0012",
    "ADR-0009" | "ADR-0010" | "ADR-0012",
    "ADR-0009" | "ADR-0010" | "ADR-0012"
  ];
  repositoryBaseCommit: "3e1b977d9ab6147eb702b62497bd0be62acb8cf7";
  correctionBaseCommit: "40ddaedd0da009a6611988e3a8e9eb00857b05be";
  /**
   * @minItems 2
   * @maxItems 2
   */
  foundationInputs: [FoundationInput, FoundationInput];
  /**
   * @minItems 3
   * @maxItems 3
   */
  providers: [ProviderContract, ProviderContract, ProviderContract];
  /**
   * @minItems 3
   * @maxItems 3
   */
  adapterCapabilityManifests: [AdapterCapabilityManifest, AdapterCapabilityManifest, AdapterCapabilityManifest];
  worstCaseResourceScope: NonEmptyStringMap;
  requiredReceiptSet: RequiredReceiptSet;
  containmentExecutionReceiptVersion: 1;
  containmentExecutionReceiptBindings: NonEmptyUniqueStrings;
  compositionFixture: CompositionFixture;
  /**
   * @minItems 1
   */
  identityMatrix: [IdentityMatrixEntry, ...IdentityMatrixEntry[]];
  /**
   * @minItems 1
   */
  lifecycleMatrix: [LifecycleMatrixEntry, ...LifecycleMatrixEntry[]];
  truthBoundary: NonEmptyStringMap;
  /**
   * @minItems 1
   */
  negativeGuard: [NegativeGuardExample, ...NegativeGuardExample[]];
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "foundationInput".
 */
export interface FoundationInput {
  pullRequest: 22 | 27;
  head: string;
  authority: "non_authoritative_design_input";
  mappedGuardrails: NonEmptyUniqueStrings;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "providerContract".
 */
export interface ProviderContract {
  provider: "codex" | "claude" | "opencode";
  packageRevision: string;
  binaryRevision?: string;
  schemaRevision?: string;
  typescriptRevision?: string;
  packageIntegrity?: string;
  bundledProviderRevision?: string;
  adapterRevision?: string;
  evidenceFixture?: string;
  evidenceFixtureDigest?: string;
  evidencePlatform?: string;
  qualification: "candidate_static_evidence_only" | "contract_only_no_production_adapter";
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "adapterCapabilityManifest".
 */
export interface AdapterCapabilityManifest {
  provider: "codex" | "claude" | "opencode";
  manifestVersion: 1;
  manifestRevision: string;
  providerRevision: string;
  resourceScopeRevision: "contained-turn-v1-worst-case-scope@1";
  effectClass: "contained_unmediated_effect";
  effectCardinality: "one_coarse_effect_per_operation";
  providerAttemptCardinality: "at_most_one";
  unknownCapabilityPolicy: "fail_closed";
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "nonEmptyStringMap".
 */
export interface NonEmptyStringMap {
  [k: string]: string;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "requiredReceiptSet".
 */
export interface RequiredReceiptSet {
  setVersion: "contained-turn-v1-required-receipts@1";
  membershipFrozenAt: "command_acceptance";
  membershipMutation: "forbidden";
  satisfaction: "typed_receipt_or_authority_defined_typed_non_applicability_proof";
  receipts: NonEmptyUniqueStrings;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "compositionFixture".
 */
export interface CompositionFixture {
  factory: "direct_pure_di";
  construction: "synchronous_effect_free_resource_free";
  providerSelection: "composition_root_before_factory";
  providerSelectionFailurePolicy: "fail_before_factory_handle_or_effects_on_missing_unknown_duplicate_or_ambiguous_selection";
  dependencySnapshot: "exact_dependencies_once";
  resourcesCreatedAtConstruction: false;
  /**
   * @minItems 7
   * @maxItems 7
   */
  dependencies: never[];
  dependencyObject: "closed_readonly_exact_membership";
  ordinaryCallerSurface: "trusted_scope_bound_runtime_access_handle";
  operations: NonEmptyUniqueStrings;
  detachedFromCompositionMachinery: true;
  hostBinding: "owning_agent_runtime_host_reject_after_disposal";
  futureModuleAdapterRole: "alternative_outer_composition_calling_same_factory_only";
  forbiddenExports: NonEmptyUniqueStrings;
  moduleKitDependency: false;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "identityMatrixEntry".
 */
export interface IdentityMatrixEntry {
  identity: string;
  namespace: string;
  mustNotAlias: NonEmptyUniqueStrings;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "lifecycleMatrixEntry".
 */
export interface LifecycleMatrixEntry {
  lifecycle: string;
  maximumMeaning: string;
  mustNotMean: NonEmptyUniqueStrings;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "negativeGuardExample".
 */
export interface NegativeGuardExample {
  id: CanonicalId;
  facts: NonEmptyUniqueStrings;
  expected:
    | "reject_before_operation"
    | "fence_before_dispatch"
    | "post_dispatch_reconcile_required"
    | "insufficient_negative_acceptance_evidence"
    | "reject_guard_authority_mismatch";
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "shardedCase".
 */
export interface ShardedCase {
  id: CanonicalId;
  requirement: number;
  /**
   * @minItems 1
   */
  exampleFragments: [string, ...string[]];
}
