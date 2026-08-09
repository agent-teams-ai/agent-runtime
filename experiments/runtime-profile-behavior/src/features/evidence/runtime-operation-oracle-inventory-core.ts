export const RUNTIME_OPERATION_ORACLE_CORE_CASES = [
  { caseId: "output-terminal-order", examples: [
    { id: "output-before-seal", check: "output_terminal_order", facts: ["append_committed_first"], expected: {"decision":"accept","code":"accepted"} },
    { id: "seal-before-output", check: "output_terminal_order", facts: ["seal_committed_first"], expected: {"decision":"reject","code":"append_rejected_after_seal"} },
  ] },
  { caseId: "dispatch-cutoff-race", examples: [
    { id: "claim-wins-cutoff-race", check: "dispatch_cutoff_race", facts: ["dispatch_claim_committed_first"], expected: {"decision":"accept","code":"accepted"} },
    { id: "operation-cutoff-wins-dispatch", check: "dispatch_cutoff_race", facts: ["operation_cutoff_committed_first"], expected: {"decision":"reject","code":"dispatch_rejected_after_cutoff"} },
    { id: "session-cutoff-wins-dispatch", check: "dispatch_cutoff_race", facts: ["session_cutoff_committed_first"], expected: {"decision":"reject","code":"dispatch_rejected_after_cutoff"} },
    { id: "scope-cutoff-wins-dispatch", check: "dispatch_cutoff_race", facts: ["scope_cutoff_committed_first"], expected: {"decision":"reject","code":"dispatch_rejected_after_cutoff"} },
  ] },
  { caseId: "requirement-closure-race", examples: [
    { id: "reservation-before-seal", check: "requirement_closure_race", facts: ["reservation_committed_first"], expected: {"decision":"accept","code":"accepted"} },
    { id: "seal-before-reservation", check: "requirement_closure_race", facts: ["manifest_seal_committed_first"], expected: {"decision":"reject","code":"reservation_rejected_after_seal"} },
  ] },
  { caseId: "terminal-command-race", examples: [
    { id: "terminal-command-before-final-receipt", check: "terminal_replay", facts: ["terminal_command_committed_first"], expected: {"decision":"accept","code":"accepted"} },
    { id: "final-receipt-before-duplicate-terminal", check: "terminal_replay", facts: ["final_receipt_committed_first"], expected: {"decision":"accept","code":"terminal_already_final"} },
    { id: "conflicting-terminal-replay", check: "terminal_replay", facts: ["conflicting_replay"], expected: {"decision":"reject","code":"stale_authority"} },
  ] },
  { caseId: "indeterminate-evidence-race", examples: [
    { id: "positive-evidence-before-indeterminate", check: "indeterminate_evidence_race", facts: ["late_positive_committed_first"], expected: {"decision":"accept","code":"accepted"} },
    { id: "positive-evidence-after-indeterminate", check: "indeterminate_evidence_race", facts: ["indeterminate_terminal_committed_first"], expected: {"decision":"accept","code":"late_evidence_is_noncanonical"} },
    { id: "invalid-indeterminate-race-shape", check: "indeterminate_evidence_race", facts: ["conflicting_replay"], expected: {"decision":"reject","code":"axis_invariant_violation"} },
  ] },
  { caseId: "seal-outbox-recovery", examples: [
    { id: "recover-sealed-unpublished-outbox", check: "outbox_recovery", facts: ["seal_durable","outbox_unpublished"], expected: {"decision":"accept","code":"durable_recovery_required"} },
    { id: "uncommitted-seal-cannot-publish", check: "outbox_recovery", facts: ["outbox_unpublished"], expected: {"decision":"reject","code":"axis_invariant_violation"} },
  ] },
  { caseId: "dispatch-claim-crash", examples: [
    { id: "claimed-without-provider-bytes", check: "dispatch_crash", facts: ["claim_durable","provider_bytes_absent"], expected: {"decision":"accept","code":"durable_recovery_required"} },
    { id: "normal-dispatch-after-claim", check: "dispatch_crash", facts: ["claim_durable","provider_accepted"], expected: {"decision":"accept","code":"accepted"} },
    { id: "new-claim-after-durable-claim", check: "dispatch_crash", facts: ["claim_durable","new_claim_requested"], expected: {"decision":"reject","code":"new_claim_forbidden"} },
    { id: "unclaimed-provider-dispatch", check: "dispatch_crash", facts: ["provider_bytes_or_action"], expected: {"decision":"reject","code":"provider_dispatch_not_authorized"} },
    { id: "absence-is-not-nonacceptance-proof", check: "dispatch_crash", facts: ["claim_durable","provider_acceptance_unproven"], expected: {"decision":"reject","code":"acceptance_unknown_reconcile_required"} },
  ] },
  { caseId: "provider-acceptance-observation", examples: [
    { id: "accepted-and-observed", check: "provider_observation", facts: ["provider_accepted"], expected: {"decision":"accept","code":"accepted"} },
    { id: "accepted-before-durable-observation", check: "provider_observation", facts: ["provider_accepted","observation_not_durable"], expected: {"decision":"reject","code":"reconciliation_required"} },
  ] },
  { caseId: "terminal-lost-ack", examples: [
    { id: "exact-terminal-replay-after-lost-ack", check: "lost_acknowledgement", facts: ["terminal_durable","acknowledgement_lost","exact_replay"], expected: {"decision":"accept","code":"replay_returns_original_receipt"} },
    { id: "conflicting-terminal-replay-after-lost-ack", check: "lost_acknowledgement", facts: ["terminal_durable","acknowledgement_lost","conflicting_replay"], expected: {"decision":"reject","code":"stale_authority"} },
  ] },
  { caseId: "successor-effect-identity", examples: [
    { id: "successors-share-qualified-effect", check: "effect_identity_claim", facts: ["same_external_identity","same_fingerprint"], expected: {"decision":"accept","code":"idempotent_existing_effect"} },
    { id: "successors-conflict-on-fingerprint", check: "effect_identity_claim", facts: ["same_external_identity","different_fingerprint"], expected: {"decision":"reject","code":"external_identity_conflict"} },
  ] },
  { caseId: "effect-fingerprint-conflict", examples: [
    { id: "new-external-identity-new-fingerprint", check: "effect_fingerprint_conflict", facts: ["different_external_identity","different_fingerprint"], expected: {"decision":"accept","code":"accepted"} },
    { id: "same-external-identity-conflicting-fingerprint", check: "effect_fingerprint_conflict", facts: ["same_external_identity","different_fingerprint"], expected: {"decision":"reject","code":"external_identity_conflict"} },
  ] },
  { caseId: "distinct-identity-equal-payload", examples: [
    { id: "equal-payload-distinct-effects", check: "distinct_external_identity", facts: ["different_external_identity","same_payload"], expected: {"decision":"accept","code":"distinct_effect_required"} },
    { id: "same-identity-cannot-create-distinct-effect", check: "distinct_external_identity", facts: ["same_external_identity","same_payload"], expected: {"decision":"reject","code":"external_identity_conflict"} },
  ] },
  { caseId: "completed-effect-replay", examples: [
    { id: "completed-effect-zero-provider-calls", check: "completed_effect_replay", facts: ["effect_completed"], expected: {"decision":"accept","code":"completed_result_replayed"} },
    { id: "completed-effect-provider-call-forbidden", check: "completed_effect_replay", facts: ["effect_completed","provider_call_requested"], expected: {"decision":"reject","code":"retry_permanently_forbidden"} },
  ] },
  { caseId: "known-not-accepted-retry", examples: [
    { id: "one-fresh-attempt-after-proof", check: "retry_after_known_not_accepted", facts: ["known_not_accepted_receipt","fresh_attempt_identity"], expected: {"decision":"accept","code":"accepted"} },
    { id: "stale-attempt-after-proof", check: "retry_after_known_not_accepted", facts: ["known_not_accepted_receipt","stale_attempt_identity"], expected: {"decision":"reject","code":"fresh_attempt_required"} },
  ] },
  { caseId: "tombstone-restore", examples: [
    { id: "ordinary-restored-effect", check: "tombstone_restore", facts: ["restore_or_compaction"], expected: {"decision":"accept","code":"accepted"} },
    { id: "restored-tombstone-still-blocks-retry", check: "tombstone_restore", facts: ["permanent_tombstone","restore_or_compaction"], expected: {"decision":"reject","code":"retry_permanently_forbidden"} },
  ] },
  { caseId: "effect-cardinality", examples: [
    { id: "operation-with-zero-effects", check: "effect_cardinality", facts: ["zero_effects"], expected: {"decision":"accept","code":"accepted"} },
    { id: "operation-with-one-coarse-effect", check: "effect_cardinality", facts: ["one_coarse_effect"], expected: {"decision":"accept","code":"accepted"} },
    { id: "operation-with-multiple-mediated-effects", check: "effect_cardinality", facts: ["multiple_mediated_effects"], expected: {"decision":"accept","code":"accepted"} },
    { id: "operation-with-invalid-effect-cardinality", check: "effect_cardinality", facts: ["invalid_effect_cardinality"], expected: {"decision":"reject","code":"invalid_effect_cardinality"} },
  ] },
  { caseId: "receipt-ordering", examples: [
    { id: "delayed-receipt", check: "receipt_handling", facts: ["receipt_delayed"], expected: {"decision":"accept","code":"accepted"} },
    { id: "reordered-receipt", check: "receipt_handling", facts: ["receipt_reordered"], expected: {"decision":"accept","code":"accepted"} },
    { id: "exact-duplicate-receipt", check: "receipt_handling", facts: ["receipt_duplicate_exact"], expected: {"decision":"accept","code":"accepted"} },
    { id: "conflicting-receipt-rejected", check: "receipt_handling", facts: ["receipt_conflicting"], expected: {"decision":"reject","code":"conflicting_receipt"} },
  ] },
  { caseId: "stale-authority-restore", examples: [
    { id: "monotonic-authority-restore", check: "stale_restore", facts: ["authority_monotonic"], expected: {"decision":"accept","code":"accepted"} },
    { id: "restore-reopens-authority", check: "stale_restore", facts: ["authority_reopen_requested"], expected: {"decision":"reject","code":"stale_authority"} },
  ] },
  { caseId: "model-generation", examples: [
    { id: "generated-valid-axis-product", check: "model_invariants", facts: ["all_axis_invariants_hold"], expected: {"decision":"accept","code":"accepted"} },
    { id: "generated-invalid-axis-product", check: "model_invariants", facts: ["axis_invariant_violated"], expected: {"decision":"reject","code":"axis_invariant_violation"} },
  ] },
  { caseId: "cutoff-before-boundary", examples: [
    { id: "boundary-reuses-cutoff-fences", check: "cutoff_boundary_reuse", facts: ["prior_cutoff_fences_exact","cursor_and_receipt_reused"], expected: {"decision":"accept","code":"accepted"} },
    { id: "boundary-advances-cutoff-cursor", check: "cutoff_boundary_reuse", facts: ["prior_cutoff_fences_exact","cursor_or_receipt_advanced"], expected: {"decision":"reject","code":"cutoff_boundary_conflict"} },
  ] },
  { caseId: "normal-provider-termination", examples: [
    { id: "normal-termination-needs-no-containment", check: "normal_provider_termination", facts: ["provider_execution_terminated","containment_not_requested"], expected: {"decision":"accept","code":"containment_not_required"} },
    { id: "uncertain-containment-blocks-terminal", check: "normal_provider_termination", facts: ["provider_execution_terminated","containment_uncertain"], expected: {"decision":"reject","code":"reconciliation_required"} },
  ] },
  { caseId: "zero-attempt-effect-cutoff", examples: [
    { id: "registered-effect-cutoff-before-attempt", check: "zero_attempt_cutoff", facts: ["effect_registered","zero_attempts","cutoff_fenced"], expected: {"decision":"accept","code":"zero_attempt_effect_closed"} },
    { id: "zero-attempt-effect-without-cutoff", check: "zero_attempt_cutoff", facts: ["effect_registered","zero_attempts"], expected: {"decision":"reject","code":"axis_invariant_violation"} },
  ] },
  { caseId: "post-seal-receipt", examples: [
    { id: "bound-receipt-after-seal", check: "post_seal_receipt", facts: ["manifest_sealed","receipt_bound_to_manifest_entry"], expected: {"decision":"accept","code":"accepted"} },
    { id: "unbound-receipt-after-seal", check: "post_seal_receipt", facts: ["manifest_sealed","receipt_unbound"], expected: {"decision":"reject","code":"receipt_not_bound"} },
  ] },
  { caseId: "atomic-indeterminate-clear", examples: [
    { id: "all-tombstones-clear-and-terminal-atomically", check: "atomic_indeterminate_clear", facts: ["all_tombstone_receipts_present","debt_clear_terminal_atomic"], expected: {"decision":"accept","code":"accepted"} },
    { id: "indeterminate-debt-cleared-separately", check: "atomic_indeterminate_clear", facts: ["all_tombstone_receipts_present","debt_cleared_separately"], expected: {"decision":"reject","code":"indeterminate_clear_not_atomic"} },
    { id: "missing-tombstone-blocks-clear", check: "atomic_indeterminate_clear", facts: ["tombstone_receipt_missing","debt_clear_terminal_atomic"], expected: {"decision":"reject","code":"indeterminate_clear_not_atomic"} },
  ] },
  { caseId: "deployment-continuity", examples: [
    { id: "verified-continuity-allows-dispatch", check: "deployment_continuity", facts: ["continuity_receipt_verified","dispatch_requested"], expected: {"decision":"accept","code":"accepted"} },
    { id: "missing-continuity-fails-closed", check: "deployment_continuity", facts: ["continuity_receipt_missing","dispatch_requested"], expected: {"decision":"reject","code":"continuity_unproven"} },
  ] },
  { caseId: "manifest-coverage", examples: [
    { id: "complete-manifest-satisfaction", check: "manifest_coverage", facts: ["all_manifest_entries_satisfied"], expected: {"decision":"accept","code":"accepted"} },
    { id: "missing-child-satisfaction", check: "manifest_coverage", facts: ["child_requirement_missing"], expected: {"decision":"reject","code":"manifest_incomplete"} },
    { id: "missing-transcript-satisfaction", check: "manifest_coverage", facts: ["transcript_requirement_missing"], expected: {"decision":"reject","code":"manifest_incomplete"} },
  ] },
] as const;
