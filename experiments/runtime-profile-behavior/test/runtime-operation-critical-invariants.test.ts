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

test("terminal transitions require their exact single execution state", async () => {
  const examples = await readExamples();
  const executions = ["execution_not_started", "execution_active", "execution_terminated"] as const;
  const terminalTransitions = [
    ["allow-terminal-with-complete-closure", "execution_terminated"],
    ["allow-terminal-not-started-with-complete-closure", "execution_not_started"],
  ] as const;
  for (const [id, expectedExecution] of terminalTransitions) {
    const seed = examples.find((example) => example.id === id);
    assert.ok(seed, id);
    const closureFacts: OracleExample["facts"] = seed.facts.filter((fact) => !executions.includes(
      fact as typeof executions[number],
    ));
    for (let mask = 0; mask < 2 ** executions.length; mask += 1) {
      const observed = executions.filter((_, index) => (mask & (1 << index)) !== 0);
      const shouldAccept = observed.length === 1 && observed[0] === expectedExecution;
      assert.deepEqual(evaluateOracleExample({
        ...seed,
        facts: [...closureFacts, ...observed],
      }), {
        decision: shouldAccept ? "accept" : "reject",
        code: shouldAccept ? "accepted" : "transition_forbidden",
      }, `${id}: ${observed.join("+") || "missing"}`);
    }
  }
});
