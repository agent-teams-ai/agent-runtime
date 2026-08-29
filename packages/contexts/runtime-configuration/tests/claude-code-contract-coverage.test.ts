import assert from "node:assert/strict";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixtureRoot = new URL("./fixtures/claude-code-settings/", import.meta.url);
const repositoryRoot = new URL("../../../..", import.meta.url);
const readJson = async (path: URL) => JSON.parse(await readFile(path, "utf8"));
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const packageTestCoordinates = (testFile: string) => {
  assert.match(testFile, /^[A-Za-z0-9_./-]+$/u, `${testFile} must use portable ASCII path segments`);
  const match = /^(packages\/[^/]+\/[^/]+)\/(tests\/(?:[^/]+\/)?[^/]+\.test\.ts)$/u.exec(testFile);
  assert.ok(match, `${testFile} must be a package-owned test file`);
  assert.equal(
    testFile.split("/").some(segment => segment === "." || segment === ".."),
    false,
    `${testFile} must not contain dot path segments`,
  );
  assert.equal(
    new URL(testFile, repositoryRoot).href.startsWith(new URL(`${match[1]}/tests/`, repositoryRoot).href),
    true,
    `${testFile} must remain inside its package tests directory`,
  );
  return { packageRoot: match[1], relativeTestFile: match[2] };
};
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
      const { packageRoot, relativeTestFile } = packageTestCoordinates(entry.testFile);
      const testFilePath = fileURLToPath(new URL(entry.testFile, repositoryRoot));
      const pathSegments = entry.testFile.split("/");
      let observedPath = fileURLToPath(repositoryRoot);
      for (const [index, segment] of pathSegments.entries()) {
        observedPath = join(observedPath, segment);
        const metadata = await lstat(observedPath);
        assert.equal(metadata.isSymbolicLink(), false, `${entry.testFile} must not traverse a symbolic link`);
        assert.equal(
          index === pathSegments.length - 1 ? metadata.isFile() : metadata.isDirectory(),
          true,
          `${entry.testFile} must resolve through directories to a regular file`,
        );
      }
      assert.equal(observedPath, testFilePath, `${entry.testFile} must resolve from the repository root`);
      const containedPath = relative(
        await realpath(fileURLToPath(new URL(`${packageRoot}/tests/`, repositoryRoot))),
        await realpath(testFilePath),
      );
      assert.equal(
        containedPath === ".." || containedPath.startsWith(`..${sep}`) || isAbsolute(containedPath),
        false,
        `${entry.testFile} must remain inside its real package tests directory`,
      );
      const source = await readFile(testFilePath, "utf8");
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
