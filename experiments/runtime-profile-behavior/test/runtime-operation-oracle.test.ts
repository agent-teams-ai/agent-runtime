import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  BINARY_RETENTION_ALLOWED_FACTS,
  BINARY_RETENTION_FACT_ROLE_CATALOG,
  BINARY_RETENTION_MIXED_COMMAND_INTENT_FACTS,
  binaryRetentionHasMixedCommandIntent,
} from "../src/features/evidence/runtime-operation-binary-retention-oracle.ts";
import { ENSURE_ROOT_ESTABLISHMENT_WINNER_FENCES } from "../src/features/evidence/runtime-operation-root-lifecycle-oracle.ts";
import {
  evaluateOracleExample,
  evaluateGeneratedAxisProducts,
  generatedStateIsValid,
  ORACLE_CHECKS,
  ORACLE_FACTS,
  ORACLE_RESULT_CODES,
  parseRuntimeOperationOracle,
  type OracleExample,
  validateRuntimeOperationOracle,
  validateRuntimeOperationOracleValue,
} from "../src/features/evidence/validate-runtime-operation-oracle.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const fixturePath = join(
  repositoryRoot,
  "experiments/runtime-profile-behavior/fixtures/adr-0006-runtime-operation-oracle.json",
);
const schemaPath = join(
  repositoryRoot,
  "experiments/runtime-profile-behavior/fixtures/adr-0006-runtime-operation-oracle.schema.json",
);

const readFixture = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;

const casesOf = (fixture: Record<string, unknown>): Record<string, unknown>[] =>
  fixture.cases as Record<string, unknown>[];

const examplesOf = (oracleCase: Record<string, unknown>): Record<string, unknown>[] =>
  oracleCase.examples as Record<string, unknown>[];

test("ADR-0006 oracle covers every required case and expected outcome", async () => {
  assert.deepEqual(await validateRuntimeOperationOracle(repositoryRoot), {
    caseCount: 28,
    exampleCount: 234,
    acceptedCount: 106,
    rejectedCount: 128,
  });
});

test("JSON schema closed enums stay aligned with the executable validator", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, unknown>;
  const definitions = schema.$defs as Record<string, Record<string, unknown>>;
  assert.deepEqual(definitions.check?.enum, ORACLE_CHECKS);
  assert.deepEqual(definitions.fact?.enum, ORACLE_FACTS);
  assert.deepEqual(definitions.resultCode?.enum, ORACLE_RESULT_CODES);
});

test("model oracle exhausts the deterministic ten-axis state product", () => {
  assert.deepEqual(evaluateGeneratedAxisProducts(), {
    total: 48000,
    valid: 1277,
    invalid: 46723,
  });
});

test("generated model enforces coupled and terminal invariants", () => {
  const openState = {
    dispatch: "unclaimed",
    admission: "open",
    output: "open",
    execution: "not_started",
    containment: "not_requested",
    reconciliation: "clear",
    manifest: "open",
    satisfaction: "incomplete",
    effectResolution: "none",
    terminal: "open",
  } as const;
  assert.equal(generatedStateIsValid(openState), true);
  assert.equal(generatedStateIsValid({ ...openState, dispatch: "claimed" }), false);
  assert.equal(generatedStateIsValid({ ...openState, manifest: "sealed" }), false);
  assert.equal(generatedStateIsValid({
    ...openState,
    admission: "fenced",
    manifest: "sealed",
  }), false);
  assert.equal(generatedStateIsValid({ ...openState, satisfaction: "complete" }), false);
  assert.equal(generatedStateIsValid({
    ...openState,
    admission: "fenced",
    output: "fenced",
    manifest: "sealed",
    satisfaction: "complete",
    effectResolution: "unresolved",
  }), false);
  assert.equal(generatedStateIsValid({
    ...openState,
    containment: "qualified_not_required",
  }), false);
  assert.equal(generatedStateIsValid({
    ...openState,
    dispatch: "provider_accepted",
    admission: "fenced",
    output: "fenced",
    execution: "active",
    containment: "qualified_not_required",
  }), false);
  assert.equal(generatedStateIsValid({
    ...openState,
    admission: "fenced",
    output: "fenced",
    containment: "qualified_not_required",
  }), true);
  assert.equal(generatedStateIsValid({
    ...openState,
    dispatch: "acceptance_unknown",
    admission: "fenced",
    output: "fenced",
    execution: "terminated",
    containment: "contained",
    reconciliation: "required",
  }), true);
  assert.equal(generatedStateIsValid({
    ...openState,
    dispatch: "acceptance_unknown",
    admission: "fenced",
    output: "fenced",
    execution: "terminated",
    containment: "contained",
    reconciliation: "clear",
  }), false);

  const finalState = {
    ...openState,
    admission: "fenced",
    output: "fenced",
    manifest: "sealed",
    satisfaction: "complete",
    terminal: "succeeded",
  } as const;
  assert.equal(generatedStateIsValid(finalState), true);
  assert.equal(generatedStateIsValid({ ...finalState, effectResolution: "unresolved" }), false);
  assert.equal(generatedStateIsValid({ ...finalState, execution: "active" }), false);
  assert.equal(generatedStateIsValid({
    ...finalState,
    effectResolution: "indeterminate",
    terminal: "outcome_indeterminate",
  }), true);
  assert.equal(generatedStateIsValid({
    ...finalState,
    dispatch: "acceptance_unknown",
    execution: "terminated",
    containment: "contained",
    effectResolution: "indeterminate",
    terminal: "outcome_indeterminate",
  }), true);
});

test("oracle fails closed when a required case is missing", async () => {
  const fixture = await readFixture();
  fixture.cases = casesOf(fixture).slice(0, -1);
  assert.throws(
    () => parseRuntimeOperationOracle(fixture),
    /cover requirements 1 through 28 exactly once/,
  );
});

test("oracle rejects duplicate case and example IDs", async () => {
  const fixture = await readFixture();
  const cases = casesOf(fixture);
  cases[1] = { ...cases[1], id: cases[0]?.id };
  fixture.cases = cases;
  assert.throws(
    () => parseRuntimeOperationOracle(fixture),
    /IDs must be globally unique/,
  );
});

test("oracle rejects unknown checks, facts, and result codes", async (context) => {
  for (const [field, mutation] of [
    ["check", (example: Record<string, unknown>) => { example.check = "mega_lifecycle"; }],
    ["fact", (example: Record<string, unknown>) => { example.facts = ["authority_maybe_open"]; }],
    ["code", (example: Record<string, unknown>) => {
      example.expected = { decision: "reject", code: "best_effort" };
    }],
  ] as const) {
    await context.test(`unknown ${field}`, async () => {
      const fixture = await readFixture();
      const firstCase = casesOf(fixture)[0];
      assert.ok(firstCase);
      const firstExample = examplesOf(firstCase)[0];
      assert.ok(firstExample);
      mutation(firstExample);
      assert.throws(() => parseRuntimeOperationOracle(fixture), /is unknown/);
    });
  }
});

test("oracle rejects open fields and duplicate facts", async () => {
  const fixture = await readFixture();
  const firstCase = casesOf(fixture)[0];
  assert.ok(firstCase);
  const firstExample = examplesOf(firstCase)[0];
  assert.ok(firstExample);
  firstExample.policyBag = { allow: true };
  assert.throws(() => parseRuntimeOperationOracle(fixture), /keys differ/);

  delete firstExample.policyBag;
  firstExample.facts = ["append_committed_first", "append_committed_first"];
  assert.throws(() => parseRuntimeOperationOracle(fixture), /contains duplicates/);
});

test("oracle rejects facts outside the closed semantics of a check", async () => {
  const fixture = await readFixture();
  const firstCase = casesOf(fixture)[0];
  assert.ok(firstCase);
  const firstExample = examplesOf(firstCase)[0];
  assert.ok(firstExample);
  firstExample.facts = ["append_committed_first", "same_payload"];
  assert.throws(
    () => parseRuntimeOperationOracle(fixture),
    /not allowed for output_terminal_order/,
  );
});

test("exact inventory rejects a truncated cross-axis matrix", async () => {
  const fixture = await readFixture();
  const transitionCase = casesOf(fixture).find(({ requirement }) => requirement === 27);
  assert.ok(transitionCase);
  const transitionExamples = examplesOf(transitionCase);
  transitionCase.examples = [transitionExamples[0], transitionExamples[7]];
  assert.throws(
    () => parseRuntimeOperationOracle(fixture),
    /does not match the exact scenario\/example inventory/,
  );
});

test("exact inventory distinguishes operation, session, and scope cutoff races", async () => {
  const fixture = await readFixture();
  const cutoffCase = casesOf(fixture).find(({ requirement }) => requirement === 2);
  assert.ok(cutoffCase);
  for (const example of examplesOf(cutoffCase)) {
    if (["session-cutoff-wins-dispatch", "scope-cutoff-wins-dispatch"].includes(String(example.id))) {
      example.facts = ["operation_cutoff_committed_first"];
    }
  }
  assert.throws(
    () => parseRuntimeOperationOracle(fixture),
    /does not match the exact scenario\/example inventory/,
  );
});

test("exact inventory prevents transition-matrix collapse", async () => {
  const fixture = await readFixture();
  const transitionCase = casesOf(fixture).find(({ requirement }) => requirement === 27);
  assert.ok(transitionCase);
  for (const example of examplesOf(transitionCase)) {
    const expected = example.expected as Record<string, unknown>;
    example.facts = expected.decision === "accept"
      ? ["transition_dispatch_unclaimed_claimed"]
      : ["transition_dispatch_accepted_claimed"];
  }
  assert.throws(
    () => parseRuntimeOperationOracle(fixture),
    /does not match the exact scenario\/example inventory/,
  );
});

test("every case carries both accepted and rejected evidence", async () => {
  const fixture = await readFixture();
  const firstCase = casesOf(fixture)[0];
  assert.ok(firstCase);
  firstCase.examples = examplesOf(firstCase).filter(
    (example) => (example.expected as Record<string, unknown>).decision === "accept",
  );
  assert.throws(
    () => parseRuntimeOperationOracle(fixture),
    /positive and negative outcomes|include accept and reject expectations/,
  );
});

test("exact inventory detects a rewritten expected outcome", async () => {
  const fixture = await readFixture();
  const cases = casesOf(fixture);
  const manifestCase = cases.find(({ requirement }) => requirement === 26);
  assert.ok(manifestCase);
  const missingChild = examplesOf(manifestCase).find(
    ({ id }) => id === "missing-child-satisfaction",
  );
  assert.ok(missingChild);
  missingChild.expected = { decision: "accept", code: "accepted" };
  assert.throws(
    () => validateRuntimeOperationOracleValue(fixture),
    /does not match the exact scenario\/example inventory/,
  );
});

test("cross-axis matrix includes all five axes and coupled invalid states", async () => {
  const fixture = await readFixture();
  const oracle = parseRuntimeOperationOracle(fixture);
  const transitionCase = oracle.cases.find(({ requirement }) => requirement === 27);
  assert.ok(transitionCase);
  const facts = new Set(transitionCase.examples.flatMap(({ facts: items }) => items));
  for (const prefix of [
    "transition_dispatch_",
    "transition_execution_",
    "transition_containment_",
    "transition_cutoff_",
    "transition_terminal_",
  ]) {
    assert.ok([...facts].some((fact) => fact.startsWith(prefix)), prefix);
  }
  assert.ok(facts.has("transition_claim_without_execution_activation"));
  assert.ok(facts.has("transition_terminal_open_final_active_execution"));
});

test("terminal transition rejects otherwise complete closure without sealed manifest", async () => {
  const fixture = await readFixture();
  const oracle = parseRuntimeOperationOracle(fixture);
  const transitionCase = oracle.cases.find(({ requirement }) => requirement === 27);
  const terminalExample = transitionCase?.examples.find(
    ({ id }) => id === "allow-terminal-with-complete-closure",
  );
  assert.ok(terminalExample);
  const missingManifest = {
    ...terminalExample,
    facts: terminalExample.facts.filter((fact) => fact !== "manifest_sealed"),
  };
  assert.deepEqual(evaluateOracleExample(missingManifest), {
    decision: "reject",
    code: "transition_forbidden",
  });
});

test("binary revision semantic retention fails closed before work and GC", async () => {
  const fixture = await readFixture();
  const oracle = parseRuntimeOperationOracle(fixture);
  const retentionCase = oracle.cases.find(({ requirement }) => requirement === 28);
  assert.ok(retentionCase);
  const rootedWork = retentionCase.examples.find(
    ({ id }) => id === "root-before-provider-or-effect-work",
  );
  assert.ok(rootedWork);
  assert.deepEqual(evaluateOracleExample({
    ...rootedWork,
    facts: ["provider_or_effect_work_requested"],
  }), {
    decision: "reject",
    code: "semantic_root_required",
  });
  assert.deepEqual(evaluateOracleExample({
    ...rootedWork,
    facts: rootedWork.facts.filter((fact) => fact !== "execution_authority_present"),
  }), {
    decision: "reject",
    code: "root_not_execution_authority",
  });
  assert.deepEqual(evaluateOracleExample({
    ...rootedWork,
    facts: rootedWork.facts.filter((fact) => fact !== "operation_acceptance_committed"),
  }), {
    decision: "reject",
    code: "operation_acceptance_required",
  });

  const gcWithRoot = retentionCase.examples.find(
    ({ id }) => id === "gc-with-retained-semantic-root",
  );
  assert.ok(gcWithRoot);
  assert.deepEqual(evaluateOracleExample(gcWithRoot), gcWithRoot.expected);

  const gcAllowed = retentionCase.examples.find(
    ({ id }) => id === "gc-with-zero-semantic-roots",
  );
  assert.ok(gcAllowed);
  assert.deepEqual(evaluateOracleExample({
    ...gcAllowed,
    facts: ["gc_requested", "zero_semantic_roots"],
  }), {
    decision: "reject",
    code: "binary_revision_gc_blocked",
  });

  const safeRelease = retentionCase.examples.find(
    ({ id }) => id === "closed-operation-releases-root",
  );
  assert.ok(safeRelease);
  assert.deepEqual(evaluateOracleExample({
    ...safeRelease,
    facts: safeRelease.facts.filter((fact) => fact !== "binary_revision_root_established"),
  }), {
    decision: "reject",
    code: "semantic_root_required",
  });

  const releaseReplay = retentionCase.examples.find(
    ({ id }) => id === "exact-release-replay-is-idempotent",
  );
  assert.ok(releaseReplay);
  assert.equal(releaseReplay.facts.includes("binary_revision_root_established"), false);
  assert.deepEqual(evaluateOracleExample(releaseReplay), releaseReplay.expected);
  for (const invalidReleaseEvidence of [
    "release_manifest_stale",
    "release_manifest_wrong_scope",
    "release_manifest_unknown",
    "release_manifest_incomplete",
  ] as const) {
    assert.deepEqual(evaluateOracleExample({
      ...releaseReplay,
      facts: [...releaseReplay.facts, invalidReleaseEvidence],
    }), {
      decision: "reject",
      code: "release_manifest_conflict",
    });
  }

  const abandonReplay = retentionCase.examples.find(
    ({ id }) => id === "exact-abandon-release-replay",
  );
  assert.ok(abandonReplay);
  for (const invalidAbortEvidence of [
    "operation_acceptance_aborted_receipt_stale",
    "operation_acceptance_aborted_receipt_wrong_scope",
  ] as const) {
    assert.deepEqual(evaluateOracleExample({
      ...abandonReplay,
      facts: [...abandonReplay.facts, invalidAbortEvidence],
    }), {
      decision: "reject",
      code: "operation_acceptance_stale_current_receipt",
    });
  }

  const lostReceipt = retentionCase.examples.find(
    ({ id }) => id === "lost-root-receipt-ack-replays",
  );
  assert.ok(lostReceipt);
  assert.deepEqual(evaluateOracleExample({
    ...lostReceipt,
    facts: lostReceipt.facts.filter((fact) => fact !== "root_receipt_exact_replay_or_query"),
  }), {
    decision: "reject",
    code: "retention_receipt_reconciliation_required",
  });

  const deletionReplay = retentionCase.examples.find(
    ({ id }) => id === "physical-deletion-exact-replay",
  );
  assert.ok(deletionReplay);
  for (const fact of ["durable_gc_deletion_intent_claim", "zero_semantic_roots"] as const) {
    assert.deepEqual(evaluateOracleExample({
      ...deletionReplay,
      facts: deletionReplay.facts.filter((candidate) => candidate !== fact),
    }), {
      decision: "reject",
      code: "deletion_integrity_contradiction",
    });
  }
  assert.deepEqual(evaluateOracleExample({
    ...deletionReplay,
    facts: [...deletionReplay.facts, "binary_revision_root_established"],
  }), {
    decision: "reject",
    code: "deletion_integrity_contradiction",
  });
  for (const contradictoryFact of [
    "root_cas_won",
    "contradictory_zero_and_retained_roots",
  ] as const) {
    assert.deepEqual(evaluateOracleExample({
      ...deletionReplay,
      facts: [...deletionReplay.facts, contradictoryFact],
    }), {
      decision: "reject",
      code: "deletion_integrity_contradiction",
    });
  }
  assert.deepEqual(evaluateOracleExample({
    ...deletionReplay,
    facts: deletionReplay.facts.filter(
      (fact) => fact !== "deletion_completed_receipt_durable",
    ),
  }), {
    decision: "reject",
    code: "deletion_integrity_contradiction",
  });

  const sharedEffectWork = retentionCase.examples.find(
    ({ id }) => id === "shared-effect-work-complete-roots",
  );
  assert.ok(sharedEffectWork);
  assert.deepEqual(evaluateOracleExample({
    ...sharedEffectWork,
    facts: sharedEffectWork.facts.filter((fact) => fact !== "execution_authority_present"),
  }), {
    decision: "reject",
    code: "root_not_execution_authority",
  });

  const sharedEffectConflict = retentionCase.examples.find(
    ({ id }) => id === "shared-effect-conflicting-root-facts-reject",
  );
  assert.ok(sharedEffectConflict);
  assert.deepEqual(evaluateOracleExample(sharedEffectConflict), sharedEffectConflict.expected);

  const acceptedAbort = retentionCase.examples.find(
    ({ id }) => id === "accepted-operation-with-abort-receipt-quarantines",
  );
  assert.ok(acceptedAbort);
  assert.deepEqual(evaluateOracleExample(acceptedAbort), acceptedAbort.expected);

  const abortAfterTtl = retentionCase.examples.find(
    ({ id }) => id === "valid-abort-proof-after-ttl-releases-root",
  );
  assert.ok(abortAfterTtl);
  assert.deepEqual(evaluateOracleExample(abortAfterTtl), abortAfterTtl.expected);

  for (const id of [
    "normal-abort-releases-established-root",
    "abort-first-persists-forbidden-tombstone",
    "abort-first-forbids-delayed-ensure",
    "abort-first-crash-replay-stays-forbidden",
    "ensure-first-abort-releases-and-forbids",
    "root-establish-and-abort-same-revision-both-win-forbidden",
    "concurrent-accept-abort-accept-wins",
    "concurrent-accept-abort-abort-wins",
    "concurrent-accept-abort-both-cas-win-forbidden",
    "reserve-and-seal-same-revision-both-win-forbidden",
    "physical-deletion-completed-receipt-lost-reconciles",
    "predelete-tombstone-is-not-final-deleted",
    "established-root-lost-ack-replays-original-receipt",
    "established-root-stale-generation-replay-rejects",
    "established-root-replay-with-conflicting-digest-rejects",
    "established-root-replay-with-weaker-set-rejects",
    "release-replay-with-stale-manifest-rejects",
    "release-replay-with-wrong-scope-manifest-rejects",
    "release-replay-with-unknown-manifest-rejects",
    "release-replay-with-incomplete-manifest-rejects",
    "abandon-replay-with-stale-abort-receipt-rejects",
    "abandon-replay-with-wrong-scope-abort-receipt-rejects",
    "accepted-state-with-abort-cas-quarantines",
    "aborted-state-with-accept-cas-quarantines",
    "nonconcurrent-both-terminal-states-quarantine",
    "nonconcurrent-both-cas-winners-quarantine",
    "concurrent-accept-winner-with-both-terminal-states-rejects",
    "concurrent-accept-winner-with-abort-receipt-rejects",
    "concurrent-accept-winner-without-pending-rejects",
    "final-deleted-state-without-completion-receipt-quarantines",
    "completion-receipt-without-final-deleted-state-quarantines",
    "acceptance-command-cannot-bypass-work-authorization",
    "acceptance-command-cannot-bypass-dispatch-authorization",
    "root-request-cannot-bypass-work-authorization",
    "root-request-cannot-bypass-dispatch-authorization",
    "gc-command-cannot-bypass-work-authorization",
    "gc-command-cannot-bypass-dispatch-authorization",
    "deletion-command-cannot-bypass-work-authorization",
    "deletion-command-cannot-bypass-dispatch-authorization",
    "authorized-work-with-acceptance-command-intent-rejects",
    "authorized-work-with-release-replay-intent-rejects",
    "authorized-work-with-abandon-replay-intent-rejects",
    "authorized-work-with-session-release-intent-rejects",
  ] as const) {
    const example: OracleExample | undefined = retentionCase.examples.find(
      (candidate: OracleExample) => candidate.id === id,
    );
    assert.ok(example, id);
    assert.deepEqual(evaluateOracleExample(example), example.expected, id);
  }

  const establishedReplay = retentionCase.examples.find(
    ({ id }) => id === "established-root-lost-ack-replays-original-receipt",
  );
  assert.ok(establishedReplay);
  for (const invalidDigest of [
    "retention_obligation_set_digest_wrong",
    "retention_obligation_set_weaker",
  ] as const) {
    assert.deepEqual(evaluateOracleExample({
      ...establishedReplay,
      facts: [...establishedReplay.facts, invalidDigest],
    }), {
      decision: "reject",
      code: "root_lifecycle_integrity_contradiction",
    });
  }

  const abortLoses = retentionCase.examples.find(({ id }) => id === "abort-loses-after-accept");
  assert.ok(abortLoses);
  assert.deepEqual(evaluateOracleExample({
    ...abortLoses,
    facts: [...abortLoses.facts, "operation_acceptance_abort_cas_won"],
  }), {
    decision: "reject",
    code: "operation_acceptance_integrity_contradiction",
  });

});

test("work authorization dominates accepted non-work branch outcomes", async () => {
  const fixture = await readFixture();
  const oracle = parseRuntimeOperationOracle(fixture);
  const retentionCase = oracle.cases.find(({ requirement }) => requirement === 28);
  assert.ok(retentionCase);
  const branchBypassSeeds = [
    "gc-with-zero-semantic-roots",
    "physical-deletion-completes-with-durable-receipt",
    "physical-deletion-exact-replay",
    "accept-cas-wins-pending-revision",
    "abort-cas-wins-pending-revision",
    "accept-exact-replay-returns-current-receipt",
    "abort-exact-replay-returns-current-receipt",
    "concurrent-accept-abort-accept-wins",
    "concurrent-accept-abort-abort-wins",
    "abort-first-persists-forbidden-tombstone",
    "ensure-first-abort-releases-and-forbids",
    "ensure-establishes-open-obligation-set",
    "established-root-lost-ack-replays-original-receipt",
  ] as const;
  assert.equal(branchBypassSeeds.length, 13);
  for (const id of branchBypassSeeds) {
    const seed: OracleExample | undefined = retentionCase.examples.find(
      (example: OracleExample) => example.id === id,
    );
    assert.ok(seed, id);
    assert.equal(seed.expected.decision, "accept", id);
    for (const trigger of ["provider_or_effect_work_requested", "dispatch_requested"] as const) {
      const outcome = evaluateOracleExample({
        ...seed,
        facts: [...seed.facts, trigger],
      });
      assert.equal(outcome.decision, "reject", `${id} + ${trigger}`);
    }
  }
});

test("closed mixed-command vocabulary cannot drift around work authorization", async () => {
  assert.deepEqual(Object.keys(BINARY_RETENTION_FACT_ROLE_CATALOG), BINARY_RETENTION_ALLOWED_FACTS);
  const classifiedCommands = BINARY_RETENTION_ALLOWED_FACTS.filter((fact) =>
    BINARY_RETENTION_FACT_ROLE_CATALOG[fact] === "command_intent"
  );
  assert.deepEqual(classifiedCommands, BINARY_RETENTION_MIXED_COMMAND_INTENT_FACTS);
  assert.equal(BINARY_RETENTION_FACT_ROLE_CATALOG.provider_or_effect_work_requested, "work_intent");
  assert.equal(BINARY_RETENTION_FACT_ROLE_CATALOG.dispatch_requested, "work_intent");
  for (const historicalEvidence of [
    "root_cas_won",
    "operation_acceptance_accept_cas_won",
    "operation_acceptance_abort_cas_won",
    "root_abort_release_cas_won",
    "collection_or_tombstone_cas_won",
    "host_custody_collection_cas_won",
    "physical_deletion_started",
    "physical_deletion_completed",
  ] as const) {
    assert.equal(BINARY_RETENTION_FACT_ROLE_CATALOG[historicalEvidence], "evidence");
  }

  const fixture = await readFixture();
  const oracle = parseRuntimeOperationOracle(fixture);
  const retentionCase = oracle.cases.find(({ requirement }) => requirement === 28);
  const authorizedWork = retentionCase?.examples.find(
    ({ id }) => id === "root-before-provider-or-effect-work",
  );
  assert.ok(authorizedWork);
  const authorizedFacts = authorizedWork.facts.filter(
    (fact) => fact !== "provider_or_effect_work_requested",
  );
  for (const commandFact of BINARY_RETENTION_MIXED_COMMAND_INTENT_FACTS) {
    for (const trigger of ["provider_or_effect_work_requested", "dispatch_requested"] as const) {
      const facts = [...authorizedFacts, commandFact, trigger];
      assert.equal(binaryRetentionHasMixedCommandIntent(new Set(facts)), true, commandFact);
      const outcome = evaluateOracleExample({ ...authorizedWork, facts });
      assert.equal(outcome.decision, "reject", `${commandFact} + ${trigger}`);
      assert.equal(outcome.code, "mixed_command_intent_forbidden", `${commandFact} + ${trigger}`);
    }
  }

  for (const historicalEvidence of ["root_cas_won", "operation_acceptance_accept_cas_won"] as const) {
    for (const trigger of ["provider_or_effect_work_requested", "dispatch_requested"] as const) {
      const outcome = evaluateOracleExample({
        ...authorizedWork,
        facts: [...authorizedFacts, historicalEvidence, trigger],
      });
      assert.deepEqual(outcome, { decision: "accept", code: "accepted" });
    }
  }
});

test("durable integrity preflight dominates appended work intents", async () => {
  const fixture = await readFixture();
  const oracle = parseRuntimeOperationOracle(fixture);
  const retentionCase = oracle.cases.find(({ requirement }) => requirement === 28);
  assert.ok(retentionCase);
  const durableIntegrityExamples = retentionCase.examples.filter(({ id, expected }) =>
    expected.code === "deletion_integrity_contradiction" ||
    expected.code === "retention_obligation_integrity_contradiction" ||
    id === "root-establish-and-abort-same-revision-both-win-forbidden" ||
    (expected.code === "operation_acceptance_integrity_contradiction" &&
      id !== "concurrent-accept-winner-without-pending-rejects")
  );
  assert.equal(durableIntegrityExamples.length, 19);
  for (const example of durableIntegrityExamples) {
    for (const trigger of ["provider_or_effect_work_requested", "dispatch_requested"] as const) {
      assert.deepEqual(evaluateOracleExample({
        ...example,
        facts: [...example.facts, trigger],
      }), example.expected, `${example.id} + ${trigger}`);
    }
  }
});

test("winning lifecycle evidence fences otherwise authorized work", async () => {
  const fixture = await readFixture();
  const oracle = parseRuntimeOperationOracle(fixture);
  const retentionCase = oracle.cases.find(({ requirement }) => requirement === 28);
  const authorizedWork = retentionCase?.examples.find(
    ({ id }) => id === "root-before-provider-or-effect-work",
  );
  assert.ok(authorizedWork);
  const authorizedFacts = authorizedWork.facts.filter(
    (fact) => fact !== "provider_or_effect_work_requested",
  );
  const fences = [
    ["collection_or_tombstone_cas_won", "semantic_root_establishment_race"],
    ["host_custody_collection_cas_won", "semantic_root_establishment_race"],
    ["root_abort_release_cas_won", "root_lifecycle_integrity_contradiction"],
    ["retention_obligation_seal_cas_won", "retention_obligation_integrity_contradiction"],
  ] as const;
  for (const [fence, code] of fences) {
    for (const trigger of ["provider_or_effect_work_requested", "dispatch_requested"] as const) {
      assert.deepEqual(evaluateOracleExample({
        ...authorizedWork,
        facts: [...authorizedFacts, fence, trigger],
      }), { decision: "reject", code }, `${fence} + ${trigger}`);
    }
  }
});

test("root establishment rejects competing collection and seal winners", async () => {
  const fixture = await readFixture();
  const oracle = parseRuntimeOperationOracle(fixture);
  const retentionCase = oracle.cases.find(({ requirement }) => requirement === 28);
  const ensure = retentionCase?.examples.find(
    ({ id }) => id === "ensure-establishes-open-obligation-set",
  );
  assert.ok(ensure);
  assert.deepEqual(ENSURE_ROOT_ESTABLISHMENT_WINNER_FENCES.map(({ fact }) => fact), [
    "collection_or_tombstone_cas_won",
    "host_custody_collection_cas_won",
    "retention_obligation_seal_cas_won",
    "root_abort_release_cas_won",
  ]);
  for (const winner of ENSURE_ROOT_ESTABLISHMENT_WINNER_FENCES) {
    for (const facts of [
      [winner.fact, ...ensure.facts],
      [...ensure.facts, winner.fact],
    ]) {
      assert.deepEqual(evaluateOracleExample({ ...ensure, facts }), {
        decision: "reject",
        code: winner.currentOutcome,
      });
    }
    assert.deepEqual(evaluateOracleExample({
      ...ensure,
      facts: [
        ...ensure.facts.filter((fact) => fact !== "retention_obligation_set_open"),
        winner.fact,
      ],
    }), {
        decision: "reject",
        code: winner.staleOutcome,
      });
  }
  for (const sealRequest of [[], ["retention_obligation_seal_requested"]] as const) {
    assert.deepEqual(evaluateOracleExample({
      ...ensure,
      facts: [...ensure.facts, ...sealRequest, "retention_obligation_seal_cas_won"],
    }), { decision: "reject", code: "retention_obligation_integrity_contradiction" });
  }
});
test("completed release and seal history rejects work without false quarantine", async () => {
  const fixture = await readFixture();
  const oracle = parseRuntimeOperationOracle(fixture);
  const retentionCase = oracle.cases.find(({ requirement }) => requirement === 28);
  assert.ok(retentionCase);
  const histories = [["ensure-first-abort-releases-and-forbids", "semantic_root_required"],
    ["closed-operation-releases-root", "retention_obligation_set_required"],
    ["dynamic-obligation-sealed-before-release", "retention_obligation_set_required"],
  ] as const;
  for (const [id, code] of histories) {
    const seed: OracleExample | undefined = retentionCase.examples.find(
      (example: OracleExample) => example.id === id,
    );
    assert.ok(seed, id);
    assert.equal(seed.expected.decision, "accept", id);
    for (const trigger of ["provider_or_effect_work_requested", "dispatch_requested"] as const) {
      assert.deepEqual(evaluateOracleExample({
        ...seed,
        facts: [...seed.facts, trigger],
      }), { decision: "reject", code }, `${id} + ${trigger}`);
    }
  }
});

test("complete historical root evidence remains non-command work evidence", async () => {
  const fixture = await readFixture();
  const oracle = parseRuntimeOperationOracle(fixture);
  const retentionCase = oracle.cases.find(({ requirement }) => requirement === 28);
  const authorizedWork = retentionCase?.examples.find(
    ({ id }) => id === "root-before-provider-or-effect-work",
  );
  assert.ok(authorizedWork);
  const authorizedFacts = authorizedWork.facts.filter(
    (fact) => fact !== "provider_or_effect_work_requested",
  );
  const historicalRoot = [
    "root_request_id_stable",
    "root_request_state_established",
    "root_cas_won",
    "root_request_generation_current",
    "root_establishment_receipt_durable",
  ] as const;
  for (const trigger of ["provider_or_effect_work_requested", "dispatch_requested"] as const) {
    assert.deepEqual(evaluateOracleExample({
      ...authorizedWork,
      facts: [...authorizedFacts, ...historicalRoot, trigger],
    }), { decision: "accept", code: "accepted" });
  }
});

test("exact inventory rejects weakened binary revision retention evidence", async () => {
  const fixture = await readFixture();
  const retentionCase = casesOf(fixture).find(({ requirement }) => requirement === 28);
  assert.ok(retentionCase);
  const rootedWork = examplesOf(retentionCase).find(
    ({ id }) => id === "root-before-provider-or-effect-work",
  );
  assert.ok(rootedWork);
  rootedWork.facts = ["provider_or_effect_work_requested"];
  assert.throws(
    () => parseRuntimeOperationOracle(fixture),
    /does not match the exact scenario\/example inventory/,
  );
});
