import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { initialTransition, transition as transitionMachine } from "xstate";

import { loadRuntimeOperationOracleAuthority } from "../src/features/evidence/runtime-operation-oracle-authority.ts";
import {
  buildSyntheticCrossAxisMachine,
  syntheticCrossAxisModelFromAuthority,
} from "../src/features/evidence/runtime-operation-xstate-builder.ts";
import type { Fact } from "../fixtures/proof-artifacts/runtime-operation-oracle/runtime-operation-oracle-types.generated.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const pathEvidencePath = join(
  repositoryRoot,
  "experiments/runtime-profile-behavior/fixtures/proof-artifacts/runtime-operation-oracle/runtime-operation-xstate-paths.generated.json",
);

test("Foundation XState axes exactly follow JSON authority and generated path evidence", async () => {
  const { crossAxis } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const authorityAxes = Object.keys(crossAxis.axes);
  const foundationCatalog = JSON.parse(await readFile(
    join(repositoryRoot, "architecture/specifications/catalog.json"),
    "utf8",
  )) as { specifications: { stateModel: { axes: string[] } }[] };
  const pathEvidence = JSON.parse(await readFile(pathEvidencePath, "utf8")) as {
    topologyReachability: { axes: string[] };
    shortestPathWitnesses: { source: Record<string, string>; target: Record<string, string> }[];
  };
  assert.deepEqual(foundationCatalog.specifications[0]!.stateModel.axes, authorityAxes);
  assert.deepEqual(pathEvidence.topologyReachability.axes, authorityAxes);
  for (const witness of pathEvidence.shortestPathWitnesses) {
    assert.deepEqual(Object.keys(witness.source), authorityAxes);
    assert.deepEqual(Object.keys(witness.target), authorityAxes);
  }
});

test("repository workflow routes Foundation catalog and XState proof changes through the full scan", async () => {
  const workflow = await readFile(
    join(repositoryRoot, "architecture/foundation/repository-agent-workflow.yaml"),
    "utf8",
  );
  assert.match(workflow, /^  - architecture\/specifications$/m);
  assert.match(
    workflow,
    /^  - experiments\/runtime-profile-behavior\/fixtures\/proof-artifacts\/runtime-operation-oracle$/m,
  );
  assert.match(
    workflow,
    /^  - experiments\/runtime-profile-behavior\/src\/features\/evidence\/runtime-operation-xstate-adapter\.ts$/m,
  );
});

test("XState artifact is a pure parallel synthetic verifier", async () => {
  const { crossAxis } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const runtimeOperationCrossAxisMachine = buildSyntheticCrossAxisMachine(
    syntheticCrossAxisModelFromAuthority(crossAxis),
  );
  assert.equal(runtimeOperationCrossAxisMachine.config.type, "parallel");
  assert.equal(runtimeOperationCrossAxisMachine.id, "adr-0006-requirement-27-synthetic-verifier");
  const forbiddenKeys = new Set(["actions", "actors", "invoke", "after", "delays", "entry", "exit"]);
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden XState runtime key ${key}`);
      visit(child);
    }
  };
  visit(runtimeOperationCrossAxisMachine.config);

  const artifact = JSON.parse(await readFile(pathEvidencePath, "utf8")) as {
    machineKind: string;
    scope: string;
    staticStateProduct: { total: number; valid: number; invalid: number };
    topologyReachability: {
      axes: string[];
      reachableStateCount: number;
      validExtensionCount: number;
    };
    shortestPathWitnesses: unknown[];
  };
  assert.equal(artifact.machineKind, "synthetic-verifier");
  assert.match(artifact.scope, /not production runtime behavior/);
  assert.deepEqual(artifact.staticStateProduct, {
    total: 48_000,
    valid: 1_277,
    invalid: 46_723,
    meaning: "independent handwritten classification of the complete ten-axis Cartesian product; not XState reachability",
  });
  assert.equal(artifact.topologyReachability.axes.length, 7);
  assert.ok(artifact.topologyReachability.reachableStateCount > 0);
  assert.equal(
    artifact.topologyReachability.validExtensionCount,
    artifact.topologyReachability.reachableStateCount,
  );
  assert.equal(artifact.shortestPathWitnesses.length, 20);
});

test("XState witnesses prove every declared composite target", async () => {
  const { crossAxis } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const artifact = JSON.parse(await readFile(pathEvidencePath, "utf8")) as {
    shortestPathWitnesses: {
      fact: string;
      events: { type: string; facts: string[] }[];
      source: Record<string, string>;
      target: Record<string, string>;
    }[];
  };
  for (const transition of crossAxis.transitions) {
    const witness = artifact.shortestPathWitnesses.find(({ fact }) => fact === transition.fact);
    assert.ok(witness, transition.fact);
    assert.deepEqual(witness.events.at(-1), {
      type: transition.fact,
      facts: transition.requiredFacts ?? [],
    });
    assert.equal(witness.events.some(({ type }) => type === "xstate.init"), false);
    for (const target of transition.targets) {
      assert.equal(witness.source[target.axis], target.from, `${transition.fact} source`);
      assert.equal(witness.target[target.axis], target.to, `${transition.fact} target`);
    }
  }
});

test("terminal XState edges require closure evidence and reject forbidden contradictions", async () => {
  const { crossAxis } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const machine = buildSyntheticCrossAxisMachine(syntheticCrossAxisModelFromAuthority(crossAxis));
  const artifact = JSON.parse(await readFile(pathEvidencePath, "utf8")) as {
    shortestPathWitnesses: {
      fact: string;
      events: { type: string; facts: string[] }[];
    }[];
  };
  const terminalTransitions = crossAxis.transitions.filter(({ fact }) =>
    fact.startsWith("transition_terminal_open_final_"),
  );
  const criticalEvidence: readonly Fact[] = [
    "reconciliation_clear",
    "containment_satisfied",
    "all_manifest_entries_satisfied",
  ];
  for (const declaration of terminalTransitions) {
    const witness = artifact.shortestPathWitnesses.find(({ fact }) => fact === declaration.fact);
    assert.ok(witness, declaration.fact);
    let [source] = initialTransition(machine);
    for (const event of witness.events.slice(0, -1)) {
      [source] = transitionMachine(machine, source, event);
    }
    const exactEvent = witness.events.at(-1)!;
    assert.deepEqual(exactEvent.facts, declaration.requiredFacts);
    assert.equal(declaration.forbiddenFacts?.includes("execution_active"), true);
    const [accepted] = transitionMachine(machine, source, exactEvent);
    assert.equal((accepted.value as Record<string, string>).terminal, "final");
    const supplementalEvent: { type: string; facts: string[] } = {
      ...exactEvent,
      facts: [...exactEvent.facts, "containment_capability_evidence_immutable"],
    };
    const [supplemental] = transitionMachine(machine, source, supplementalEvent);
    assert.equal((supplemental.value as Record<string, string>).terminal, "final");
    for (const missingFact of criticalEvidence) {
      assert.equal(exactEvent.facts.includes(missingFact), true, declaration.fact);
      const incompleteEvent: { type: string; facts: string[] } = {
        ...exactEvent,
        facts: exactEvent.facts.filter((fact) => fact !== missingFact),
      };
      const [rejected] = transitionMachine(machine, source, incompleteEvent);
      assert.deepEqual(rejected.value, source.value, `${declaration.fact} without ${missingFact}`);
    }
    const contradictoryEvent: { type: string; facts: string[] } = {
      ...exactEvent,
      facts: [...exactEvent.facts, "execution_active"],
    };
    const [contradictory] = transitionMachine(machine, source, contradictoryEvent);
    assert.deepEqual(
      contradictory.value,
      source.value,
      `${declaration.fact} with contradictory execution_active`,
    );
  }
});
