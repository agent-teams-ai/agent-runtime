import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const historicalReviewPath = "architecture/get-modular/evidence/a3-cms-pin-review.json";
export const historicalDeltaPath = "architecture/get-modular/evidence/a3-cms-pin-delta.diff";
export const standardReviewPath = "architecture/get-modular/evidence/runtime-profile-cms-pin-review.json";
export const historicalDynamicReviewPath = "architecture/get-modular/evidence/dynamic-host-cms-pin-review.json";
export const standardDeltaPath = "architecture/get-modular/evidence/dynamic-host-cms-pin-delta.diff";

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

export const validateHistoricalA3Migration = (review, deltaBytes) => {
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
  assert.equal(review.delta?.path, historicalDeltaPath,
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

export const validateStandardMigration = (review, deltaBytes) => {
  assert.deepEqual({
    schemaVersion: review.schemaVersion,
    reviewedOn: review.reviewedOn,
    repository: review.repository,
    path: review.path,
    anchor: review.anchor,
  }, {
    schemaVersion: 1,
    reviewedOn: "2026-09-29",
    repository: "agent-teams-ai/get-modular",
    path: "docs/architecture/common-assembly.md",
    anchor: "consumer-module-standard",
  }, "dynamic Host migration review identity drift");
  assert.equal(review.consumerSourceCommit,
    "be0a811288da4261d26063790c9f7924991523fe",
    "dynamic Host migration source identity drift");
  assert.deepEqual(review.before, expected.after,
    "dynamic Host migration must start at the reviewed A3 pin");
  assert.deepEqual(review.after, {
    commit: "24d6557a1b04b01a3a73c64b1d9a9afd83d89c8f",
    sha256: "33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd",
    byteLength: 24312,
    evidencePath: "architecture/get-modular/evidence/consumer-module-standard.md",
  }, "dynamic Host migration must retain the exact current pin");
  assert.deepEqual(review.upstreamDecision, {
    id: "ADR-0029",
    path: "docs/decisions/0029-admit-an-optional-lifecycle-kernel-candidate.md",
    sha256: "9247eb2c2eb70cbbc215426446101314b1085d1d03fee02b6dc0467a737eac00",
    status: "accepted",
  }, "dynamic Host migration must identify its accepted upstream authority");
  assert.deepEqual(review.delta, {
    path: standardDeltaPath,
    sha256: "68ae0186812b6f6d8615bd064f0b523537ba07b0f547336e28ca34b78a7eac8b",
    hunks: 2,
    removedLines: 0,
    addedLines: 32,
    summary: "Adds ADR-0029 to related decisions and 31 lines for an optional dynamic Host lifecycle candidate.",
  }, "dynamic Host migration delta summary drift");
  assert.equal(createHash("sha256").update(deltaBytes).digest("hex"),
    review.delta.sha256, "dynamic Host migration exact byte delta drift");
  assert.deepEqual(review.scopeDisposition, {
    passiveAndOrdinary: "active-unchanged",
    containedTurn: "pending-unchanged",
    dynamicAgentRuntime: "not-certified",
    packageUpgrade: "none",
    sdkExternalAuthority: "pending-authority-qualification",
  }, "dynamic Host migration cannot promote unsupported scope");
  assert.equal(review.historicalReview, historicalReviewPath,
    "dynamic Host migration must preserve the historical A3 review");
};

export const validateCurrentStandardMigration = review => {
  assert.deepEqual(review, {
    schemaVersion: 1,
    reviewedOn: "2026-09-30",
    repository: "agent-teams-ai/get-modular",
    path: "docs/architecture/common-assembly.md",
    anchor: "consumer-module-standard",
    before: {
      commit: "24d6557a1b04b01a3a73c64b1d9a9afd83d89c8f",
      sha256: "33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd",
      byteLength: 24312,
      evidencePath: "architecture/get-modular/evidence/consumer-module-standard.md",
    },
    after: {
      commit: "9c722ceff4ede307d06d7a4b63fdebe615f54c53",
      sha256: "33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd",
      byteLength: 24312,
      evidencePath: "architecture/get-modular/evidence/consumer-module-standard.md",
    },
    delta: { documentBytesChanged: false, hunks: 0, removedLines: 0, addedLines: 0 },
    scopeDisposition: {
      passiveAndOrdinary: "active-unchanged",
      containedTurn: "pending-unchanged",
      dynamicAgentRuntime: "not-certified",
      sdkExternalAuthority: "pending-authority-qualification",
    },
    review: "The canonical full document is byte-identical at both exact commits. No Consumer Module Standard semantic or behavioral delta is admitted. The release pin migration changes package artifacts and tooling pins without expanding composition scope.",
    historicalReview: historicalDynamicReviewPath,
  }, "current standard pin review drift");
};

export const creationCleanupReviewPath = "architecture/get-modular/evidence/creation-cleanup-cms-pin-review.json";
export const creationCleanupDeltaPath = "architecture/get-modular/evidence/creation-cleanup-cms-pin-delta.diff";

const cleanupExpected = Object.freeze({
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

export const validateCreationCleanupMigration = (review, deltaBytes) => {
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
  assert.deepEqual(review.before, cleanupExpected.before,
    "standard migration review must retain the exact prior pin");
  assert.deepEqual(review.after, cleanupExpected.after,
    "standard migration review must retain the exact current pin");
  assert.equal(review.sourceMainCommit, cleanupExpected.sourceMainCommit,
    "standard migration review source main commit drift");
  assert.equal(review.sourceMainDocumentCommit, cleanupExpected.sourceMainDocumentCommit,
    "standard migration review source document commit drift");
  assert.equal(review.sourceMainSha256, cleanupExpected.after.sha256,
    "standard migration review source main bytes drift");
  assert.equal(review.delta?.path, creationCleanupDeltaPath,
    "standard migration review delta path drift");
  assert.equal(review.delta?.sha256, cleanupExpected.deltaSha256,
    "standard migration review delta digest drift");
  assert.deepEqual({
    hunks: review.delta?.hunks,
    removedLines: review.delta?.removedLines,
    addedLines: review.delta?.addedLines,
  }, { hunks: 2, removedLines: 0, addedLines: 32 },
  "standard migration exact delta summary drift");
  assert.equal(createHash("sha256").update(deltaBytes).digest("hex"),
    cleanupExpected.deltaSha256, "standard migration exact byte delta drift");
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

// Both reviewed branches converge on the same complete document and pin.
// Do not relabel a retained review or treat the cleanup review as A3 evidence.
export const validateParallelStandardMigrations = (historical, dynamic, current, cleanup, cleanupDeltaBytes) => {
  validateCreationCleanupMigration(cleanup, cleanupDeltaBytes);
  assert.equal(cleanup.before.commit, historical.after.commit, "cleanup CMS predecessor commit drift");
  assert.equal(cleanup.before.sha256, historical.after.sha256, "cleanup CMS predecessor bytes drift");
  assert.equal(dynamic.before.commit, historical.after.commit, "dynamic CMS predecessor commit drift");
  assert.equal(dynamic.before.sha256, historical.after.sha256, "dynamic CMS predecessor bytes drift");
  assert.deepEqual(current.before, dynamic.after, "current CMS predecessor drift");
  assert.deepEqual(cleanup.after, current.after, "parallel CMS review heads must agree");
};
