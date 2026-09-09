import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { testProcesses, packagePath, checkStages, reporterArg } from "../../packages/apps/embedded-runtime/scripts/run-package-tests.mjs";
import { targets, tools, command, sha256, json, validateStream, validateReceipt, validateCoverage, requirePostgres, validatePlatformSites } from "./runtime-setup-l0-evidence-v2.mjs";

import {platformSites} from "./runtime-setup-l0-evidence-platform-sites.mjs";
import {identity, mergeReceipts, checkV2, v2ReportPath} from "./runtime-setup-l0-evidence-v2-capture.mjs";

const counts = events => ({tests: events.length, failed: 0, passed: events.filter(e => e.status === "passed").length,
  cancelled: 0, skipped: events.filter(e => e.status === "skipped").length, todo: 0,
  topLevel: events.filter(e => !e.ancestry.length).length, suites: 0});
function event(file, line = 1, title = "portable", status = "passed", ancestry = []) {
  return {kind: "test", suite: file, file, line, column: 1, title, ancestry, ordinal: 1,
    segment: [file, line, 1, title, 1], status, skip: status === "skipped" ? true : null, skipReason: status === "skipped" ? "registration skip option evaluated true" : null, type: "test"};
}
function stream(files) {
  const events = files.map(file => event(file));
  return [{kind: "begin", version: 1}, ...events.flatMap(e => [e,
    {kind: "file", suite: e.suite, counts: counts([e]), success: true}]),
  {kind: "summary", counts: counts(events), success: true}, {kind: "end"}].map(e => JSON.stringify(e)).join("\n") + "\n";
}
function fixture() {
  const identity = {sourceRevision: "a".repeat(40), inputs: [{path: "source", sha256: "b".repeat(64)}]};
  const artifacts = {"check.stdout": "", "check.stderr": ""};
  const stamp = {start: "2026-09-09T00:00:00.000Z", end: "2026-09-09T00:00:00.000Z", exitCode: 0, signal: null};
  const records = (items, kind) => items.map((argv, index) => {
    const stdout = `${kind}-${index}.stdout`, stderr = `${kind}-${index}.stderr`;
    artifacts[stdout] = kind === "process" ? stream(testProcesses[index].filter(a => !a.startsWith("--")).map(f => `${packagePath}/${f}`)) : "";
    artifacts[stderr] = "";
    return {...stamp, index, cwd: packagePath, executable: kind === "process" ? "node" : "pnpm", argv, stdout, stderr};
  });
  artifacts["stages.json"] = json(records(checkStages.map(s => ["run", s]), "stage"));
  artifacts["processes.json"] = json(records(testProcesses.map(a => [reporterArg, ...a]), "process"));
  const receipt = {...stamp, schemaVersion: 2, evidenceKind: "runtime-setup-adoption-platform-receipt", target: "linux-x64",
    platform: "linux", architecture: "x64", cwd: "/synthetic", nodeExecutable: process.execPath,
    tools, identity, postgres: {required: true, configured: true}, command, runId: "synthetic-rejecting-fixture", artifacts: {}};
  const reseal = () => {receipt.artifacts = Object.fromEntries(Object.entries(artifacts).map(([k, v]) => [k, sha256(v)]));};
  const validate = () => {reseal(); return validateReceipt(receipt, identity, name => Buffer.from(artifacts[name]));};
  return {identity, artifacts, receipt, validate};
}
test("both original explicit argv lists are preserved exactly", () => {
  const original = JSON.parse(execFileSync("git", ["show", "08fb1a71b75134b43af52579e8de86a44b2a3815:packages/apps/embedded-runtime/package.json"], {encoding: "utf8"}));
  assert.deepEqual(testProcesses, original.scripts.test.split(" && ").map(s => s.split(" ").slice(1)));
});
test("complete receipts require both entire manifest processes", () => {
  const f = fixture(); assert.equal(f.validate().length, 57);
});
for (const [name, mutate] of [
  ["missing first process", f => {f.artifacts["processes.json"] = json(JSON.parse(f.artifacts["processes.json"]).slice(1));}],
  ["hidden failure in first process despite second success", f => {const p = JSON.parse(f.artifacts["processes.json"]); p[0].exitCode = 1; f.artifacts["processes.json"] = json(p);}],
  ["hidden failure event in first process", f => {f.artifacts["process-0.stdout"] = f.artifacts["process-0.stdout"].replace('"status":"passed"', '"status":"failed"');}],
  ["incomplete event stream", f => {f.artifacts["process-0.stdout"] = f.artifacts["process-0.stdout"].replace('{"kind":"end"}\n', '');}],
  ["missing manifest input", f => {f.artifacts["process-0.stdout"] = stream([`${packagePath}/tests/assembly-reference.test.ts`]);}],
  ["source mismatch", f => {f.receipt.identity = {...f.identity, sourceRevision: "c".repeat(40)};}],
  ["input mismatch", f => {f.receipt.identity = {...f.identity, inputs: []};}],
  ["tool mismatch", f => {f.receipt.tools = {...tools, pnpm: "11.0.0"};}],
  ["missing PostgreSQL", f => {delete f.receipt.postgres;}],
  ["missing clean stage", f => {f.artifacts["stages.json"] = json(JSON.parse(f.artifacts["stages.json"]).slice(1));}],
  ["test-name filter", f => {const p = JSON.parse(f.artifacts["processes.json"]); p[0].argv.push("--test-name-pattern=passive"); f.artifacts["processes.json"] = json(p);}],
  ["cancelled test", f => {f.artifacts["process-0.stdout"] = f.artifacts["process-0.stdout"].replace('"status":"passed"', '"status":"cancelled"');}],
  ["TODO test", f => {f.artifacts["process-0.stdout"] = f.artifacts["process-0.stdout"].replace('"status":"passed"', '"status":"todo"');}],
]) test(`rejects ${name}`, () => {const f = fixture(); mutate(f); assert.throws(f.validate);});
const file = `${packagePath}/tests/codex-setup.e2e.test.ts`;
function pair() {
  const pass = event(file, 44, "platform");
  return [{target: "darwin-arm64", events: [pass]}, {target: "linux-x64", events: [{...pass, status: "skipped", skip: true}]}];
}
test("explicit platform parent accounts for its passing peer's complete subtree", () => {
  const p = pair(); p[0].events.push(event(file, 60, "child", "passed", [p[0].events[0].segment]));
  validateCoverage(p);
});
for (const [name, mutate] of [
  ["missing target", p => p.pop()],
  ["duplicate target", p => {p[1].target = p[0].target;}],
  ["same test skipped both", p => {p[0].events[0].status = "skipped";}],
  ["unknown skip", p => {p[1].events[0].line = 99;}],
  ["unknown skip reason", p => {p[1].events[0].skip = "no database";}],
  ["unexplained inventory difference", p => {p[0].events.push(event(file, 99, "missing"));}],
  ["portable skip", p => {for (const r of p) r.events[0].line = 99;}],
  ["failed child under approved parent", p => {p[0].events.push(event(file, 60, "child", "failed", [p[0].events[0].segment]));}],
]) test(`coverage rejects ${name}`, () => {const p = pair(); mutate(p); assert.throws(() => validateCoverage(p));});
test("PostgreSQL is required, disposable, loopback and never recorded as a URL", () => {
  assert.throws(() => requirePostgres({}), /PostgreSQL/);
  assert.deepEqual(requirePostgres({}, "darwin-arm64"), {required: false, configured: false});
  for (const url of ["postgres://localhost/ar69_pa_test_x", "postgres://127.0.0.1/ar69_pa_test_x?host=remote", "postgres://127.0.0.1/ar69_pa_test_x#override", "postgres://127.0.0.1/production"]) {
    assert.throws(() => requirePostgres({AE_ACL_POSTGRES_DISPOSABLE_URL: url}));
  }
  assert.throws(() => requirePostgres({AE_ACL_POSTGRES_DISPOSABLE_URL: "postgres://remote/ar69_pa_test_x"}));
  assert.deepEqual(requirePostgres({AE_ACL_POSTGRES_DISPOSABLE_URL: "postgres://127.0.0.1/ar69_pa_test_x"}), {required: true, configured: true});
});
test("reviewed platform predicates still refer to exact registration sites", () => validatePlatformSites(process.cwd()));
test("real Node reporter preserves nested ancestry, duplicate-title disambiguators, skips and failures", t => {
  const dir = mkdtempSync(resolve(tmpdir(), "adoption-v2-reporter-")); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const input = resolve(dir, "input.mjs");
  writeFileSync(input, `import {test} from 'node:test';\n test('parent', async t => {for(let i=0;i<2;i++) await t.test('child',()=>{});});\n test('skip',{skip:true},()=>{});\n test('failure',()=>{throw Error('synthetic');});`);
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", `--test-reporter=${resolve(packagePath, "scripts/adoption-test-reporter.mjs")}`, input], {encoding: "utf8", env});
  assert.equal(result.status, 1);
  const rows = result.stdout.trim().split("\n").map(s => JSON.parse(s));
  assert.equal(rows.at(-1).kind, "end");
  const children = rows.filter(r => r.title === "child");
  assert.equal(children.length, 2); assert.equal(children[0].ancestry[0][3], "parent");
  assert.deepEqual(children.map(c => c.ordinal), [1, 2]);
  assert.ok(rows.some(r => r.kind === "failure")); assert.ok(rows.some(r => r.status === "skipped"));
});

test("the actual launcher records all four stages and both full test processes in a disposable synthetic package", t => {
  const root = mkdtempSync(resolve(tmpdir(), "adoption-v2-launcher-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const pkg = resolve(root, packagePath), bin = resolve(root, "bin"), artifacts = resolve(root, "artifacts");
  const {mkdirSync, chmodSync, copyFileSync} = fs;
  for (const dir of [resolve(pkg, "scripts"), bin, artifacts]) mkdirSync(dir, {recursive: true});
  for (const name of ["run-package-tests.mjs", "adoption-test-reporter.mjs"]) {
    copyFileSync(resolve(packagePath, "scripts", name), resolve(pkg, "scripts", name));
  }
  for (const file of testProcesses.flat().filter(a => !a.startsWith("--"))) {
    const path = resolve(pkg, file); mkdirSync(resolve(path, ".."), {recursive: true});
    writeFileSync(path, "import {test} from 'node:test';\ntest('synthetic portable assertion', () => {});\n");
  }
  const pnpm = resolve(bin, "pnpm");
  writeFileSync(pnpm, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nif(process.argv[3] === 'test') {const r=spawnSync(process.execPath,['scripts/run-package-tests.mjs'],{stdio:'inherit'});process.exitCode=r.status ?? 1;}\n`);
  chmodSync(pnpm, 0o755);
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, AE_ADOPTION_CAPTURE_DIR: artifacts};
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["scripts/run-package-tests.mjs", "--check"], {cwd: pkg, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(resolve(artifacts, "stages.json"))).length, 4);
  const processes = JSON.parse(readFileSync(resolve(artifacts, "processes.json")));
  assert.equal(processes.length, 2);
  for (const [i, record] of processes.entries()) {
    assert.equal(record.exitCode, 0);
    const files = testProcesses[i].filter(a => !a.startsWith("--")).map(f => `${packagePath}/${f}`);
    assert.equal(validateStream(readFileSync(resolve(artifacts, record.stdout), "utf8"), files).length, files.length);
  }
});

test("self-contained report-only delivery validates in a clean clone after deleting original captures", async t => {
  const root = mkdtempSync(resolve(tmpdir(), "adoption-v2-delivery-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const producer = resolve(root, "producer"), captures = resolve(root, "captures"), consumer = resolve(root, "consumer");
  const git = (cwd, ...argv) => execFileSync("git", argv, {cwd, encoding: "utf8", stdio: "pipe"}).trim();
  const commit = cwd => git(cwd, "-c", "user.name=Capture fixture", "-c", "user.email=capture-fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "synthetic delivery fixture");
  git(root, "clone", "--quiet", "--no-local", process.cwd(), producer);
  // Exercise this implementation even when the caller's changes are uncommitted.
  for (const path of ["scripts/architecture/runtime-setup-l0-evidence-v2-capture.mjs",
    "scripts/architecture/runtime-setup-l0-evidence-v2.test.mjs", "docs/architecture/get-modular-adoption.md"]) {
    fs.copyFileSync(resolve(path), resolve(producer, path));
  }
  rmSync(resolve(producer, v2ReportPath), {force: true});
  git(producer, "add", ".");
  if (git(producer, "diff", "--cached", "--name-only")) commit(producer);
  const current = identity(producer);
  fs.mkdirSync(captures);
  const originals = new Map();
  const pathsToMerge = targets.map(target => {
    const f = fixture(); f.receipt.target = target; [f.receipt.platform, f.receipt.architecture] = target.split("-"); f.receipt.identity = current;
    f.receipt.postgres = {required: target === "linux-x64", configured: target === "linux-x64"};
    f.receipt.artifactDirectory = `${target}.artifacts`;
    // Non-UTF8 output proves byte preservation beyond JSON text round trips.
    f.artifacts["check.stderr"] = Buffer.from([0, 255, 128, 13, 10]);
    fs.mkdirSync(resolve(captures, f.receipt.artifactDirectory));
    for (const [name, bytes] of Object.entries(f.artifacts)) {
      writeFileSync(resolve(captures, f.receipt.artifactDirectory, name), bytes);
      f.receipt.artifacts[name] = sha256(bytes);
    }
    const bytes = Buffer.from(json(f.receipt) + " \n");
    originals.set(target, {bytes, artifacts: f.artifacts});
    const path = resolve(captures, `${target}.json`); writeFileSync(path, bytes); return path;
  });
  const output = resolve(producer, v2ReportPath);
  const report = mergeReceipts(producer, pathsToMerge, output);
  checkV2(producer, output);
  for (const ref of report.receipts) {
    const original = originals.get(ref.target);
    assert.deepEqual(Buffer.from(ref.receiptBase64, "base64"), original.bytes);
    assert.equal(ref.sha256, sha256(original.bytes));
    for (const [name, bytes] of Object.entries(original.artifacts)) {
      assert.deepEqual(Buffer.from(ref.artifacts[name], "base64"), Buffer.from(bytes));
    }
  }
  git(producer, "add", v2ReportPath); commit(producer);
  const delivery = git(producer, "rev-parse", "HEAD");
  assert.equal(git(producer, "diff", "--name-only", current.sourceRevision, delivery), v2ReportPath);
  // Historical experiment commits can be unreachable from source HEAD. Retain
  // explicit refs so an ordinary clone carries their objects without alternates.
  const {loadHistoricalSpec, historicalSpecRevision} = await import("./runtime-setup-l0-evidence-historical.mjs");
  const historical = await loadHistoricalSpec((revision, path) => execFileSync("git", ["show", `${revision}:${path}`]));
  const revisions = new Set([historicalSpecRevision, ...historical.changes.map(c => c.revision)]);
  git(producer, "fetch", "--quiet", process.cwd(), ...[...revisions].map(revision => `${revision}:refs/heads/fixture-history-${revision}`));
  git(root, "clone", "--quiet", "--no-local", producer, consumer);
  rmSync(captures, {recursive: true}); rmSync(producer, {recursive: true});
  assert.equal(fs.existsSync(captures), false);
  assert.equal(git(consumer, "status", "--porcelain"), "");
  assert.deepEqual(identity(consumer, current.sourceRevision), current);
  await loadHistoricalSpec((revision, path) => execFileSync("git", ["show", `${revision}:${path}`], {cwd: consumer}));
  for (const {revision} of historical.changes) git(consumer, "cat-file", "-e", `${revision}^{commit}`);
  const delivered = resolve(consumer, v2ReportPath);
  const {checkV2: deliveredCheck} = await import(resolve(consumer, "scripts/architecture/runtime-setup-l0-evidence-v2-capture.mjs"));
  deliveredCheck(consumer, delivered);
  const flip = encoded => {const bytes = Buffer.from(encoded, "base64"); bytes[0] ^= 1; return bytes.toString("base64");};
  for (const [name, mutate, reason] of [
    ["missing receipt", r => {r.receipts.pop();}, /Assertion/],
    ["missing receipt bytes", r => {delete r.receipts[0].receiptBase64;}, /missing base64/],
    ["mutated receipt", r => {r.receipts[0].receiptBase64 = flip(r.receipts[0].receiptBase64);}, /receipt hash mismatch/],
    ["missing artifact", r => {delete r.receipts[0].artifacts["process-0.stdout"];}, /inventory mismatch/],
    ["mutated artifact", r => {r.receipts[0].artifacts["process-0.stdout"] = flip(r.receipts[0].artifacts["process-0.stdout"]);}, /artifact hash mismatch/],
    ["extra artifact", r => {r.receipts[0].artifacts["extra.stdout"] = "";}, /inventory mismatch/],
    ["invalid encoding", r => {r.receipts[0].receiptBase64 += "!";}, /noncanonical base64/],
    ["mixed source", r => {
      const ref = r.receipts[0], receipt = JSON.parse(Buffer.from(ref.receiptBase64, "base64"));
      receipt.identity.sourceRevision = delivery;
      const bytes = Buffer.from(json(receipt)); ref.receiptBase64 = bytes.toString("base64"); ref.sha256 = sha256(bytes);
    }, /identity mismatch/],
  ]) await t.test(`rejects ${name}`, () => {
    const changed = structuredClone(report); mutate(changed); writeFileSync(delivered, json(changed));
    assert.throws(() => deliveredCheck(consumer, delivered), reason);
    writeFileSync(delivered, json(report));
  });
  for (const [name, mutate] of [
    ["tracked byte change", () => fs.appendFileSync(resolve(consumer, "README.md"), "\nchanged\n")],
    ["tracked addition", () => writeFileSync(resolve(consumer, "extra-input.txt"), "extra")],
    ["tracked removal", () => rmSync(resolve(consumer, "README.md"))],
    ["tracked path change", () => fs.renameSync(resolve(consumer, "README.md"), resolve(consumer, "RENAMED.md"))],
    ["tracked mode change", () => {git(consumer, "config", "core.fileMode", "true"); fs.chmodSync(resolve(consumer, "README.md"), 0o755);}],
  ]) await t.test(`rejects ${name} even when committed`, () => {
    mutate(); git(consumer, "add", "-A"); commit(consumer);
    assert.equal(git(consumer, "status", "--porcelain"), "");
    assert.throws(() => deliveredCheck(consumer, delivered), /source\/input mismatch/);
    git(consumer, "reset", "--hard", delivery);
  });
  deliveredCheck(consumer, delivered);
});


test("frozen historical L0 uses its original spec closure, never the incoming 42-change spec", async () => {
  const {loadHistoricalSpec, historicalSpecRevision} = await import("./runtime-setup-l0-evidence-historical.mjs");
  const {validateStoredReportShape, validateCurrentEvidenceIdentity} = await import("./runtime-setup-l0-evidence-validation.mjs");
  const current = await import("./runtime-setup-l0-evidence-spec.mjs");
  const read = (revision, path) => execFileSync("git", ["show", `${revision}:${path}`]);
  const spec = await loadHistoricalSpec(read);
  const path = "docs/spikes/runtime-setup-l0-dogfooding-evidence.json";
  const bytes = readFileSync(path);
  assert.deepEqual(bytes, read(historicalSpecRevision, path));
  const report = JSON.parse(bytes);
  validateStoredReportShape(report, spec.changes);
  const {createEvidenceInputs} = await import("./runtime-setup-l0-evidence-inputs.mjs");
  const {retainedHistoricalEvidenceRoots} = await import("./runtime-setup-l0-evidence-adoption.mjs");
  const digests = await createEvidenceInputs({repositoryRoot: process.cwd(),
    git: (...args) => execFileSync("git", args, {encoding: "utf8"}), readRevisionFile: read,
    roots: retainedHistoricalEvidenceRoots, files: {fixtures: [], sources: [], tests: []},
  }).artifactDigestsAtRevision(report.sourceRevision);
  assert.deepEqual(digests, report.artifactDigests);
  validateCurrentEvidenceIdentity(report, {changes: spec.changes,
    currentArtifactDigests: report.artifactDigests, sourceRevisionArtifactDigests: spec.sourceRevisionArtifactDigests});
  assert.deepEqual(report.historicalChanges.map(({id, revision}) => ({id, revision})), spec.changes);
  assert.deepEqual(report.ownership, spec.ownership);
  assert.deepEqual(report.traces, spec.traces);
  assert.throws(() => validateStoredReportShape(report, current.changes));
  await assert.rejects(loadHistoricalSpec((revision, file) => file === path ? Buffer.from("altered") : read(revision, file)));
});


test("Darwin PostgreSQL custody skip requires the successful Linux integration peer", () => {
  const site = platformSites.find(s => s.file.endsWith("/postgres-authority-join.test.ts"));
  const pass = event(site.file, site.line, "joined PostgreSQL");
  const skip = {...pass, status: "skipped", skip: site.reason, skipReason: site.reason};
  const pair = [{target: "darwin-arm64", events: [skip]}, {target: "linux-x64", events: [pass]}];
  validateCoverage(pair);
  pair[1].events = [{...skip}];
  assert.throws(() => validateCoverage(pair));
  pair[1].events = [pass]; pair[0].events[0].skip = true;
  assert.throws(() => validateCoverage(pair), /unknown skip reason/);
});
