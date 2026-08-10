import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { loadRuntimeOperationOracleAuthority } from "../src/features/evidence/runtime-operation-oracle-authority.ts";
import {
  createOracleEvaluator,
  type OracleEvaluator,
} from "../src/features/evidence/runtime-operation-oracle-evaluator.ts";
import type { Example } from "../spec/runtime-operation-oracle/generated/runtime-operation-oracle-types.generated.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const authority = await loadRuntimeOperationOracleAuthority(repositoryRoot);
const evaluateOracleExample = createOracleEvaluator(authority);

type SemanticMutant = {
  id: string;
  evaluate: OracleEvaluator;
};

const acceptWhen = (
  id: string,
  predicate: (example: Example) => boolean,
  baseline: OracleEvaluator = evaluateOracleExample,
): SemanticMutant => ({
  id,
  evaluate: (example) => predicate(example)
    ? { decision: "accept", code: "accepted" }
    : baseline(example),
});

const has = (example: Example, fact: Example["facts"][number]): boolean =>
  example.facts.includes(fact);

const forbiddenTransitionFacts = new Set(authority.crossAxis.forbiddenTransitionFacts);
const isCanonicalForbiddenCrossAxisEdge = (example: Example): boolean =>
  example.check === "cross_axis_transition" &&
  example.facts.some((fact) => forbiddenTransitionFacts.has(fact));

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
  acceptWhen("allow-forbidden-cross-axis-edge", isCanonicalForbiddenCrossAxisEdge),
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

test("all curated semantic mutants are killed by authoritative examples", () => {
  const examples = authority.oracle.cases.flatMap(({ examples: caseExamples }) => caseExamples);
  const survivors = semanticMutants.filter((mutant) =>
    !examples.some((example) => {
      const actual = mutant.evaluate(example);
      return JSON.stringify(actual) !== JSON.stringify(example.expected);
    }),
  );
  assert.deepEqual(survivors.map(({ id }) => id), []);
});

test("forbidden-edge mutant is equivalent against an already weakened evaluator", () => {
  const weakened: OracleEvaluator = (example) => isCanonicalForbiddenCrossAxisEdge(example)
    ? { decision: "accept", code: "accepted" }
    : evaluateOracleExample(example);
  const mutant = acceptWhen(
    "allow-forbidden-cross-axis-edge",
    isCanonicalForbiddenCrossAxisEdge,
    weakened,
  );
  for (const example of authority.oracle.cases.flatMap(({ examples }) => examples)) {
    assert.deepEqual(mutant.evaluate(example), weakened(example), example.id);
  }
});

test("every authoritative required-fact deletion is killed by the handwritten evaluator", () => {
  const examples = authority.oracle.cases.flatMap(({ examples: caseExamples }) => caseExamples);
  for (const transition of authority.crossAxis.transitions) {
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
