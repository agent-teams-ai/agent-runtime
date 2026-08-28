import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXPECTED_CAPABILITY_IDS,
  validateAr2ContractArtifacts,
  validateContractCoverage,
} from "./validate-ar2-contract-artifacts.mjs";

const repositoryRoot = new URL("../../", import.meta.url);
const readJson = async path => JSON.parse(await readFile(path, "utf8"));

const loadCoverageInputs = async () => {
  const [freeze, negatives, contractCoverage] = await Promise.all([
    readJson(new URL("docs/architecture/claude-code-setup-freeze.json", repositoryRoot)),
    readJson(new URL(
      "packages/contexts/runtime-configuration/tests/fixtures/claude-code-settings/negative-fixtures.json",
      repositoryRoot,
    )),
    readJson(new URL(
      "packages/contexts/runtime-configuration/tests/fixtures/claude-code-settings/contract-coverage.json",
      repositoryRoot,
    )),
  ]);
  const testFiles = [...new Set(contractCoverage.cases.map(entry => entry.testFile))];
  const testSources = new Map(await Promise.all(testFiles.map(async testFile => [
    testFile,
    await readFile(new URL(testFile, repositoryRoot), "utf8"),
  ])));
  const packageRoots = [...new Set(testFiles.map(testFile => /^(packages\/[^/]+\/[^/]+)\//u.exec(testFile)[1]))];
  const packageTestScripts = new Map(await Promise.all(packageRoots.map(async packageRoot => {
    const packageManifest = await readJson(new URL(`${packageRoot}/package.json`, repositoryRoot));
    return [packageRoot, packageManifest.scripts.test];
  })));
  return {
    contractCoverage,
    fixtureMatrix: freeze.fixtureMatrix,
    negativeGroups: negatives.groups,
    packageTestScripts,
    testSources,
  };
};

test("AR-2 inventory and Claude freeze packet satisfy the frozen contract", async () => {
  const result = await validateAr2ContractArtifacts();
  assert.equal(result.inventoryItems, 56);
  assert.deepEqual(result.providerCounts, {
    codex: 26,
    "claude-code": 7,
    opencode: 23,
  });
  assert.deepEqual(result.capabilityIds, [...EXPECTED_CAPABILITY_IDS].toSorted());
  assert.deepEqual(result.approvals, ["CLF-01", "CLF-02", "CLF-03", "CLF-04"]);
  assert.equal(
    result.semanticArtifactSha256,
    "448fe097c1bc546ba02c2930316a9bb200431bc6aaf15dc35907f5e88bb3e14f",
  );
  assert.equal(result.snapshotDocuments, 13);
});

test("AR-2 validator rejects fixture or executed-test mapping drift", async () => {
  const inputs = await loadCoverageInputs();
  const fixtureDrift = structuredClone(inputs);
  for (const matrix of [
    fixtureDrift.fixtureMatrix,
    fixtureDrift.negativeGroups,
    fixtureDrift.contractCoverage.cases,
  ]) {
    matrix[19].diagnostic = "configuration_dialect_unsupported";
  }
  assert.throws(
    () => validateContractCoverage(fixtureDrift),
    /frozen fixture matrix/u,
  );

  const testReferenceDrift = structuredClone(inputs);
  testReferenceDrift.contractCoverage.cases[0].testName = "stale test title";
  assert.throws(
    () => validateContractCoverage(testReferenceDrift),
    /must name exactly one declared Node test/u,
  );
});
