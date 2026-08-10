import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  assert as assertProperty,
  constant,
  constantFrom,
  integer,
  property,
  record,
} from "fast-check";

import { loadRuntimeOperationOracleAuthority } from "../src/features/evidence/runtime-operation-oracle-authority.ts";
import {
  evaluateOracleExample,
  type OracleEvaluator,
} from "../src/features/evidence/runtime-operation-oracle-evaluator.ts";
import {
  generatedStateIsValid,
  type GeneratedState,
} from "../src/features/evidence/runtime-operation-state-product.ts";
import { GENERATED_AXES } from "../spec/runtime-operation-oracle/generated/runtime-operation-oracle-catalog.generated.ts";
import type { Example } from "../spec/runtime-operation-oracle/generated/runtime-operation-oracle-types.generated.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const FAST_CHECK_SEED = 0x0a0d_0006;
const FAST_CHECK_OPTIONS = {
  seed: FAST_CHECK_SEED,
  numRuns: 1_000,
  verbose: 2 as const,
  endOnFailure: true,
};

const stateArbitrary = record({
  dispatch: constantFrom(...GENERATED_AXES.dispatch),
  admission: constantFrom(...GENERATED_AXES.admission),
  output: constantFrom(...GENERATED_AXES.output),
  execution: constantFrom(...GENERATED_AXES.execution),
  containment: constantFrom(...GENERATED_AXES.containment),
  reconciliation: constantFrom(...GENERATED_AXES.reconciliation),
  manifest: constantFrom(...GENERATED_AXES.manifest),
  satisfaction: constantFrom(...GENERATED_AXES.satisfaction),
  effectResolution: constantFrom(...GENERATED_AXES.effectResolution),
  terminal: constantFrom(...GENERATED_AXES.terminal),
});

test("fast-check terminal-valid states imply every independent closure condition", () => {
  assertProperty(property(stateArbitrary, (state) => {
    if (!generatedStateIsValid(state) || state.terminal === "open") {
      return;
    }
    assert.equal(state.admission, "fenced");
    assert.equal(state.output, "fenced");
    assert.notEqual(state.execution, "active");
    assert.equal(["pending", "uncertain"].includes(state.containment), false);
    assert.equal(state.reconciliation, "clear");
    assert.equal(state.manifest, "sealed");
    assert.equal(state.satisfaction, "complete");
    if (state.terminal === "outcome_indeterminate") {
      assert.equal(["none", "indeterminate"].includes(state.effectResolution), true);
    } else {
      assert.equal(["none", "resolved"].includes(state.effectResolution), true);
    }
  }), FAST_CHECK_OPTIONS);
});

test("fast-check kills one-field closure weakening of known-valid terminal states", () => {
  const validTerminalArbitrary = record({
    dispatch: constantFrom("unclaimed", "known_not_accepted", "provider_accepted"),
    admission: constant("fenced"),
    output: constant("fenced"),
    execution: constantFrom("not_started", "terminated"),
    containment: constantFrom("not_requested", "contained"),
    reconciliation: constant("clear"),
    manifest: constant("sealed"),
    satisfaction: constant("complete"),
    effectResolution: constantFrom("none", "resolved"),
    terminal: constantFrom("succeeded", "failed", "cancelled"),
  }).filter((state) => generatedStateIsValid(state));
  const mutation = constantFrom<Partial<GeneratedState>>(
    { admission: "open" },
    { output: "open" },
    { execution: "active" },
    { containment: "uncertain" },
    { reconciliation: "required" },
    { manifest: "open" },
    { satisfaction: "incomplete" },
    { effectResolution: "unresolved" },
  );
  assertProperty(property(validTerminalArbitrary, mutation, (state, patch) => {
    assert.equal(generatedStateIsValid({ ...state, ...patch }), false);
  }), FAST_CHECK_OPTIONS);
});

test("fast-check proves evaluator fact ordering is semantically irrelevant", async () => {
  const { oracle } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const examples = oracle.cases.flatMap(({ examples: caseExamples }) => caseExamples);
  assertProperty(property(
    constantFrom(...examples),
    integer(),
    (example, offset) => {
      const rotation = Math.abs(offset) % example.facts.length;
      const facts = [...example.facts.slice(rotation), ...example.facts.slice(0, rotation)];
      const rotated = { ...example, facts } as Example;
      assert.deepEqual(evaluateOracleExample(rotated), example.expected);
    },
  ), FAST_CHECK_OPTIONS);
});

type SemanticMutant = {
  id: string;
  evaluate: OracleEvaluator;
};

const acceptWhen = (
  id: string,
  predicate: (example: Example) => boolean,
): SemanticMutant => ({
  id,
  evaluate: (example) => predicate(example)
    ? { decision: "accept", code: "accepted" }
    : evaluateOracleExample(example),
});

const has = (example: Example, fact: Example["facts"][number]): boolean =>
  example.facts.includes(fact);

const semanticMutants: SemanticMutant[] = [
  acceptWhen("allow-append-after-seal", (example) => has(example, "seal_committed_first")),
  acceptWhen("allow-dispatch-after-cutoff", (example) =>
    example.check === "dispatch_cutoff_race" && !has(example, "dispatch_claim_committed_first")),
  acceptWhen("ignore-terminal-replay-conflict", (example) =>
    example.check === "terminal_replay" && has(example, "conflicting_replay")),
  acceptWhen("dispatch-without-durable-claim", (example) =>
    example.check === "dispatch_crash" && !has(example, "claim_durable")),
  acceptWhen("alias-conflicting-effect-fingerprint", (example) =>
    example.check === "effect_fingerprint_conflict" && has(example, "different_fingerprint")),
  acceptWhen("reuse-stale-attempt", (example) => has(example, "stale_attempt_identity")),
  acceptWhen("accept-conflicting-receipt", (example) => has(example, "receipt_conflicting")),
  acceptWhen("reopen-stale-authority", (example) => has(example, "authority_reopen_requested")),
  acceptWhen("terminalize-incomplete-manifest", (example) =>
    has(example, "child_requirement_missing") || has(example, "transcript_requirement_missing")),
  acceptWhen("allow-forbidden-cross-axis-edge", (example) =>
    example.check === "cross_axis_transition" && example.expected.decision === "reject"),
  acceptWhen("allow-mixed-binary-command", (example) =>
    example.check === "binary_revision_retention" &&
    has(example, "provider_or_effect_work_requested") &&
    (has(example, "semantic_root_release_requested") || has(example, "gc_requested"))),
  acceptWhen("weaken-release-obligation-digest", (example) =>
    has(example, "release_obligation_set_digest_wrong") || has(example, "release_obligation_set_weaker")),
  acceptWhen("establish-root-without-durable-receipt", (example) =>
    has(example, "ensure_semantic_retention_requested") && has(example, "root_cas_won") &&
    !has(example, "root_establishment_receipt_durable")),
  acceptWhen("terminalize-active-execution", (example) =>
    has(example, "transition_terminal_open_final_active_execution")),
];

test("all curated semantic mutants are killed by authoritative examples", async () => {
  const { oracle } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const examples = oracle.cases.flatMap(({ examples: caseExamples }) => caseExamples);
  const survivors = semanticMutants.filter((mutant) =>
    !examples.some((example) => {
      const actual = mutant.evaluate(example);
      return JSON.stringify(actual) !== JSON.stringify(example.expected);
    }),
  );
  assert.deepEqual(survivors.map(({ id }) => id), []);
});

test("every authoritative required-fact deletion is killed by the handwritten evaluator", async () => {
  const { crossAxis, oracle } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const examples = oracle.cases.flatMap(({ examples: caseExamples }) => caseExamples);
  for (const transition of crossAxis.transitions) {
    const acceptedExamples = examples.filter((candidate) =>
      candidate.expected.decision === "accept" && candidate.facts.includes(transition.fact),
    );
    for (const example of acceptedExamples) {
      for (const requiredFact of transition.requiredFacts ?? []) {
        const mutated = {
          ...example,
          facts: example.facts.filter((fact) => fact !== requiredFact),
        } as Example;
        assert.equal(
          evaluateOracleExample(mutated).decision,
          "reject",
          `${example.id} must require ${requiredFact}`,
        );
      }
    }
  }
});
