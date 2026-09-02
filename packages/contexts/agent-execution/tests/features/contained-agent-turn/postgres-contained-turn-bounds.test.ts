import assert from "node:assert/strict";
import test from "node:test";

import { ContainedTurnPostgresOperationRepository } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-operation-repository.js";
import {
  backfillContainedTurnPreparationDigests,
  validateContainedTurnLegacyOperationDigests,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-schema-migrator.js";
import {
  CONTAINED_TURN_POSTGRES_JSON_BUDGET,
  CONTAINED_TURN_POSTGRES_MATERIALIZATION_BUDGET,
  ContainedTurnStateBudgetError,
  digestContainedTurnPostgresJson,
  encodeContainedTurnState,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-state-codec.js";
import { encodeContainedTurnPreparation } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-preparation-codec.js";
import { PostgresContainedTurnOperationStore } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { retireContainedTurnDispatchPreparation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-preparation.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import {
  operationAuthority,
  operationForProject,
  postgresTest,
  resetSchema,
  runtimeQuery,
  withPool,
} from "./postgres-contained-turn-test-helpers.ts";

const operationRow = (suffix: string) => {
  const operation = operationForProject(`project:${suffix}`, suffix);
  const encoded = encodeContainedTurnState(operation);
  return {
    operation,
    row: {
      command_fingerprint: operation.commandFingerprint,
      command_id: operation.commandId,
      effect_id: operation.effectId,
      operation_id: operation.operationId,
      project_id: operation.scope.projectId,
      revision: String(operation.revision),
      state: JSON.parse(encoded.json),
      state_bytes: Buffer.byteLength(encoded.json),
      state_codec_version: encoded.codecVersion,
      state_digest: encoded.digest,
      state_within_budget: true,
      tenant_id: operation.scope.tenantId,
      terminal: false,
    },
  };
};

for (const corrupt of ["output", "receipt"] as const) {
  test(`${corrupt} projection excess is rejected from bounded metadata before row materialization`, async () => {
    const fixture = operationRow(`bounded-${corrupt}`);
    const queries: string[] = [];
    const client = { query: async (sql: string) => {
      queries.push(sql);
      if (queries.length === 1) {return { rows: [fixture.row] };}
      return { rows: [{
        output_bytes: "0",
        output_count: String(fixture.operation.output.chunks.length + (corrupt === "output" ? 1 : 0)),
        receipt_bytes: "0",
        receipt_count: String(fixture.operation.proofs.length + (corrupt === "receipt" ? 1 : 0)),
      }] };
    } };
    await assert.rejects(
      new ContainedTurnPostgresOperationRepository().load(
        client as never, fixture.operation.operationId, false, fixture.operation.scope,
      ),
      /projection cardinality mismatch/u,
    );
    assert.equal(queries.length, 2);
    assert.match(queries[1] ?? "", /count\(\*\)[\s\S]*sum\(octet_length/u);
    assert.doesNotMatch(queries[1] ?? "", /SELECT cursor|SELECT receipt_kind/u);
  });

  postgresTest(`${corrupt} projection corruption fails closed against PostgreSQL`, async () => {
    await withPool(async pool => {
      await resetSchema(pool);
      const operation = operationForProject(`project:corrupt-${corrupt}`, `corrupt-${corrupt}`);
      const store = new PostgresContainedTurnOperationStore({ pool });
      assert.equal((await store.accept(operation, operationAuthority(operation))).kind, "accepted");
      await runtimeQuery(pool, corrupt === "output"
        ? `INSERT INTO agent_execution.contained_turn_output_v1
             (operation_id,cursor,output_kind,output_text) VALUES ($1,0,'diagnostic','corrupt')`
        : `INSERT INTO agent_execution.contained_turn_receipt_v1
             (operation_id,receipt_kind,receipt_ref) VALUES ($1,'corrupt','receipt:corrupt')`,
      [operation.operationId]);
      await assert.rejects(
        store.read({ operationId: operation.operationId, scope: operation.scope }),
        /projection cardinality mismatch/u,
      );
    });
  });
}

test("legacy preparation digest backfill advances in deterministic bounded keyset batches", async () => {
  const operationId = "operation:migration-batches";
  const preparation = {
    attemptId: containedTurnIdentity("attempt", "attempt:migration-batches"),
    custodyId: containedTurnIdentity("custody", "custody:migration-batches"),
    kind: "active" as const,
    operationCutoffRevision: 0,
    operationId,
    preparationToken: containedTurnIdentity("preparation", "preparation:migration-batches"),
    preparedOperationRevision: 0,
    providerAccessGrantRequestId: null,
    runtimeSecurityGrantRequestId: null,
    workspaceId: containedTurnIdentity("workspace", "workspace:migration-batches"),
  };
  const encoded = encodeContainedTurnPreparation(preparation);
  const batchSize = CONTAINED_TURN_POSTGRES_MATERIALIZATION_BUDGET.migrationBatchRows;
  let selects = 0;
  let updates = 0;
  const client = { query: async (sql: string) => {
    if (sql.startsWith("LOCK TABLE")) {return { rows: [] };}
    if (sql.includes("SELECT operation_id, preparation_token")) {
      selects += 1;
      const count = selects === 1 ? batchSize : selects === 2 ? 1 : 0;
      return { rows: Array.from({ length: count }, (_unused, index) => ({
        operation_id: operationId,
        preparation_token: `${preparation.preparationToken}:${String((selects - 1) * batchSize + index).padStart(4, "0")}`,
        state: JSON.parse(encoded.json),
        state_bytes: Buffer.byteLength(encoded.json),
        state_codec_version: encoded.codecVersion,
      })) };
    }
    updates += 1;
    return { rowCount: 1, rows: [] };
  } };
  await backfillContainedTurnPreparationDigests(client as never);
  assert.equal(selects, 2);
  assert.equal(updates, batchSize + 1);
});

test("legacy operation validation rejects cumulative bytes across bounded batches", async () => {
  const state = { schemaVersion: 1 };
  const digest = digestContainedTurnPostgresJson(state);
  let selects = 0;
  const client = { query: async (sql: string) => {
    if (sql.startsWith("LOCK TABLE")) {return { rows: [] };}
    selects += 1;
    return { rows: Array.from(
      { length: CONTAINED_TURN_POSTGRES_MATERIALIZATION_BUDGET.migrationBatchRows },
      (_unused, index) => ({
        operation_id: `operation:aggregate-overflow:${String(selects).padStart(2, "0")}:${String(index).padStart(3, "0")}`,
        state,
        state_bytes: CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumSerializedBytes /
          CONTAINED_TURN_POSTGRES_MATERIALIZATION_BUDGET.migrationBatchRows,
        state_digest: digest,
      }),
    ) };
  } };
  await assert.rejects(
    validateContainedTurnLegacyOperationDigests(client as never),
    (error: unknown) => error instanceof ContainedTurnStateBudgetError,
  );
  assert.equal(selects, 5);
});

postgresTest("supported-codec active and cleanup debt cannot disappear through unverified kind", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const store = new PostgresContainedTurnOperationStore({ pool });
    const operation = operationForProject("project:kind-corruption", "kind-corruption");
    assert.equal((await store.accept(operation, operationAuthority(operation))).kind, "accepted");
    const missingToken = "preparation:000-missing-active-kind";
    const active = {
      attemptId: containedTurnIdentity("attempt", "attempt:kind-corruption"),
      custodyId: containedTurnIdentity("custody", "custody:kind-corruption"),
      kind: "active" as const,
      operationCutoffRevision: operation.operationCutoff.revision,
      operationId: operation.operationId,
      preparationToken: missingToken,
      preparedOperationRevision: operation.revision,
      providerAccessGrantRequestId: null,
      runtimeSecurityGrantRequestId: null,
      workspaceId: containedTurnIdentity("workspace", "workspace:kind-corruption"),
    };
    const activeState = JSON.parse(encodeContainedTurnPreparation(active).json) as {
      payload: Record<string, unknown>;
    };
    delete activeState.payload.kind;
    const missingKind = activeState;
    await runtimeQuery(pool,
      `INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1
         (operation_id,preparation_token,state_codec_version,state,state_digest)
       VALUES ($1,$2,4,$3::jsonb,$4)`,
      [operation.operationId, missingToken, JSON.stringify(missingKind),
        digestContainedTurnPostgresJson(missingKind)],
    );
    assert.deepEqual(await store.listDispatchPreparations({ scope: operation.scope }), []);
    assert.deepEqual((await runtimeQuery<{ reason: string }>(pool,
      `SELECT reason FROM agent_execution.contained_turn_dispatch_preparation_quarantine_v1
        WHERE operation_id=$1 AND preparation_token=$2`,
      [operation.operationId, missingToken])).rows[0], { reason: "malformed" });

    const cleanupToken = "preparation:100-altered-cleanup-kind";
    const cleanup = retireContainedTurnDispatchPreparation({
      ...active,
      preparationToken: cleanupToken,
    }, "kind-corruption-cleanup");
    assert.equal(cleanup.kind, "cleanup_pending");
    const encodedCleanup = encodeContainedTurnPreparation(cleanup);
    const alteredCleanup = JSON.parse(encodedCleanup.json) as { payload: Record<string, unknown> };
    alteredCleanup.payload.kind = "claimed";
    await runtimeQuery(pool,
      `INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1
         (operation_id,preparation_token,state_codec_version,state,state_digest)
       VALUES ($1,$2,4,$3::jsonb,$4)`,
      [operation.operationId, cleanupToken, JSON.stringify(alteredCleanup), encodedCleanup.digest],
    );
    await assert.rejects(
      store.listDispatchPreparations({ scope: operation.scope }),
      /preparation digest mismatch/u,
    );
  });
});

postgresTest("later operation projection overflow outranks an earlier preparation digest", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const store = new PostgresContainedTurnOperationStore({ pool });
    const first = operationForProject("project:cumulative-recovery", "000-cumulative-recovery");
    const later = operationForProject("project:cumulative-recovery", "zzz-cumulative-recovery");
    for (const operation of [first, later]) {
      assert.equal((await store.accept(operation, operationAuthority(operation))).kind, "accepted");
      await runtimeQuery(pool,
        `INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1
           (operation_id,preparation_token,state_codec_version,state,state_digest)
         VALUES ($1,$2,4,jsonb_build_object('codecVersion',4,'payload',jsonb_build_object('kind','active')),repeat('0',64))`,
        [operation.operationId, `preparation:${operation.operationId}`],
      );
    }
    await runtimeQuery(pool,
      `INSERT INTO agent_execution.contained_turn_output_v1(operation_id,cursor,output_kind,output_text)
       VALUES ($1,0,'diagnostic',repeat('x',$2))`,
      [later.operationId, CONTAINED_TURN_POSTGRES_MATERIALIZATION_BUDGET.maximumBatchBytes],
    );
    await assert.rejects(
      store.listDispatchPreparations({ scope: first.scope }),
      (error: unknown) => error instanceof ContainedTurnStateBudgetError,
    );
  });
});
