import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compile } from "json-schema-to-typescript";

import type { Catalog } from "../../../fixtures/proof-artifacts/runtime-operation-oracle/runtime-operation-oracle-types.generated.ts";

import { loadRuntimeOperationOracleAuthority } from "./runtime-operation-oracle-authority.ts";
import {
  createStateProductEvaluator,
} from "./runtime-operation-state-product.ts";
import {
  buildSyntheticCrossAxisMachine,
  deriveShortestPathWitnesses,
  syntheticCrossAxisModelFromAuthority,
} from "./runtime-operation-xstate-builder.ts";
import type { SyntheticCrossAxisModel } from "./runtime-operation-xstate-adapter.ts";

const GENERATED_DIRECTORY =
  "experiments/runtime-profile-behavior/fixtures/proof-artifacts/runtime-operation-oracle";
const BANNER = "// Generated from ADR-0006 JSON authority. Do not edit.\n\n";

const generatedUnionMembers = (source: string, name: string): string[] => {
  const body = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(source)?.[1];
  if (body === undefined) {
    throw new Error(`runtime-operation oracle generation: missing ${name} union`);
  }
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
};

const renderTypes = async (
  schema: Record<string, unknown>,
  catalog: Catalog,
): Promise<string> => {
  const projectionSchema = structuredClone(schema);
  const definitions = projectionSchema.$defs as Record<string, Record<string, unknown>>;
  definitions.check = { ...definitions.check, enum: [...catalog.checks] };
  definitions.fact = { ...definitions.fact, enum: [...catalog.facts] };
  definitions.resultCode = { ...definitions.resultCode, enum: [...catalog.resultCodes] };
  const generated = await compile(projectionSchema, "RuntimeOperationOracle", {
    bannerComment: BANNER.trimEnd(),
    format: true,
    unreachableDefinitions: true,
  });
  const source = generated.endsWith("\n") ? generated : `${generated}\n`;
  for (const [name, expected] of [
    ["Check", catalog.checks],
    ["Fact", catalog.facts],
    ["ResultCode", catalog.resultCodes],
  ] as const) {
    const actual = generatedUnionMembers(source, name);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`runtime-operation oracle generation: ${name} differs from catalog order`);
    }
  }
  return source;
};

const renderMermaid = (model: SyntheticCrossAxisModel): string => {
  const lines = [
    "%% Generated from ADR-0006 JSON authority. Do not edit.",
    "flowchart LR",
    "  scope[\"Synthetic verifier: ADR-0006 requirement 27 only\"]",
    "  warning[\"Topology reachability is not 10-axis semantic validity or production runtime behavior\"]",
    "  scope -.-> warning",
  ];
  for (const [axis, values] of Object.entries(model.axes)) {
    lines.push(`  subgraph ${axis}["${axis}"]`);
    for (const value of values) {
      lines.push(`    ${axis}_${value}["${value}"]`);
    }
    lines.push("  end");
  }
  for (const transition of model.transitions) {
    for (const { axis, from, to } of transition.targets) {
      lines.push(`  ${axis}_${from} -->|"${transition.fact}"| ${axis}_${to}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

export const renderRuntimeOperationOracleGeneratedFiles = async (
  repositoryRoot: string,
): Promise<Map<string, string>> => {
  const authority = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const model = syntheticCrossAxisModelFromAuthority(authority.crossAxis);
  const machine = buildSyntheticCrossAxisMachine(model);
  const topology = deriveShortestPathWitnesses(
    machine,
    model.transitions,
  );
  const stateProduct = createStateProductEvaluator(authority);
  const validity = stateProduct.evaluate();
  const invalidReachableStates = topology.reachableStates.filter(
    (state) => !stateProduct.projectedStateHasValidExtension(state),
  );
  if (invalidReachableStates.length > 0) {
    throw new Error(
      `synthetic cross-axis machine: ${invalidReachableStates.length} reachable snapshots have no valid ten-axis extension: ${JSON.stringify(invalidReachableStates.slice(0, 3))}`,
    );
  }
  const pathArtifact = {
    schemaVersion: 1,
    adr: "ADR-0006",
    requirement: 27,
    machineKind: "synthetic-verifier",
    scope: "seven-axis transition topology only; not production runtime behavior",
    staticStateProduct: {
      ...validity,
      meaning: "independent handwritten classification of the complete ten-axis Cartesian product; not XState reachability",
    },
    topologyReachability: {
      axes: Object.keys(model.axes),
      reachableStateCount: topology.reachableStateCount,
      validExtensionCount: topology.reachableStateCount,
      meaning: "reachable snapshots in the requirement-27 synthetic XState topology; each has at least one valid ten-axis extension",
    },
    shortestPathWitnesses: topology.witnesses,
  };
  return new Map([
    ["runtime-operation-oracle-types.generated.ts", await renderTypes(authority.schema, authority.catalog)],
    ["runtime-operation-xstate-paths.generated.json", `${JSON.stringify(pathArtifact, null, 2)}\n`],
    ["runtime-operation-xstate.generated.mmd", renderMermaid(model)],
  ]);
};

export const checkRuntimeOperationOracleGeneratedFiles = async (
  repositoryRoot: string,
): Promise<void> => {
  const files = await renderRuntimeOperationOracleGeneratedFiles(repositoryRoot);
  await checkGeneratedFiles(repositoryRoot, files);
};

const writeGeneratedFiles = async (
  directory: string,
  files: ReadonlyMap<string, string>,
): Promise<void> => {
  await mkdir(directory, { recursive: true });
  const obsoleteNames = (await readdir(directory)).filter((name) => !files.has(name));
  await Promise.all(obsoleteNames.map((name) => rm(join(directory, name))));
  await Promise.all([...files].map(([name, contents]) => writeFile(join(directory, name), contents)));
};

const checkGeneratedFiles = async (
  repositoryRoot: string,
  files: ReadonlyMap<string, string>,
): Promise<void> => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-runtime-oracle-generation-"));
  try {
    await writeGeneratedFiles(temporaryDirectory, files);
    const stale: string[] = [];
    const actualNames = await readdir(join(repositoryRoot, GENERATED_DIRECTORY)).catch(() => []);
    if (JSON.stringify(actualNames.toSorted()) !== JSON.stringify([...files.keys()].toSorted())) {
      stale.push("<generated-directory-membership>");
    }
    for (const name of files.keys()) {
      const expected = await readFile(join(temporaryDirectory, name), "utf8");
      const actual = await readFile(join(repositoryRoot, GENERATED_DIRECTORY, name), "utf8")
        .catch(() => null);
      if (actual !== expected) {
        stale.push(name);
      }
    }
    if (stale.length > 0) {
      throw new Error(`runtime-operation oracle generated files are stale: ${stale.join(", ")}`);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

if (process.argv[1]?.endsWith("generate-runtime-operation-oracle.ts")) {
  const mode = process.argv[2];
  if (mode !== "--write" && mode !== "--check") {
    throw new Error("usage: generate-runtime-operation-oracle.ts --write|--check");
  }
  const repositoryRoot = process.cwd();
  const files = await renderRuntimeOperationOracleGeneratedFiles(repositoryRoot);
  if (mode === "--write") {
    await writeGeneratedFiles(join(repositoryRoot, GENERATED_DIRECTORY), files);
    console.log(JSON.stringify({ mode: "write", generated: files.size }));
  } else {
    await checkGeneratedFiles(repositoryRoot, files);
    console.log(JSON.stringify({ mode: "check", generated: files.size, fresh: true }));
  }
}
