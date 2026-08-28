import assert from "node:assert/strict";
import test from "node:test";

import {
  isHistoricalObjectClosureUnavailable,
  validateStoredReportShape,
} from "./runtime-setup-l0-evidence-validation.mjs";

const changes = [{ id: "slice", revision: "a".repeat(40) }];
const report = {
  schemaVersion: 3,
  evidenceKind: "runtime-setup-l0-direct-composition",
  sourceRevision: changes[0].revision,
  authority: "ADR-0008",
  productOutcome: "detached-safe-runtime-setup-preview",
  taxonomyAuthority: "experiment-local-non-qualification-rubric",
  ownership: [],
  verdicts: {},
  guidanceThresholds: {},
  promotionRule: "hold",
  capture: {
    command: "pnpm --filter @agent-teams/embedded-runtime check",
    exitCode: 0,
    outputSha256: "b".repeat(64),
    architecture: "arm64",
    nodeVersion: "v24.18.0",
    platform: "darwin",
    testSummary: {
      tests: 1,
      pass: 1,
      fail: 0,
      cancelled: 0,
      skipped: 0,
    },
  },
  artifactDigests: {},
  historicalChanges: [{
    ...changes[0],
    files: 1,
    additions: 1,
    deletions: 0,
    binaryFiles: 0,
    composition: { files: 1, additions: 1, deletions: 0 },
    production: { files: 1, additions: 1, deletions: 0 },
    tests: { files: 1, additions: 1, deletions: 0 },
    behaviorFixtures: { before: 0, after: 1, retained: 0, reusePercent: null },
  }],
  prospectiveBenchmarks: [],
  traces: {},
  limitations: [],
};

test("recognizes only failed Git commands with missing historical objects", () => {
  assert.equal(isHistoricalObjectClosureUnavailable({
    status: 128,
    stderr: "fatal: promised object deadbeef unavailable",
  }), true);
  assert.equal(isHistoricalObjectClosureUnavailable({
    status: 128,
    stderr: "fatal: ambiguous argument 'deadbeef^': unknown revision or path not in the working tree.",
  }), true);
  assert.equal(isHistoricalObjectClosureUnavailable(new Error("bad object")), false);
  assert.equal(isHistoricalObjectClosureUnavailable({
    status: 128,
    stderr: "fatal: permission denied",
  }), false);
});

test("accepts the complete retained evidence shape", () => {
  assert.doesNotThrow(() => validateStoredReportShape(report, changes));
});

test("rejects drift even when historical values cannot be recomputed", () => {
  const missingAuthority = structuredClone(report);
  delete missingAuthority.authority;
  assert.throws(
    () => validateStoredReportShape(missingAuthority, changes),
    /evidence report fields drifted/u,
  );

  const incompleteCapture = structuredClone(report);
  delete incompleteCapture.capture.platform;
  assert.throws(
    () => validateStoredReportShape(incompleteCapture, changes),
    /capture fields drifted/u,
  );

  const malformedHistory = structuredClone(report);
  delete malformedHistory.historicalChanges[0].composition.files;
  assert.throws(
    () => validateStoredReportShape(malformedHistory, changes),
    /historicalChanges\[0\]\.composition fields drifted/u,
  );
});
