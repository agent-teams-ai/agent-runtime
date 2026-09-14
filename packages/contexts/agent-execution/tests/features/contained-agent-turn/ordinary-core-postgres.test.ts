import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {Pool} from "pg";
import {applyOrdinaryPostgresSchema, PostgresOrdinaryOperationStore} from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/ordinary-postgres-store.js";
import type {OrdinaryAuthoritySnapshot, OrdinaryOperation} from "../../../dist/features/contained-agent-turn/domain/ordinary-model.js";

const connectionString = process.env.ORDINARY_TEST_POSTGRES_URL;
test("disposable PostgreSQL ordinary namespace: concurrent accept and claim, durable restart and scope isolation", {skip: connectionString === undefined}, async () => {
  const schema = `ordinary_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({connectionString, max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000});
  const pool = new Pool({connectionString, options: `-c search_path=${schema}`, max: 4, connectionTimeoutMillis: 5000, query_timeout: 10000});
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); await applyOrdinaryPostgresSchema(pool);
    const store = new PostgresOrdinaryOperationStore({pool});
    const input = {commandId: "test", expectedProvider: "codex", intent: {mode: "workspace-write", prompt: "write a result"}, scope: {tenantId: "test", projectId: "disposable"}} as const;
    const accepted = await Promise.all(Array.from({length: 8}, () => store.accept(input)));
    assert.equal(accepted.filter(item => item.kind === "accepted").length, 1);
    const acceptedOwner = accepted.find(item => item.kind === "accepted"); assert.ok(acceptedOwner && acceptedOwner.kind === "accepted");
    assert.equal(new Set(accepted.flatMap(item => item.kind === "accepted" || item.kind === "duplicate" ? [item.operation.operationId] : [])).size, 1);
    assert.equal((await store.accept({...input, intent: {...input.intent, prompt: "different"}})).kind, "conflict");
    const authority = (operation: OrdinaryOperation, owner: OrdinaryAuthoritySnapshot["owner"]): OrdinaryAuthoritySnapshot => ({operationId: operation.operationId, attemptId: operation.attemptId, executionProfile: operation.executionProfile, capabilityManifestRevision: operation.capabilityManifestRevision, owner, grantId: owner, ownerReceiptId: `receipt:${owner}`, consumptionDigest: "a".repeat(64), consumptionRevision: 1, authorityDigest: "b".repeat(64), expiresAt: Date.now() + 55000, scope: input.scope, provider: "codex"});
    const prepared = await store.prepare(acceptedOwner.operation, {providerAccess: authority(acceptedOwner.operation, "provider_access"), security: authority(acceptedOwner.operation, "runtime_security"), reservationId: "reservation:test", workspaceId: "workspace:test", materializationId: "materialization:test", credentialGeneration: 1});
    const claimed = await Promise.all(Array.from({length: 8}, () => store.claim(prepared)));
    assert.equal(claimed.filter(item => item.kind === "claimed").length, 1);
    const restarted = new PostgresOrdinaryOperationStore({pool});
    const ref = {operationId: acceptedOwner.operation.operationId, scope: input.scope};
    assert.equal((await restarted.read(ref))?.status, "running");
    assert.equal(await restarted.read({...ref, scope: {...input.scope, tenantId: "other"}}), undefined);
    assert.equal((await restarted.cancel(ref))?.cancellationRequested, true);
    assert.equal((await restarted.claim(prepared)).kind, "not_claimed");
    // The adapter borrows this pool; reconstructing stores never closes it.
    assert.equal((await pool.query("SELECT 1 AS alive")).rows[0].alive, 1);
  } finally {await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();}
});

test("ordinary reads and migrations bound exhausted-pool acquisition and release late clients", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  const waiting: ((client: import("../../../dist/features/contained-agent-turn/adapters/outbound/postgres/ordinary-postgres-store.js").OrdinaryPostgresClient) => void)[] = [];
  let released = 0;
  const pool = {connect: () => new Promise<import("../../../dist/features/contained-agent-turn/adapters/outbound/postgres/ordinary-postgres-store.js").OrdinaryPostgresClient>(resolve => {waiting.push(resolve);})};
  const store = new PostgresOrdinaryOperationStore({pool});
  const pending = [assert.rejects(store.read({operationId: "test", scope: {tenantId: "test", projectId: "test"}}), /acquisition timed out/), assert.rejects(applyOrdinaryPostgresSchema(pool), /acquisition timed out/)];
  t.mock.timers.tick(5001); await Promise.all(pending);
  for (const resolve of waiting) {resolve({query: async () => {throw new Error("must not query a late client");}, release: () => {released++;}});}
  await Promise.resolve(); assert.equal(released, 2);
});

test("stalled acquired-client query is bounded and discarded exactly once", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  let entered!: () => void; const ready = new Promise<void>(resolve => {entered = resolve;});
  const releases: (boolean | undefined)[] = [];
  const pool = {async connect() {return {query: async () => {entered(); return new Promise<never>(() => {});}, release: (discard?: boolean) => {releases.push(discard);}};}};
  const store = new PostgresOrdinaryOperationStore({pool});
  const result = assert.rejects(store.cancel({operationId: "test", scope: {tenantId: "test", projectId: "test"}}), /query timed out/);
  await ready; t.mock.timers.tick(5001); await result;
  assert.deepEqual(releases, [true]);
});
