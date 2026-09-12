import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresCurrentProviderAccess, createPostgresOperationDispatchConsumption, createPostgresRouteSelectionOwner } from "../../../dist/composition.js";
import { createPostgresMaterializationRepository } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-repository.js";
import { acceptedFixture, issuanceFixture, fixtureHash } from "./operation-dispatch-test-fixture.ts";
import { settlementFor } from "./dispatch-consumption-test-fixture.ts";
import { selection as routeFixture } from "./route-selection-fixture.ts";
import { validateDisposablePostgresUrl } from "./postgres-materialization-url.fixtures.ts";
import type { MaterializationPostgresPool } from "../../../dist/composition.js";

const databaseUrl = process.env.PA_POSTGRES_DISPOSABLE_URL;
const publicationBoundary = (pool: MaterializationPostgresPool, afterCommit: () => Promise<void>): MaterializationPostgresPool => ({
  async connect() {
    const client = await pool.connect(); let publication = false;
    return {async query(sql: string, values?: unknown[]) {
      if (sql.startsWith("INSERT INTO provider_access.dispatch_operation_record_v2") && values?.[1] === "publication") {publication = true;}
      const result = await client.query(sql, values);
      if (sql === "COMMIT" && publication) {await afterCommit();}
      return result;
    }, release(discard?: boolean) {client.release(discard);}};
  },
});

// Orchestrator runs this against a fresh disposable DB. A skip is not PG evidence.
test("PA v2 disposable PostgreSQL operation issuance, concurrency and restart", {skip: !databaseUrl, timeout: 60_000}, async t => {
  const {Pool} = await import("pg");
  const connectionString = validateDisposablePostgresUrl(databaseUrl!);
  const pools: InstanceType<typeof Pool>[] = [];
  const pool = () => {const value = new Pool({connectionString, max: 4, connectionTimeoutMillis: 2_000,
    query_timeout: 5_000, idleTimeoutMillis: 1_000, application_name: "ar69-pa-operation-disposable"}); pools.push(value); return value;};
  t.after(async () => {await Promise.all(pools.map(value => value.end()));});
  const a = pool(); const b = pool();
  assert.equal((await a.query("SELECT 1 FROM pg_namespace WHERE nspname='provider_access'")).rowCount, 0, "Refuse existing PA schema");
  const now = Number((await a.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0].now);
  const selection = issuanceFixture(now);
  const one = createPostgresOperationDispatchConsumption(a, selection); const two = createPostgresOperationDispatchConsumption(b, selection);
  t.after(one.dispose); t.after(two.dispose);
  await Promise.all([one.control.migrate(), two.control.migrate()]);
  const material = createPostgresMaterializationRepository(a); t.after(material.dispose);
  assert.equal(await material.replaceBinding(selection.binding, 0), 1);
  const selected = {provider: selection.binding.provider, tenantId: selection.binding.tenantId,
    projectId: selection.binding.projectId, scopeDigest: selection.binding.scopeDigest};
  const current = createPostgresCurrentProviderAccess(b, selected); t.after(current.dispose);
  const resolve = async (operationId: string, grantRequestId?: string) => {
    const result = await current.providerAccess.resolve.execute({provider: selected.provider,
      scope: {tenantId: selected.tenantId, projectId: selected.projectId}});
    assert.equal(result.kind, "resolved"); if (result.kind !== "resolved") {throw new Error("Expected genuine materialization-backed resolution");}
    return acceptedFixture(result.binding, operationId, grantRequestId);
  };
  const [opA, opB] = await Promise.all([resolve("operation:A"), resolve("operation:B")]);
  assert.deepEqual(await one.dispatchConsumption.publishAndConsumeForDispatch(opA.prepared, opA.request), {kind: "indeterminate"});
  await one.control.provisionIssuance();
  const route = createPostgresRouteSelectionOwner(b, {...routeFixture(), binding: selection.binding}); t.after(route.dispose);
  await route.control.migrate(); const endorsed = await route.control.endorse(1);
  const before = (await a.query("SELECT binding,head_version FROM provider_access.materialization_owner")).rows;
  const [resultA, resultB] = await Promise.all([one.dispatchConsumption.publishAndConsumeForDispatch(opA.prepared, opA.request),
    two.dispatchConsumption.publishAndConsumeForDispatch(opB.prepared, opB.request)]);
  assert.equal(resultA.kind, "consumed"); assert.equal(resultB.kind, "consumed");
  if (resultA.kind !== "consumed" || resultB.kind !== "consumed") {throw new Error("Expected independent A/B consumption");}
  assert.deepEqual((await a.query("SELECT binding,head_version FROM provider_access.materialization_owner")).rows, before);
  assert.deepEqual(await route.readCurrent(), endorsed, "Late publication preserves actual endorsed version");

  await t.test("same-op races and request substitutions never mint another consumption", async () => {
    const op = await resolve("operation:race");
    const outcomes = await Promise.all(Array.from({length: 12}, (_, i) => (i % 2 ? one : two).dispatchConsumption.publishAndConsumeForDispatch(op.prepared, op.request)));
    assert.equal(outcomes[0]?.kind, "consumed"); for (const outcome of outcomes) {assert.deepEqual(outcome, outcomes[0]);}
    const changed = await resolve(op.request.operationId, "grant:alternate");
    assert.equal((await one.dispatchConsumption.publishAndConsumeForDispatch(changed.prepared, changed.request)).kind, "conflict");
    assert.equal((await a.query("SELECT count(*) AS n FROM provider_access.dispatch_operation_record_v2 WHERE kind='consumption'")).rows[0].n, "3");
    await assert.rejects(a.query("UPDATE provider_access.dispatch_operation_record_v2 SET record=record WHERE kind='publication'"), /immutable/u);
    await assert.rejects(a.query("DELETE FROM provider_access.dispatch_operation_record_v2 WHERE kind='consumption'"), /immutable/u);
  });

  await t.test("reconstruction retains A and permits newly accepted B2 using unchanged credential generation", async () => {
    const rebuilt = createPostgresOperationDispatchConsumption(pool(), selection); t.after(rebuilt.dispose);
    assert.deepEqual(await rebuilt.dispatchConsumption.publishAndConsumeForDispatch(opA.prepared, opA.request), resultA);
    const newB = await resolve("operation:B2");
    const consumed = await rebuilt.dispatchConsumption.publishAndConsumeForDispatch(newB.prepared, newB.request);
    assert.equal(consumed.kind, "consumed"); if (consumed.kind === "consumed") {assert.equal(consumed.receipt.credentialGeneration, resultA.receipt.credentialGeneration);}
    const observation = {grantRequestId: opA.request.grantRequestId, requestDigest: opA.request.requestDigest,
      scope: opA.request.scope, provider: opA.request.provider};
    assert.deepEqual(await rebuilt.dispatchConsumption.observeDispatchConsumption(observation), resultA);
    assert.deepEqual(await rebuilt.dispatchConsumption.observeDispatchConsumption({...observation, scope: {...observation.scope, tenantId: "foreign"}}), {kind: "not_found"});
  });

  await t.test("negative history stays negative after publication and rejects a new same-operation request", async () => {
    const missing = await resolve("operation:absent");
    assert.deepEqual(await one.dispatchConsumption.consumeForDispatch(missing.request), {kind: "not_found"});
    assert.deepEqual(await two.dispatchConsumption.publishAndConsumeForDispatch(missing.prepared, missing.request), {kind: "not_found"});
    const other = await resolve("operation:absent", "grant:escape");
    assert.equal((await two.dispatchConsumption.publishAndConsumeForDispatch(other.prepared, other.request)).kind, "conflict");
  });

  await t.test("publication acknowledgement gates consumption; exact read-back preserves deadlines", async () => {
    const op = await resolve("operation:lost-publication");
    const uncertain = createPostgresOperationDispatchConsumption(publicationBoundary(b, async () => {throw new Error("lost COMMIT acknowledgement");}), selection);
    t.after(uncertain.dispose);
    assert.deepEqual(await uncertain.dispatchConsumption.publishAndConsumeForDispatch(op.prepared, op.request), {kind: "indeterminate"});
    const rows = await a.query("SELECT record FROM provider_access.dispatch_operation_record_v2 WHERE kind='publication' AND record->'value'->'prepared'->>'operationId'=$1", [op.request.operationId]);
    assert.equal(rows.rowCount, 1);
    const observed = await one.dispatchConsumption.observeDispatchConsumption({grantRequestId: op.request.grantRequestId,
      requestDigest: op.request.requestDigest, scope: op.request.scope, provider: op.request.provider});
    assert.deepEqual(observed, {kind: "not_found"}, "No consumption before acknowledged publication");
    assert.equal((await two.dispatchConsumption.publishAndConsumeForDispatch(op.prepared, op.request)).kind, "consumed");
    assert.deepEqual((await a.query("SELECT record FROM provider_access.dispatch_operation_record_v2 WHERE kind='publication' AND record->'value'->'prepared'->>'operationId'=$1", [op.request.operationId])).rows, rows.rows);
  });

  await t.test("independent revocation wins before consumption; historical settlement survives and route invalidates", async () => {
    const op = await resolve("operation:revocation-race");
    const revoker = createPostgresMaterializationRepository(b); t.after(revoker.dispose);
    const racing = createPostgresOperationDispatchConsumption(publicationBoundary(a, async () => {
      assert.equal(await revoker.replaceBinding({...selection.binding, revocation: "revoked"}, 1), 2);
    }), selection); t.after(racing.dispose);
    assert.deepEqual(await racing.dispatchConsumption.publishAndConsumeForDispatch(op.prepared, op.request), {kind: "indeterminate"});
    assert.equal(await route.readCurrent(), undefined);
    assert.equal((await material.observeBinding(selected))?.revocation, "revoked");
    const rebuilt = createPostgresOperationDispatchConsumption(pool(), selection); t.after(rebuilt.dispose);
    assert.deepEqual(await rebuilt.dispatchConsumption.publishAndConsumeForDispatch(op.prepared, op.request), {kind: "indeterminate"});
    assert.deepEqual(await rebuilt.dispatchConsumption.publishAndConsumeForDispatch(opA.prepared, opA.request), resultA);
    const settlements = await Promise.all([rebuilt.dispatchConsumption.settleDispatchConsumption(settlementFor(resultA.receipt)),
      two.dispatchConsumption.settleDispatchConsumption(settlementFor(resultB.receipt))]);
    assert.deepEqual(settlements.map(value => value.kind), ["settled", "settled"]);
    assert.deepEqual(await rebuilt.dispatchConsumption.settleDispatchConsumption(settlementFor(resultA.receipt)), settlements[0]);
    const changed = {...settlementFor(resultA.receipt), settlementRequestId: "settlement:alternate", disposition: "claim_committed" as const};
    assert.equal((await rebuilt.dispatchConsumption.settleDispatchConsumption(changed)).kind, "conflict");
  });

  await t.test("rotation/new issuance cannot replace A or allow another consumption; replay never extends windows", async () => {
    const rotated = {...selection.binding, bindingRevision: 8, credentialGeneration: 4, credentialBindingDigest: fixtureHash({material: "rotated"})};
    assert.equal(await material.replaceBinding(rotated, 2), 3);
    const nextSelection = {...selection, binding: rotated, materializationHeadVersion: 3, issuanceRef: "issuance:operator:rotation"};
    const next = createPostgresOperationDispatchConsumption(pool(), nextSelection); t.after(next.dispose); await next.control.provisionIssuance();
    const replacement = await resolve("operation:A", "grant:rotation");
    assert.equal((await next.dispatchConsumption.publishAndConsumeForDispatch(replacement.prepared, replacement.request)).kind, "conflict");
    const fresh = await resolve("operation:rotation-new");
    assert.equal((await next.dispatchConsumption.publishAndConsumeForDispatch(fresh.prepared, fresh.request)).kind, "consumed");
    await a.query("UPDATE provider_access.dispatch_operation_owner_v2 SET control_time=$1", [String(selection.expiresAtControlTime + 1)]);
    assert.deepEqual(await next.dispatchConsumption.publishAndConsumeForDispatch(opA.prepared, opA.request), resultA);
    const expired = await resolve("operation:expired");
    assert.deepEqual(await next.dispatchConsumption.publishAndConsumeForDispatch(expired.prepared, expired.request), {kind: "indeterminate"});
  });
});
