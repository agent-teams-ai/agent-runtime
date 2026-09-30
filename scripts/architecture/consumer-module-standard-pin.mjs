import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const standardReviewPath = "architecture/get-modular/evidence/creation-cleanup-cms-pin-review.json";
export const standardDeltaPath = "architecture/get-modular/evidence/creation-cleanup-cms-pin-delta.diff";

const expected = Object.freeze({
  before: {
    commit: "ac49bb3374946330ec820591f8195a22d2c90900",
    sha256: "d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f",
    byteLength: 22337,
  },
  after: {
    commit: "9c722ceff4ede307d06d7a4b63fdebe615f54c53",
    sha256: "33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd",
    byteLength: 24312,
    evidencePath: "architecture/get-modular/evidence/consumer-module-standard.md",
  },
  sourceMainCommit: "9c722ceff4ede307d06d7a4b63fdebe615f54c53",
  sourceMainDocumentCommit: "9c722ceff4ede307d06d7a4b63fdebe615f54c53",
  deltaSha256: "04d1793e4312f39612a304400032ed6f3b19a3b15cfb9c24e706b87e0789c425",
});

export const validateStandardMigration = (review, deltaBytes) => {
  assert.deepEqual({
    schemaVersion: review.schemaVersion,
    reviewedOn: review.reviewedOn,
    repository: review.repository,
    path: review.path,
    anchor: review.anchor,
  }, {
    schemaVersion: 1,
    reviewedOn: "2026-09-30",
    repository: "agent-teams-ai/get-modular",
    path: "docs/architecture/common-assembly.md",
    anchor: "consumer-module-standard",
  }, "standard migration review identity drift");
  assert.deepEqual(review.before, expected.before,
    "standard migration review must retain the exact prior pin");
  assert.deepEqual(review.after, expected.after,
    "standard migration review must retain the exact current pin");
  assert.equal(review.sourceMainCommit, expected.sourceMainCommit,
    "standard migration review source main commit drift");
  assert.equal(review.sourceMainDocumentCommit, expected.sourceMainDocumentCommit,
    "standard migration review source document commit drift");
  assert.equal(review.sourceMainSha256, expected.after.sha256,
    "standard migration review source main bytes drift");
  assert.equal(review.delta?.path, standardDeltaPath,
    "standard migration review delta path drift");
  assert.equal(review.delta?.sha256, expected.deltaSha256,
    "standard migration review delta digest drift");
  assert.deepEqual({
    hunks: review.delta?.hunks,
    removedLines: review.delta?.removedLines,
    addedLines: review.delta?.addedLines,
  }, { hunks: 2, removedLines: 0, addedLines: 32 },
  "standard migration exact delta summary drift");
  assert.equal(createHash("sha256").update(deltaBytes).digest("hex"),
    expected.deltaSha256, "standard migration exact byte delta drift");
  assert.equal(review.behavioralContractChange, false,
    "candidate-only pin migration cannot claim a behavioral contract change");
  assert.deepEqual(review.adoption, {
    passiveAndOrdinary: "active",
    containedTurn: "pending",
    sdkExternalAuthority: "pending-authority-qualification",
  }, "standard migration must preserve scoped adoption states");
  assert.equal(review.historicalReview,
    "architecture/get-modular/evidence/a3-cms-pin-review.json",
  "standard migration must preserve the earlier reciprocal review as history");
  assert.match(review.historicalReviewDisposition,
    /not current upstream authority and is not used for this pin/u,
    "standard migration cannot treat historical bytes as current authority");
};
