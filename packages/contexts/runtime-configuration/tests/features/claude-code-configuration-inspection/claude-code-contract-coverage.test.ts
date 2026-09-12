import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { findRepoRoot } from "../../helpers/repo-root.ts";

const repoRoot = findRepoRoot();
const { readCustodiedRepositoryFile } = await import(pathToFileURL(join(
  repoRoot,
  "scripts/architecture/ar2-evidence-custody.mjs",
)).href);
const { readAr2CoverageTestSource } = await import(pathToFileURL(join(
  repoRoot,
  "scripts/architecture/validate-ar2-contract-artifacts.mjs",
)).href);

const { ar2InventoryExecutes, readAr2TestExecutionInventory } = await import(pathToFileURL(join(
  repoRoot,
  "scripts/architecture/ar2-test-execution-inventory.mjs",
)).href);

const fixtureRoot = "packages/contexts/runtime-configuration/tests/fixtures/claude-code-settings";
const readJson = async (path: string, allowedRoot: string) => JSON.parse(
  (await readCustodiedRepositoryFile(path, { allowedRoot })).toString("utf8"),
);
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

test("requires exact executable coverage for every frozen AR-2 fixture", async t => {
  const [freeze, manifest, negatives, coverage] = await Promise.all([
    readJson("docs/architecture/claude-code-setup-freeze.json", "docs/architecture"),
    readJson(`${fixtureRoot}/manifest.json`, fixtureRoot),
    readJson(`${fixtureRoot}/negative-fixtures.json`, fixtureRoot),
    readJson(`${fixtureRoot}/contract-coverage.json`, fixtureRoot),
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
      const { packageRoot, relativeTestFile, source } = await readAr2CoverageTestSource(entry.testFile);
      const declaration = new RegExp(
        `\\btest\\(\\s*${escapeRegExp(JSON.stringify(entry.testName))}\\s*,`,
        "gu",
      );
      assert.equal(
        [...source.matchAll(declaration)].length,
        1,
        `${entry.id} must name exactly one declared Node test in ${entry.testFile}`,
      );
      const inventory = await readAr2TestExecutionInventory(packageRoot);
      assert.equal(
        ar2InventoryExecutes(inventory, relativeTestFile),
        true,
        `${entry.id} test file must be executed by ${packageRoot}/package.json`,
      );
    });
  }
});
