import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const ORACLE_CHECKS = [
  "output_terminal_order",
  "dispatch_cutoff_race",
  "requirement_closure_race",
  "terminal_replay",
  "indeterminate_evidence_race",
  "outbox_recovery",
  "dispatch_crash",
  "provider_observation",
  "lost_acknowledgement",
  "effect_identity_claim",
  "effect_fingerprint_conflict",
  "distinct_external_identity",
  "completed_effect_replay",
  "retry_after_known_not_accepted",
  "tombstone_restore",
  "effect_cardinality",
  "receipt_handling",
  "stale_restore",
  "model_invariants",
  "cutoff_boundary_reuse",
  "normal_provider_termination",
  "zero_attempt_cutoff",
  "post_seal_receipt",
  "atomic_indeterminate_clear",
  "deployment_continuity",
  "manifest_coverage",
  "cross_axis_transition",
] as const;

export const ORACLE_FACTS = [
  "append_committed_first",
  "seal_committed_first",
  "dispatch_claim_committed_first",
  "operation_cutoff_committed_first",
  "session_cutoff_committed_first",
  "scope_cutoff_committed_first",
  "reservation_committed_first",
  "manifest_seal_committed_first",
  "final_receipt_committed_first",
  "terminal_command_committed_first",
  "late_positive_committed_first",
  "indeterminate_terminal_committed_first",
  "seal_durable",
  "outbox_unpublished",
  "claim_durable",
  "provider_bytes_absent",
  "provider_accepted",
  "observation_not_durable",
  "terminal_durable",
  "acknowledgement_lost",
  "exact_replay",
  "conflicting_replay",
  "same_external_identity",
  "different_external_identity",
  "same_fingerprint",
  "different_fingerprint",
  "same_payload",
  "effect_completed",
  "provider_call_requested",
  "known_not_accepted_receipt",
  "fresh_attempt_identity",
  "stale_attempt_identity",
  "permanent_tombstone",
  "restore_or_compaction",
  "zero_effects",
  "one_coarse_effect",
  "multiple_mediated_effects",
  "invalid_effect_cardinality",
  "receipt_delayed",
  "receipt_reordered",
  "receipt_duplicate_exact",
  "receipt_conflicting",
  "authority_reopen_requested",
  "authority_monotonic",
  "all_axis_invariants_hold",
  "axis_invariant_violated",
  "prior_cutoff_fences_exact",
  "cursor_and_receipt_reused",
  "cursor_or_receipt_advanced",
  "provider_execution_terminated",
  "containment_not_requested",
  "containment_uncertain",
  "effect_registered",
  "zero_attempts",
  "cutoff_fenced",
  "manifest_sealed",
  "receipt_bound_to_manifest_entry",
  "receipt_unbound",
  "all_tombstone_receipts_present",
  "tombstone_receipt_missing",
  "debt_clear_terminal_atomic",
  "debt_cleared_separately",
  "continuity_receipt_verified",
  "continuity_receipt_missing",
  "dispatch_requested",
  "all_manifest_entries_satisfied",
  "child_requirement_missing",
  "transcript_requirement_missing",
  "admission_fenced",
  "output_fenced",
  "reconciliation_clear",
  "execution_not_started",
  "execution_active",
  "execution_terminated",
  "containment_satisfied",
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
  "transition_containment_not_requested_pending",
  "transition_containment_pending_contained",
  "transition_containment_pending_uncertain",
  "transition_containment_contained_pending",
  "transition_cutoff_open_fenced",
  "transition_cutoff_fenced_open",
  "transition_terminal_open_final_with_closure",
  "transition_terminal_open_final_active_execution",
  "transition_terminal_final_open",
  "transition_claim_without_execution_activation",
] as const;

export const ORACLE_RESULT_CODES = [
  "accepted",
  "append_rejected_after_seal",
  "dispatch_rejected_after_cutoff",
  "reservation_rejected_after_seal",
  "terminal_already_final",
  "late_evidence_is_noncanonical",
  "durable_recovery_required",
  "provider_dispatch_not_authorized",
  "reconciliation_required",
  "replay_returns_original_receipt",
  "idempotent_existing_effect",
  "external_identity_conflict",
  "distinct_effect_required",
  "completed_result_replayed",
  "fresh_attempt_required",
  "retry_permanently_forbidden",
  "invalid_effect_cardinality",
  "conflicting_receipt",
  "stale_authority",
  "axis_invariant_violation",
  "cutoff_boundary_conflict",
  "containment_not_required",
  "zero_attempt_effect_closed",
  "receipt_not_bound",
  "indeterminate_clear_not_atomic",
  "continuity_unproven",
  "manifest_incomplete",
  "transition_forbidden",
] as const;

type Check = (typeof ORACLE_CHECKS)[number];
type Fact = (typeof ORACLE_FACTS)[number];
type ResultCode = (typeof ORACLE_RESULT_CODES)[number];
type JsonRecord = Record<string, unknown>;

export type OracleExample = {
  id: string;
  check: Check;
  facts: readonly Fact[];
  expected: { decision: "accept" | "reject"; code: ResultCode };
};

export type OracleCase = {
  id: string;
  requirement: number;
  examples: readonly OracleExample[];
};

export type RuntimeOperationOracle = {
  $schema: "./adr-0006-runtime-operation-oracle.schema.json";
  schemaVersion: 1;
  adr: "ADR-0006";
  cases: readonly OracleCase[];
};

const fail = (message: string): never => {
  throw new Error(`runtime-operation oracle: ${message}`);
};

const asRecord = (value: unknown, label: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${label} must be an object`);
  }
  return value as JsonRecord;
};

const exactKeys = (record: JsonRecord, keys: readonly string[], label: string): void => {
  const actual = Object.keys(record).toSorted();
  const expected = [...keys].toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} keys differ: expected ${expected.join(", ")}, got ${actual.join(", ")}`);
  }
};

const enumValue = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return fail(`${label} is unknown`);
  }
  return value as T;
};

const canonicalId = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    return fail(`${label} is not canonical`);
  }
  return value;
};

const parseExample = (value: unknown, label: string): OracleExample => {
  const record = asRecord(value, label);
  exactKeys(record, ["id", "check", "facts", "expected"], label);
  if (!Array.isArray(record.facts) || record.facts.length === 0) {
    fail(`${label}.facts must be a non-empty array`);
  }
  const factsValue = record.facts as unknown[];
  const facts = factsValue.map((fact: unknown, index: number) =>
      enumValue(fact, ORACLE_FACTS, `${label}.facts[${index}]`),
  );
  if (new Set(facts).size !== facts.length) {
    fail(`${label}.facts contains duplicates`);
  }
  const expected = asRecord(record.expected, `${label}.expected`);
  exactKeys(expected, ["decision", "code"], `${label}.expected`);
  return {
    id: canonicalId(record.id, `${label}.id`),
    check: enumValue(record.check, ORACLE_CHECKS, `${label}.check`),
    facts,
    expected: {
      decision: enumValue(expected.decision, ["accept", "reject"], `${label}.expected.decision`),
      code: enumValue(expected.code, ORACLE_RESULT_CODES, `${label}.expected.code`),
    },
  };
};

export const parseRuntimeOperationOracle = (value: unknown): RuntimeOperationOracle => {
  const root = asRecord(value, "root");
  exactKeys(root, ["$schema", "schemaVersion", "adr", "cases"], "root");
  if (root.$schema !== "./adr-0006-runtime-operation-oracle.schema.json" ||
      root.schemaVersion !== 1 || root.adr !== "ADR-0006") {
    fail("local schema, schemaVersion 1, and ADR-0006 identity are required");
  }
  if (!Array.isArray(root.cases)) {
    fail("root.cases must be an array");
  }
  const caseValues = root.cases as unknown[];
  const cases: OracleCase[] = caseValues.map((item: unknown, caseIndex: number): OracleCase => {
    const label = `cases[${caseIndex}]`;
    const record = asRecord(item, label);
    exactKeys(record, ["id", "requirement", "examples"], label);
    if (!Number.isInteger(record.requirement) || Number(record.requirement) < 1) {
      fail(`${label}.requirement must be a positive integer`);
    }
    if (!Array.isArray(record.examples) || record.examples.length < 2) {
      fail(`${label}.examples must contain positive and negative outcomes`);
    }
    const exampleValues = record.examples as unknown[];
    const examples: OracleExample[] = exampleValues.map((example: unknown, exampleIndex: number) =>
      parseExample(example, `${label}.examples[${exampleIndex}]`),
    );
    if (!examples.some(({ expected }) => expected.decision === "accept") ||
        !examples.some(({ expected }) => expected.decision === "reject")) {
      fail(`${label}.examples must include accept and reject expectations`);
    }
    return {
      id: canonicalId(record.id, `${label}.id`),
      requirement: Number(record.requirement),
      examples,
    };
  });
  const requirements = cases.map(({ requirement }) => requirement);
  const expectedRequirements = Array.from({ length: 27 }, (_, index) => index + 1);
  if (JSON.stringify(requirements.toSorted((a, b) => a - b)) !== JSON.stringify(expectedRequirements)) {
    fail("cases must cover requirements 1 through 27 exactly once");
  }
  const ids = [...cases.map(({ id }) => id), ...cases.flatMap(({ examples }) => examples.map(({ id }) => id))];
  if (new Set(ids).size !== ids.length) {
    fail("case and example IDs must be globally unique");
  }
  for (const oracleCase of cases) {
    for (const example of oracleCase.examples) {
      if (example.check !== ORACLE_CHECKS[oracleCase.requirement - 1]) {
        fail(`${example.id} uses the wrong check for requirement ${oracleCase.requirement}`);
      }
    }
  }
  return {
    $schema: "./adr-0006-runtime-operation-oracle.schema.json",
    schemaVersion: 1,
    adr: "ADR-0006",
    cases,
  };
};

const has = (facts: ReadonlySet<Fact>, fact: Fact): boolean => facts.has(fact);
const result = (code: ResultCode): OracleExample["expected"] => ({
  decision: code === "accepted" || [
    "terminal_already_final",
    "late_evidence_is_noncanonical",
    "durable_recovery_required",
    "replay_returns_original_receipt",
    "idempotent_existing_effect",
    "distinct_effect_required",
    "completed_result_replayed",
    "containment_not_required",
    "zero_attempt_effect_closed",
  ].includes(code) ? "accept" : "reject",
  code,
});

type Evaluator = (facts: ReadonlySet<Fact>) => ResultCode;

const ALLOWED_TRANSITIONS = new Set<Fact>([
  "transition_dispatch_unclaimed_claimed",
  "transition_dispatch_claimed_unknown",
  "transition_dispatch_claimed_not_accepted",
  "transition_dispatch_claimed_accepted",
  "transition_dispatch_unknown_not_accepted",
  "transition_dispatch_unknown_accepted",
  "transition_dispatch_not_accepted_claimed_fresh",
  "transition_execution_not_started_active_with_claim",
  "transition_execution_active_not_started_with_proof",
  "transition_execution_active_terminated_with_receipt",
  "transition_containment_not_requested_pending",
  "transition_containment_pending_contained",
  "transition_containment_pending_uncertain",
  "transition_cutoff_open_fenced",
  "transition_terminal_open_final_with_closure",
]);
const TRANSITION_FACTS = new Set<Fact>(
  ORACLE_FACTS.filter((fact) => fact.startsWith("transition_")),
);

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
    return "axis_invariant_violation";
  }
  if (has(facts, "provider_bytes_absent")) {
    return "provider_dispatch_not_authorized";
  }
  return has(facts, "provider_accepted") ? "accepted" : "axis_invariant_violation";
};

const evaluateCrossAxisTransition: Evaluator = (facts) => {
  const transitions = [...facts].filter((fact) => TRANSITION_FACTS.has(fact));
  if (transitions.length !== 1 || !ALLOWED_TRANSITIONS.has(transitions[0] as Fact)) {
    return "transition_forbidden";
  }
  if (transitions[0] !== "transition_terminal_open_final_with_closure") {
    return "accepted";
  }
  const closureFacts: readonly Fact[] = [
    "admission_fenced",
    "output_fenced",
    "reconciliation_clear",
    "containment_satisfied",
    "all_manifest_entries_satisfied",
  ];
  const executionClosed = has(facts, "execution_not_started") || has(facts, "execution_terminated");
  return closureFacts.every((fact) => has(facts, fact)) && executionClosed
    ? "accepted"
    : "transition_forbidden";
};

const EVALUATORS: Record<Check, Evaluator> = {
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
  cross_axis_transition: evaluateCrossAxisTransition,
};

export const evaluateOracleExample = (example: OracleExample): OracleExample["expected"] =>
  result(EVALUATORS[example.check](new Set(example.facts)));

export type RuntimeOperationOracleValidation = {
  caseCount: number;
  exampleCount: number;
  acceptedCount: number;
  rejectedCount: number;
};

const GENERATED_AXES = {
  dispatch: ["unclaimed", "claimed", "acceptance_unknown", "known_not_accepted", "provider_accepted"],
  admission: ["open", "fenced"],
  output: ["open", "fenced"],
  execution: ["not_started", "active", "terminated"],
  containment: ["not_requested", "pending", "contained", "uncertain", "qualified_not_required"],
  reconciliation: ["clear", "required"],
  manifest: ["open", "sealed"],
  terminal: ["open", "final"],
} as const;

type GeneratedState = {
  [Axis in keyof typeof GENERATED_AXES]: (typeof GENERATED_AXES)[Axis][number];
};

const generatedStateIsValid = (state: GeneratedState): boolean => {
  if (state.execution === "active" && ["unclaimed", "known_not_accepted"].includes(state.dispatch)) {
    return false;
  }
  if (state.dispatch === "known_not_accepted" && state.execution !== "not_started") {
    return false;
  }
  if (state.terminal === "open") {
    return true;
  }
  return state.admission === "fenced" &&
    state.output === "fenced" &&
    state.execution !== "active" &&
    !["pending", "uncertain"].includes(state.containment) &&
    state.reconciliation === "clear" &&
    state.manifest === "sealed";
};

export const evaluateGeneratedAxisProducts = (): {
  total: number;
  valid: number;
  invalid: number;
} => {
  let valid = 0;
  let invalid = 0;
  const total = 2400;
  for (let index = 0; index < total; index += 1) {
    const state: GeneratedState = {
      dispatch: GENERATED_AXES.dispatch[index % 5]!,
      admission: GENERATED_AXES.admission[Math.floor(index / 5) % 2]!,
      output: GENERATED_AXES.output[Math.floor(index / 10) % 2]!,
      execution: GENERATED_AXES.execution[Math.floor(index / 20) % 3]!,
      containment: GENERATED_AXES.containment[Math.floor(index / 60) % 5]!,
      reconciliation: GENERATED_AXES.reconciliation[Math.floor(index / 300) % 2]!,
      manifest: GENERATED_AXES.manifest[Math.floor(index / 600) % 2]!,
      terminal: GENERATED_AXES.terminal[Math.floor(index / 1200) % 2]!,
    };
    if (generatedStateIsValid(state)) {
      valid += 1;
    } else {
      invalid += 1;
    }
  }
  return { total: valid + invalid, valid, invalid };
};

export const validateRuntimeOperationOracleValue = (value: unknown): RuntimeOperationOracleValidation => {
  const oracle = parseRuntimeOperationOracle(value);
  const generated = evaluateGeneratedAxisProducts();
  if (generated.total !== 2400 || generated.valid === 0 || generated.invalid === 0) {
    fail("model generation must exhaust the complete eight-axis product");
  }
  const examples = oracle.cases.flatMap(({ examples: items }) => items);
  for (const example of examples) {
    const actual = evaluateOracleExample(example);
    if (JSON.stringify(actual) !== JSON.stringify(example.expected)) {
      fail(`${example.id} expected ${JSON.stringify(example.expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  return {
    caseCount: oracle.cases.length,
    exampleCount: examples.length,
    acceptedCount: examples.filter(({ expected }) => expected.decision === "accept").length,
    rejectedCount: examples.filter(({ expected }) => expected.decision === "reject").length,
  };
};

export const validateRuntimeOperationOracle = async (repositoryRoot: string): Promise<RuntimeOperationOracleValidation> => {
  const fixturePath = join(repositoryRoot, "experiments/runtime-profile-behavior/fixtures/adr-0006-runtime-operation-oracle.json");
  const value: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
  return validateRuntimeOperationOracleValue(value);
};

if (process.argv[1]?.endsWith("validate-runtime-operation-oracle.ts")) {
  const repositoryRoot = process.cwd();
  const validation = await validateRuntimeOperationOracle(repositoryRoot);
  console.log(JSON.stringify(validation));
}
