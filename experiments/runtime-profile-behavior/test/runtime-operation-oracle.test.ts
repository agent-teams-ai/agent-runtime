import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { initialTransition, transition as transitionMachine } from "xstate";

import { loadRuntimeOperationOracleAuthority, parseAuthorityJson } from "../src/features/evidence/runtime-operation-oracle-authority.ts";
import { createOracleEvaluator } from "../src/features/evidence/runtime-operation-oracle-evaluator.ts";
import {
  checkRuntimeOperationOracleGeneratedFiles,
  renderRuntimeOperationOracleGeneratedFiles,
} from "../src/features/evidence/generate-runtime-operation-oracle.ts";
import { validateRuntimeOperationOracle } from "../src/features/evidence/validate-runtime-operation-oracle.ts";
import {
  buildSyntheticCrossAxisMachine,
  syntheticCrossAxisModelFromAuthority,
} from "../src/features/evidence/runtime-operation-xstate-builder.ts";
import type { Fact } from "../spec/runtime-operation-oracle/generated/runtime-operation-oracle-types.generated.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const specificationRelative = "experiments/runtime-profile-behavior/spec/runtime-operation-oracle";
const specificationRoot = join(repositoryRoot, specificationRelative);

const withSpecificationCopy = async (
  mutate: (temporarySpecificationRoot: string) => Promise<void>,
  verify: (temporaryRepositoryRoot: string) => Promise<void>,
): Promise<void> => {
  const temporaryRepositoryRoot = await mkdtemp(join(tmpdir(), "agent-runtime-oracle-test-"));
  const temporarySpecificationRoot = join(temporaryRepositoryRoot, specificationRelative);
  try {
    await mkdir(join(temporarySpecificationRoot, ".."), { recursive: true });
    await cp(specificationRoot, temporarySpecificationRoot, { recursive: true });
    await mutate(temporarySpecificationRoot);
    await verify(temporaryRepositoryRoot);
  } finally {
    await rm(temporaryRepositoryRoot, { recursive: true, force: true });
  }
};

test("fragment authority preserves cutover parity and ten-axis validity counts", async () => {
  assert.deepEqual(await validateRuntimeOperationOracle(repositoryRoot), {
    caseCount: 28,
    exampleCount: 242,
    acceptedCount: 107,
    rejectedCount: 135,
    stateProduct: { total: 48_000, valid: 1_277, invalid: 46_723 },
  });
});

test("every authority example agrees with the independent handwritten evaluator", async () => {
  const authority = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const { oracle } = authority;
  const evaluateOracleExample = createOracleEvaluator(authority);
  for (const example of oracle.cases.flatMap(({ examples }) => examples)) {
    assert.deepEqual(evaluateOracleExample(example), example.expected, example.id);
  }
});

test("manifest is the sole ordered case membership authority", async () => {
  const { manifest, oracle } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  assert.equal(manifest.cases.length, 28);
  assert.deepEqual(
    manifest.cases.map(({ requirement }) => requirement),
    Array.from({ length: 28 }, (_, index) => index + 1),
  );
  assert.deepEqual(
    oracle.cases.map(({ requirement }) => requirement),
    manifest.cases.map(({ requirement }) => requirement),
  );
});

test("Foundation catalog closes over the manifest and every referenced case part", async () => {
  const { manifest } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const shardedCase = JSON.parse(await readFile(
    join(specificationRoot, "cases/28-binary-revision-semantic-retention.json"),
    "utf8",
  )) as { exampleFragments: string[] };
  const foundationCatalog = JSON.parse(await readFile(
    join(repositoryRoot, "architecture/specifications/catalog.json"),
    "utf8",
  )) as { specifications: { documents: { path: string }[] }[] };
  const declared = foundationCatalog.specifications[0]!.documents
    .map(({ path }) => path.replace(`${specificationRelative}/`, ""))
    .toSorted();
  const expected = [
    "manifest.json",
    manifest.catalog,
    manifest.crossAxis,
    ...manifest.cases.map(({ path }) => path),
    ...shardedCase.exampleFragments,
  ].toSorted();
  assert.deepEqual(declared, expected);
});

test("Foundation XState axes exactly follow JSON authority and generated path evidence", async () => {
  const { crossAxis } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const authorityAxes = Object.keys(crossAxis.axes);
  const foundationCatalog = JSON.parse(await readFile(
    join(repositoryRoot, "architecture/specifications/catalog.json"),
    "utf8",
  )) as { specifications: { stateModel: { axes: string[] } }[] };
  const pathEvidence = JSON.parse(await readFile(
    join(specificationRoot, "generated/runtime-operation-xstate-paths.generated.json"),
    "utf8",
  )) as {
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

test("repository workflow routes Foundation catalog and XState adapter changes through the full scan", async () => {
  const workflow = await readFile(
    join(repositoryRoot, "architecture/foundation/repository-agent-workflow.yaml"),
    "utf8",
  );
  assert.match(workflow, /^  - architecture\/specifications$/m);
  assert.match(
    workflow,
    /^  - experiments\/runtime-profile-behavior\/src\/features\/evidence\/runtime-operation-xstate-adapter\.ts$/m,
  );
});

test("jsonc-parser defense rejects nested duplicate keys before Ajv", () => {
  assert.throws(
    () => parseAuthorityJson('{"outer":{"fact":"first","fact":"second"}}', "duplicate.json"),
    /duplicate property "fact"/,
  );
  assert.throws(
    () => parseAuthorityJson('{"outer":true,}', "trailing.json"),
    /not strict JSON/,
  );
  assert.throws(
    () => parseAuthorityJson('{/* comment */"outer":true}', "comment.json"),
    /not strict JSON/,
  );
});

test("strict Draft 2020-12 validation rejects an open case field", async () => {
  await withSpecificationCopy(async (root) => {
    const path = join(root, "cases/01-output-terminal-order.json");
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    value.policyBag = { allow: true };
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }, async (temporaryRepositoryRoot) => {
    await assert.rejects(
      loadRuntimeOperationOracleAuthority(temporaryRepositoryRoot),
      /violates Draft 2020-12 schema/,
    );
  });
});

test("schema stays structural while catalog owns vocabulary", async () => {
  const schema = JSON.parse(await readFile(join(specificationRoot, "schema.json"), "utf8")) as {
    $defs: Record<string, {
      type?: string;
      enum?: unknown;
      properties?: Record<string, { enum?: unknown; propertyNames?: { enum?: unknown } }>;
    }>;
  };
  for (const definition of ["check", "fact", "resultCode"]) {
    assert.equal(schema.$defs[definition]?.type, "string");
    assert.equal(schema.$defs[definition]?.enum, undefined);
  }
  assert.equal(schema.$defs.crossAxisTarget?.properties?.axis?.enum, undefined);
  assert.equal(
    schema.$defs.crossAxisTransition?.properties?.requiredState?.propertyNames?.enum,
    undefined,
  );
});

test("generated vocabulary unions exactly project the loaded catalog", async () => {
  const { catalog } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const source = await readFile(
    join(specificationRoot, "generated/runtime-operation-oracle-types.generated.ts"),
    "utf8",
  );
  const members = (name: string): string[] => {
    const body = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(source)?.[1];
    assert.ok(body, name);
    return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  };
  assert.deepEqual(members("Check"), catalog.checks);
  assert.deepEqual(members("Fact"), catalog.facts);
  assert.deepEqual(members("ResultCode"), catalog.resultCodes);
});

test("temporary catalog vocabulary changes generated projection and freshness", async () => {
  const baseline = await renderRuntimeOperationOracleGeneratedFiles(repositoryRoot);
  await withSpecificationCopy(async (root) => {
    const path = join(root, "catalog.json");
    const value = JSON.parse(await readFile(path, "utf8")) as { resultCodes: string[] };
    value.resultCodes.push("temporary_projection_code");
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }, async (temporaryRepositoryRoot) => {
    const changed = await renderRuntimeOperationOracleGeneratedFiles(temporaryRepositoryRoot);
    const generatedName = "runtime-operation-oracle-types.generated.ts";
    assert.notEqual(changed.get(generatedName), baseline.get(generatedName));
    assert.match(changed.get(generatedName) ?? "", /"temporary_projection_code"/);
    await assert.rejects(
      checkRuntimeOperationOracleGeneratedFiles(temporaryRepositoryRoot),
      /runtime-operation-oracle-types.generated.ts/,
    );
  });
});

test("semantic linker rejects vocabulary drift that structural schema permits", async () => {
  await withSpecificationCopy(async (root) => {
    const path = join(root, "cases/01-output-terminal-order.json");
    const value = JSON.parse(await readFile(path, "utf8")) as {
      examples: { facts: string[] }[];
    };
    value.examples[0]!.facts[0] = "catalog_drift_fact";
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }, async (temporaryRepositoryRoot) => {
    await assert.rejects(
      loadRuntimeOperationOracleAuthority(temporaryRepositoryRoot),
      /contains a fact outside output_terminal_order/,
    );
  });
});

test("temporary-root validation derives evaluator roles from temporary catalog", async () => {
  await withSpecificationCopy(async (root) => {
    const path = join(root, "catalog.json");
    const value = JSON.parse(await readFile(path, "utf8")) as {
      binaryRetentionFactRoles: Record<string, string>;
    };
    for (const fact of Object.keys(value.binaryRetentionFactRoles)) {
      if (value.binaryRetentionFactRoles[fact] === "command_intent") {
        value.binaryRetentionFactRoles[fact] = "evidence";
      }
    }
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }, async (temporaryRepositoryRoot) => {
    await assert.rejects(
      validateRuntimeOperationOracle(temporaryRepositoryRoot),
      /expected .*mixed_command_intent_forbidden/,
    );
  });
});

test("authority linker rejects orphan fragments", async () => {
  await withSpecificationCopy(async (root) => {
    await writeFile(join(root, "cases/29-orphan.json"), "{}\n");
  }, async (temporaryRepositoryRoot) => {
    await assert.rejects(
      loadRuntimeOperationOracleAuthority(temporaryRepositoryRoot),
      /manifest case-file membership/,
    );
  });
});

test("authority linker rejects an orphan root JSON file", async () => {
  await withSpecificationCopy(async (root) => {
    await writeFile(join(root, "unused.json"), "{}\n");
  }, async (temporaryRepositoryRoot) => {
    await assert.rejects(
      loadRuntimeOperationOracleAuthority(temporaryRepositoryRoot),
      /root authority-file membership/,
    );
  });
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

  const artifact = JSON.parse(await readFile(
    join(specificationRoot, "generated/runtime-operation-xstate-paths.generated.json"),
    "utf8",
  )) as {
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
  const artifact = JSON.parse(await readFile(
    join(specificationRoot, "generated/runtime-operation-xstate-paths.generated.json"),
    "utf8",
  )) as {
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

test("terminal XState edges require exact closure evidence payloads", async () => {
  const { crossAxis } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const machine = buildSyntheticCrossAxisMachine(syntheticCrossAxisModelFromAuthority(crossAxis));
  const artifact = JSON.parse(await readFile(
    join(specificationRoot, "generated/runtime-operation-xstate-paths.generated.json"),
    "utf8",
  )) as {
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
    const [accepted] = transitionMachine(machine, source, exactEvent);
    assert.equal((accepted.value as Record<string, string>).terminal, "final");
    for (const missingFact of criticalEvidence) {
      assert.equal(exactEvent.facts.includes(missingFact), true, declaration.fact);
      const incompleteEvent: { type: string; facts: string[] } = {
        ...exactEvent,
        facts: exactEvent.facts.filter((fact) => fact !== missingFact),
      };
      const [rejected] = transitionMachine(machine, source, incompleteEvent);
      assert.deepEqual(rejected.value, source.value, `${declaration.fact} without ${missingFact}`);
    }
  }
});
