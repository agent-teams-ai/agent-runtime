import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_CAPABILITY_IDS,
  validateAr2ContractArtifacts,
} from "./validate-ar2-contract-artifacts.mjs";

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
