import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readAr2CoverageTestSource } from "../../../../scripts/architecture/validate-ar2-contract-artifacts.mjs";

const fixtureRoot = new URL("./fixtures/claude-code-settings/", import.meta.url);
const repositoryRoot = new URL("../../../..", import.meta.url);
const readJson = async (path: URL) => JSON.parse(await readFile(path, "utf8"));
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const testScriptExecutes = (script: string, relativeTestFile: string) => script
  .split(/\s+/u)
  .some(token => new RegExp(
    `^${escapeRegExp(token).replaceAll("\\*", "[^/]+")}$`,
    "u",
  ).test(relativeTestFile));

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
      const packageManifest = await readJson(new URL(`${packageRoot}/package.json`, repositoryRoot));
      assert.equal(
        testScriptExecutes(packageManifest.scripts?.test ?? "", relativeTestFile),
        true,
        `${entry.id} test file must be executed by ${packageRoot}/package.json`,
      );
    });
  }
});
