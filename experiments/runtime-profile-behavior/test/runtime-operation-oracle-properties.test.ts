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
import { createOracleEvaluator } from "../src/features/evidence/runtime-operation-oracle-evaluator.ts";
import {
  createStateProductEvaluator,
  type GeneratedState,
} from "../src/features/evidence/runtime-operation-state-product.ts";
import type { Example } from "../fixtures/proof-artifacts/runtime-operation-oracle/runtime-operation-oracle-types.generated.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const authority = await loadRuntimeOperationOracleAuthority(repositoryRoot);
const evaluateOracleExample = createOracleEvaluator(authority);
const stateProduct = createStateProductEvaluator(authority);
const GENERATED_AXES = stateProduct.axes;
const FAST_CHECK_SEED = 0x0a0d_0006;
const FAST_CHECK_OPTIONS = {
  seed: FAST_CHECK_SEED,
  numRuns: 1_000,
  verbose: 2 as const,
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
    if (!stateProduct.stateIsValid(state) || state.terminal === "open") {
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
  }).filter((state) => stateProduct.stateIsValid(state));
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
    assert.equal(stateProduct.stateIsValid({ ...state, ...patch }), false);
  }), FAST_CHECK_OPTIONS);
});

test("fast-check proves evaluator fact ordering is semantically irrelevant", async () => {
  const examples = authority.oracle.cases.flatMap(({ examples: caseExamples }) => caseExamples);
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
