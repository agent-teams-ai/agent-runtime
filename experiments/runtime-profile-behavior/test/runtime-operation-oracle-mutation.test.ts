import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { loadRuntimeOperationOracleAuthority } from "../src/features/evidence/runtime-operation-oracle-authority.ts";
import {
  createOracleEvaluator,
  type OracleEvaluator,
} from "../src/features/evidence/runtime-operation-oracle-evaluator.ts";
import { evaluatePreMaterializationGuard } from "../src/features/evidence/runtime-operation-contained-turn-v1.ts";
import type { Example } from "../fixtures/proof-artifacts/runtime-operation-oracle/runtime-operation-oracle-types.generated.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const authority = await loadRuntimeOperationOracleAuthority(repositoryRoot);
const evaluateOracleExample = createOracleEvaluator(authority);

const schemaId = "https://agent-teams.ai/schemas/adr-0006-runtime-operation-oracle.schema.json";
const schemaValidator = new Ajv2020({ allErrors: true, strict: true, strictRequired: true });
schemaValidator.addSchema(authority.schema);
const validateContainedTurnContract = schemaValidator.getSchema(
  `${schemaId}#/$defs/containedTurnV1Contract`,
) ?? assert.fail("contained-turn V1 contract schema is unavailable");

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

test("composition schema kills missing, renamed, nested, and provider-hidden Provider Access mutants", () => {
  const dependencies = authority.containedTurnV1Contract.compositionFixture.dependencies;
  const mutants: ReadonlyArray<readonly [string, unknown[]]> = [
    ["missing-provider-access", dependencies.filter((value) => value !== "provider_access")],
    ["renamed-provider-access", dependencies.map((value) =>
      value === "provider_access" ? "provider_access_binding" : value)],
    ["nested-provider-access", dependencies.map((value) =>
      value === "provider_access" ? { provider_access: value } : value)],
    ["provider-hidden-access", dependencies.map((value) =>
      value === "provider_access" ? "provider" : value)],
  ];

  for (const [id, mutatedDependencies] of mutants) {
    const contract = structuredClone(authority.containedTurnV1Contract) as Record<string, unknown>;
    const fixture = contract.compositionFixture as Record<string, unknown>;
    fixture.dependencies = mutatedDependencies;
    assert.equal(validateContainedTurnContract(contract), false, id);
  }
});

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

test("ADR-0004 guard examples kill pre-dispatch and false-negative mutants", () => {
  const examples = authority.containedTurnV1Contract.negativeGuard;
  const mutants = [
    { id: "delayed-command-materializes", example: "guard-before-delayed-command", result: "fence_before_dispatch" },
    { id: "pre-claim-guard-allows-dispatch", example: "guard-after-acceptance-before-claim", result: "post_dispatch_reconcile_required" },
    { id: "post-claim-guard-erases-claim", example: "claim-before-guard", result: "fence_before_dispatch" },
    { id: "not-found-proves-no-acceptance", example: "provider-not-found-is-not-prevention-proof", result: "fence_before_dispatch" },
    { id: "digest-mismatch-authorizes-guard", example: "guard-command-digest-mismatch", result: "fence_before_dispatch" },
    { id: "scope-mismatch-authorizes-guard", example: "guard-scope-mismatch", result: "fence_before_dispatch" },
  ] as const;
  for (const mutant of mutants) {
    const example = examples.find(({ id }) => id === mutant.example);
    assert.ok(example, mutant.id);
    assert.equal(evaluatePreMaterializationGuard(example.facts), example.expected, mutant.id);
    assert.notEqual(mutant.result, example.expected, `${mutant.id} must be killed`);
  }
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

test("historical release replay rejects contradictions from either evidence family", () => {
  const retentionCase = authority.oracle.cases.find(({ requirement }) => requirement === 28);
  assert.ok(retentionCase);
  const releaseReplay = retentionCase.examples.find(
    ({ id }) => id === "exact-release-replay-is-idempotent",
  );
  const abandonReplay = retentionCase.examples.find(
    ({ id }) => id === "exact-abandon-release-replay",
  );
  assert.ok(releaseReplay);
  assert.ok(abandonReplay);
  const earlierAcceptanceReplay = [
    "operation_acceptance_exact_replay",
    "operation_acceptance_state_accepted",
    "operation_acceptance_transaction_complete",
  ] as const;

  for (const replay of [releaseReplay, abandonReplay]) {
    for (const invalidAbortEvidence of [
      "operation_acceptance_aborted_receipt_stale",
      "operation_acceptance_aborted_receipt_wrong_scope",
      "operation_acceptance_aborted_receipt_unknown",
    ] as const) {
      assert.deepEqual(evaluateOracleExample({
        ...replay,
        facts: [...replay.facts, ...earlierAcceptanceReplay, invalidAbortEvidence],
      }), {
        decision: "reject",
        code: "operation_acceptance_stale_current_receipt",
      });
    }

    for (const invalidManifestEvidence of [
      "release_manifest_incomplete",
      "release_manifest_stale",
      "release_manifest_wrong_scope",
      "release_manifest_unknown",
      "release_manifest_duplicate_evidence",
      "release_obligation_set_digest_wrong",
      "release_obligation_set_weaker",
    ] as const) {
      assert.deepEqual(evaluateOracleExample({
        ...replay,
        facts: [...replay.facts, ...earlierAcceptanceReplay, invalidManifestEvidence],
      }), {
        decision: "reject",
        code: "release_manifest_conflict",
      });
    }
  }
});
