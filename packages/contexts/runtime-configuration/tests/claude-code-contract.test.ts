import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CLAUDE_CODE_CONFIGURATION_BUDGETS,
  CLAUDE_CODE_EFFORT_VALUES,
  CLAUDE_CODE_MODEL_ALIASES,
  CLAUDE_CODE_PORTABLE_INTENT_EXAMPLE,
  CLAUDE_CODE_SETTINGS_DIALECT,
} from "../dist/index.js";

test("freezes the Claude Code dialect, allowlists, budgets and detached example", async () => {
  assert.equal(CLAUDE_CODE_SETTINGS_DIALECT, "claude-code-settings@2026-08-28");
  assert.deepEqual(CLAUDE_CODE_EFFORT_VALUES, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(CLAUDE_CODE_MODEL_ALIASES, [
    "default", "best", "fable", "sonnet", "opus", "haiku", "sonnet[1m]",
    "opus[1m]", "opusplan",
  ]);
  assert.equal(CLAUDE_CODE_CONFIGURATION_BUDGETS.bytesPerSource, 131_072);
  assert.equal(CLAUDE_CODE_CONFIGURATION_BUDGETS.sourceSlots, 3);
  assert.equal(Object.isFrozen(CLAUDE_CODE_PORTABLE_INTENT_EXAMPLE), true);

  const manifest = JSON.parse(await readFile(
    new URL("./fixtures/claude-code-settings/manifest.json", import.meta.url),
    "utf8",
  ));
  const negatives = JSON.parse(await readFile(
    new URL("./fixtures/claude-code-settings/negative-fixtures.json", import.meta.url),
    "utf8",
  ));
  assert.equal(manifest.qualifiesExecutable, false);
  assert.deepEqual(manifest.sourcesLowToHigh, ["user", "shared-project", "project-local"]);
  assert.ok(negatives.groups.length >= 19);
});
