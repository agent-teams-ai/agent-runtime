import { registerAdoptionEvidenceTests } from "./runtime-setup-l0-evidence-adoption.test.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { createEvidenceInputs } from "./runtime-setup-l0-evidence-inputs.mjs";
import test from "node:test";

import {
  GitCommandFailure,
  isHistoricalObjectClosureUnavailable,
  parseTrackedEvidenceEntries,
  validateStoredReportShape,
} from "./runtime-setup-l0-evidence-validation.mjs";

registerAdoptionEvidenceTests();

test("legacy retained provenance rejects replacement commit, tree and blob bytes", async t => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "legacy-provenance-"));
  t.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
  const replacementEnvironment = { ...process.env };
  delete replacementEnvironment.GIT_NO_REPLACE_OBJECTS;
  const runGit = (...args) => execFileSync("git", args, {
    cwd: repositoryRoot, encoding: "utf8", env: replacementEnvironment,
  }).trim();
  runGit("init", "--quiet");
  runGit("config", "core.hooksPath", "/dev/null");
  runGit("config", "user.name", "Fixture");
  runGit("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repositoryRoot, "evidence"), "original\n");
  runGit("add", "."); runGit("commit", "--quiet", "-m", "original");
  const original = runGit("rev-parse", "HEAD");
  writeFileSync(join(repositoryRoot, "evidence"), "substituted\n");
  runGit("add", "."); runGit("commit", "--quiet", "-m", "substitute");
  const replacement = runGit("rev-parse", "HEAD");
  // Exercise the actual legacy Git helpers without executing the CLI's architecture gates.
  const source = readFileSync(new URL("./runtime-setup-l0-evidence.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const provenanceGitEnvironment ="), end = source.indexOf("const pathExists =");
  assert.ok(start >= 0 && end > start, "legacy helper boundaries unavailable");
  const helpers = source.slice(start, end);
  const { git, readRevisionFile } = runInNewContext(`${helpers}; ({ git, readRevisionFile });`, {
    process, execFileSync, repositoryRoot, GitCommandFailure,
  });
  const inputs = createEvidenceInputs({ repositoryRoot, git, readRevisionFile,
    roots: { fixtures: [], sources: [], tests: [] },
    files: { fixtures: ["evidence"], sources: ["evidence"], tests: ["evidence"] },
  });
  const expected = await inputs.artifactDigestsAtRevision(original);
  const substituted = await inputs.artifactDigestsAtRevision(replacement);
  assert.notDeepEqual(expected, substituted);
  for (const suffix of ["", "^{tree}", ":evidence"]) {
    await t.test(`replacement of ${suffix || "commit"}`, async () => {
      const object = runGit("rev-parse", `${original}${suffix}`);
      const substitute = runGit("rev-parse", `${replacement}${suffix}`);
      runGit("replace", object, substitute);
      try {
        assert.equal(runGit("show", `${original}:evidence`), "substituted");
        assert.equal(readRevisionFile(original, "evidence").toString(), "original\n");
        assert.equal(git("show", `${original}:evidence`), "original\n");
        assert.deepEqual(await inputs.artifactDigestsAtRevision(original), expected);
        assert.notDeepEqual(await inputs.artifactDigestsAtRevision(original), substituted);
      } finally { runGit("replace", "-d", object); }
    });
  }
});

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
  assert.equal(isHistoricalObjectClosureUnavailable(new GitCommandFailure({
    message: "git failed",
    status: 128,
    stderr: "fatal: promised object deadbeef unavailable",
  })), true);
  assert.equal(isHistoricalObjectClosureUnavailable(new GitCommandFailure({
    message: "git failed",
    status: 128,
    stderr: "fatal: ambiguous argument 'deadbeef^': unknown revision or path not in the working tree.\n" +
      "Use '--' to separate paths from revisions, like this:\n" +
      "'git <command> [<revision>...] -- [<file>...]'\n",
  })), true);
  assert.equal(isHistoricalObjectClosureUnavailable(new Error("bad object")), false);
  assert.equal(isHistoricalObjectClosureUnavailable({
    status: 128,
    stderr: "fatal: bad object deadbeef",
  }), false);
  assert.equal(isHistoricalObjectClosureUnavailable(new GitCommandFailure({
    message: "git returned success",
    status: 0,
    stderr: "fatal: bad object deadbeef",
  })), false);
  assert.equal(isHistoricalObjectClosureUnavailable(new GitCommandFailure({
    message: "git failed",
    status: 128,
    stderr: "fatal: permission denied",
  })), false);
  assert.equal(isHistoricalObjectClosureUnavailable(new GitCommandFailure({
    message: "corrupt repository",
    status: 128,
    stderr: "error: object deadbeef is corrupt\nfatal: unable to read tree deadbeef",
  })), false);
  assert.equal(isHistoricalObjectClosureUnavailable(new GitCommandFailure({
    message: "permission failure",
    status: 128,
    stderr: "fatal: unable to read tree deadbeef\nfatal: permission denied",
  })), false);
});

test("retains executable modes and rejects non-regular evidence entries", () => {
  assert.deepEqual(
    parseTrackedEvidenceEntries(
      `100755 ${"a".repeat(40)} 0\tbin/tool\0` +
      `100644 ${"b".repeat(40)} 0\tsrc/index.ts\0`,
    ),
    [
      { mode: "100755", path: "bin/tool" },
      { mode: "100644", path: "src/index.ts" },
    ],
  );
  assert.throws(
    () => parseTrackedEvidenceEntries(`120000 ${"c".repeat(40)} 0\tsrc/link.ts\0`),
    /evidence roots allow regular files only/u,
  );
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

// Keep paired-platform rejecting fixtures on the existing architecture gate.
await import("./runtime-setup-l0-evidence-v2.test.mjs");
