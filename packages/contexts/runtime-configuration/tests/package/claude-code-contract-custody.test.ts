import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { findRepoRoot } from "../helpers/repo-root.ts";

const { readCustodiedRepositoryFile } = await import(pathToFileURL(join(
  findRepoRoot(),
  "scripts/architecture/ar2-evidence-custody.mjs",
)).href);

test("routes the Claude Code settings manifest through AR-2 descriptor custody", async () => {
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
