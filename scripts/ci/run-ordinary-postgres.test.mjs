import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {ordinaryPostgresEnvironment, runOrdinaryPostgres} from "./run-ordinary-postgres.mjs";

const url = "postgresql://postgres@localhost/postgres?host=/tmp/ordinary-pa-pg-TEST-unit";
const environment = {ORDINARY_TEST_POSTGRES_URL: url, ORDINARY_PA_TEST_POSTGRES_URL: url};
const names = [
  "disposable PostgreSQL ordinary namespace: concurrent accept and claim, durable restart and scope isolation",
  "ordinary security durable consumed identity, unknown-commit readback, settlement and no persisted secrets",
  "ordinary PA PostgreSQL grants, counters, retirement and original rendering authority",
];
const summary = {type: "test:summary", data: {success: true, counts: {failed: 0, cancelled: 0, skipped: 0, todo: 0}}};
const invoke = (mutate = events => events) => runOrdinaryPostgres({environment, write() {},
  runTests(options) {
    assert.equal(options.files.length, 3);
    assert.equal(options.concurrency, 1);
    assert.equal(options.isolation, "process");
    assert.deepEqual(options.env, environment);
    assert.deepEqual(options.execArgv, []);
    const events = options.files.map((file, index) => ({type: "test:pass", data: {file, name: names[index]}}));
    return (async function* () {yield* mutate([...events, summary]);})();
  }});

test("ordinary DB gate rejects absent, remote, non-disposable or ambiguous URLs before starting tests", async () => {
  for (const invalid of [undefined, "", "postgresql://postgres@localhost/postgres", "https://localhost/postgres",
    url.replace("localhost", "example.com"), url.replace("/postgres?", "/production?"),
    url.replace("-TEST-", "-PROD-"), `${url}&host=/tmp/other`, `${url}&sslmode=disable`,
    url.replace("localhost", "localhost:5432"), `${url}#fragment`]) {
    for (const key of Object.keys(environment)) {
      let started = false;
      await assert.rejects(runOrdinaryPostgres({environment: {...environment, [key]: invalid},
        runTests() {started = true;}, write() {}}), /disposable socket URL required/u);
      assert.equal(started, false);
    }
  }
  assert.deepEqual(ordinaryPostgresEnvironment({...environment, NODE_OPTIONS: "--test-only", PGPASSWORD: "private"}), environment);
});

test("ordinary DB gate requires every named integration, rejects skip/todo/failure and incomplete streams", async () => {
  await invoke();
  for (const mutate of [
    events => events.slice(1),
    events => events.slice(0, -1),
    events => events.map((event, i) => i === 0 ? {...event, data: {...event.data, skip: true}} : event),
    events => events.map((event, i) => i === 0 ? {...event, data: {...event.data, todo: "later"}} : event),
    events => events.map((event, i) => i === 0 ? {...event, type: "test:fail"} : event),
    events => events.map((event, i) => i === 0 ? {...event, data: {...event.data, name: "unrelated passing test"}} : event),
    events => [...events, {type: "test:pass", data: {name: "nested skipped test", skip: true}}],
    events => [...events, {type: "test:summary", data: {...summary.data, success: false}}],
  ]) {await assert.rejects(invoke(mutate), /gate incomplete/u);}
});

test("mandatory PostgreSQL CI invokes the disposable ordinary gate and its rejecting tests remain in full/fast gates", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.match(workflow, /Run disposable ordinary PostgreSQL gate/u);
  assert.match(workflow, /bash scripts\/ci\/ordinary-postgres-disposable\.sh/u);
  assert.ok(manifest.scripts["foundation:boundaries:negative"].includes("scripts/ci/run-ordinary-postgres.test.mjs"));
  for (const gate of ["check", "check:fast"]) {assert.ok(manifest.scripts[gate].includes("pnpm foundation:check"));}
});
