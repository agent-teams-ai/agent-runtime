import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CLAUDE_CODE_SETTINGS_DIALECT } from "../dist/index.js";
import { createClaudeCodeConfigurationSemanticClassifierV1 } from "../dist/composition.js";

const fixtureRoot = new URL("./fixtures/claude-code-settings/", import.meta.url);
const repositoryRoot = new URL("../../../..", import.meta.url);
const readJson = async (path: URL) => JSON.parse(await readFile(path, "utf8"));

test("executes the secret-setting negative fixture", () => {
  const result = createClaudeCodeConfigurationSemanticClassifierV1().classify(
    CLAUDE_CODE_SETTINGS_DIALECT,
    { sessionSecret: "opaque" },
  );
  assert.deepEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
    "secret_setting_rejected",
  ]);
});

test("requires exact executable coverage for every frozen AR-2 fixture", async t => {
  const [freeze, manifest, negatives, coverage] = await Promise.all([
    readJson(new URL(
      "../../../../docs/architecture/claude-code-setup-freeze.json",
      import.meta.url,
    )),
    readJson(new URL("manifest.json", fixtureRoot)),
    readJson(new URL("negative-fixtures.json", fixtureRoot)),
    readJson(new URL("contract-coverage.json", fixtureRoot)),
  ]);

  assert.equal(manifest.negativeManifest, "./negative-fixtures.json");
  assert.equal(manifest.contractCoverage, "./contract-coverage.json");
  assert.equal(coverage.contractId, manifest.contractId);
  assert.deepEqual(freeze.fixtureMatrix, negatives.groups);
  assert.deepEqual(
    coverage.cases.map(({ id, expected, diagnostic }: Record<string, string>) => ({
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(expected === undefined ? {} : { expected }),
      id,
    })),
    negatives.groups,
  );
  assert.equal(new Set(coverage.cases.map((entry: { id: string }) => entry.id)).size, coverage.cases.length);

  for (const entry of coverage.cases) {
    await t.test(entry.id, async () => {
      assert.deepEqual(
        Object.keys(entry).toSorted(),
        ["id", entry.diagnostic === undefined ? "expected" : "diagnostic", "testFile", "testName"].toSorted(),
      );
      const source = await readFile(new URL(entry.testFile, repositoryRoot), "utf8");
      assert.ok(
        source.includes(entry.testName),
        `${entry.id} executable test ${JSON.stringify(entry.testName)} is missing`,
      );
    });
  }
});
