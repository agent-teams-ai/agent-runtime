import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  evaluateOracleExample,
  parseRuntimeOperationOracle,
  type OracleExample,
} from "../src/features/evidence/validate-runtime-operation-oracle.ts";

const fixturePath = resolve(
  import.meta.dirname,
  "../fixtures/adr-0006-runtime-operation-oracle.json",
);

const readExamples = async (): Promise<OracleExample[]> => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
  return parseRuntimeOperationOracle(fixture).cases.flatMap(({ examples }) => examples);
};

test("root establishment requires its durable typed receipt", async () => {
  const examples = await readExamples();
  const established = examples.find(({ id }) => id === "ensure-establishes-open-obligation-set");
  assert.ok(established);
  assert.deepEqual(evaluateOracleExample({
    ...established,
    facts: established.facts.filter((fact) => fact !== "root_establishment_receipt_durable"),
  }), {
    decision: "reject",
    code: "retention_receipt_reconciliation_required",
  });
});

test("qualified-not-required requires proof, both fences, and inactive execution", async () => {
  const examples = await readExamples();
  const qualified = examples.find(({ id }) => id === "allow-qualified-containment-not-required");
  assert.ok(qualified);
  for (const required of [
    "containment_capability_evidence_immutable",
    "containment_qualification_receipt_exact",
    "admission_fenced",
    "output_fenced",
    "execution_not_started",
  ] as const) {
    assert.deepEqual(evaluateOracleExample({
      ...qualified,
      facts: qualified.facts.filter((fact) => fact !== required),
    }), {
      decision: "reject",
      code: "transition_forbidden",
    }, required);
  }
  assert.deepEqual(evaluateOracleExample({
    ...qualified,
    facts: qualified.facts.map((fact) =>
      fact === "execution_not_started" ? "execution_active" : fact
    ),
  }), {
    decision: "reject",
    code: "transition_forbidden",
  });
  assert.deepEqual(evaluateOracleExample({
    ...qualified,
    facts: [...qualified.facts, "execution_terminated"],
  }), {
    decision: "reject",
    code: "transition_forbidden",
  });
  assert.deepEqual(evaluateOracleExample({
    ...qualified,
    facts: qualified.facts.map((fact) =>
      fact === "execution_not_started" ? "execution_terminated" : fact
    ),
  }), {
    decision: "accept",
    code: "accepted",
  });
});
