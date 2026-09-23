import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const standardReviewPath = "architecture/get-modular/evidence/a3-cms-pin-review.json";
export const standardDeltaPath = "architecture/get-modular/evidence/a3-cms-pin-delta.diff";

const expected = Object.freeze({
  before: {
    commit: "669a750d8db451e04f075cdeb36576c6606fba6e",
    sha256: "e6cd8d26b4317bf5f94ddd22f6e36bf25e90548f72265d94808eaf20b947e553",
    byteLength: 22017,
  },
  after: {
    commit: "ac49bb3374946330ec820591f8195a22d2c90900",
    sha256: "d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f",
    byteLength: 22337,
    evidencePath: "architecture/get-modular/evidence/consumer-module-standard.md",
  },
  sourceMainCommit: "6b31f20fe3e5fb8324812aa2ee907905751cde71",
  sourceMainDocumentCommit: "ac49bb3374946330ec820591f8195a22d2c90900",
  deltaSha256: "75fbaee48d4e6c7ad61548f15237a62a8a0e5e85cd8a642ec29a335a13de49d8",
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
    reviewedOn: "2026-09-23",
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
  }, { hunks: 1, removedLines: 6, addedLines: 11 },
  "standard migration exact delta summary drift");
  assert.equal(createHash("sha256").update(deltaBytes).digest("hex"),
    expected.deltaSha256, "standard migration exact byte delta drift");
  assert.equal(review.behavioralContractChange, false,
    "reciprocal-only pin migration cannot claim a behavioral contract change");
  assert.deepEqual(review.adoption, {
    passiveAndOrdinary: "active",
    containedTurn: "pending",
    sdkExternalAuthority: "pending-authority-qualification",
  }, "standard migration must preserve scoped adoption states");
  assert.equal(review.historicalReview,
    "architecture/get-modular/evidence/sdk-growth-standard-review.json",
  "standard migration must preserve the earlier A3 review as history");
  assert.match(review.historicalReviewDisposition,
    /not current upstream authority and is not used for this pin/u,
    "standard migration cannot treat uncommitted historical bytes as authority");
};
