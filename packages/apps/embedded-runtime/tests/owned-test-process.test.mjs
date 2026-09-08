import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, readFile, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runOwnedTestProcess} from "../scripts/owned-test-process.mjs";

const fixture = async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ar69-owned-process-test-"));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const evidence = join(cwd, "evidence.json");
  const prefix = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({root:process.env.AR69_JOINED_TEST_PARENT,pid:process.pid}));`;
  return {cwd, evidence, prefix};
};
const absent = async evidence => {
  const facts = JSON.parse(await readFile(evidence, "utf8"));
  await assert.rejects(stat(facts.root), {code: "ENOENT"});
  assert.throws(() => process.kill(facts.pid, 0), {code: "ESRCH"});
};

test("ordinary exit releases the parent-owned temporary directory", async t => {
  const f = await fixture(t);
  assert.equal(await runOwnedTestProcess({command: process.execPath,
    args: ["-e", `${f.prefix}process.exit(7)`], cwd: f.cwd}), 7);
  await absent(f.evidence);
});

test("hard timeout kills owned process and removes its temporary directory", async t => {
  const f = await fixture(t);
  assert.equal(await runOwnedTestProcess({command: process.execPath,
    args: ["-e", `${f.prefix}setInterval(()=>{},1000)`], cwd: f.cwd, timeoutMilliseconds: 1000}), 124);
  await absent(f.evidence);
});

test("direct child exit still terminates a surviving descendant", async t => {
  const f = await fixture(t);
  const descendant = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready');`;
  const source = `${f.prefix}const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>{fs.writeFileSync(${JSON.stringify(f.evidence)},JSON.stringify({root:process.env.AR69_JOINED_TEST_PARENT,pid:child.pid}));process.exit(0)});`;
  assert.equal(await runOwnedTestProcess({command: process.execPath, args: ["-e", source], cwd: f.cwd}), 0);
  await absent(f.evidence);
});

test("interruption cannot become success when the child exits zero", async t => {
  const f = await fixture(t);
  const source = `${f.prefix}process.on('SIGTERM',()=>process.exit(0));process.kill(process.ppid,'SIGTERM');setInterval(()=>{},1000);`;
  assert.equal(await runOwnedTestProcess({command: process.execPath, args: ["-e", source], cwd: f.cwd}), 130);
  await absent(f.evidence);
});

test("interruption escalates even when the direct child ignores TERM", async t => {
  const f = await fixture(t);
  const source = `${f.prefix}process.on('SIGTERM',()=>{});process.kill(process.ppid,'SIGTERM');setInterval(()=>{},1000);`;
  const started = performance.now();
  assert.equal(await runOwnedTestProcess({command: process.execPath, args: ["-e", source], cwd: f.cwd}), 130);
  assert.ok(performance.now() - started < 10000);
  await absent(f.evidence);
});

test("synchronous spawn failure restores interruption handlers", async t => {
  const f = await fixture(t);
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await assert.rejects(runOwnedTestProcess({command: null, args: [], cwd: f.cwd}), {code: "ERR_INVALID_ARG_TYPE"});
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});
