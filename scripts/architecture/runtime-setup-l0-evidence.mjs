import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSync, Visitor } from "oxc-parser";

import {historicalSpecRevision, loadHistoricalSpec} from "./runtime-setup-l0-evidence-historical.mjs";
import * as currentSpec from "./runtime-setup-l0-evidence-spec.mjs";
import {
  changes,
  evidenceFiles,
  evidenceRoots,
  traces,
} from "./runtime-setup-l0-evidence-spec.mjs";
import {
  GitCommandFailure,
  isHistoricalObjectClosureUnavailable,
  validateCurrentEvidenceIdentity,
  validateStoredReportShape,
} from "./runtime-setup-l0-evidence-validation.mjs";

import { createEvidenceInputs } from "./runtime-setup-l0-evidence-inputs.mjs";

import {
  adoptionPaths, adoptionConstruction, adoptionEvidenceFiles, assertAdoptionAuthority, retainedHistoricalEvidenceRoots,
  validateAdoptionReport,
} from "./runtime-setup-l0-evidence-adoption.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidencePath = join(
  repositoryRoot,
  "docs/spikes/runtime-setup-l0-dogfooding-evidence.json",
);
const benchmarkEnvelopePath = join(
  repositoryRoot,
  "docs/spikes/runtime-setup-l0-benchmark-envelopes.json",
);

const git = (...args) => {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new GitCommandFailure(error);
  }
};

const readRevisionFile = (revision, path) => execFileSync("git", ["show", `${revision}:${path}`], {
  cwd: repositoryRoot, env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
  stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024,
});
const pathExists = async path => {
  try { await lstat(join(repositoryRoot, path)); return true; }
  catch (error) { if (error.code === "ENOENT") { return false; } throw error; }
};

const sum = (items, field) => items.reduce((total, item) => total + item[field], 0);

const behaviorTestTitles = revision => {
  const root = "packages/apps/embedded-runtime/tests";
  const files = git("ls-tree", "-r", "--name-only", revision, "--", root)
    .trim().split("\n").filter(path => path.endsWith(".test.ts"));
  const titles = files.flatMap(path => {
    const source = git("show", `${revision}:${path}`);
    return [...source.matchAll(/\btest\(\s*["'`]([^"'`]+)["'`]/gu)]
      .map(match => match[1] ?? "");
  });
  return new Set(titles);
};

const summarizeChange = ({ id, revision }) => {
  const parentRevision = git("rev-parse", `${revision}^`).trim();
  const rows = git(
    "diff-tree",
    "--root",
    "--no-commit-id",
    "--numstat",
    "-r",
    revision,
  ).trim().split("\n").filter(Boolean).map(line => {
    const [rawAdditions, rawDeletions, ...pathParts] = line.split("\t");
    return {
      additions: rawAdditions === "-" ? 0 : Number(rawAdditions),
      binary: rawAdditions === "-",
      deletions: rawDeletions === "-" ? 0 : Number(rawDeletions),
      path: pathParts.join("\t"),
    };
  });
  const composition = rows.filter(({ path }) =>
    path.includes("/composition/") || path.endsWith("/composition.ts"));
  const production = rows.filter(({ path }) =>
    path.startsWith("packages/") && path.includes("/src/"));
  const tests = rows.filter(({ path }) =>
    path.startsWith("packages/") && path.includes("/tests/"));
  const beforeTitles = behaviorTestTitles(parentRevision);
  const afterTitles = behaviorTestTitles(revision);
  const retainedTitles = [...beforeTitles].filter(title => afterTitles.has(title));
  return {
    id,
    revision,
    files: rows.length,
    additions: sum(rows, "additions"),
    deletions: sum(rows, "deletions"),
    binaryFiles: rows.filter(({ binary }) => binary).length,
    composition: {
      files: composition.length,
      additions: sum(composition, "additions"),
      deletions: sum(composition, "deletions"),
    },
    production: {
      files: production.length,
      additions: sum(production, "additions"),
      deletions: sum(production, "deletions"),
    },
    tests: {
      files: tests.length,
      additions: sum(tests, "additions"),
      deletions: sum(tests, "deletions"),
    },
    behaviorFixtures: {
      before: beforeTitles.size,
      after: afterTitles.size,
      retained: retainedTitles.length,
      reusePercent: beforeTitles.size === 0
        ? null
        : Math.round((retainedTitles.length / beforeTitles.size) * 10_000) / 100,
    },
  };
};

const loadHistoricalChanges = (summarize = summarizeChange, inventory = changes) => {
  try {
    return inventory.map(summarize);
  } catch (error) {
    if (!isHistoricalObjectClosureUnavailable(error)) {
      throw error;
    }
  }
};

const walkFiles = async directory => {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
};

const collectEvidenceFiles = async roots => {
  const files = await Promise.all(roots.map(root => walkFiles(join(repositoryRoot, root))));
  return files.flat().toSorted();
};

const {
  artifactDigests,
  assertEvidenceRootsClean,
  assertEvidenceRootsMatchRevision,
} = createEvidenceInputs({ repositoryRoot, git, readRevisionFile });

const importSpecifiers = (source, path) => {
  const parsed = parseSync(path, source);
  assert.deepEqual(parsed.errors, [], `Oxc could not parse ${path}`);

  const specifiers = [
    ...parsed.module.staticImports.map(entry => entry.moduleRequest.value),
    ...parsed.module.staticExports.flatMap(entry => entry.entries)
      .flatMap(entry => entry.moduleRequest === null ? [] : [entry.moduleRequest.value]),
  ];
  const unresolvedImports = [];
  new Visitor({
    CallExpression(node) {
      const argument = node.arguments[0];
      if (node.callee.type === "Identifier" && node.callee.name === "require") {
        if (node.arguments.length === 1 && argument?.type === "Literal" &&
          typeof argument.value === "string") {
          specifiers.push(argument.value);
        } else {
          unresolvedImports.push("require");
        }
      }
    },
    ImportExpression(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        specifiers.push(node.source.value);
      } else {
        unresolvedImports.push("import");
      }
    },
    TSImportEqualsDeclaration(node) {
      const expression = node.moduleReference.type === "TSExternalModuleReference"
        ? node.moduleReference.expression
        : undefined;
      if (expression?.type === "Literal" && typeof expression.value === "string") {
        specifiers.push(expression.value);
      }
    },
    TSImportType(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        specifiers.push(node.source.value);
      } else {
        unresolvedImports.push("import-type");
      }
    },
  }).visit(parsed.program);
  assert.deepEqual(
    unresolvedImports,
    [],
    `${path} contains a non-literal dynamic dependency`,
  );
  return specifiers.toSorted();
};

assert.deepEqual(
  importSpecifiers(
    "import a from 'a'; export * from 'b'; import c = require('c'); " +
      "const d = require('d'); void import('e'); type F = import('f').F;",
    "evidence-import-parser-self-test.ts",
  ),
  ["a", "b", "c", "d", "e", "f"],
  "evidence import parser must cover every supported dependency form",
);

const forbiddenInwardDependency = /@get-modular\/(?:core|assembly)|@agent-teams\/(?:engineering|extension)-foundation|cordis|awilix|(?:^|\/)(?:adapters|composition)(?:\/|$)|(?:^|[-/])(?:container|module-(?:graph|runtime)|registry)(?:[-/]|$)/iu;

assert.equal(
  importSpecifiers(
    "type Forbidden = import('@agent-teams/extension-foundation').Runtime;",
    "evidence-import-type-boundary-self-test.ts",
  ).some(specifier => forbiddenInwardDependency.test(specifier)),
  true,
  "TypeScript import types must participate in the inward dependency gate",
);

for (const packageRoot of ["@get-modular/core", "@get-modular/assembly"]) {
  assert.ok(importSpecifiers(`type Boundary = import('${packageRoot}').Boundary;`, "adoption-boundary-self-test.ts")
    .some(specifier => forbiddenInwardDependency.test(specifier)), "Core/Assembly import types must remain outward");
}

const verifyCurrentArchitecture = async (construction = traces.construction) => {
  const traceEntries = [
    ...construction,
    ...traces.invocations.claudeCode,
    ...traces.invocations.codex,
  ];
  for (const entry of traceEntries) {
    const source = await readFile(join(repositoryRoot, entry.path), "utf8");
    for (const symbol of entry.symbols) {
      assert.match(source, new RegExp(`\\b${symbol}\\b`, "u"), `${entry.path} lacks ${symbol}`);
    }
  }

  const sourceFiles = await collectEvidenceFiles(evidenceRoots.sources);
  const inwardFiles = sourceFiles.filter(path =>
    path.endsWith(".ts") &&
    (path.includes("/application/") || path.includes("/contracts/") || path.includes("/domain/")));
  for (const path of inwardFiles) {
    const source = await readFile(path, "utf8");
    assert.equal(
      importSpecifiers(source, path).some(specifier => forbiddenInwardDependency.test(specifier)),
      false,
      `module runtime or outward layer leaked into ${relative(repositoryRoot, path)}`,
    );
  }
};

const captureProductCheck = () => {
  const args = ["--filter", "@agent-teams/embedded-runtime", "check"];
  const output = execFileSync("pnpm", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const summaries = (
    [...output.matchAll(/^(?:#|ℹ)\s+(tests|pass|fail|cancelled|skipped)\s+(\d+)$/gmu)]
      .map(([, key, value]) => [key, Number(value)])
  );
  const testSummary = {};
  for (const [key, value] of summaries) testSummary[key] = (testSummary[key] ?? 0) + value;
  assert.ok(testSummary.tests > 0, "captured embedded-runtime check must execute tests");
  assert.equal(testSummary.pass, testSummary.tests, "captured tests must all pass");
  assert.equal(testSummary.fail, 0, "captured embedded-runtime check must not fail tests");
  assert.equal(testSummary.cancelled, 0, "captured embedded-runtime check must not cancel tests");
  assert.equal(testSummary.skipped, 0, "captured embedded-runtime check must not skip tests");
  return {
    command: "pnpm --filter @agent-teams/embedded-runtime check",
    exitCode: 0,
    outputSha256: createHash("sha256").update(output).digest("hex"),
    architecture: process.arch,
    nodeVersion: process.version,
    platform: process.platform,
    testSummary,
  };
};

const canonicalJsonBytes = value => `${JSON.stringify(value, null, 2)}\n`;

const loadProspectiveBenchmarks = async (spec = currentSpec, revision) => {
  const {benchmarkSourceRevision, prospectiveBenchmarks} = spec;
  const document = JSON.parse(revision ? readRevisionFile(revision, relative(repositoryRoot, benchmarkEnvelopePath)) : await readFile(benchmarkEnvelopePath, "utf8"));
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.evidenceKind, "redacted-hosted-worker-result-envelopes");
  assert.equal(document.sourceRevision, benchmarkSourceRevision);
  assert.equal(document.envelopes.length, prospectiveBenchmarks.length);

  const envelopes = new Map(document.envelopes.map(envelope => [envelope.jobId, envelope]));
  assert.equal(envelopes.size, document.envelopes.length, "benchmark job IDs must be unique");

  return prospectiveBenchmarks.map(benchmark => {
    assert.equal(benchmark.sourceRevision, document.sourceRevision);
    assert.equal(benchmark.promptEncoding, "utf8-lf-terminated");
    assert.equal(
      createHash("sha256").update(`${benchmark.prompt}\n`).digest("hex"),
      benchmark.promptSha256,
      `${benchmark.id} prompt hash drifted`,
    );

    const envelope = envelopes.get(benchmark.jobId);
    assert.ok(envelope, `${benchmark.id} retained result envelope is missing`);
    assert.equal(
      createHash("sha256").update(canonicalJsonBytes(envelope)).digest("hex"),
      benchmark.retainedEnvelopeSha256,
      `${benchmark.id} retained result envelope hash drifted`,
    );
    assert.equal(envelope.status, "done");
    assert.deepEqual(envelope.changedFiles, []);
    assert.equal(envelope.verdict, "hold");
    assert.equal(envelope.promotionEvidence, false);
    assert.ok(typeof envelope.reason === "string" && envelope.reason.length > 0);
    assert.ok(typeof envelope.measurements === "object" && envelope.measurements !== null);
    assert.ok(typeof envelope.oracle === "object" && envelope.oracle !== null);

    return Object.freeze({ ...benchmark, ...envelope });
  });
};

const buildReport = async ({ capture, historicalChanges, sourceRevision, digests, spec = currentSpec, specRevision }) => ({
  schemaVersion: 3,
  evidenceKind: "runtime-setup-l0-direct-composition",
  sourceRevision,
  authority: "ADR-0008",
  productOutcome: "detached-safe-runtime-setup-preview",
  taxonomyAuthority: "experiment-local-non-qualification-rubric",
  ownership: spec.ownership,
  verdicts: {
    L0: "demonstrated-product-pure-di",
    L1: "no-go-measurement-candidate",
    L2: "no-go",
    L3: "no-go",
    L4: "no-go",
    L5: "no-go",
  },
  guidanceThresholds: {
    compositionFilesPerOrdinaryChange: 3,
    compositionGlueLinesPerOrdinaryChange: 60,
    behaviorFixtureReusePercent: 80,
  },
  promotionRule: "hold-unless-two-of-three-prospective-changes-show-the-same-neutral-composition-problem",
  capture,
  artifactDigests: digests ?? await artifactDigests(),
  historicalChanges,
  prospectiveBenchmarks: await loadProspectiveBenchmarks(spec, specRevision),
  traces: spec.traces,
  limitations: [
    "historical-change-size-is-not-an-authoring-benchmark",
    "historical-data-does-not-prove-incorrect-edit-count",
    "codex-and-claude-code-are-sibling-capabilities-not-one-provider-slot",
    "no-runtime-provider-selection-without-rebuild-is-proved",
    "host-disposal-does-not-prove-generic-module-lifecycle",
    "prospective-benchmarks-are-exploratory-historical-evidence-and-do-not-satisfy-the-promotion-rule",
    "no-shared-foundation-runtime-is-authorized",
  ],
});

const historicalSpec = () => loadHistoricalSpec(readRevisionFile);

const validateStoredReport = async (report, historical = false) => {
  const spec = historical ? await historicalSpec() : currentSpec;
  const {changes, ownership, traces, sourceRevisionArtifactDigests, benchmarkSourceRevision} = spec;
  const specRevision = historical ? historicalSpecRevision : undefined;
  const digests = historical ? await createEvidenceInputs({
    repositoryRoot, git, readRevisionFile, roots: retainedHistoricalEvidenceRoots,
    files: { fixtures: [], sources: [], tests: [] },
  }).artifactDigestsAtRevision(report.sourceRevision) : await artifactDigests();
  validateStoredReportShape(report, changes);
  assert.equal(report.schemaVersion, 3);
  validateCurrentEvidenceIdentity(report, {
    changes,
    currentArtifactDigests: digests,
    sourceRevisionArtifactDigests,
  });
  assert.deepEqual(report.ownership, ownership);
  assert.deepEqual(report.traces, traces);
  assert.equal(report.taxonomyAuthority, "experiment-local-non-qualification-rubric");
  assert.equal(report.verdicts.L0, "demonstrated-product-pure-di");
  assert.deepEqual(report.verdicts, {
    L0: "demonstrated-product-pure-di",
    L1: "no-go-measurement-candidate",
    L2: "no-go",
    L3: "no-go",
    L4: "no-go",
    L5: "no-go",
  });
  assert.ok(report.historicalChanges.length >= 3);
  assert.equal(report.historicalChanges.length, changes.length);
  assert.deepEqual(
    report.historicalChanges.map(({ id, revision }) => ({ id, revision })),
    changes,
  );
  assert.deepEqual(
    report.prospectiveBenchmarks,
    await loadProspectiveBenchmarks(spec, specRevision),
    "retained prospective benchmark evidence drifted",
  );
  for (const benchmark of report.prospectiveBenchmarks) {
    assert.equal(benchmark.sourceRevision, benchmarkSourceRevision);
    assert.equal(benchmark.execution.editMode, "read-only");
    assert.equal(benchmark.verdict, "hold");
    assert.equal(benchmark.promotionEvidence, false);
    assert.equal(benchmark.promptEncoding, "utf8-lf-terminated");
    assert.match(benchmark.retainedEnvelopeSha256, /^[a-f0-9]{64}$/u);
  }
  assert.deepEqual(
    report,
    await buildReport({
      capture: report.capture,
      historicalChanges: report.historicalChanges,
      sourceRevision: report.sourceRevision,
      digests, spec, specRevision,
    }),
    "canonical non-historical evidence content drifted",
  );
};

const {captureReceipt, mergeReceipts, checkV2, v2ReportPath, retainedV1} = await import("./runtime-setup-l0-evidence-v2-capture.mjs");
const option = name => {const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];};
const mode = process.argv[2] ?? "--check";
assert.ok(["--check", "--capture", "--capture-adoption-receipt", "--merge-adoption-receipts"].includes(mode), `Unsupported mode: ${mode}`);
const profile = JSON.parse(await readFile(join(repositoryRoot, adoptionPaths.profile), "utf8"));
const adoption = mode.includes("adoption") || profile.status === "active" ||
  await pathExists(adoptionPaths.default) || await pathExists(adoptionPaths.graph) ||
  await pathExists(adoptionPaths.report);

if (adoption) {
  assert.notEqual(mode, "--capture", "direct L0 recapture is forbidden after adoption starts");
  assert.equal(profile.status, "active", "adoption not ready: consumer profile remains pending");
  const gateOutput = execFileSync(process.execPath, [adoptionPaths.checker], {
    cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const historicalBytes = await readFile(evidencePath);
  const stored = JSON.parse(historicalBytes);
  assertAdoptionAuthority({
    authorityBytes: await readFile(join(repositoryRoot, adoptionPaths.authority)),
    registry: JSON.parse(await readFile(join(repositoryRoot, adoptionPaths.registry), "utf8")),
    historicalBytes, profile, gate: JSON.parse(gateOutput),
  });
  // Historical content is authenticated against its own exact Git source.
  await validateStoredReport(stored, true);
  const originalSpec = await historicalSpec();
  const historicalChanges = loadHistoricalChanges(summarizeChange, originalSpec.changes);
  assert.ok(historicalChanges, "full historical evidence object closure is required for adoption");
  assert.deepEqual(stored.historicalChanges, historicalChanges);
  for (const entry of [...originalSpec.traces.construction, ...originalSpec.traces.invocations.claudeCode, ...originalSpec.traces.invocations.codex]) {
    const source = readRevisionFile(stored.sourceRevision, entry.path).toString("utf8");
    for (const symbol of entry.symbols) {
      assert.match(source, new RegExp(`\\b${symbol}\\b`, "u"), `historical trace lacks ${symbol}`);
    }
  }
  await verifyCurrentArchitecture([...adoptionConstruction, ...traces.construction.slice(1)]);
  const graphImports = new Set(importSpecifiers(await readFile(join(repositoryRoot, adoptionPaths.graph), "utf8"), adoptionPaths.graph));
  const defaultImports = new Set(importSpecifiers(await readFile(join(repositoryRoot, adoptionPaths.default), "utf8"), adoptionPaths.default));
  for (const name of ["@get-modular/core", "@get-modular/assembly"]) {
    assert.ok(graphImports.has(name) || defaultImports.has(name), `current construction lacks public root ${name}`);
  }
  const currentInputs = createEvidenceInputs({ repositoryRoot, git, readRevisionFile,
    files: { ...evidenceFiles, sources: [...evidenceFiles.sources, ...adoptionEvidenceFiles,
      profile.standard.evidencePath, ...profile.packages.map(pkg => pkg.archivePath)] },
  });
  currentInputs.assertEvidenceRootsClean();
  // Schema-v1 remains immutable and is validated against its own source closure.
  const retainedBytes = await readFile(join(repositoryRoot, adoptionPaths.report));
  assert.equal(createHash("sha256").update(retainedBytes).digest("hex"), retainedV1.sha256,
    "retained schema-v1 adoption bytes drifted");
  const retained = JSON.parse(retainedBytes);
  validateAdoptionReport(retained, {sourceRevision: retained.sourceRevision,
    historicalRevision: stored.sourceRevision,
    artifactDigests: await currentInputs.artifactDigestsAtRevision(retained.sourceRevision)});
  const output = resolve(option("--output") ?? join(repositoryRoot, v2ReportPath));
  if (mode === "--capture-adoption-receipt") {
    assert.ok(option("--output"), "receipt --output is required");
    captureReceipt(repositoryRoot, output, option("--run-id"));
  } else if (mode === "--merge-adoption-receipts") {
    const paths = process.argv.slice(3, process.argv.indexOf("--output"));
    assert.ok(option("--output"), "merge --output is required");
    mergeReceipts(repositoryRoot, paths, output);
  } else {
    await checkV2(repositoryRoot, output);
  }
} else {
  await verifyCurrentArchitecture();
  assertEvidenceRootsClean();
  if (mode === "--capture") {
    const historicalChanges = loadHistoricalChanges();
    assert.ok(historicalChanges, "full evidence object closure is required");
    const sourceRevision = changes.at(-1)?.revision;
    assert.ok(sourceRevision, "a retained product source revision is required");
    assertEvidenceRootsMatchRevision(sourceRevision);
    const report = await buildReport({ capture: captureProductCheck(), historicalChanges, sourceRevision });
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } else {
    const stored = JSON.parse(await readFile(evidencePath, "utf8"));
    await validateStoredReport(stored);
    try { assertEvidenceRootsMatchRevision(stored.sourceRevision); }
    catch (error) { if (!isHistoricalObjectClosureUnavailable(error)) { throw error; } }
    const historicalChanges = loadHistoricalChanges();
    if (historicalChanges !== undefined) {
      assert.deepEqual(stored.historicalChanges, historicalChanges, "runtime setup L0 historical evidence is stale");
    }
  }
}
console.log(`runtime-setup-l0-evidence: ${mode === "--check" ? "valid" : "captured"}`);
