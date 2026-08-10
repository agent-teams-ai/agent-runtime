// Generated from ADR-0006 JSON authority. Do not edit.

export const ALLOWED_FACTS_BY_CHECK = {
  "output_terminal_order": [
    "append_committed_first",
    "seal_committed_first"
  ],
  "dispatch_cutoff_race": [
    "dispatch_claim_committed_first",
    "operation_cutoff_committed_first",
    "session_cutoff_committed_first",
    "scope_cutoff_committed_first"
  ],
  "requirement_closure_race": [
    "reservation_committed_first",
    "manifest_seal_committed_first"
  ],
  "terminal_replay": [
    "terminal_command_committed_first",
    "final_receipt_committed_first",
    "conflicting_replay"
  ],
  "indeterminate_evidence_race": [
    "late_positive_committed_first",
    "indeterminate_terminal_committed_first",
    "conflicting_replay"
  ],
  "outbox_recovery": [
    "seal_durable",
    "outbox_unpublished"
  ],
  "dispatch_crash": [
    "claim_durable",
    "provider_bytes_absent",
    "provider_accepted",
    "new_claim_requested",
    "provider_bytes_or_action",
    "provider_acceptance_unproven"
  ],
  "provider_observation": [
    "provider_accepted",
    "observation_not_durable"
  ],
  "lost_acknowledgement": [
    "terminal_durable",
    "acknowledgement_lost",
    "exact_replay",
    "conflicting_replay"
  ],
  "effect_identity_claim": [
    "same_external_identity",
    "same_fingerprint",
    "different_fingerprint"
  ],
  "effect_fingerprint_conflict": [
    "different_external_identity",
    "different_fingerprint",
    "same_external_identity"
  ],
  "distinct_external_identity": [
    "different_external_identity",
    "same_payload",
    "same_external_identity"
  ],
  "completed_effect_replay": [
    "effect_completed",
    "provider_call_requested"
  ],
  "retry_after_known_not_accepted": [
    "known_not_accepted_receipt",
    "fresh_attempt_identity",
    "stale_attempt_identity"
  ],
  "tombstone_restore": [
    "restore_or_compaction",
    "permanent_tombstone"
  ],
  "effect_cardinality": [
    "zero_effects",
    "one_coarse_effect",
    "multiple_mediated_effects",
    "invalid_effect_cardinality"
  ],
  "receipt_handling": [
    "receipt_delayed",
    "receipt_reordered",
    "receipt_duplicate_exact",
    "receipt_conflicting"
  ],
  "stale_restore": [
    "authority_monotonic",
    "authority_reopen_requested"
  ],
  "model_invariants": [
    "all_axis_invariants_hold",
    "axis_invariant_violated"
  ],
  "cutoff_boundary_reuse": [
    "prior_cutoff_fences_exact",
    "cursor_and_receipt_reused",
    "cursor_or_receipt_advanced"
  ],
  "normal_provider_termination": [
    "provider_execution_terminated",
    "containment_not_requested",
    "containment_uncertain"
  ],
  "zero_attempt_cutoff": [
    "effect_registered",
    "zero_attempts",
    "cutoff_fenced"
  ],
  "post_seal_receipt": [
    "manifest_sealed",
    "receipt_bound_to_manifest_entry",
    "receipt_unbound"
  ],
  "atomic_indeterminate_clear": [
    "all_tombstone_receipts_present",
    "debt_clear_terminal_atomic",
    "debt_cleared_separately",
    "tombstone_receipt_missing"
  ],
  "deployment_continuity": [
    "continuity_receipt_verified",
    "dispatch_requested",
    "continuity_receipt_missing"
  ],
  "manifest_coverage": [
    "all_manifest_entries_satisfied",
    "child_requirement_missing",
    "transcript_requirement_missing"
  ],
  "cross_axis_transition": [
    "transition_dispatch_unclaimed_claimed",
    "transition_dispatch_claimed_unknown",
    "transition_dispatch_claimed_not_accepted",
    "transition_dispatch_claimed_accepted",
    "transition_dispatch_unknown_not_accepted",
    "transition_dispatch_unknown_accepted",
    "transition_dispatch_not_accepted_claimed_fresh",
    "transition_dispatch_accepted_claimed",
    "transition_execution_not_started_active_with_claim",
    "transition_execution_active_not_started_with_proof",
    "transition_execution_active_terminated_with_receipt",
    "transition_execution_terminated_active",
    "transition_execution_start_without_claim",
    "transition_execution_reset_without_not_accepted_proof",
    "transition_execution_terminate_without_receipt",
    "transition_containment_not_requested_pending",
    "transition_containment_pending_contained",
    "transition_containment_pending_uncertain",
    "transition_containment_uncertain_pending_retry",
    "transition_containment_uncertain_contained_late_proof",
    "transition_containment_not_requested_qualified_not_required",
    "containment_capability_evidence_immutable",
    "containment_qualification_receipt_exact",
    "admission_fenced",
    "output_fenced",
    "execution_not_started",
    "execution_terminated",
    "execution_active",
    "transition_containment_contained_pending",
    "transition_containment_qualified_not_required_pending",
    "transition_cutoff_open_fenced",
    "transition_cutoff_fenced_open",
    "transition_manifest_open_sealed_with_fences",
    "transition_manifest_open_sealed_open_admission",
    "transition_manifest_open_sealed_open_output",
    "transition_terminal_open_final_with_closure",
    "reconciliation_clear",
    "containment_satisfied",
    "manifest_sealed",
    "all_manifest_entries_satisfied",
    "transition_terminal_open_final_not_started_with_closure",
    "transition_terminal_open_final_active_execution",
    "transition_terminal_final_open",
    "transition_claim_without_execution_activation"
  ],
  "binary_revision_retention": [
    "operation_acceptance_intent_persisted",
    "operation_acceptance_committed",
    "operation_acceptance_state_accepted",
    "operation_acceptance_transaction_complete",
    "binary_revision_root_established",
    "retention_receipt_exact_current",
    "retention_obligation_set_pinned",
    "retention_obligation_schema_revision_pinned",
    "retention_obligation_policy_revision_pinned",
    "retention_obligation_capability_revision_pinned",
    "retention_obligation_set_digest_exact",
    "retention_obligation_set_open",
    "execution_authority_present",
    "provider_or_effect_work_requested",
    "session_assignment_release_requested",
    "operation_nonterminal",
    "effect_reconciliation_required",
    "terminal_projection_requires_revision",
    "transcript_projection_requires_revision",
    "semantic_root_release_requested",
    "terminal_write_once",
    "effect_closure_write_once",
    "durable_revision_independent_projection",
    "release_manifest_identity_binding_complete",
    "release_manifest_retention_obligation_digest",
    "release_manifest_terminal_satisfaction_digests",
    "release_manifest_effect_closure_receipts",
    "release_manifest_projection_independence_receipts",
    "release_manifest_typed_non_applicability_complete",
    "retention_obligation_set_sealed",
    "retention_obligation_seal_requested",
    "retention_obligation_seal_cas_won",
    "retention_obligation_final_digest_durable",
    "retention_obligation_seal_receipt_durable",
    "release_obligation_final_digest_exact",
    "owner_release_receipt_durable",
    "release_exact_replay",
    "release_manifest_stale",
    "release_manifest_wrong_scope",
    "release_manifest_unknown",
    "release_manifest_incomplete",
    "release_outcome_unknown",
    "gc_requested",
    "zero_semantic_roots",
    "existing_gc_blockers_clear",
    "host_custody_collection_cas_won",
    "semantic_root_retained",
    "dispatch_requested",
    "operation_acceptance_revision_pending",
    "shared_effect",
    "attempting_operation_roots_complete",
    "attempting_operation_root_missing",
    "root_cas_won",
    "collection_or_tombstone_cas_won",
    "contradictory_zero_and_retained_roots",
    "root_receipt_ack_lost",
    "root_receipt_exact_replay_or_query",
    "acceptance_outcome_unknown",
    "ttl_elapsed",
    "operation_acceptance_aborted_receipt_exact",
    "owner_abandon_release_receipt_durable",
    "abandon_release_exact_replay",
    "operation_acceptance_aborted_receipt_stale",
    "operation_acceptance_aborted_receipt_wrong_scope",
    "operation_acceptance_aborted_receipt_unknown",
    "release_manifest_duplicate_evidence",
    "release_manifest_digest_conflict",
    "durable_gc_deletion_intent_claim",
    "deletion_set_digest_exact",
    "store_level_deletion_reference_fence_exact",
    "predelete_tombstone_durable",
    "physical_deletion_started",
    "physical_deletion_crash",
    "physical_deletion_completed",
    "deletion_completed_receipt_durable",
    "final_deleted_state_durable",
    "physical_deletion_exact_replay",
    "physical_deletion_partial",
    "physical_deletion_unknown",
    "deletion_claim_wrong_scope",
    "deletion_set_digest_wrong",
    "store_level_deletion_reference_fence_stale",
    "operation_acceptance_accept_requested",
    "operation_acceptance_accept_cas_won",
    "operation_acceptance_abort_requested",
    "operation_acceptance_abort_cas_won",
    "operation_acceptance_state_aborted",
    "operation_abort_transaction_complete",
    "operation_acceptance_exact_replay",
    "operation_abort_exact_replay",
    "retention_obligation_set_digest_wrong",
    "retention_obligation_set_weaker",
    "dynamic_obligation_arose",
    "dynamic_obligation_reserved_before_use",
    "dynamic_obligation_revision_digest_advanced",
    "retention_obligation_reserve_cas_won",
    "release_obligation_set_digest_wrong",
    "release_obligation_set_weaker",
    "root_request_id_stable",
    "root_request_state_pending",
    "root_request_state_establishment_forbidden",
    "root_abort_release_requested",
    "root_abort_release_cas_won",
    "establishment_forbidden_tombstone_durable",
    "root_establishment_rejected_receipt_durable",
    "ensure_semantic_retention_requested",
    "root_request_exact_replay",
    "root_request_state_established",
    "same_revision_root_and_abort_cas_both_won",
    "root_establishment_receipt_durable",
    "same_revision_reserve_and_seal_cas_both_won",
    "physical_deletion_preclaim_requested",
    "physical_absence_observed",
    "shared_store_reference_active",
    "root_request_generation_current",
    "root_request_generation_stale"
  ]
} as const;
