import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as publicApi from "../../dist/index.js";

test("package root exposes only supported V1 consumer contracts", async () => {
  assert.deepEqual(Object.keys(publicApi), ["CONTAINED_TURN_PROVIDER_DISPATCH_PURPOSE"]);
  const declarations = await readFile(new URL("../../dist/index.d.ts", import.meta.url), "utf8");
  assert.match(declarations, /ContainedTurnDispatchAuthorityV1/);
  for (const internalName of [
    "DispatchAuthorityHead",
    "DispatchConsumptionRepository",
    "DispatchControlClock",
    "DispatchDigest",
    "PersistedConsumption",
  ]) {
    assert.doesNotMatch(declarations, new RegExp(`\\b${internalName}\\b`));
  }
});

test("composition factories stay off the public package root", () => {
  assert.equal("createContainedTurnEgressGateway" in publicApi, false);
  assert.equal("containedTurnEgressProviderBindingDigest" in publicApi, false);
});
