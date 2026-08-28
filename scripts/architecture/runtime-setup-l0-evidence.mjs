import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSync, Visitor } from "oxc-parser";

import {
  changes,
  evidenceRoots,
  ownership,
  prospectiveBenchmarks,
  traces,
} from "./runtime-setup-l0-evidence-spec.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidencePath = join(
  repositoryRoot,
  "docs/spikes/runtime-setup-l0-dogfooding-evidence.json",
);
const benchmarkEnvelopePath = join(
  repositoryRoot,
  "docs/spikes/runtime-setup-l0-benchmark-envelopes.json",
);

const git = (...args) => execFileSync("git", args, {
  cwd: repositoryRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const sum = (items, field) => items.reduce((total, item) => total + item[field], 0);

const hasCommit = revision => {
  try {
    git("cat-file", "-e", `${revision}^{commit}`);
    return true;
  } catch {
    return false;
  }
};

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

const walkFiles = async directory => {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return files;
    }
    throw error;
  }
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

const hashFileSet = async roots => {
  const files = await collectEvidenceFiles(roots);
  const digest = createHash("sha256");
  for (const path of files) {
    const content = await readFile(path);
    digest.update(relative(repositoryRoot, path));
    digest.update("\0");
    digest.update(createHash("sha256").update(content).digest("hex"));
    digest.update("\n");
  }
  return { fileCount: files.length, sha256: digest.digest("hex") };
};

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

const forbiddenInwardDependency = /@agent-teams\/(?:engineering|extension)-foundation|cordis|awilix|(?:^|\/)(?:adapters|composition)(?:\/|$)|(?:^|[-/])(?:container|module-(?:graph|runtime)|registry)(?:[-/]|$)/iu;

assert.equal(
  importSpecifiers(
    "type Forbidden = import('@agent-teams/extension-foundation').Runtime;",
    "evidence-import-type-boundary-self-test.ts",
  ).some(specifier => forbiddenInwardDependency.test(specifier)),
  true,
  "TypeScript import types must participate in the inward dependency gate",
);

const verifyCurrentArchitecture = async () => {
  const traceEntries = [
    ...traces.construction,
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
    (path.includes("/application/") || path.includes("/contracts/")));
  for (const path of inwardFiles) {
    const source = await readFile(path, "utf8");
    assert.equal(
      importSpecifiers(source, path).some(specifier => forbiddenInwardDependency.test(specifier)),
      false,
      `module runtime or outward layer leaked into ${relative(repositoryRoot, path)}`,
    );
  }
};

const artifactDigests = async () => ({
  fixtures: await hashFileSet(evidenceRoots.fixtures),
  sources: await hashFileSet(evidenceRoots.sources),
  tests: await hashFileSet(evidenceRoots.tests),
});

const assertEvidenceRootsClean = () => {
  const roots = [...evidenceRoots.fixtures, ...evidenceRoots.sources, ...evidenceRoots.tests];
  assert.equal(
    git("status", "--porcelain=v1", "--untracked-files=all", "--", ...roots).trim(),
    "",
    "captured product source, tests, and fixtures must match the source revision",
  );
};

const assertEvidenceRootsMatchRevision = revision => {
  const roots = [...evidenceRoots.fixtures, ...evidenceRoots.sources, ...evidenceRoots.tests];
  assert.equal(
    git("diff", "--name-only", revision, "HEAD", "--", ...roots).trim(),
    "",
    "captured product source, tests, and fixtures must match the retained product revision",
  );
};

const captureProductCheck = () => {
  const args = ["--filter", "@agent-teams/embedded-runtime", "check"];
  const output = execFileSync("pnpm", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const testSummary = Object.fromEntries(
    [...output.matchAll(/^(?:#|ℹ)\s+(tests|pass|fail|cancelled|skipped)\s+(\d+)$/gmu)]
      .map(([, key, value]) => [key, Number(value)]),
  );
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

const loadProspectiveBenchmarks = async () => {
  const document = JSON.parse(await readFile(benchmarkEnvelopePath, "utf8"));
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.evidenceKind, "redacted-hosted-worker-result-envelopes");
  assert.equal(document.sourceRevision, changes.at(-1)?.revision);
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

const buildReport = async ({ capture, sourceRevision }) => ({
  schemaVersion: 3,
  evidenceKind: "runtime-setup-l0-direct-composition",
  sourceRevision,
  authority: "ADR-0008",
  productOutcome: "detached-safe-runtime-setup-preview",
  taxonomyAuthority: "experiment-local-non-qualification-rubric",
  ownership,
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
  artifactDigests: await artifactDigests(),
  historicalChanges: changes.map(summarizeChange),
  prospectiveBenchmarks: await loadProspectiveBenchmarks(),
  traces,
  limitations: [
    "historical-change-size-is-not-an-authoring-benchmark",
    "historical-data-does-not-prove-incorrect-edit-count",
    "codex-and-claude-code-are-sibling-capabilities-not-one-provider-slot",
    "no-runtime-provider-selection-without-rebuild-is-proved",
    "host-disposal-does-not-prove-generic-module-lifecycle",
    "prospective-benchmarks-are-exploratory-and-do-not-satisfy-the-promotion-rule",
    "no-shared-foundation-runtime-is-authorized",
  ],
});

const validateStoredReport = report => {
  assert.equal(report.schemaVersion, 3);
  assert.ok(hasCommit(report.sourceRevision), "captured source revision must exist");
  assert.equal(
    report.sourceRevision,
    changes.at(-1)?.revision,
    "captured source revision must be the latest retained product change",
  );
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
  assert.equal(report.capture.exitCode, 0);
  assert.match(report.capture.nodeVersion, /^v24\./u);
  assert.ok(["arm64", "x64"].includes(report.capture.architecture));
  assert.ok(report.capture.testSummary.tests > 0);
  assert.equal(report.capture.testSummary.pass, report.capture.testSummary.tests);
  assert.equal(report.capture.testSummary.fail, 0);
  assert.equal(report.capture.testSummary.cancelled, 0);
  assert.equal(report.capture.testSummary.skipped, 0);
  assert.match(report.capture.outputSha256, /^[a-f0-9]{64}$/u);
  assert.ok(report.historicalChanges.length >= 3);
  assert.equal(report.historicalChanges.length, changes.length);
  assert.deepEqual(
    report.historicalChanges.map(({ id, revision }) => ({ id, revision })),
    changes,
  );
  assert.equal(report.prospectiveBenchmarks.length, 3);
  for (const benchmark of report.prospectiveBenchmarks) {
    assert.equal(benchmark.sourceRevision, changes.at(-1)?.revision);
    assert.equal(benchmark.execution.editMode, "read-only");
    assert.equal(benchmark.verdict, "hold");
    assert.equal(benchmark.promotionEvidence, false);
    assert.equal(benchmark.promptEncoding, "utf8-lf-terminated");
    assert.match(benchmark.retainedEnvelopeSha256, /^[a-f0-9]{64}$/u);
  }
};

await verifyCurrentArchitecture();
assertEvidenceRootsClean();
const mode = process.argv[2] ?? "--check";
if (mode === "--capture") {
  assert.ok(changes.every(({ revision }) => hasCommit(revision)), "full evidence history is required");
  const sourceRevision = changes.at(-1)?.revision;
  assert.ok(sourceRevision, "a retained product source revision is required");
  assertEvidenceRootsMatchRevision(sourceRevision);
  const report = await buildReport({ capture: captureProductCheck(), sourceRevision });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
} else if (mode === "--check") {
  const stored = JSON.parse(await readFile(evidencePath, "utf8"));
  validateStoredReport(stored);
  if (changes.every(({ revision }) => hasCommit(revision))) {
    assert.deepEqual(
      stored,
      await buildReport({ capture: stored.capture, sourceRevision: stored.sourceRevision }),
      "runtime setup L0 evidence is stale",
    );
  }
} else {
  throw new Error(`Unsupported mode: ${mode}`);
}

console.log(`runtime-setup-l0-evidence: ${mode === "--capture" ? "captured" : "valid"}`);
