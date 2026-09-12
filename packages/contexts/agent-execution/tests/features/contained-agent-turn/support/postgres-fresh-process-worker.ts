import { intentAuthority, intentHarness, prevention, submission } from "./intent-guard-fixture.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyContainedTurnPostgresSchema, CONTAINED_TURN_POSTGRES_MIGRATIONS } from "../../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-schema.js";
import { PostgresContainedTurnOperationStore } from "../../../../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { containedTurnApplicationView } from "../../../../dist/features/contained-agent-turn/application/contained-turn-engine.js";
import { operationAuthority, operationForProject, resetSchema, runtimeQuery, withPool } from "../postgres-contained-turn-test-helpers.ts";
import { createPostgresReplayApplication } from "./postgres-replay-application.ts";
import { seedScopedPreparations, verifyScopedPreparations } from "./postgres-scoped-preparations.ts";

const history = async (pool: Parameters<typeof resetSchema>[0]) => (await pool.query(
  "SELECT version,migration_digest,predecessor_digest,applied_at::text FROM agent_execution.schema_migration_history ORDER BY version",
)).rows;

const seed = async (pool: Parameters<typeof resetSchema>[0]) => {
  await resetSchema(pool);
  const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
  const scope = { projectId: "project:fresh-process", tenantId: "tenant:postgres-durability" };
  const fixture = createPostgresReplayApplication(store, scope);
  const input = {
    commandId: "command:fresh-process", expectedProvider: "codex" as const,
    intent: { mode: "analysis" as const, prompt: "Inspect the disposable workspace." }, scope,
  };
  const submitted = await fixture.application.submit(input);
  assert.equal(submitted.status, "observed");
  if (submitted.status !== "observed") {throw new Error("missing committed submission");}
  const ambiguous = submitted.operation;
  assert.equal(fixture.providerCalls.value, 1);
  assert.equal(fixture.starts.value, 1);
  assert.equal(fixture.claims.length, 1);
  assert.equal(ambiguous.providerProcessStart.kind, "execution_started");
  assert.equal(containedTurnApplicationView(ambiguous).status, "reconcile_required");
  assert.deepEqual(await store.read({ operationId: ambiguous.operationId, scope }), ambiguous);
  const other = operationForProject("project:fresh-process-other", "fresh-process-other", ambiguous.commandId);
  assert.equal((await store.accept(other, operationAuthority(other))).kind, "accepted");
  const otherTenant = operationForProject(ambiguous.scope.projectId, "fresh-process-tenant", ambiguous.commandId, "tenant:other");
  assert.equal((await store.accept(otherTenant, operationAuthority(otherTenant))).kind, "accepted");
  const corrupt = operationForProject("project:fresh-process-corrupt", "fresh-process-corrupt");
  assert.equal((await store.accept(corrupt, operationAuthority(corrupt))).kind, "accepted");
  await runtimeQuery(pool, "UPDATE agent_execution.contained_turn_operation_v1 SET state_digest=repeat('0',64) WHERE operation_id=$1", [corrupt.operationId]);
  const preparations = await seedScopedPreparations(store, scope);
  const negative = await intentHarness(pool).feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
  assert.equal(negative.kind, "committed");
  return { pid: process.pid, input, providerCalls: fixture.providerCalls.value,
    negative, claimInput: fixture.claims[0]!, ambiguous, other, otherTenant, corrupt, preparations,
    migrations: await history(pool) };
};

type Snapshot = Awaited<ReturnType<typeof seed>>;
const recover = async (pool: Parameters<typeof resetSchema>[0], snapshot: Snapshot) => {
  assert.notEqual(process.pid, snapshot.pid);
  await applyContainedTurnPostgresSchema(pool);
  assert.deepEqual(await history(pool), snapshot.migrations);
  assert.deepEqual(snapshot.migrations.map(row => ({ version: row.version, digest: row.migration_digest,
    predecessorDigest: row.predecessor_digest })), CONTAINED_TURN_POSTGRES_MIGRATIONS.map(row => ({
    version: row.version, digest: row.digest, predecessorDigest: row.predecessorDigest ?? null,
  })));
  const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
  const prevented = intentHarness(pool);
  assert.deepEqual(await prevented.feature.cancel.execute({ prevention: prevention(), scope: submission.scope }), snapshot.negative);
  assert.deepEqual(await prevented.feature.submit.execute(submission), { status: "denied" });
  assert.equal(prevented.counts.provider, 0);
  assert.equal(prevented.counts.workspace, 0);
  assert.equal((await runtimeQuery(pool, "SELECT 1 FROM agent_execution.contained_turn_operation_v1 WHERE tenant_id=$1 AND project_id=$2 AND command_id=$3", [submission.scope.tenantId, submission.scope.projectId, submission.commandId])).rowCount, 0);
  const { ambiguous, other, otherTenant, corrupt } = snapshot;
  const fixture = createPostgresReplayApplication(store, ambiguous.scope);
  assert.equal(snapshot.providerCalls, 1);
  await verifyScopedPreparations(store, snapshot.preparations);
  for (const operation of [ambiguous, other, otherTenant]) {
    assert.deepEqual(await store.read({ operationId: operation.operationId, scope: operation.scope }), operation);
    for (const scope of [
      { ...operation.scope, projectId: "project:foreign" },
      { ...operation.scope, tenantId: "tenant:foreign" },
    ]) {
      assert.equal(await store.read({ operationId: operation.operationId, scope }), undefined);
      assert.deepEqual(await store.listDispatchPreparations({ scope }), []);
    }
  }
  assert.equal(await store.read({ operationId: ambiguous.operationId, scope: other.scope }), undefined);
  for (const operation of [ambiguous, other, otherTenant]) {
    const candidate = operationForProject(operation.scope.projectId, `replay-${operation.operationId}`,
      operation.commandId, operation.scope.tenantId);
    assert.notEqual(candidate.operationId, operation.operationId);
    assert.notEqual(candidate.effectId, operation.effectId);
    const replay = await store.accept(candidate, operationAuthority(candidate));
    assert.equal(replay.kind, "replayed");
    if (replay.kind !== "replayed") {throw new Error("missing winning acceptance");}
    assert.deepEqual(replay.operation, operation);
    assert.equal(await store.read({ operationId: candidate.operationId, scope: candidate.scope }), undefined);
  }
  assert.equal(await store.read({ operationId: ambiguous.operationId, scope: otherTenant.scope }), undefined);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const replay = await store.claimPreparedDispatch(snapshot.claimInput);
    assert.equal(replay.kind, "observed_claim");
    assert.equal("committedDispatchProof" in replay, false);
    assert.deepEqual(replay.operation, ambiguous);
    const accepted: unknown[] = [];
    const submitted = await fixture.application.submit(snapshot.input, {
      onAccepted: operation => {accepted.push(operation);},
    });
    assert.deepEqual(submitted, { status: "observed", operation: ambiguous });
    assert.deepEqual(accepted, [ambiguous]);
    assert.deepEqual(await fixture.application.observe({ operationId: ambiguous.operationId, scope: ambiguous.scope }),
      { status: "observed", operation: ambiguous });
    assert.deepEqual(await fixture.application.submit({
      ...snapshot.input, intent: { ...snapshot.input.intent, prompt: "Changed semantics after restart." },
    }), { status: "conflict", code: "command_fingerprint_conflict" });
    assert.equal(fixture.providerCalls.value, 0);
    assert.equal(fixture.starts.value, 0);
    assert.equal(fixture.claims.length, 0);
    const recovered = await store.read({ operationId: ambiguous.operationId, scope: ambiguous.scope });
    assert.deepEqual(recovered, ambiguous);
    assert.equal(containedTurnApplicationView(recovered!).status, "reconcile_required");
    await verifyScopedPreparations(store, snapshot.preparations);
    await assert.rejects(store.read({ operationId: corrupt.operationId, scope: corrupt.scope }), /state digest mismatch/u);
  }
  const attempts = await pool.query("SELECT state->'payload'->>'attemptId' AS attempt_id FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1", [ambiguous.operationId]);
  assert.deepEqual(attempts.rows, [{ attempt_id: snapshot.claimInput.subject.attemptId }]);
  const receipts = await pool.query("SELECT receipt_ref FROM agent_execution.contained_turn_receipt_v1 WHERE operation_id=$1 ORDER BY receipt_ref", [ambiguous.operationId]);
  assert.deepEqual(receipts.rows.map(row => row.receipt_ref), ambiguous.proofs.map(proof => proof.proofId).toSorted());
  const outputs = await pool.query("SELECT cursor,output_kind,output_text FROM agent_execution.contained_turn_output_v1 WHERE operation_id=$1 ORDER BY cursor", [ambiguous.operationId]);
  assert.deepEqual(outputs.rows, [{ cursor: 0, output_kind: "assistant", output_text: "committed before process exit" }]);
  await pool.query("UPDATE agent_execution.schema_migration SET migration_digest=repeat('1',64)");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(applyContainedTurnPostgresSchema(pool), /schema identity mismatch/u);
  }
  return { pid: process.pid, recovered: true, preventedReceiptReplayed: true, providerCalls: fixture.providerCalls.value,
    totalProviderCalls: snapshot.providerCalls + fixture.providerCalls.value };
};

assert.ok(process.env.POSTGRES_DURABILITY_URL?.trim(), "fresh process requires POSTGRES_DURABILITY_URL");
const phase = process.argv[2];
assert.ok(phase === "seed" || phase === "recover", "unknown recovery phase");
let result: unknown;
await withPool(async pool => {
  result = phase === "seed" ? await seed(pool) : await recover(pool, JSON.parse(readFileSync(0, "utf8")) as Snapshot);
});
// Only JSON crosses the process boundary, after the pool has closed.
process.stdout.write(JSON.stringify(result));
