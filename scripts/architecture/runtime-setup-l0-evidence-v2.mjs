import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { testProcesses, packagePath, reporterArg, checkStages } from "../../packages/apps/embedded-runtime/scripts/run-package-tests.mjs";
import { platformSites } from "./runtime-setup-l0-evidence-platform-sites.mjs";

export const targets = ["darwin-arm64", "linux-x64"];
export const tools = {node: "v24.18.0", pnpm: "11.18.0"};
export const command = "pnpm --filter @agent-teams/embedded-runtime check";
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const json = value => JSON.stringify(value, null, 2) + "\n";
const equal = (a, b, message) => assert.deepEqual(a, b, message);
export const eventId = e => JSON.stringify([e.suite, ...e.ancestry, e.segment]);
const parentId = e => e.ancestry.length ? JSON.stringify([e.suite, ...e.ancestry]) : null;
const siteFor = e => platformSites.find(s => s.file === e.file && s.line === e.line);
const zero = {tests: 0, failed: 0, passed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 0, suites: 0};
function counts(events) {
  const result = {...zero};
  for (const e of events) {
    if (e.type === "suite") {result.suites++;} else { result.tests++; result[e.status]++; }
    if (!e.ancestry.length) {result.topLevel++;}
  }
  return result;
}
export function validateStream(bytes, expectedFiles) {
  assert.ok(bytes.endsWith("\n"), "incomplete stream");
  const rows = bytes.trimEnd().split("\n").map(line => JSON.parse(line));
  equal(rows.shift(), {kind: "begin", version: 1}, "missing stream begin");
  equal(rows.pop(), {kind: "end"}, "incomplete stream");
  const summary = rows.pop();
  assert.equal(summary?.kind, "summary", "missing final summary");
  assert.equal(summary.success, true);
  const events = [], files = [], pending = [], ids = new Set();
  for (const row of rows) {
    if (row.kind === "test") {
      assert.ok(["passed", "skipped"].includes(row.status), "failed/cancelled/todo test");
      assert.ok(["test", "suite"].includes(row.type));
      assert.ok(Array.isArray(row.ancestry));
      assert.match(row.file, /^packages\/apps\/embedded-runtime\/tests\/(?!.*\.\.)/u);
      assert.ok(Number.isInteger(row.line) && row.line > 0);
      assert.ok(Number.isInteger(row.column) && row.column > 0);
      assert.ok(Number.isInteger(row.ordinal) && row.ordinal > 0);
      assert.ok(typeof row.title === "string" && row.title.length > 0);
      equal(row.segment, [row.file, row.line, row.column, row.title, row.ordinal]);
      if (row.status === "passed") { assert.equal(row.skip, null); assert.equal(row.skipReason, null); }
      else {assert.equal(row.skipReason, typeof row.skip === "string" ? row.skip : "registration skip option evaluated true");}
      assert.ok(!ids.has(eventId(row)), "duplicate test identity"); ids.add(eventId(row));
      events.push(row); pending.push(row);
    } else if (row.kind === "output") {
      assert.ok(["stdout", "stderr"].includes(row.stream));
      assert.equal(typeof row.message, "string");
    } else {
      assert.equal(row.kind, "file", "unknown or failure event");
      assert.equal(row.success, true);
      assert.ok(pending.length > 0, "empty suite");
      assert.ok(pending.every(e => e.suite === row.suite));
      equal(row.counts, counts(pending), "file counts disagree with terminal events");
      files.push(row.suite); pending.length = 0;
    }
  }
  assert.equal(pending.length, 0, "missing file completion");
  equal(files.toSorted(), expectedFiles.toSorted(), "missing/duplicate/changed manifest test input");
  equal(summary.counts, counts(events), "process counts disagree with terminal events");
  const byId = new Map(events.map(e => [eventId(e), e]));
  for (const e of events) {if (parentId(e)) {
    assert.ok(ids.has(parentId(e)), "missing parent");
    assert.equal(byId.get(parentId(e)).status, "passed", "skipped parent cannot prove children");
  }}
  return events;
}
function success(record) {
  assert.equal(record.exitCode, 0, "failed process/stage"); assert.equal(record.signal, null);
  assert.ok(Number.isFinite(Date.parse(record.start)) && Date.parse(record.end) >= Date.parse(record.start));
}
export function requirePostgres(env, target = "linux-x64") {
  assert.ok(targets.includes(target));
  if (target === "darwin-arm64") {return {required: false, configured: false};}
  assert.ok(env.AE_ACL_POSTGRES_DISPOSABLE_URL, "missing PostgreSQL disposable prerequisite");
  const url = new URL(env.AE_ACL_POSTGRES_DISPOSABLE_URL);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "[::1]"].includes(url.hostname));
  assert.equal(url.search, "", "Connection target overrides are forbidden");
  assert.equal(url.hash, "", "Connection fragments are forbidden");
  assert.match(url.pathname, /^\/ar69_pa_test_[a-z0-9]+$/u);
  return {required: true, configured: true}; // Never retain the URL or credentials.
}
export function validateReceipt(receipt, current, readArtifact) {
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.evidenceKind, "runtime-setup-adoption-platform-receipt");
  assert.ok(targets.includes(receipt.target));
  assert.equal(`${receipt.platform}-${receipt.architecture}`, receipt.target);
  assert.ok(isAbsolute(receipt.cwd) && isAbsolute(receipt.nodeExecutable), "exact execution paths required");
  equal(receipt.tools, tools, "tool mismatch"); equal(receipt.identity, current, "source/input/tool identity mismatch");
  equal(receipt.postgres, {required: receipt.target === "linux-x64", configured: receipt.target === "linux-x64"}, "missing PostgreSQL");
  assert.equal(receipt.command, command);
  assert.ok(typeof receipt.runId === "string" && receipt.runId.trim().length > 0);
  success(receipt);
  const artifact = name => {
    assert.match(name, /^[a-z0-9.-]+$/u);
    const bytes = readArtifact(name);
    assert.equal(sha256(bytes), receipt.artifacts[name], `artifact hash mismatch: ${name}`);
    return bytes.toString("utf8");
  };
  for (const name of Object.keys(receipt.artifacts)) {artifact(name);}
  artifact("check.stdout"); artifact("check.stderr");
  const stages = JSON.parse(artifact("stages.json"));
  const processes = JSON.parse(artifact("processes.json"));
  assert.equal(stages.length, 4, "missing stage"); assert.equal(processes.length, 2, "missing process");
  for (const [i, stage] of stages.entries()) {
    success(stage); assert.equal(stage.index, i); assert.equal(stage.cwd, packagePath);
    assert.equal(stage.executable, "pnpm"); equal(stage.argv, ["run", checkStages[i]], "altered stage command");
    assert.equal(stage.stdout, `stage-${i}.stdout`); assert.equal(stage.stderr, `stage-${i}.stderr`);
    artifact(stage.stdout); artifact(stage.stderr);
    assert.ok(Date.parse(stage.start) >= Date.parse(i ? stages[i-1].end : receipt.start));
    assert.ok(Date.parse(stage.end) <= Date.parse(receipt.end));
  }
  const events = processes.flatMap((p, i) => {
    success(p); assert.equal(p.index, i); assert.equal(p.cwd, packagePath); assert.equal(p.executable, "node");
    equal(p.argv, [reporterArg, ...testProcesses[i]], "altered test process argv");
    assert.equal(p.stdout, `process-${i}.stdout`); assert.equal(p.stderr, `process-${i}.stderr`);
    artifact(p.stderr);
    assert.ok(Date.parse(p.start) >= Date.parse(i ? processes[i-1].end : stages[3].start));
    assert.ok(Date.parse(p.end) <= Date.parse(stages[3].end));
    return validateStream(artifact(p.stdout), testProcesses[i].filter(a => !a.startsWith("--")).map(f => `${packagePath}/${f}`));
  });
  assert.equal(new Set(events.map(eventId)).size, events.length, "duplicate process test identity");
  for (const event of events) {if (event.status === "skipped") {
    const site = siteFor(event);
    assert.ok(site, `unknown skip: ${eventId(event)}`);
    assert.notEqual(receipt.target, site.target, "applicable-platform skip");
    equal(event.skip, site.reason, "unknown skip reason");
  }}
  return events;
}
export function validateCoverage(pair) {
  equal(pair.map(r => r.target).toSorted(), targets, "missing or duplicate target");
  const maps = pair.map(r => {
    const map = new Map(r.events.map(e => [eventId(e), e]));
    assert.equal(map.size, r.events.length, "duplicate test identity");
    return map;
  });
  for (let i = 0; i < 2; i++) {for (const [id, event] of maps[i]) {
    const peer = maps[1-i].get(id);
    const site = siteFor(event);
    if (event.status === "skipped") {
      assert.ok(site, `unknown skip: ${id}`);
      assert.notEqual(pair[i].target, site.target, "applicable-platform skip");
      equal(event.skip, site.reason, "unknown skip reason");
      assert.equal(peer?.status, "passed", "skip requires passing peer");
      continue;
    }
    assert.equal(event.status, "passed", "failed/cancelled/todo test");
    if (peer) {
      const platformPeer = site && pair[i].target === site.target;
      assert.equal(peer.status, platformPeer ? "skipped" : "passed",
        platformPeer ? "platform predicate drift" : "portable test must pass both");
      continue;
    }
    let ancestor = parentId(event), covered = false;
    while (ancestor) {
      const own = maps[i].get(ancestor); assert.ok(own, "missing parent");
      const other = maps[1-i].get(ancestor), restriction = siteFor(own);
      covered = other?.status === "skipped" && restriction?.target === pair[i].target;
      ancestor = covered ? null : parentId(own);
    }
    assert.ok(covered, `unexplained inventory difference: ${id}`);
  }}
  assert.ok(maps.every(m => m.size > 0), "empty inventory");
}
export function validatePlatformSites(root) {
  for (const s of platformSites) {
    const lines = readFileSync(resolve(root, s.file), "utf8").split("\n");
    assert.ok(lines[s.skipLine-1]?.includes(s.predicate), `platform predicate drift: ${s.file}:${s.skipLine}`);
    assert.match(lines[s.line-1], /\btest\(/u, "platform registration site drift");
  }
}
