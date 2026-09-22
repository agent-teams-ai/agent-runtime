import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../../..");

const specifiers = (source: string): string[] =>
  [...source.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]([^"'`]+)["'`]/gu)]
    .map(match => match[1] ?? "");

const run = (
  command: string,
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>> = {},
): string => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
      ...environment,
    },
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
};

test("package assembly reaches features only through curated entrypoints", async () => {
  const index = await readFile(join(packageRoot, "src/index.ts"), "utf8");
  const composition = await readFile(join(packageRoot, "src/composition.ts"), "utf8");
  assert.deepEqual([...new Set(specifiers(index))].toSorted(), [
    "./features/claude-code-configuration-inspection/index.js",
    "./features/codex-configuration-inspection/index.js",
  ]);
  assert.deepEqual([...new Set(specifiers(composition))].toSorted(), [
    "./features/claude-code-configuration-inspection/internal.js",
    "./features/codex-configuration-inspection/internal.js",
  ]);
});

test("the public entry exposes only portable contracts while composition carries the runtime", async () => {
  const publicEntry = await import("../../dist/index.js") as Record<string, unknown>;
  assert.deepEqual(Object.keys(publicEntry).toSorted(), [
    "CLAUDE_CODE_CONFIGURATION_BUDGETS",
    "CLAUDE_CODE_EFFORT_VALUES",
    "CLAUDE_CODE_MODEL_ALIASES",
    "CLAUDE_CODE_MODEL_DEFAULT",
    "CLAUDE_CODE_OBSERVED_SOURCE_PLAN_CONTRACT",
    "CLAUDE_CODE_PROVIDER_ROUTE_KEYS",
    "CLAUDE_CODE_PROVIDER_ROUTE_VOCABULARY_REVISION",
    "CLAUDE_CODE_SETTINGS_DIALECT",
  ]);
  for (const name of Object.keys(publicEntry)) {
    assert.notEqual(typeof publicEntry[name], "function", `public entry must not export factory ${name}`);
  }

  const composition = await import("../../dist/composition.js") as Record<string, unknown>;
  for (const name of [
    "createClaudeCodeConfigurationInspectionFeature",
    "createClaudeCodeConfigurationSemanticClassifierV2",
    "createClaudeCodeConfigurationSourceReaderAdapter",
    "createCodexConfigurationInspectionFeature",
    "createCodexConfigurationSemanticClassifierV1",
    "createNodeClaudeCodeConfigurationDigest",
    "createNodeCodexConfigurationDigest",
    "createNodeConfigurationSourceReader",
    "createSmolTomlParser",
    "createStrictClaudeCodeJsonParser",
  ]) {
    assert.equal(typeof composition[name], "function", `composition must export ${name}`);
  }
  assert.equal(
    Object.hasOwn(composition, "assertClaudeCodeVocabularyParity"),
    false,
    "the inbound parity guard is owner-internal, not a package composition factory",
  );
});

test("composition contracts are curated and do not leak private application models", async () => {
  const composition = await readFile(join(packageRoot, "src/composition.ts"), "utf8");
  for (const requiredType of [
    "AuthorizedClaudeCodeConfigurationSource",
    "ClaudeCodeConfigurationInspectionDependencies",
    "ClaudeCodeConfigurationSemanticClassifier",
    "ClaudeCodeJsonParserDiagnosticCode",
    "CodexConfigurationInspectionFeature",
    "CodexConfigurationSemanticClassifier",
    "CodexTomlParseResult",
    "ConfigurationSourceRead",
    "InspectClaudeCodeConfiguration",
    "InspectCodexConfiguration",
  ]) {
    assert.match(
      composition,
      new RegExp(`\\btype ${requiredType}\\b`, "u"),
      `composition must retain supported contract ${requiredType}`,
    );
  }

  for (const relativePath of [
    "src/features/claude-code-configuration-inspection/application/ports/outbound/claude-code-configuration-semantic-classifier.ts",
    "src/features/claude-code-configuration-inspection/application/ports/outbound/claude-code-configuration-source-reader.ts",
    "src/features/claude-code-configuration-inspection/application/ports/outbound/claude-code-json-parser.ts",
    "src/features/codex-configuration-inspection/application/ports/outbound/codex-configuration-semantic-classifier.ts",
  ]) {
    const source = await readFile(join(packageRoot, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /(?:from|import)\s+["'][^"']*(?:application\/models|\/models\/|\/contracts\/)/u,
      `${relativePath} must own its supported port contracts instead of leaking private models`,
    );
  }
});

test("a packed consumer can implement supported ports and retain exact factory results", async t => {
  const cacheRoot = join(packageRoot, ".cache");
  await mkdir(cacheRoot, { recursive: true });
  const temporaryRoot = await mkdtemp(join(cacheRoot, "contract-consumer-"));
  t.after(() => rm(temporaryRoot, { force: true, recursive: true }));

  const packed = JSON.parse(run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot, "."],
    packageRoot,
    { npm_config_cache: join(temporaryRoot, "npm-cache") },
  )) as readonly [{ readonly filename: string }];
  assert.equal(packed.length, 1);
  const archive = join(temporaryRoot, packed[0]?.filename ?? "missing.tgz");
  run("tar", ["-xzf", archive, "-C", temporaryRoot], packageRoot);

  const consumerRoot = join(temporaryRoot, "consumer");
  const installedPackage = join(
    consumerRoot,
    "node_modules",
    "@agent-teams",
    "runtime-configuration",
  );
  await mkdir(dirname(installedPackage), { recursive: true });
  await rename(join(temporaryRoot, "package"), installedPackage);

  await writeFile(join(consumerRoot, "consumer.ts"), `
import type {
  InspectClaudeCodeConfiguration as RootInspectClaudeCodeConfiguration,
  InspectCodexConfiguration as RootInspectCodexConfiguration,
} from "@agent-teams/runtime-configuration";
import {
  claudeCodeConfigurationSemanticClassifierContract,
  codexConfigurationSemanticClassifierContract,
  createClaudeCodeConfigurationInspectionFeature,
  createCodexConfigurationInspectionFeature,
  type AuthorizedClaudeCodeConfigurationSource,
  type ClaudeCodeConfigurationSemanticClassifier,
  type ClaudeCodeConfigurationSourceReader,
  type ClaudeCodeJsonParser,
  type CodexConfigurationInspectionFeature,
  type CodexConfigurationSemanticClassifier,
  type CodexTomlParser,
  type ConfigurationSourceReader,
  type InspectClaudeCodeConfiguration,
} from "@agent-teams/runtime-configuration/composition";

const digest = {
  hmacSha256Hex: () => "0".repeat(64),
  sha256Hex: () => "1".repeat(64),
};
const codexParser: CodexTomlParser = {
  parse: () => ({ document: Object.freeze({}), kind: "parsed" }),
};
const codexClassifier: CodexConfigurationSemanticClassifier = {
  contract: codexConfigurationSemanticClassifierContract,
  revision: "packed-consumer/1",
  classify: () => ({
    diagnostics: [{ code: "unknown_setting_ignored", setting: "synthetic" }],
    settings: [{ key: "personality", value: "pragmatic" }],
  }),
  supportsDialect: () => true,
};
const codexReader: ConfigurationSourceReader = {
  read: async () => ({ kind: "missing" }),
};
const codexFeature: CodexConfigurationInspectionFeature =
  createCodexConfigurationInspectionFeature({
    digest,
    parser: codexParser,
    semanticClassifier: codexClassifier,
    sourceIdentityKey: new Uint8Array(32),
    sourceReader: codexReader,
  });
const codexInspection: RootInspectCodexConfiguration = codexFeature.inspectCodexConfiguration;

const authorizedSource: AuthorizedClaudeCodeConfigurationSource = {
  access: "authorized",
  absolutePath: "/synthetic/settings.json",
  canonicalPath: "/synthetic/settings.json",
  custodyRoot: { absolutePath: "/synthetic", canonicalPath: "/synthetic", rootId: "root-1" },
  displayPath: "$CLAUDE_CONFIG_DIR/settings.json",
  observationEpoch: "epoch-1",
  role: "user",
  selectionBasis: "claude-config-dir",
  sourceId: "source-1",
  trust: "user",
};
const claudeReader: ClaudeCodeConfigurationSourceReader = {
  measure: async source => ({ bytes: source.sourceId.length, status: "measured" }),
  read: async source => source === authorizedSource
    ? { bytes: new Uint8Array(), status: "read" }
    : { status: "stale" },
};
const claudeParser: ClaudeCodeJsonParser = {
  parse: () => ({ diagnostic: "config_duplicate_key", status: "rejected" }),
};
const claudeClassifier: ClaudeCodeConfigurationSemanticClassifier = {
  contract: claudeCodeConfigurationSemanticClassifierContract,
  revision: "packed-consumer/1",
  classify: () => ({
    definitions: [
      { key: "model", selection: { kind: "alias", value: "sonnet" } },
      { key: "effortLevel", value: "xhigh" },
    ],
    deferredObservations: [{ form: "provider-deployment", key: "model", status: "deferred" }],
    diagnostics: [{ code: "provider_route_deferred" }],
    definedPortableKeys: ["model", "effortLevel"],
    taintedPortableKeys: [],
  }),
  supportsDialect: () => true,
};
const claudeFeature: InspectClaudeCodeConfiguration =
  createClaudeCodeConfigurationInspectionFeature({
    digest,
    parser: claudeParser,
    semanticClassifier: claudeClassifier,
    sourceIdentityKey: new Uint8Array(32),
    sourceReader: claudeReader,
  });
const rootClaudeFeature: RootInspectClaudeCodeConfiguration = claudeFeature;
void codexInspection;
void rootClaudeFeature;
`);
  await writeFile(join(consumerRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      lib: ["ES2024", "DOM"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      strict: true,
      typeRoots: [join(repositoryRoot, "node_modules", "@types")],
      types: ["node"],
    },
    files: ["consumer.ts"],
  }));
  run(
    join(repositoryRoot, "node_modules", ".bin", "tsc"),
    ["--project", "tsconfig.json", "--pretty", "false"],
    consumerRoot,
  );
});
