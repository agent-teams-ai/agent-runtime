import { v2Inputs, v2InputsAtRevision } from "./runtime-setup-l0-evidence-v2-inputs.mjs";
import {historicalSpecRevision} from "./runtime-setup-l0-evidence-historical.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { checkCommand, testCommand } from "@agent-teams/embedded-runtime/scripts/run-package-tests.mjs";
import { adoptionAuthority, adoptionConstruction, adoptionPaths, retainedHistoricalSha256 } from "./runtime-setup-l0-evidence-adoption.mjs";
import { command, targets, tools, sha256, json, requirePostgres, validateReceipt, validateCoverage, validatePlatformSites } from "./runtime-setup-l0-evidence-v2.mjs";

// The earlier v2 deliveries stay at their original paths. This is the single
// current-report selection shared by merge and the default check command.
export const v2ReportPath = "docs/spikes/runtime-setup-assembly-adoption-v2-node26-successor-evidence.json";
export const retainedNode26 = Object.freeze({
  path: "docs/spikes/runtime-setup-assembly-adoption-v2-node26-evidence.json",
  sha256: "8ba80a3da8746f8eac5c1d0ac0e8e01e8db5e242ca2f6fead8d8f3e63a021067",
});
export const retainedV2 = Object.freeze({
  path: "docs/spikes/runtime-setup-assembly-adoption-v2-evidence.json",
  sha256: "08fef99589d67358f020e3a0b063a44d6c4c99381370f76b2ca200b005d9bf3d",
});
export const retainedV1 = Object.freeze({
  revision: "08fb1a71b75134b43af52579e8de86a44b2a3815", path: adoptionPaths.report,
  sha256: "4432ad0a6b23a8f99fa37183da5270ec312f83056d0de62d8da117d6566777ac",
});
const runner = "packages/apps/embedded-runtime/scripts/run-package-tests.mjs";
const reporter = "packages/apps/embedded-runtime/scripts/adoption-test-reporter.mjs";
const git = (root, ...args) => execFileSync("git", args, {cwd: root, encoding: "utf8",
  env: {...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0"}}).trimEnd();
const revisionBytes = (root, revision, path) => execFileSync("git", ["show", `${revision}:${path}`], {cwd: root,
  env: {...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0"}});
export function identity(root, sourceRevision = git(root, "rev-parse", "HEAD")) {
  assert.match(sourceRevision, /^[a-f0-9]{40}$/u);
  const {inputPolicy, inputs} = v2Inputs(root, sourceRevision);
  const manifest = JSON.parse(readFileSync(resolve(root, "packages/apps/embedded-runtime/package.json")));
  assert.equal(manifest.scripts.check, checkCommand, "altered check chain");
  assert.equal(manifest.scripts.test, testCommand, "altered test command");
  validatePlatformSites(root);
  return {sourceRevision, inputPolicy, inputs, runner: {path: runner, sha256: sha256(readFileSync(resolve(root, runner)))},
    reporter: {path: reporter, sha256: sha256(readFileSync(resolve(root, reporter)))}};
}
function identityAtRevision(root, sourceRevision) {
  const {inputPolicy, inputs} = v2InputsAtRevision(root, sourceRevision);
  return {sourceRevision, inputPolicy, inputs,
    runner: {path: runner, sha256: sha256(revisionBytes(root, sourceRevision, runner))},
    reporter: {path: reporter, sha256: sha256(revisionBytes(root, sourceRevision, reporter))}};
}
function observedTools(root) {
  const observed = {node: process.version, pnpm: execFileSync("pnpm", ["--version"], {cwd: root, encoding: "utf8"}).trim()};
  assert.deepEqual(observed, tools, "exact capture tool versions required");
  assert.ok(!process.env.NODE_OPTIONS && !process.env.NODE_TEST_CONTEXT, "injected Node options/test context forbidden");
  return observed;
}
export function captureReceipt(root, output, runId) {
  const postgres = requirePostgres(process.env, `${process.platform}-${process.arch}`);
  assert.ok(runId?.trim(), "--run-id is required for execution provenance");
  const target = `${process.platform}-${process.arch}`; assert.ok(targets.includes(target));
  const observed = observedTools(root), before = identity(root);
  output = resolve(output);
  const artifactRoot = `${output}.artifacts`;
  mkdirSync(artifactRoot); // Refuse reuse or overwrite of retained execution artifacts.
  const start = new Date().toISOString();
  const result = spawnSync("pnpm", ["--filter", "@agent-teams/embedded-runtime", "check"], {
    cwd: root, env: {...process.env, AE_ADOPTION_CAPTURE_DIR: artifactRoot},
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  });
  const end = new Date().toISOString();
  for (const stream of ["stdout", "stderr"]) {writeFileSync(resolve(artifactRoot, `check.${stream}`), result[stream] ?? "");}
  const artifacts = Object.fromEntries(readdirSync(artifactRoot).toSorted().map(name => [name, sha256(readFileSync(resolve(artifactRoot, name)))]));
  const receipt = {schemaVersion: 2, evidenceKind: "runtime-setup-adoption-platform-receipt",
    identity: before, target, platform: process.platform, architecture: process.arch,
    cwd: root, nodeExecutable: process.execPath, tools: observed, postgres, command, runId, start, end,
    exitCode: result.status, signal: result.signal, artifactDirectory: relative(dirname(output), artifactRoot), artifacts};
  // Retain even a rejected run for diagnosis; the merger never accepts failures.
  writeFileSync(output, json(receipt), {flag: "wx"});
  assert.deepEqual(identity(root), before, "source changed during capture");
  assert.deepEqual(observedTools(root), observed, "tools changed during capture");
  validateReceipt(receipt, before, name => readFileSync(resolve(artifactRoot, name)));
  return receipt;
}
function loadReceipt(root, path, current) {
  const bytes = readFileSync(path), receipt = JSON.parse(bytes);
  const artifacts = resolve(dirname(path), receipt.artifactDirectory);
  const artifactBytes = {};
  const retained = identityAtRevision(root, receipt.identity.sourceRevision);
  const events = validateReceipt(receipt, retained, name => {
    const value = readFileSync(resolve(artifacts, name));
    artifactBytes[name] = value.toString("base64");
    return value;
  });
  assert.deepEqual(receipt.identity, current, "successor receipts must bind the exact SOURCE revision and inputs");
  return {receipt, events, sha256: sha256(bytes), receiptBase64: bytes.toString("base64"), artifacts: artifactBytes};
}
function reportBody(root, current, references) {
  assert.equal(git(root, "ls-tree", "-z", "--name-only", current.sourceRevision, "--", v2ReportPath), "",
    "successor report must be delivered after the SOURCE revision");
  const historical = JSON.parse(readFileSync(resolve(root, adoptionPaths.historical)));
  assert.equal(sha256(readFileSync(resolve(root, retainedV1.path))), retainedV1.sha256, "retained v1 bytes drifted");
  assert.equal(sha256(readFileSync(resolve(root, retainedV2.path))), retainedV2.sha256, "retained original v2 bytes drifted");
  assert.equal(sha256(readFileSync(resolve(root, retainedNode26.path))), retainedNode26.sha256, "retained Node26 v2 bytes drifted");
  return {schemaVersion: 2, evidenceKind: "runtime-setup-static-assembly-construction",
    identity: current, authority: adoptionAuthority,
    historical: {revision: historicalSpecRevision, path: adoptionPaths.historical, sha256: retainedHistoricalSha256, sourceRevision: historical.sourceRevision},
    retainedV1, retainedV2, retainedNode26,
    construction: adoptionConstruction, requiredTargets: targets, receipts: references,
    scope: "embedded-runtime passive setup",
    limitations: ["hashes-authenticate-bytes-not-independent-execution", "historical-L1-HOLD-unchanged",
      "benefit-not-established-by-construction-evidence", "contained-turn-not-adopted",
      "no-provider-qualification", "no-repository-wide-conformance"]};
}
export function mergeReceipts(root, paths, output) {
  assert.equal(paths.length, 2, "exactly two receipts required");
  const current = identity(root);
  const loaded = paths.map(path => loadReceipt(root, resolve(path), current));
  validateCoverage(loaded.map(({receipt, events}) => ({target: receipt.target, events})));
  const refs = loaded.map(({receipt, sha256: receiptSha256, receiptBase64, artifacts}, i) => ({target: receipt.target,
    path: relative(dirname(resolve(output)), resolve(paths[i])), sha256: receiptSha256, receiptBase64, artifacts})).toSorted((a, b) => a.target.localeCompare(b.target));
  const report = reportBody(root, current, refs);
  writeFileSync(output, json(report), {flag: "wx"});
  return report;
}
function decodeBytes(encoded) {
  assert.equal(typeof encoded, "string", "missing base64 bytes");
  const bytes = Buffer.from(encoded, "base64");
  assert.equal(bytes.toString("base64"), encoded, "noncanonical base64 bytes");
  return bytes;
}
export function checkV2(root, path) {
  const report = JSON.parse(readFileSync(path));
  const current = identity(root, report.identity.sourceRevision);
  assert.equal(report.receipts.length, 2);
  const loaded = report.receipts.map(ref => {
    // Paths retain execution provenance only. Checking never opens receipt paths.
    const bytes = decodeBytes(ref.receiptBase64);
    assert.equal(sha256(bytes), ref.sha256, "receipt hash mismatch");
    const receipt = JSON.parse(bytes);
    assert.equal(receipt.target, ref.target);
    assert.deepEqual(Object.keys(ref.artifacts).toSorted(), Object.keys(receipt.artifacts).toSorted(), "bundled artifact inventory mismatch");
    const retained = identityAtRevision(root, receipt.identity.sourceRevision);
    const events = validateReceipt(receipt, retained, name => {
      assert.ok(Object.hasOwn(ref.artifacts, name), `missing bundled artifact: ${name}`);
      return decodeBytes(ref.artifacts[name]);
    });
    assert.deepEqual(receipt.identity, current, "successor receipts must bind the exact SOURCE revision and inputs");
    return {target: ref.target, events};
  });
  validateCoverage(loaded);
  assert.deepEqual(report, reportBody(root, current, report.receipts));
}
export function checkCurrentV2(root) {
  return checkV2(root, resolve(root, v2ReportPath));
}
