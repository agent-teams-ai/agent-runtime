import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

const specifiers = (source: string): string[] =>
  [...source.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]([^"'`]+)["'`]/gu)]
    .map(match => match[1] ?? "");

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
