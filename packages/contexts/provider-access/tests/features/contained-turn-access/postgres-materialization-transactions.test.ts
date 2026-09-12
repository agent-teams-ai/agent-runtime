import assert from "node:assert/strict";
import test from "node:test";
import { MaterializationPostgresTransactions, type MaterializationPostgresClient } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-transactions.js";
import { createPostgresMaterializationAuthorization } from "../../../dist/features/contained-turn-access/composition/postgres-materialization-authorization.js";
import { createPostgresMaterializationRepository } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-repository.js";
import { materializationPostgresSchemaDigest } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-schema.js";
import { renderingFixture } from "./credential-rendering-test-fixture.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(_resolve => {resolve = _resolve;});
  return {promise, resolve};
};
const harness = (execute: MaterializationPostgresClient["query"] = async () => ({rows: [], rowCount: 0})) => {
  const calls: {sql: string; values?: unknown[]}[] = [];
  const releases: boolean[] = [];
  const client: MaterializationPostgresClient = {
    async query(sql, values) {calls.push({sql, values}); return execute(sql, values);},
    release(discard) {releases.push(discard === true);},
  };
  let connects = 0;
  const pool = {async connect() {connects++; return client;}};
  return {pool, client, calls, releases, connects: () => connects};
};
const schemaRow = {version: 1, digest: await materializationPostgresSchemaDigest()};
const selector = {authorizationRequestId: "request:fixture", projectId: "project:1", provider: "codex" as const,
  scopeDigest: "scope:digest:1", tenantId: "tenant:1"};

test("transaction publishes a result only after commit and releases the borrowed connection", async () => {
  const commit = deferred<{rows: []; rowCount: 0}>();
  const entered = deferred<void>();
  const h = harness(async sql => {if (sql === "COMMIT") {entered.resolve(); return commit.promise;} return {rows: [], rowCount: 0};});
  const tx = new MaterializationPostgresTransactions(h.pool);
  let returned = false;
  const pending = tx.write(async client => {await client.query("SELECT 42"); return 42;}).then(value => {returned = true; return value;});
  await entered.promise;
  assert.equal(returned, false); assert.deepEqual(h.releases, []);
  commit.resolve({rows: [], rowCount: 0});
  assert.equal(await pending, 42); assert.deepEqual(h.releases, [false]);
  assert.deepEqual(h.calls.map(call => call.sql).filter(sql => !sql.startsWith("SELECT set_config")), ["BEGIN", "SELECT 42", "COMMIT"]);
});

test("application failure rolls back; rollback rejection discards the client", async () => {
  for (const brokenRollback of [false, true]) {
    const h = harness(async sql => {if (sql === "ROLLBACK" && brokenRollback) {throw new Error("connection lost");} return {rows: [], rowCount: 0};});
    const tx = new MaterializationPostgresTransactions(h.pool);
    await assert.rejects(tx.write(async () => {throw new Error("work failed");}), /work failed/u);
    assert.equal(h.calls.some(call => call.sql === "COMMIT"), false);
    assert.equal(h.calls.at(-1)?.sql, "ROLLBACK"); assert.deepEqual(h.releases, [brokenRollback]);
  }
});

test("ambiguous commit never returns a result or retries and discards the connection", async () => {
  const h = harness(async sql => {if (sql === "COMMIT") {throw new Error("ack lost");} return {rows: [], rowCount: 0};});
  await assert.rejects(new MaterializationPostgresTransactions(h.pool).write(async () => "fresh"), /indeterminate/u);
  assert.equal(h.calls.filter(call => call.sql === "COMMIT").length, 1);
  assert.equal(h.calls.some(call => call.sql === "ROLLBACK"), false); assert.deepEqual(h.releases, [true]);
});

test("connection acquisition timeout cleans a late connection once", async () => {
  const h = harness(); const connection = deferred<MaterializationPostgresClient>();
  const tx = new MaterializationPostgresTransactions({connect: () => connection.promise}, {connectionMs: 10});
  await assert.rejects(tx.write(async () => true), /deadline/u);
  connection.resolve(h.client); await new Promise(resolve => {setImmediate(resolve);});
  assert.deepEqual(h.calls, []); assert.deepEqual(h.releases, [true]);
});

test("hung BEGIN and COMMIT are bounded and their uncertain connections discarded", async () => {
  for (const phase of ["BEGIN", "COMMIT"]) {
    const h = harness(async sql => sql === phase ? new Promise(() => {}) : {rows: [], rowCount: 0});
    await assert.rejects(new MaterializationPostgresTransactions(h.pool, {statementMs: 10}).write(async () => true));
    assert.deepEqual(h.releases, [true]);
    assert.equal(h.calls.some(call => call.sql === "ROLLBACK"), false);
  }
});

test("late callback cannot use a transaction after its deadline", async () => {
  const h = harness(); let retained: MaterializationPostgresClient | undefined; let check: (() => void) | undefined;
  const pending = new MaterializationPostgresTransactions(h.pool, {transactionMs: 10}).write(async (client, checkOpen) => {
    retained = client; check = checkOpen; return new Promise(() => {});
  });
  await assert.rejects(pending, /deadline/u);
  assert.ok(retained); assert.ok(check); assert.throws(check, /closed/u);
  await assert.rejects(retained.query("SELECT late"), /closed/u);
  assert.equal(h.calls.some(call => call.sql === "SELECT late"), false); assert.deepEqual(h.releases, [false]);
});

test("disposal before connection and during commit never admits fresh work", async () => {
  const h = harness(); const tx = new MaterializationPostgresTransactions(h.pool); tx.dispose();
  await assert.rejects(tx.write(async () => true), /closed/u); assert.equal(h.connects(), 0);
  let active: MaterializationPostgresTransactions;
  const h2 = harness(async sql => {if (sql === "COMMIT") {active.dispose();} return {rows: [], rowCount: 0};});
  active = new MaterializationPostgresTransactions(h2.pool);
  await assert.rejects(active.write(async () => "fresh"), /indeterminate/u); assert.deepEqual(h2.releases, [true]);
});

test("schema mismatch and foreign stored receipt fail closed through the actual PA use case", async () => {
  for (const corrupt of ["schema", "receipt"] as const) {
    const f = renderingFixture(); const request = await f.request();
    const h = harness(async sql => {
      if (sql.includes("SELECT version")) {return {rows: [{...schemaRow, version: corrupt === "schema" ? 2 : 1}], rowCount: 1};}
      if (sql.includes("FOR UPDATE")) {return {rows: [{head_version: "1", binding: f.selection.binding}], rowCount: 1};}
      if (sql.includes("SELECT a.receipt")) {return {rows: [{receipt: {...request, tenantId: "foreign", decision: "authorized", rejectionReason: null}}], rowCount: 1};}
      return {rows: [], rowCount: 0};
    });
    const owner = createPostgresMaterializationAuthorization(h.pool);
    assert.deepEqual(await owner.authorization.authorize(request), {kind: "indeterminate"}); owner.dispose();
    assert.equal(h.calls.some(call => call.sql.startsWith("INSERT INTO provider_access.materialization_authorization")), false);
    assert.equal(h.calls.some(call => call.sql === "COMMIT"), false);
  }
});

test("authorization selects and locks the complete owner before scoped immutable insertion", async () => {
  const f = renderingFixture(); const request = await f.request();
  const h = harness(async sql => {
    if (sql.includes("SELECT version")) {return {rows: [schemaRow], rowCount: 1};}
    if (sql.includes("FOR UPDATE")) {return {rows: [{head_version: "1", binding: f.selection.binding}], rowCount: 1};}
    return {rows: [], rowCount: sql.startsWith("INSERT INTO provider_access.materialization_authorization") ? 1 : 0};
  });
  const owner = createPostgresMaterializationAuthorization(h.pool);
  assert.equal((await owner.authorization.authorize(request)).kind, "authorized"); owner.dispose();
  const lock = h.calls.findIndex(call => call.sql.includes("FOR UPDATE"));
  const insert = h.calls.findIndex(call => call.sql.startsWith("INSERT INTO provider_access.materialization_authorization"));
  assert.ok(lock > 0 && insert > lock);
  const values = h.calls[lock]?.values; assert.match(String(values?.[0]), /^[a-f0-9]{64}$/u);
  assert.deepEqual(values?.slice(1), [request.tenantId, request.projectId, request.provider, request.scopeDigest]);
  const lookup = h.calls.find(call => call.sql.includes("SELECT a.receipt"));
  assert.deepEqual(lookup?.values, [...values!, request.authorizationRequestId]);
  assert.equal(h.calls[insert]?.values?.[1], request.authorizationRequestId);
});

test("stale owner CAS cannot write; malformed selectors cannot touch the pool", async () => {
  const f = renderingFixture();
  const h = harness(async sql => {
    if (sql.includes("SELECT version")) {return {rows: [schemaRow], rowCount: 1};}
    if (sql.includes("FOR UPDATE")) {return {rows: [{head_version: "2", binding: f.selection.binding}], rowCount: 1};}
    return {rows: [], rowCount: 0};
  });
  const owner = createPostgresMaterializationRepository(h.pool);
  assert.equal(await owner.replaceBinding(f.selection.binding, 1), undefined);
  assert.equal(h.calls.some(call => call.sql.startsWith("UPDATE")), false);
  const before = h.connects();
  await assert.rejects(owner.repository.observeAuthorizationRequest({...selector, tenantId: "bad owner space"}));
  assert.equal(h.connects(), before); owner.dispose();
});

test("transaction deadline discards an in-flight query without queueing rollback or reusing connection", async () => {
  const h = harness(async sql => sql === "SELECT blocked" ? new Promise(() => {}) : {rows: [], rowCount: 0});
  const tx = new MaterializationPostgresTransactions(h.pool, {transactionMs: 10, statementMs: 20});
  await assert.rejects(tx.write(async client => client.query("SELECT blocked")), /deadline/u);
  assert.deepEqual(h.releases, [true]); assert.equal(h.calls.some(call => call.sql === "ROLLBACK"), false);
});

test("missing receipt insert acknowledgement never becomes fresh authorization", async () => {
  const f = renderingFixture(); const request = await f.request();
  const h = harness(async sql => {
    if (sql.includes("SELECT version")) {return {rows: [schemaRow], rowCount: 1};}
    if (sql.includes("FOR UPDATE")) {return {rows: [{head_version: "1", binding: f.selection.binding}], rowCount: 1};}
    return {rows: [], rowCount: 0};
  });
  const owner = createPostgresMaterializationAuthorization(h.pool);
  assert.deepEqual(await owner.authorization.authorize(request), {kind: "indeterminate"});
  assert.equal(h.calls.some(call => call.sql === "COMMIT"), false);
  assert.equal(h.calls.at(-1)?.sql, "ROLLBACK"); owner.dispose();
});
