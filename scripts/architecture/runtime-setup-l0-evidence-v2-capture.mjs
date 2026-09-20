import { v2Inputs, v2InputsAtRevision } from "./runtime-setup-l0-evidence-v2-inputs.mjs";
import {historicalSpecRevision} from "./runtime-setup-l0-evidence-historical.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { checkCommand, testCommand } from "@agent-teams/embedded-runtime/scripts/run-package-tests.mjs";
import { adoptionAuthority, adoptionConstruction, adoptionPaths, retainedHistoricalSha256 } from "./runtime-setup-l0-evidence-adoption.mjs";
import { command, targets, tools, sha256, json, requirePostgres, validateReceipt, validateCoverage, validatePlatformSites } from "./runtime-setup-l0-evidence-v2.mjs";

export const v2ReportPath = "docs/spikes/runtime-setup-assembly-adoption-v2-evidence.json";
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
function lineBody(line) {
  let end = line.length;
  if (end > 0 && line[end - 1] === 0x0a) { end--; }
  if (end > 0 && line[end - 1] === 0x0d) { end--; }
  return line.subarray(0, end);
}
// Keep this delivery checker self-contained. The workspace policy comparison only
// needs its three release-age keys; retaining the other bytes makes the equality
// check exact without requiring a parser in a clean consumer clone.
const workspacePolicy = bytes => {
  const lines = [];
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(0x0a, start), end = newline === -1 ? bytes.length : newline + 1;
    lines.push(bytes.subarray(start, end)); start = end;
  }
  assert.ok(lines.some(line => /^packages:[ \t]*/u.test(lineBody(line).toString("latin1"))),
    "pnpm-workspace policy must be a mapping");
  const fields = {}, retained = [];
  let skipBlock = false;
  for (const line of lines) {
    const content = lineBody(line), text = content.toString("latin1");
    const field = /^(minimumReleaseAge(?:Strict|Exclude)?):[ \t]*(.*?)[ \t]*$/u.exec(text);
    if (field) {
      assert.equal(Object.hasOwn(fields, field[1]), false, `duplicate workspace policy field: ${field[1]}`);
      fields[field[1]] = field[2];
      skipBlock = field[2] === "";
    } else if (skipBlock && (content.length === 0 || content[0] === 0x20 || content[0] === 0x09)) {
      continue;
    } else {
      skipBlock = false;
      retained.push(line);
    }
  }
  if (Object.hasOwn(fields, "minimumReleaseAge")) {
    assert.match(fields.minimumReleaseAge, /^\d+$/u, "minimumReleaseAge must be an unsigned integer");
    fields.minimumReleaseAge = Number(fields.minimumReleaseAge);
  }
  return {...fields, source: Buffer.concat(retained)};
};
export function validateRetainedReceiptCompatibility(root, retained, current) {
  assert.equal(retained.inputPolicy, current.inputPolicy, "receipt input policy mismatch");
  assert.deepEqual(retained.runner, current.runner, "receipt runner mismatch");
  assert.deepEqual(retained.reporter, current.reporter, "receipt reporter mismatch");
  assert.equal(retained.inputs.length, current.inputs.length, "receipt input inventory mismatch");
  let workspaceChanged = false;
  for (let index = 0; index < retained.inputs.length; index++) {
    const before = retained.inputs[index], after = current.inputs[index];
    assert.equal(before.path, after.path, "receipt input path mismatch");
    assert.equal(before.mode, after.mode, `receipt input mode mismatch: ${before.path}`);
    if (before.path === "pnpm-workspace.yaml") {
      assert.notEqual(before.sha256, after.sha256, "receipt identity mismatch: release-age compatibility requires a workspace policy change");
      workspaceChanged = true;
    } else {
      assert.equal(before.sha256, after.sha256, `receipt input digest mismatch: ${before.path}`);
    }
  }
  assert.equal(workspaceChanged, true, "receipt input inventory is missing pnpm-workspace.yaml");
  const before = workspacePolicy(revisionBytes(root, retained.sourceRevision, "pnpm-workspace.yaml"));
  const after = workspacePolicy(revisionBytes(root, current.sourceRevision, "pnpm-workspace.yaml"));
  assert.equal(after.minimumReleaseAge, 0, "current minimumReleaseAge must be 0");
  assert.equal(Object.hasOwn(after, "minimumReleaseAgeStrict"), false, "current minimumReleaseAgeStrict must be absent");
  assert.equal(Object.hasOwn(after, "minimumReleaseAgeExclude"), false, "current minimumReleaseAgeExclude must be absent");
  assert.ok(before.minimumReleaseAge !== 0 || Object.hasOwn(before, "minimumReleaseAgeStrict") ||
    Object.hasOwn(before, "minimumReleaseAgeExclude"), "receipt does not predate the release-age policy change");
  for (const name of ["minimumReleaseAge", "minimumReleaseAgeStrict", "minimumReleaseAgeExclude"]) {
    delete before[name]; delete after[name];
  }
  assert.deepEqual(before, after, "pnpm-workspace change is not limited to release-age policy");
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
  if (!isDeepStrictEqual(receipt.identity, current)) {validateRetainedReceiptCompatibility(root, retained, current);}
  return {receipt, events, sha256: sha256(bytes), receiptBase64: bytes.toString("base64"), artifacts: artifactBytes};
}
function reportBody(root, current, references) {
  const historical = JSON.parse(readFileSync(resolve(root, adoptionPaths.historical)));
  assert.equal(sha256(readFileSync(resolve(root, retainedV1.path))), retainedV1.sha256, "retained v1 bytes drifted");
  return {schemaVersion: 2, evidenceKind: "runtime-setup-static-assembly-construction",
    identity: current, authority: adoptionAuthority,
    historical: {revision: historicalSpecRevision, path: adoptionPaths.historical, sha256: retainedHistoricalSha256, sourceRevision: historical.sourceRevision},
    retainedV1,
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
    if (!isDeepStrictEqual(receipt.identity, current)) {validateRetainedReceiptCompatibility(root, retained, current);}
    return {target: ref.target, events};
  });
  validateCoverage(loaded);
  assert.deepEqual(report, reportBody(root, current, report.receipts));
}
