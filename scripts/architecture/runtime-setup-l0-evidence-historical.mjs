import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {adoptionPaths, retainedHistoricalSha256} from "./runtime-setup-l0-evidence-adoption.mjs";

// The original report and specification are retained together, independently of
// incoming direct-L0 experiments and the current composition specification.
export const historicalSpecRevision = "15f92b38d0fec8a56fbd6d6324d02de2566cccb7";
export async function loadHistoricalSpec(readRevisionFile) {
  const report = readRevisionFile(historicalSpecRevision, adoptionPaths.historical);
  assert.equal(createHash("sha256").update(report).digest("hex"), retainedHistoricalSha256);
  const bytes = readRevisionFile(historicalSpecRevision, "scripts/architecture/runtime-setup-l0-evidence-spec.mjs");
  return import(`data:text/javascript;base64,${bytes.toString("base64")}`);
}
