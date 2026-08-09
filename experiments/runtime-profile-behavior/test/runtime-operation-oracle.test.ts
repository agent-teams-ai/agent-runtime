import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  evaluateGeneratedAxisProducts,
  ORACLE_CHECKS,
  ORACLE_FACTS,
  ORACLE_RESULT_CODES,
  parseRuntimeOperationOracle,
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
    caseCount: 27,
    exampleCount: 85,
    acceptedCount: 47,
    rejectedCount: 38,
  });
});

test("JSON schema closed enums stay aligned with the executable validator", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, unknown>;
  const definitions = schema.$defs as Record<string, Record<string, unknown>>;
  assert.deepEqual(definitions.check?.enum, ORACLE_CHECKS);
  assert.deepEqual(definitions.fact?.enum, ORACLE_FACTS);
  assert.deepEqual(definitions.resultCode?.enum, ORACLE_RESULT_CODES);
});

test("model oracle exhausts the deterministic eight-axis state product", () => {
  assert.deepEqual(evaluateGeneratedAxisProducts(), {
    total: 2400,
    valid: 987,
    invalid: 1413,
  });
});

test("oracle fails closed when a required case is missing", async () => {
  const fixture = await readFixture();
  fixture.cases = casesOf(fixture).slice(0, -1);
  assert.throws(
    () => parseRuntimeOperationOracle(fixture),
    /cover requirements 1 through 27 exactly once/,
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

test("oracle detects an expectation that contradicts the model", async () => {
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
    /missing-child-satisfaction expected.*got/,
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
