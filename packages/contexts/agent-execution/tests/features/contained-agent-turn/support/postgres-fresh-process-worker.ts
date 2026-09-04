import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyContainedTurnPostgresSchema, CONTAINED_TURN_POSTGRES_MIGRATIONS } from "../../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-schema.js";
import { PostgresContainedTurnOperationStore } from "../../../../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { containedTurnApplicationView } from "../../../../dist/features/contained-agent-turn/application/contained-turn-engine.js";
import { containedTurnOutputWriteAuthority } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";
import { containedTurnIdentity } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { mutateContainedTurnOperation } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import { operationAuthority, operationForProject, resetSchema, runtimeQuery, withPool } from "../postgres-contained-turn-test-helpers.ts";
import { preparePostgresClaim } from "./postgres-committed-dispatch-fixture.ts";

const history = async (pool: Parameters<typeof resetSchema>[0]) => (await pool.query(
  "SELECT version,migration_digest,predecessor_digest,applied_at::text FROM agent_execution.schema_migration_history ORDER BY version",
)).rows;

const seed = async (pool: Parameters<typeof resetSchema>[0]) => {
  await resetSchema(pool);
  const fixture = await preparePostgresClaim(pool, "fresh-process");
  const { store, bound, claim } = fixture;
  const claimed = await store.claimPreparedDispatch(claim.claimInput);
  assert.equal(claimed.kind, "claimed");
  if (claimed.kind !== "claimed") {throw new Error("missing committed claim");}
  const subject = claim.subject;
  const started = mutateContainedTurnOperation(claimed.operation, {
    kind: "record_process_start",
    proof: {
      binding: {
        operationId: bound.operationId, effectId: bound.effectId,
        authorityVectorDigest: bound.acceptedAuthorityVectorDigest,
        attemptId: subject.attemptId, custodyId: subject.custodyId,
        hostBootId: subject.hostBootId, hostInstanceId: subject.hostInstanceId,
      },
      kind: "provider_process_start",
      proofId: containedTurnIdentity("proof", "proof:fresh-process-start"),
    },
  });
  assert.equal((await store.commit({ authority: operationAuthority(bound), candidate: started,
    expectedRevision: claimed.operation.revision })).kind, "applied");
  const output = await store.appendOutput({ authority: operationAuthority(bound),
    expectedRevision: started.revision, expectedCursor: 0,
    outputAuthority: containedTurnOutputWriteAuthority(started),
    output: { cursor: 0, kind: "assistant", text: "committed before process exit" } });
  assert.equal(output.kind, "applied");
  if (output.kind !== "applied") {throw new Error("missing committed output");}
  const ambiguous = mutateContainedTurnOperation(output.operation, {
    kind: "record_ambiguity", evidenceId: containedTurnIdentity("evidence", "evidence:fresh-process-ambiguous"),
  });
  assert.equal((await store.commit({ authority: operationAuthority(bound), candidate: ambiguous,
    expectedRevision: output.operation.revision })).kind, "applied");
  assert.equal(containedTurnApplicationView(ambiguous).status, "reconcile_required");
  const other = operationForProject("project:fresh-process-other", "fresh-process-other");
  assert.equal((await store.accept(other, operationAuthority(other))).kind, "accepted");
  const otherTenant = operationForProject(bound.scope.projectId, "fresh-process-tenant", bound.commandId, "tenant:other");
  assert.equal((await store.accept(otherTenant, operationAuthority(otherTenant))).kind, "accepted");
  const corrupt = operationForProject("project:fresh-process-corrupt", "fresh-process-corrupt");
  assert.equal((await store.accept(corrupt, operationAuthority(corrupt))).kind, "accepted");
  await runtimeQuery(pool, "UPDATE agent_execution.contained_turn_operation_v1 SET state_digest=repeat('0',64) WHERE operation_id=$1", [corrupt.operationId]);
  return { pid: process.pid, bound, claimInput: claim.claimInput, ambiguous, other, otherTenant, corrupt,
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
  const store = new PostgresContainedTurnOperationStore({ pool });
  const { ambiguous, bound, other, otherTenant, corrupt } = snapshot;
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
  assert.equal(await store.read({ operationId: bound.operationId, scope: other.scope }), undefined);
  assert.equal((await store.accept(bound, operationAuthority(bound))).kind, "replayed");
  assert.equal((await store.accept(other, operationAuthority(other))).kind, "replayed");
  assert.equal((await store.accept(otherTenant, operationAuthority(otherTenant))).kind, "replayed");
  assert.equal(await store.read({ operationId: bound.operationId, scope: otherTenant.scope }), undefined);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const replay = await store.claimPreparedDispatch(snapshot.claimInput);
    assert.equal(replay.kind, "observed_claim");
    assert.equal("committedDispatchProof" in replay, false);
    await assert.rejects(store.prepareDispatch({ authority: operationAuthority(bound), operation: bound }),
      /revision fence/u);
    const recovered = await store.read({ operationId: bound.operationId, scope: bound.scope });
    assert.deepEqual(recovered, ambiguous);
    assert.equal(containedTurnApplicationView(recovered!).status, "reconcile_required");
    assert.deepEqual(await store.listDispatchPreparations({ scope: bound.scope }), []);
    await assert.rejects(store.read({ operationId: corrupt.operationId, scope: corrupt.scope }), /state digest mismatch/u);
  }
  const attempts = await pool.query("SELECT state->'payload'->>'attemptId' AS attempt_id FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1", [bound.operationId]);
  assert.deepEqual(attempts.rows, [{ attempt_id: snapshot.claimInput.subject.attemptId }]);
  const receipts = await pool.query("SELECT receipt_ref FROM agent_execution.contained_turn_receipt_v1 WHERE operation_id=$1 ORDER BY receipt_ref", [bound.operationId]);
  assert.deepEqual(receipts.rows.map(row => row.receipt_ref), ambiguous.proofs.map(proof => proof.proofId).toSorted());
  const outputs = await pool.query("SELECT cursor,output_kind,output_text FROM agent_execution.contained_turn_output_v1 WHERE operation_id=$1 ORDER BY cursor", [bound.operationId]);
  assert.deepEqual(outputs.rows, [{ cursor: 0, output_kind: "assistant", output_text: "committed before process exit" }]);
  await pool.query("UPDATE agent_execution.schema_migration SET migration_digest=repeat('1',64)");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(applyContainedTurnPostgresSchema(pool), /schema identity mismatch/u);
  }
  return { pid: process.pid, recovered: true };
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
