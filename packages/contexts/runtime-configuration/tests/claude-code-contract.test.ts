import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readCustodiedRepositoryFile } from "../../../../scripts/architecture/ar2-evidence-custody.mjs";

import {
  CLAUDE_CODE_CONFIGURATION_BUDGETS,
  CLAUDE_CODE_EFFORT_VALUES,
  CLAUDE_CODE_MODEL_ALIASES,
  CLAUDE_CODE_MODEL_DEFAULT,
  CLAUDE_CODE_OBSERVED_SOURCE_PLAN_CONTRACT,
  CLAUDE_CODE_SETTINGS_DIALECT,
} from "../dist/index.js";
import { claudeCodePortableIntentExample } from "./fixtures/claude-code-portable-intent-example.ts";

test("freezes the Claude Code dialect, allowlists, budgets and test-fixture example", async () => {
  assert.equal(CLAUDE_CODE_SETTINGS_DIALECT, "claude-code-settings@2026-08-28");
  assert.deepEqual(CLAUDE_CODE_EFFORT_VALUES, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(CLAUDE_CODE_MODEL_ALIASES, [
    "best", "fable", "sonnet", "opus", "haiku", "sonnet[1m]",
    "opus[1m]", "opusplan",
  ]);
  assert.equal(CLAUDE_CODE_MODEL_DEFAULT, "default");
  assert.equal(CLAUDE_CODE_OBSERVED_SOURCE_PLAN_CONTRACT, "claude-code-observed-source-plan/v1");
  assert.equal(CLAUDE_CODE_CONFIGURATION_BUDGETS.bytesPerSource, 131_072);
  assert.equal(CLAUDE_CODE_CONFIGURATION_BUDGETS.sourceSlots, 16);
  assert.equal(CLAUDE_CODE_CONFIGURATION_BUDGETS.rootSlots, 16);
  assert.equal(Object.isFrozen(claudeCodePortableIntentExample), true);

  const manifest = JSON.parse((await readCustodiedRepositoryFile(
    "packages/contexts/runtime-configuration/tests/fixtures/claude-code-settings/manifest.json",
    { allowedRoot: "packages/contexts/runtime-configuration/tests/fixtures/claude-code-settings" },
  )).toString("utf8"));
  assert.equal(manifest.qualifiesExecutable, false);
  assert.equal(manifest.sourceModel.claim, "observed-files-only");
  assert.equal(manifest.sourceModel.precedence, "not-evaluated");
  assert.equal(manifest.providerRouteVocabularyRevision, "claude-code-provider-route-vocabulary/v2");
  assert.equal(manifest.contractCoverage, "./contract-coverage.json");
});

test("keeps the portable-intent example out of production exports", async () => {
  const declaration = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8");
  assert.doesNotMatch(declaration, /PORTABLE_INTENT_EXAMPLE|claudeCodePortableIntentExample/u);
});
