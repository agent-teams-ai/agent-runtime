import assert from "node:assert/strict";

const assertExactKeys = (value, keys, label) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).toSorted(), keys.toSorted(), `${label} fields drifted`);
};

const assertNonNegativeInteger = (value, label) => {
  assert.ok(Number.isInteger(value) && value >= 0, `${label} must be a non-negative integer`);
};

const validateHistoricalChangeShape = (change, index) => {
  const label = `historicalChanges[${index}]`;
  assertExactKeys(change, [
    "additions",
    "behaviorFixtures",
    "binaryFiles",
    "composition",
    "deletions",
    "files",
    "id",
    "production",
    "revision",
    "tests",
  ], label);
  for (const field of ["files", "additions", "deletions", "binaryFiles"]) {
    assertNonNegativeInteger(change[field], `${label}.${field}`);
  }
  for (const field of ["composition", "production", "tests"]) {
    assertExactKeys(change[field], ["additions", "deletions", "files"], `${label}.${field}`);
    for (const metric of ["files", "additions", "deletions"]) {
      assertNonNegativeInteger(change[field][metric], `${label}.${field}.${metric}`);
    }
  }
  assertExactKeys(
    change.behaviorFixtures,
    ["after", "before", "retained", "reusePercent"],
    `${label}.behaviorFixtures`,
  );
  for (const field of ["before", "after", "retained"]) {
    assertNonNegativeInteger(change.behaviorFixtures[field], `${label}.behaviorFixtures.${field}`);
  }
  const { reusePercent } = change.behaviorFixtures;
  assert.ok(
    reusePercent === null ||
      (typeof reusePercent === "number" && reusePercent >= 0 && reusePercent <= 100),
    `${label}.behaviorFixtures.reusePercent must be null or a percentage`,
  );
};

export class GitCommandFailure extends Error {
  constructor(error) {
    super(error.message, { cause: error });
    this.name = "GitCommandFailure";
    this.status = error.status;
    this.stderr = String(error.stderr ?? "");
  }
}

export const isHistoricalObjectClosureUnavailable = error => {
  if (!(error instanceof GitCommandFailure) || !Number.isInteger(error.status) || error.status === 0) {
    return false;
  }
  const lines = error.stderr.trim().split(/\r?\n/u);
  const [diagnostic, ...details] = lines;
  const ambiguousRevision = /^fatal: ambiguous argument .+: unknown revision or path not in the working tree\.$/iu;
  if (ambiguousRevision.test(diagnostic)) {
    return details.length === 0 ||
      (details.length === 2 &&
        details[0] === "Use '--' to separate paths from revisions, like this:" &&
        details[1] === "'git <command> [<revision>...] -- [<file>...]'");
  }
  return details.length === 0 && [
    /^fatal: bad object \S+$/iu,
    /^fatal: could not parse object \S+$/iu,
    /^fatal: missing (?:blob|tree)(?: object)? ['"]?[a-f0-9]+['"]?$/iu,
    /^fatal: not a valid object name .+$/iu,
    /^fatal: object [a-f0-9]+ not found$/iu,
    /^fatal: promised object [a-f0-9]+ unavailable$/iu,
    /^fatal: unable to read tree [a-f0-9]+$/iu,
  ].some(pattern => pattern.test(diagnostic));
};

export const parseTrackedEvidenceEntries = output => output
  .split("\0")
  .filter(Boolean)
  .map(row => {
    const separator = row.indexOf("\t");
    assert.notEqual(separator, -1, "tracked evidence entry lacks a path separator");
    const [mode, objectId, stage] = row.slice(0, separator).split(" ");
    const path = row.slice(separator + 1);
    assert.equal(stage, "0", `${path} has an unresolved Git index stage`);
    assert.match(objectId, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u, `${path} has an invalid object ID`);
    assert.ok(
      mode === "100644" || mode === "100755",
      `${path} uses unsupported Git mode ${mode}; evidence roots allow regular files only`,
    );
    return { mode, path };
  })
  .toSorted((left, right) => left.path.localeCompare(right.path));

export const validateStoredReportShape = (report, changes) => {
  assertExactKeys(report, [
    "artifactDigests",
    "authority",
    "capture",
    "evidenceKind",
    "guidanceThresholds",
    "historicalChanges",
    "limitations",
    "ownership",
    "productOutcome",
    "promotionRule",
    "prospectiveBenchmarks",
    "schemaVersion",
    "sourceRevision",
    "taxonomyAuthority",
    "traces",
    "verdicts",
  ], "evidence report");
  validateProductCapture(report.capture);
  assert.equal(report.historicalChanges.length, changes.length);
  report.historicalChanges.forEach(validateHistoricalChangeShape);
};

export const validateCurrentEvidenceIdentity = (report, {
  changes, currentArtifactDigests, sourceRevisionArtifactDigests,
}) => {
  assert.match(report.sourceRevision, /^[a-f0-9]{40}$/u);
  assert.equal(
    report.sourceRevision,
    changes.at(-1)?.revision,
    "captured source revision must be the latest retained product change",
  );
  assert.deepEqual(
    currentArtifactDigests,
    sourceRevisionArtifactDigests,
    "current product roots no longer match the pinned source revision",
  );
  assert.deepEqual(
    report.artifactDigests,
    currentArtifactDigests,
    "captured product source, tests, fixtures, or build inputs drifted",
  );
};

export const validateProductCapture = capture => {
  assertExactKeys(capture, [
    "architecture",
    "command",
    "exitCode",
    "nodeVersion",
    "outputSha256",
    "platform",
    "testSummary",
  ], "capture");
  assertExactKeys(
    capture.testSummary,
    ["cancelled", "fail", "pass", "skipped", "tests"],
    "capture.testSummary",
  );
  assert.equal(capture.command, "pnpm --filter @agent-teams/embedded-runtime check");
  assert.ok(["darwin", "linux", "win32"].includes(capture.platform));
  assert.equal(capture.exitCode, 0);
  assert.match(capture.nodeVersion, /^v24\./u);
  assert.ok(["arm64", "x64"].includes(capture.architecture));
  assert.match(capture.outputSha256, /^[a-f0-9]{64}$/u);
  for (const [key, value] of Object.entries(capture.testSummary)) {
    assertNonNegativeInteger(value, `capture.testSummary.${key}`);
  }
  assert.ok(capture.testSummary.tests > 0);
  assert.equal(capture.testSummary.pass, capture.testSummary.tests);
  for (const key of ["fail", "cancelled", "skipped"]) {
    assert.equal(capture.testSummary[key], 0);
  }
};
