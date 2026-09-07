import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  adoptionAuthority, adoptionConstruction, adoptionPaths, assertAdoptionAuthority,
  buildAdoptionReport, validateAdoptionReport,
} from "./runtime-setup-l0-evidence-adoption.mjs";

const capture = {
  command: "pnpm --filter @agent-teams/embedded-runtime check", exitCode: 0,
  architecture: "arm64", platform: "darwin", nodeVersion: "v24.18.0",
  outputSha256: "a".repeat(64),
  testSummary: { tests: 3, pass: 3, fail: 0, skipped: 0, cancelled: 0 },
};
const current = {
  sourceRevision: "a".repeat(40), historicalRevision: "b".repeat(40),
  artifactDigests: { sources: { fileCount: 2, sha256: "c".repeat(64) } },
};
const authorityInput = async () => ({
  authorityBytes: await readFile(new URL(`../../${adoptionPaths.authority}`, import.meta.url)),
  historicalBytes: await readFile(new URL(`../../${adoptionPaths.historical}`, import.meta.url)),
  registry: { decisions: [{ id: adoptionAuthority.id, path: adoptionAuthority.path,
    immutableDigest: adoptionAuthority.immutableDigest }] },
  profile: { status: "active", authority: { id: adoptionAuthority.id, path: adoptionAuthority.path } },
  gate: { status: "verified-metadata", scope: "embedded-runtime passive setup" },
});

export function registerAdoptionEvidenceTests() {
test("adoption evidence keeps historical HOLD identity separate from current construction", async () => {
  assertAdoptionAuthority(await authorityInput());
  const report = buildAdoptionReport({ ...current, capture });
  validateAdoptionReport(report, current);
  assert.equal(report.authority.id, "ADR-0015");
  assert.equal(report.historical.sourceRevision, current.historicalRevision);
  assert.deepEqual(report.construction, adoptionConstruction);
  assert.ok(report.limitations.includes("historical-L1-HOLD-unchanged"));
  assert.equal(Object.hasOwn(report, "verdicts"), false);
});

for (const [name, mutate] of [
  ["pending profile", input => { input.profile.status = "pending"; }],
  ["metadata-only pending gate", input => { input.gate.status = "pending"; }],
  ["wrong scope gate", input => { input.gate.scope = "whole-runtime"; }],
  ["unaccepted ADR", input => { input.registry.decisions = []; }],
  ["different ADR registry digest", input => { input.registry.decisions[0].immutableDigest = "sha256:" + "0".repeat(64); }],
  ["accepted ADR byte drift", input => { input.authorityBytes = Buffer.from("changed"); }],
  ["historical PASS rewrite", input => { input.historicalBytes = Buffer.from(input.historicalBytes.toString().replace('"hold"', '"PASS"')); }],
]) {
  test(`adoption fails closed for ${name}`, async () => {
    const input = await authorityInput(); mutate(input);
    assert.throws(() => assertAdoptionAuthority(input));
  });
}

for (const [name, mutate] of [
  ["changed current source", report => { report.sourceRevision = "d".repeat(40); }],
  ["changed historical source", report => { report.historical.sourceRevision = "d".repeat(40); }],
  ["wrong default trace", report => { report.construction[0].path = adoptionPaths.leaf; }],
  ["changed current closure", report => { report.artifactDigests.sources.sha256 = "d".repeat(64); }],
  ["invented benchmark verdict", report => { report.verdicts = { L1: "PASS" }; }],
  ["skipped capture", report => { report.capture.testSummary.skipped = 1; }],
  ["failed capture", report => { report.capture.exitCode = 1; }],
  ["empty capture", report => { report.capture.testSummary.tests = 0; }],
]) {
  test(`current report rejects ${name}`, () => {
    const report = structuredClone(buildAdoptionReport({ ...current, capture })); mutate(report);
    assert.throws(() => validateAdoptionReport(report, current));
  });
}
}
