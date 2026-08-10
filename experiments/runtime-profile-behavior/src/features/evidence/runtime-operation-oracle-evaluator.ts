import { evaluateBinaryRevisionRetention } from "./runtime-operation-binary-retention-oracle.ts";

import type {
  Catalog,
  CrossAxis,
  Example,
  Fact,
  ResultCode,
} from "../../../spec/runtime-operation-oracle/generated/runtime-operation-oracle-types.generated.ts";

type Evaluator = (facts: ReadonlySet<Fact>) => ResultCode;

const has = (facts: ReadonlySet<Fact>, fact: Fact): boolean => facts.has(fact);

const result = (acceptedCodes: ReadonlySet<string>, code: ResultCode): Example["expected"] => ({
  decision: acceptedCodes.has(code) ? "accept" : "reject",
  code,
});

const evaluateTerminalReplay: Evaluator = (facts) => {
  if (has(facts, "conflicting_replay")) {
    return "stale_authority";
  }
  return has(facts, "final_receipt_committed_first") ? "terminal_already_final" : "accepted";
};

const evaluateIndeterminateRace: Evaluator = (facts) => {
  if (has(facts, "conflicting_replay")) {
    return "axis_invariant_violation";
  }
  return has(facts, "late_positive_committed_first") ? "accepted" : "late_evidence_is_noncanonical";
};

const evaluateDispatchCrash: Evaluator = (facts) => {
  if (!has(facts, "claim_durable")) {
    return "provider_dispatch_not_authorized";
  }
  if (has(facts, "new_claim_requested")) {
    return "new_claim_forbidden";
  }
  if (has(facts, "provider_bytes_absent")) {
    return "durable_recovery_required";
  }
  if (has(facts, "provider_acceptance_unproven")) {
    return "acceptance_unknown_reconcile_required";
  }
  return has(facts, "provider_accepted") ? "accepted" : "axis_invariant_violation";
};

const executionStateFacts: readonly Fact[] = [
  "execution_not_started",
  "execution_active",
  "execution_terminated",
];

const hasExactExecutionState = (facts: ReadonlySet<Fact>, expected: Fact): boolean => {
  const observed = executionStateFacts.filter((fact) => has(facts, fact));
  return observed.length === 1 && observed[0] === expected;
};

const evaluateCrossAxisTransition = (
  facts: ReadonlySet<Fact>,
  allowedTransitions: ReadonlySet<string>,
): ResultCode => {
  const transitions = [...facts].filter((fact) => fact.startsWith("transition_"));
  if (transitions.length !== 1 || !allowedTransitions.has(transitions[0]!)) {
    return "transition_forbidden";
  }
  const transition = transitions[0]!;
  if (transition === "transition_manifest_open_sealed_with_fences") {
    return has(facts, "admission_fenced") && has(facts, "output_fenced")
      ? "accepted"
      : "transition_forbidden";
  }
  if (transition === "transition_containment_not_requested_qualified_not_required") {
    const executionNotActive = hasExactExecutionState(facts, "execution_not_started") ||
      hasExactExecutionState(facts, "execution_terminated");
    return has(facts, "admission_fenced") && has(facts, "output_fenced") &&
        executionNotActive && has(facts, "containment_capability_evidence_immutable") &&
        has(facts, "containment_qualification_receipt_exact")
      ? "accepted"
      : "transition_forbidden";
  }
  if (transition !== "transition_terminal_open_final_with_closure" &&
      transition !== "transition_terminal_open_final_not_started_with_closure") {
    return "accepted";
  }
  const closureFacts: readonly Fact[] = [
    "admission_fenced",
    "output_fenced",
    "reconciliation_clear",
    "containment_satisfied",
    "manifest_sealed",
    "all_manifest_entries_satisfied",
  ];
  const expectedExecutionState = transition === "transition_terminal_open_final_with_closure"
    ? "execution_terminated"
    : "execution_not_started";
  return closureFacts.every((fact) => has(facts, fact)) &&
      hasExactExecutionState(facts, expectedExecutionState)
    ? "accepted"
    : "transition_forbidden";
};

const EVALUATORS: Record<string, Evaluator> = {
  output_terminal_order: (facts) => has(facts, "seal_committed_first") ? "append_rejected_after_seal" : "accepted",
  dispatch_cutoff_race: (facts) => has(facts, "dispatch_claim_committed_first") ? "accepted" : "dispatch_rejected_after_cutoff",
  requirement_closure_race: (facts) => has(facts, "reservation_committed_first") ? "accepted" : "reservation_rejected_after_seal",
  terminal_replay: evaluateTerminalReplay,
  indeterminate_evidence_race: evaluateIndeterminateRace,
  outbox_recovery: (facts) => has(facts, "seal_durable") && has(facts, "outbox_unpublished") ? "durable_recovery_required" : "axis_invariant_violation",
  dispatch_crash: evaluateDispatchCrash,
  provider_observation: (facts) => has(facts, "provider_accepted") && has(facts, "observation_not_durable") ? "reconciliation_required" : "accepted",
  lost_acknowledgement: (facts) => has(facts, "terminal_durable") && has(facts, "acknowledgement_lost") && has(facts, "exact_replay") ? "replay_returns_original_receipt" : "stale_authority",
  effect_identity_claim: (facts) => has(facts, "same_external_identity") && has(facts, "same_fingerprint") ? "idempotent_existing_effect" : "external_identity_conflict",
  effect_fingerprint_conflict: (facts) => has(facts, "same_external_identity") && has(facts, "different_fingerprint") ? "external_identity_conflict" : "accepted",
  distinct_external_identity: (facts) => has(facts, "different_external_identity") && has(facts, "same_payload") ? "distinct_effect_required" : "external_identity_conflict",
  completed_effect_replay: (facts) => has(facts, "effect_completed") && !has(facts, "provider_call_requested") ? "completed_result_replayed" : "retry_permanently_forbidden",
  retry_after_known_not_accepted: (facts) => has(facts, "known_not_accepted_receipt") && has(facts, "fresh_attempt_identity") ? "accepted" : "fresh_attempt_required",
  tombstone_restore: (facts) => has(facts, "permanent_tombstone") && has(facts, "restore_or_compaction") ? "retry_permanently_forbidden" : "accepted",
  effect_cardinality: (facts) => has(facts, "invalid_effect_cardinality") ? "invalid_effect_cardinality" : "accepted",
  receipt_handling: (facts) => has(facts, "receipt_conflicting") ? "conflicting_receipt" : "accepted",
  stale_restore: (facts) => has(facts, "authority_reopen_requested") ? "stale_authority" : "accepted",
  model_invariants: (facts) => has(facts, "all_axis_invariants_hold") && !has(facts, "axis_invariant_violated") ? "accepted" : "axis_invariant_violation",
  cutoff_boundary_reuse: (facts) => has(facts, "prior_cutoff_fences_exact") && has(facts, "cursor_and_receipt_reused") ? "accepted" : "cutoff_boundary_conflict",
  normal_provider_termination: (facts) => has(facts, "provider_execution_terminated") && has(facts, "containment_not_requested") ? "containment_not_required" : "reconciliation_required",
  zero_attempt_cutoff: (facts) => has(facts, "effect_registered") && has(facts, "zero_attempts") && has(facts, "cutoff_fenced") ? "zero_attempt_effect_closed" : "axis_invariant_violation",
  post_seal_receipt: (facts) => has(facts, "manifest_sealed") && has(facts, "receipt_bound_to_manifest_entry") ? "accepted" : "receipt_not_bound",
  atomic_indeterminate_clear: (facts) => has(facts, "all_tombstone_receipts_present") && has(facts, "debt_clear_terminal_atomic") ? "accepted" : "indeterminate_clear_not_atomic",
  deployment_continuity: (facts) => has(facts, "continuity_receipt_verified") ? "accepted" : "continuity_unproven",
  manifest_coverage: (facts) => has(facts, "all_manifest_entries_satisfied") && !has(facts, "child_requirement_missing") && !has(facts, "transcript_requirement_missing") ? "accepted" : "manifest_incomplete",
};

export type OracleEvaluator = (example: Example) => Example["expected"];

export const createOracleEvaluator = (
  authority: { catalog: Catalog; crossAxis: CrossAxis },
): OracleEvaluator => {
  const allowedTransitions = new Set(authority.crossAxis.transitions.map(({ fact }) => fact));
  const evaluators: Record<string, Evaluator> = {
    ...EVALUATORS,
    cross_axis_transition: (facts) => evaluateCrossAxisTransition(facts, allowedTransitions),
    binary_revision_retention: (facts) => evaluateBinaryRevisionRetention(
      facts,
      authority.catalog.binaryRetentionFactRoles,
    ),
  };
  const implementedChecks = Object.keys(evaluators).toSorted();
  if (JSON.stringify(implementedChecks) !== JSON.stringify([...authority.catalog.checks].toSorted())) {
    throw new Error("runtime-operation evaluator: catalog checks differ from handwritten semantics");
  }
  const acceptedCodes = new Set(authority.catalog.acceptedResultCodes);
  return (example) => {
    const evaluator = evaluators[example.check];
    if (evaluator === undefined) {
      throw new Error(`runtime-operation evaluator: unsupported check ${example.check}`);
    }
    return result(acceptedCodes, evaluator(new Set(example.facts)));
  };
};
