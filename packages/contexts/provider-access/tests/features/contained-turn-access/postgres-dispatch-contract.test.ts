import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresDispatchConsumption } from "../../../dist/composition.js";
import { createPostgresDispatchConsumptionRepository } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/dispatch-postgres-repository.js";
import { dispatchPostgresSchemaDigest } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/dispatch-postgres-schema.js";
import { materializationPostgresSchemaDigest } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-schema.js";
import { materializationProjection } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/dispatch-postgres-data.js";
import { validateDispatchHeadAdvance } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/dispatch-postgres-control.js";
import type { DispatchConsumptionTransaction } from "../../../dist/features/contained-turn-access/application/ports/outbound/dispatch-consumption-repository.js";
import { seed, inputFor, settlementFor } from "./dispatch-consumption-test-fixture.ts";

const head = {...seed(), availability: "available" as const, revocation: "active" as const};
const owner = {provider: head.provider, scope: {tenantId: head.tenantId, projectId: head.projectId, scopeDigest: head.scopeDigest}};
const dispatchSchema = {version: 1, digest: await dispatchPostgresSchemaDigest()};
const materializationSchema = {version: 1, digest: await materializationPostgresSchemaDigest()};
// Scripted SQL boundary, not a PostgreSQL emulator or durability evidence.
const harness = (options: {absent?: boolean; loseCommit?: boolean; badSchema?: boolean; badOwner?: boolean; divergentMaterialization?: boolean; failGrant?: boolean; materialVersion?: string; materialBinding?: unknown} = {}) => {
  const calls: {sql: string; values?: unknown[]}[] = []; const releases: boolean[] = [];
  let consumption: unknown; let grant: unknown; let settlement: unknown;
  const lockedRows = (sql: string) => {
    return sql.includes("materialization_owner") ?
        {rows: [{head_version: options.materialVersion ?? "0", binding: options.materialBinding ?? (options.absent ? null : {...materializationProjection(head), revocation: options.divergentMaterialization ? "revoked" : "active"})}], rowCount: 1} :
        {rows: [{owner: options.badOwner ? {...owner, provider: "claude"} : owner, version: options.absent ? "0" : "1", control_time: "100", head: options.absent ? null : head}], rowCount: 1};
  };
  return {calls, releases, pool: {async connect() {return {
    async query(sql: string, values?: unknown[]) {
      calls.push({sql, values});
      if (sql === "COMMIT" && options.loseCommit) {throw new Error("ack lost");}
      if (sql.includes("FROM provider_access.dispatch_schema")) {return {rows: [{...dispatchSchema, version: options.badSchema ? 9 : 1}], rowCount: 1};}
      if (sql.includes("FROM provider_access.materialization_schema")) {return {rows: [materializationSchema], rowCount: 1};}
      if (sql.includes("FOR UPDATE")) {return lockedRows(sql);}
      if (sql.includes("RETURNING control_time")) {return {rows: [{control_time: "100"}], rowCount: 1};}
      if (sql.startsWith("SELECT record FROM provider_access.dispatch_consumption") || sql.startsWith("SELECT c.record")) {return {rows: consumption ? [{record: consumption}] : [], rowCount: consumption ? 1 : 0};}
      if (sql.startsWith("SELECT record FROM provider_access.dispatch_grant") || sql.startsWith("SELECT g.record")) {return {rows: grant ? [{record: grant}] : [], rowCount: grant ? 1 : 0};}
      if (sql.startsWith("SELECT record FROM provider_access.dispatch_settlement")) {return {rows: settlement ? [{record: settlement}] : [], rowCount: settlement ? 1 : 0};}
      if (sql.startsWith("SELECT 1 FROM provider_access.dispatch_consumption")) {return {rows: consumption ? [{}] : [], rowCount: consumption ? 1 : 0};}
      if (sql.startsWith("INSERT INTO provider_access.dispatch_consumption")) {consumption = JSON.parse(values![3] as string);}
      if (sql.startsWith("INSERT INTO provider_access.dispatch_grant")) {
        if (options.failGrant) {return {rows: [], rowCount: 0};}
        grant = JSON.parse(values![2] as string);
      }
      if (sql.startsWith("INSERT INTO provider_access.dispatch_settlement")) {settlement = JSON.parse(values![5] as string);}
      return {rows: [], rowCount: sql.startsWith("INSERT") || sql.startsWith("UPDATE") ? 1 : 0};
    }, release(discard?: boolean) {releases.push(discard === true);},
  };}}};
};

test("actual dispatch use cases consume, observe and settle through targeted PG adapter calls", async () => {
  const h = harness(); const pa = createPostgresDispatchConsumption(h.pool); const request = await inputFor();
  const consumed = await pa.dispatchConsumption.consumeForDispatch(request);
  assert.equal(consumed.kind, "consumed"); if (consumed.kind !== "consumed") {throw new Error("expected receipt");}
  assert.deepEqual(await pa.dispatchConsumption.consumeForDispatch(request), consumed);
  assert.deepEqual(await pa.dispatchConsumption.observeDispatchConsumption({grantRequestId: request.grantRequestId, provider: request.provider, scope: request.scope, requestDigest: request.requestDigest}), consumed);
  assert.equal((await pa.control.observeConsumption(owner, consumed.receipt.consumptionDigest))?.state, "consumed_pending");
  const settled = await pa.dispatchConsumption.settleDispatchConsumption(settlementFor(consumed.receipt));
  assert.equal(settled.kind, "settled");
  assert.equal((await pa.control.observeConsumption(owner, consumed.receipt.consumptionDigest))?.state, "abandoned_without_claim");
  assert.deepEqual(await pa.dispatchConsumption.settleDispatchConsumption(settlementFor(consumed.receipt)), settled);
  assert.equal(h.calls.filter(call => call.sql.startsWith("INSERT INTO provider_access.dispatch_consumption")).length, 1);
  assert.equal(h.calls.filter(call => call.sql.startsWith("INSERT INTO provider_access.dispatch_settlement")).length, 1);
  const lock = h.calls.findIndex(call => call.sql.includes("FOR UPDATE"));
  const write = h.calls.findIndex(call => call.sql.startsWith("INSERT INTO provider_access.dispatch_consumption"));
  assert.ok(write > lock); assert.deepEqual(h.releases, [false, false, false, false, false, false, false]); pa.dispose();
});

test("missing head journals not_found and never fabricates authority from request expectations", async () => {
  const h = harness({absent: true}); const pa = createPostgresDispatchConsumption(h.pool);
  assert.deepEqual(await pa.dispatchConsumption.consumeForDispatch(await inputFor()), {kind: "not_found"});
  assert.ok(h.calls.some(call => call.sql.startsWith("INSERT INTO provider_access.dispatch_grant")));
  assert.equal(h.calls.some(call => call.sql.includes("SET head=") || call.sql.startsWith("INSERT INTO provider_access.materialization")), false);
  pa.dispose();
});

test("schema, foreign owner, lost write acknowledgement and lost commit fail closed without retries", async () => {
  for (const options of [{badSchema: true}, {badOwner: true}, {divergentMaterialization: true}, {failGrant: true}, {loseCommit: true}]) {
    const h = harness(options); const pa = createPostgresDispatchConsumption(h.pool);
    assert.deepEqual(await pa.dispatchConsumption.consumeForDispatch(await inputFor()), {kind: "indeterminate"});
    assert.equal(h.calls.filter(call => call.sql === "BEGIN").length, 1);
    assert.equal(h.calls.filter(call => call.sql === "COMMIT").length, options.loseCommit ? 1 : 0);
    assert.equal(h.releases[0], options.loseCommit === true); pa.dispose();
  }
});

test("private publication atomically projects actual head into existing materialization CAS", async () => {
  const h = harness({absent: true}); const pa = createPostgresDispatchConsumption(h.pool);
  assert.deepEqual(await pa.control.publishHead({head, publicationRequestId: "publish:1", expectedHeadVersion: 0, expectedMaterializationHeadVersion: 0}), {headVersion: 1, materializationHeadVersion: 1});
  const projection = h.calls.find(call => call.sql.startsWith("UPDATE provider_access.materialization_owner"));
  const binding = JSON.parse(projection!.values![5] as string);
  assert.equal(binding.credentialGeneration, head.credentialGeneration); assert.equal(binding.bindingRevision, head.bindingRevision);
  assert.equal(binding.providerRouteRef, head.providerRouteRef); assert.equal(binding.revocation, "active");
  assert.equal(h.calls.filter(call => call.sql === "COMMIT").length, 1); pa.dispose();
  const conflict = harness({absent: true, materialVersion: "1"}); const other = createPostgresDispatchConsumption(conflict.pool);
  await assert.rejects(other.control.publishHead({head, publicationRequestId: "publish:1", expectedHeadVersion: 0, expectedMaterializationHeadVersion: 0}), /CAS conflict/u);
  assert.equal(conflict.calls.at(-1)?.sql, "ROLLBACK");
  assert.equal(conflict.calls.some(call => call.sql.includes("SET head=")), false); other.dispose();
});

test("head publication cannot refresh consumed identity, revive revocation or regress generation", () => {
  validateDispatchHeadAdvance(head, {...head, revocation: "revoked"});
  validateDispatchHeadAdvance(head, {...head, availability: "unavailable"});
  for (const change of [{credentialGeneration: 2}, {claimBeforeControlTime: 201}, {bindingDigest: "binding:other"}]) {
    assert.throws(() => validateDispatchHeadAdvance(head, {...head, ...change}), /rebound/u);
  }
  assert.throws(() => validateDispatchHeadAdvance({...head, revocation: "revoked"}, head), /revived/u);
  assert.throws(() => validateDispatchHeadAdvance(head, {...head, authorityHeadDigest: "head:new"}), /advance/u);
  assert.throws(() => validateDispatchHeadAdvance({...head, credentialGeneration: 2}, {...head, bindingRevision: 2, authorityHeadDigest: "head:new"}), /advance/u);
  validateDispatchHeadAdvance(head, {...head, bindingRevision: 2, authorityHeadDigest: "head:new"});
});

test("retained callback and disposed owner cannot use connection or local cached reads", async () => {
  const h = harness(); const pa = createPostgresDispatchConsumptionRepository(h.pool);
  let retained: DispatchConsumptionTransaction | undefined;
  await pa.repository.transact({...owner, kind: "consume", grantRequestId: "grant:1"}, async tx => {retained = tx;});
  assert.ok(retained); await assert.rejects(retained.findBindingHead(), /closed/u);
  await assert.rejects(retained.controlTime(), /closed/u);
  const before = h.calls.length; pa.dispose();
  await assert.rejects(pa.control.observeHead(owner), /closed/u); assert.equal(h.calls.length, before);
  await assert.rejects(pa.repository.transact({...owner, kind: "consume", grantRequestId: "invalid token"}, async () => {}));
  assert.equal(h.calls.length, before);
});

test("disposing an in-flight dispatch transaction rolls back and closes retained local reads", async () => {
  const h = harness(); const pa = createPostgresDispatchConsumptionRepository(h.pool);
  let entered!: () => void; const started = new Promise<void>(resolve => {entered = resolve;});
  let unblock!: () => void; const barrier = new Promise<void>(resolve => {unblock = resolve;});
  const pending = pa.repository.transact({...owner, kind: "consume", grantRequestId: "grant:inflight"}, async tx => {
    entered(); await barrier; await tx.controlTime(); return "must not escape";
  });
  await started; pa.dispose(); unblock();
  await assert.rejects(pending, /closed/u);
  assert.equal(h.calls.some(call => call.sql === "COMMIT"), false);
  assert.equal(h.calls.at(-1)?.sql, "ROLLBACK"); assert.deepEqual(h.releases, [false]);
});

test("owner time is sampled after row lock acquisition, and low-water updates fail closed", async () => {
  const h = harness(); const pa = createPostgresDispatchConsumption(h.pool);
  const observed = await pa.control.observeHead(owner);
  assert.equal(observed.controlTime, 100);
  assert.equal(observed.materializationBinding?.credentialGeneration, head.credentialGeneration);
  const lock = h.calls.findIndex(call => call.sql.includes("FOR UPDATE"));
  const sample = h.calls.findIndex(call => call.sql.includes("clock_timestamp()"));
  assert.ok(sample > lock); assert.ok(h.calls[sample]?.sql.includes("GREATEST(control_time"));
  await assert.rejects(pa.control.advanceControlTime(owner, 99), /regress/u);
  assert.equal(h.calls.at(-1)?.sql, "ROLLBACK"); pa.dispose();
});

// Matching persistence versions must not authorize overwriting newer PA facts.
test("publication validates the locked materialization authority before any head update", async () => {
  for (const change of [{revocation: "revoked"}, {availability: "unavailable"},
    {bindingRevision: 2}, {credentialGeneration: 2}, {credentialBindingRef: "credential:rotated"}]) {
    const h = harness({materialVersion: "2", materialBinding: {...materializationProjection(head), ...change}});
    const pa = createPostgresDispatchConsumption(h.pool);
    await assert.rejects(pa.control.publishHead({head, publicationRequestId: "publish:stale-materialization",
      expectedHeadVersion: 1, expectedMaterializationHeadVersion: 2}), /rebound|revived|advance/u);
    assert.ok(h.calls.some(call => call.sql.includes("SELECT head_version, binding") && call.sql.includes("FOR UPDATE")));
    assert.equal(h.calls.some(call => call.sql.startsWith("UPDATE provider_access.materialization_owner") || call.sql.includes("SET head=")), false);
    assert.equal(h.calls.at(-1)?.sql, "ROLLBACK"); pa.dispose();
  }
});
