import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadRuntimeOperationOracleAuthority, parseAuthorityJson } from "../src/features/evidence/runtime-operation-oracle-authority.ts";
import { evaluateOracleExample } from "../src/features/evidence/runtime-operation-oracle-evaluator.ts";
import { validateRuntimeOperationOracle } from "../src/features/evidence/validate-runtime-operation-oracle.ts";
import {
  buildSyntheticCrossAxisMachine,
  syntheticCrossAxisModelFromAuthority,
} from "../src/features/evidence/runtime-operation-xstate-builder.ts";

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
  const { oracle } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
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
      events: string[];
      source: Record<string, string>;
      target: Record<string, string>;
    }[];
  };
  for (const transition of crossAxis.transitions) {
    const witness = artifact.shortestPathWitnesses.find(({ fact }) => fact === transition.fact);
    assert.ok(witness, transition.fact);
    assert.equal(witness.events.at(-1), transition.fact);
    assert.equal(witness.events.includes("xstate.init"), false);
    for (const target of transition.targets) {
      assert.equal(witness.source[target.axis], target.from, `${transition.fact} source`);
      assert.equal(witness.target[target.axis], target.to, `${transition.fact} target`);
    }
  }
});
