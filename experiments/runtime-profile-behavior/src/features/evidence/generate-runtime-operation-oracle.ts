import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compile } from "json-schema-to-typescript";

import { loadRuntimeOperationOracleAuthority } from "./runtime-operation-oracle-authority.ts";
import {
  createStateProductEvaluator,
} from "./runtime-operation-state-product.ts";
import {
  buildSyntheticCrossAxisMachine,
  deriveShortestPathWitnesses,
  syntheticCrossAxisModelFromAuthority,
  type SyntheticCrossAxisModel,
} from "./runtime-operation-xstate-builder.ts";

const GENERATED_DIRECTORY =
  "experiments/runtime-profile-behavior/spec/runtime-operation-oracle/generated";
const BANNER = "// Generated from ADR-0006 JSON authority. Do not edit.\n\n";

const renderTypes = async (schema: Record<string, unknown>): Promise<string> => {
  const generated = await compile(schema, "RuntimeOperationOracle", {
    bannerComment: BANNER.trimEnd(),
    format: true,
    unreachableDefinitions: true,
  });
  return generated.endsWith("\n") ? generated : `${generated}\n`;
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

const renderGeneratedFiles = async (repositoryRoot: string): Promise<Map<string, string>> => {
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
    ["runtime-operation-oracle-types.generated.ts", await renderTypes(authority.schema)],
    ["runtime-operation-xstate-paths.generated.json", `${JSON.stringify(pathArtifact, null, 2)}\n`],
    ["runtime-operation-xstate.generated.mmd", renderMermaid(model)],
  ]);
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

const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") {
  throw new Error("usage: generate-runtime-operation-oracle.ts --write|--check");
}

const repositoryRoot = process.cwd();
const files = await renderGeneratedFiles(repositoryRoot);
if (mode === "--write") {
  await writeGeneratedFiles(join(repositoryRoot, GENERATED_DIRECTORY), files);
  console.log(JSON.stringify({ mode: "write", generated: files.size }));
} else {
  await checkGeneratedFiles(repositoryRoot, files);
  console.log(JSON.stringify({ mode: "check", generated: files.size, fresh: true }));
}
