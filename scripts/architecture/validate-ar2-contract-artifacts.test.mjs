import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXPECTED_CAPABILITY_IDS,
  validateAr2ContractArtifacts,
  validateContractCoverage,
  validateOfficialSemantics,
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
    "9eff9540cb54c1aae9aafbbf5688c6a516d24b13af3341da064a8a1806e5b786",
  );
  assert.equal(result.snapshotDocuments, 5);
});

test("AR-2 validator rejects gzip metadata drift and a fabricated retained excerpt", async () => {
  const snapshot = await readJson(new URL(
    "docs/architecture/claude-code-official-semantics.snapshot.json",
    repositoryRoot,
  ));
  snapshot.documents[0].gzipSha256 = "0".repeat(64);
  await assert.rejects(
    validateOfficialSemantics(snapshot),
    /deterministic gzip hash/u,
  );

  const fabricatedExcerpt = await readJson(new URL(
    "docs/architecture/claude-code-official-semantics.snapshot.json",
    repositoryRoot,
  ));
  fabricatedExcerpt.documents[0].retainedBytesUtf8 = fabricatedExcerpt.documents[0]
    .retainedBytesUtf8
    .replace("User |", "Fake |");
  fabricatedExcerpt.documents[0].retainedSha256 = createHash("sha256")
    .update(fabricatedExcerpt.documents[0].retainedBytesUtf8)
    .digest("hex");
  await assert.rejects(
    validateOfficialSemantics(fabricatedExcerpt),
    /retained evidence derivation/u,
  );
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
