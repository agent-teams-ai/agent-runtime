import { seedLegacyIntentOperation } from "./support/intent-guard-legacy-fixture.ts";
import { intentAuthority } from "./support/intent-guard-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { type Pool, type PoolClient } from "pg";

import {
  applyContainedTurnPostgresSchema,
  ContainedTurnPostgresLegacyConversionRequiredError,
  CONTAINED_TURN_POSTGRES_MIGRATIONS,
  CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE,
  CONTAINED_TURN_POSTGRES_V1_DATA_DIAGNOSTIC,
  rollbackContainedTurnPostgresSchemaV4,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-schema.js";
import {
  decodeContainedTurnPreparation,
  encodeContainedTurnPreparation,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-preparation-codec.js";
import {
  ContainedTurnStateQuarantineError,
  ContainedTurnStateBudgetError,
  CONTAINED_TURN_POSTGRES_JSON_BUDGET,
  CONTAINED_TURN_STATE_BUDGET_DIAGNOSTIC,
  decodeContainedTurnState,
  digestContainedTurnPostgresJson,
  encodeContainedTurnState,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-state-codec.js";
import { PostgresContainedTurnOperationStore } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { mutateContainedTurnOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import { createOperation } from "../../contained-turn-kernel-fixtures.ts";
import {
  operationAuthority,
  operationForProject,
  postgresTest,
  resetSchema,
  runtimeQuery,
  withPool,
} from "./postgres-contained-turn-test-helpers.ts";
import { postgresClaimInput } from "./support/postgres-committed-dispatch-fixture.ts";

const assertStateBudgetRejected = (candidate: unknown): void => {
  assert.throws(
    () => digestContainedTurnPostgresJson(candidate),
    (error: unknown) => error instanceof ContainedTurnStateBudgetError &&
      error.message === CONTAINED_TURN_STATE_BUDGET_DIAGNOSTIC,
  );
};

test("versioned state and preparation codecs upcast, round-trip, and quarantine corruption", () => {
  const operation = operationForProject("project:codec", "codec");
  const encoded = encodeContainedTurnState(operation);
  assert.equal(encoded.codecVersion, 2);
  assert.deepEqual(decodeContainedTurnState(JSON.parse(encoded.json), encoded.digest, 2), operation);
  assert.throws(
    () => decodeContainedTurnState(JSON.parse(encoded.json), "0".repeat(64), 2),
    /state digest mismatch/u,
  );

  const legacy = { ...operation, schemaVersion: 1 };
  const legacyDigest = digestContainedTurnPostgresJson(legacy);
  const upcast = decodeContainedTurnState(legacy, legacyDigest, 1);
  assert.equal(upcast.schemaVersion, 2);
  assert.equal(upcast.operationId, operation.operationId);
  assert.throws(
    () => decodeContainedTurnState({ codecVersion: 99, payload: operation }, "0".repeat(64), 99),
    (error: unknown) => error instanceof ContainedTurnStateQuarantineError && error.reason === "unsupported_version",
  );

  const preparation = Object.freeze({
    attemptId: containedTurnIdentity("attempt", "attempt:codec"),
    custodyId: containedTurnIdentity("custody", "custody:codec"),
    kind: "active" as const,
    operationCutoffRevision: 0,
    operationId: operation.operationId,
    preparationToken: containedTurnIdentity("preparation", "preparation:codec"),
    preparedOperationRevision: 0,
    providerAccessGrantRequestId: null,
    runtimeSecurityGrantRequestId: null,
    workspaceId: containedTurnIdentity("workspace", "workspace:codec"),
  });
  const encodedPreparation = encodeContainedTurnPreparation(preparation);
  assert.equal(encodedPreparation.codecVersion, 6);
  assert.deepEqual(
    decodeContainedTurnPreparation(
      JSON.parse(encodedPreparation.json), encodedPreparation.digest, encodedPreparation.codecVersion,
    ),
    preparation,
  );
  assert.throws(
    () => decodeContainedTurnPreparation(
      JSON.parse(encodedPreparation.json), "f".repeat(64), encodedPreparation.codecVersion,
    ),
    /preparation digest mismatch/u,
  );
  const v2Preparation = { codecVersion: 2, payload: preparation };
  assert.deepEqual(
    decodeContainedTurnPreparation(
      v2Preparation, digestContainedTurnPostgresJson(v2Preparation), 2,
    ),
    preparation,
  );
  const legacyPreparation = {
    ...preparation,
    providerAccessGrantRequestId: "provider-access-grant:legacy-placeholder",
    runtimeSecurityGrantRequestId: "runtime-security-grant:legacy-placeholder",
  };
  assert.deepEqual(
    decodeContainedTurnPreparation(legacyPreparation, null, 1),
    preparation,
  );
});

test("persisted JSON hashing rejects deterministic byte, depth, node, and width excess", () => {
  assertStateBudgetRejected("x".repeat(CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumCanonicalBytes + 1));
  let deep: unknown = null;
  for (let index = 0; index <= CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumDepth; index += 1) {
    deep = { nested: deep };
  }
  assertStateBudgetRejected(deep);
  assertStateBudgetRejected(Array.from({
    length: CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumCollectionWidth + 1,
  }, () => null));
  assertStateBudgetRejected(Array.from({
    length: CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumCollectionWidth,
  }, () => Array.from({ length: 13 }, () => null)));
});

postgresTest("populated genuine v1 fails closed before migration without changing history or data", async () => {
  await withPool(async pool => {
    await resetSchema(pool, 1);
    await pool.query("DROP TABLE agent_execution.schema_migration_history CASCADE");
    const legacyFingerprint = "1".repeat(64);
    const legacy = {
      artifact: { kind: "open" },
      cancellation: { kind: "open" },
      commandFingerprint: legacyFingerprint,
      commandId: "command:legacy-v1",
      containment: { kind: "not_required" },
      cutoff: { kind: "pending" },
      dispatch: { kind: "unclaimed" },
      effect: { kind: "unresolved" },
      effectId: "effect:legacy-v1",
      execution: { kind: "not_started" },
      intent: { mode: "analysis", prompt: "inspect disposable legacy state" },
      operationId: "operation:legacy-v1",
      output: { chunks: [], kind: "open", nextCursor: 0 },
      providerAcceptance: { kind: "unobserved" },
      providerBinding: {
        adapterRevision: "adapter:legacy-v1",
        binaryRevision: "binary:legacy-v1",
        capabilityManifestRevision: "manifest:legacy-v1",
        credentialBindingDigest: "credential:legacy-v1",
        provider: "codex",
        providerRouteRef: "route:legacy-v1",
      },
      receipts: [{ kind: "command_acceptance", receiptRef: "receipt:legacy-v1" }],
      reconciliation: { kind: "none" },
      result: { kind: "unpublished" },
      revision: 0,
      scope: { projectId: "project:legacy-v1", tenantId: "tenant:legacy-v1" },
      securityDecision: { authorityRevision: "authority:legacy-v1", decisionDigest: "decision:legacy-v1" },
      terminal: { kind: "nonterminal" },
      workspace: { kind: "unbound" },
    };
    await pool.query(
      `INSERT INTO agent_execution.contained_turn_operation_v1
         (operation_id,tenant_id,command_id,command_fingerprint,effect_id,revision,state,state_digest,terminal)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,false)`,
      [legacy.operationId, legacy.scope.tenantId, legacy.commandId,
        legacy.commandFingerprint, legacy.effectId, legacy.revision,
        JSON.stringify(legacy), digestContainedTurnPostgresJson(legacy)],
    );
    await pool.query(
      "INSERT INTO agent_execution.contained_turn_output_v1(operation_id,cursor,output_kind,output_text) VALUES ($1,0,'diagnostic','legacy-output')",
      [legacy.operationId],
    );
    await pool.query(
      "INSERT INTO agent_execution.contained_turn_receipt_v1(operation_id,receipt_kind,receipt_ref) VALUES ($1,'legacy','legacy-receipt')",
      [legacy.operationId],
    );
    const snapshot = async () => pool.query(
      `SELECT
        (SELECT row_to_json(m) FROM agent_execution.schema_migration AS m) AS migration,
        (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_id) FROM agent_execution.contained_turn_operation_v1 AS o) AS operations,
        (SELECT jsonb_agg(to_jsonb(x) ORDER BY operation_id,cursor) FROM agent_execution.contained_turn_output_v1 AS x) AS outputs,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY operation_id,receipt_kind) FROM agent_execution.contained_turn_receipt_v1 AS r) AS receipts`,
    );
    const before = (await snapshot()).rows[0];

    await assert.rejects(
      applyContainedTurnPostgresSchema(pool),
      (error: unknown) => error instanceof ContainedTurnPostgresLegacyConversionRequiredError &&
        error.code === "CONTAINED_TURN_POSTGRES_LEGACY_CONVERSION_REQUIRED" &&
        error.message === CONTAINED_TURN_POSTGRES_V1_DATA_DIAGNOSTIC,
    );

    assert.deepEqual((await snapshot()).rows[0], before);
    assert.equal((await pool.query(
      "SELECT to_regclass('agent_execution.schema_migration_history') AS history",
    )).rows[0]?.history, null);
    assert.equal((await pool.query(
      `SELECT count(*)::integer AS count FROM information_schema.columns
        WHERE table_schema='agent_execution' AND table_name='contained_turn_operation_v1'
          AND column_name IN ('project_id','state_codec_version')`,
    )).rows[0]?.count, 0);
  });
});

postgresTest("operation reads reject oversized JSON before pg materializes the selected state", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const operation = operationForProject("project:oversized-state", "oversized-state");
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
    assert.equal((await store.accept(operation, operationAuthority(operation))).kind, "accepted");
    await runtimeQuery(
      pool,
      `UPDATE agent_execution.contained_turn_operation_v1
          SET state=jsonb_set(state,'{payload,oversizedPadding}',to_jsonb(repeat('x',$2)),true),
              state_digest=repeat('0',64)
        WHERE operation_id=$1`,
      [operation.operationId, CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumSerializedBytes + 1],
    );

    await assert.rejects(
      store.read({ operationId: operation.operationId, scope: operation.scope }),
      (error: unknown) => error instanceof ContainedTurnStateBudgetError,
    );
    assert.equal((await runtimeQuery<{ oversized: boolean }>(
      pool,
      `SELECT octet_length(state::text) > $2 AS oversized
         FROM agent_execution.contained_turn_operation_v1 WHERE operation_id=$1`,
      [operation.operationId, CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumSerializedBytes],
    )).rows[0]?.oversized, true);
  });
});

postgresTest("migration chain is exact, serialized, drift-detecting, no-op safe, and reversible", async () => {
  await withPool(async pool => {
    await resetSchema(pool, 1);
    let current = await pool.query("SELECT version, migration_digest FROM agent_execution.schema_migration");
    assert.deepEqual(current.rows[0], { version: 1, migration_digest: CONTAINED_TURN_POSTGRES_MIGRATIONS[0]?.digest });

    await applyContainedTurnPostgresSchema(pool, { targetVersion: 2 });
    await assert.rejects(
      applyContainedTurnPostgresSchema(pool, { targetVersion: 4 }),
      /explicit disposable-test fence bypass/u,
    );
    await applyContainedTurnPostgresSchema(pool, {
      allowUnfencedV4ForTest: true, targetVersion: 4,
    });
    const history = await pool.query(
      "SELECT version,migration_digest,predecessor_digest,applied_at::text FROM agent_execution.schema_migration_history ORDER BY version",
    );
    assert.equal(history.rowCount, 4);
    for (const expected of CONTAINED_TURN_POSTGRES_MIGRATIONS.slice(0, 4)) {
      const actual = history.rows[expected.version - 1];
      assert.equal(actual.version, expected.version);
      assert.equal(actual.migration_digest, expected.digest);
      assert.equal(actual.predecessor_digest, expected.predecessorDigest ?? null);
    }
    const timestamps = history.rows.map(row => row.applied_at);
    await applyContainedTurnPostgresSchema(pool, {
      allowUnfencedV4ForTest: true, targetVersion: 4,
    });
    const noOp = await pool.query(
      "SELECT applied_at::text FROM agent_execution.schema_migration_history ORDER BY version",
    );
    assert.deepEqual(noOp.rows.map(row => row.applied_at), timestamps);
    await assert.rejects(
      pool.query("UPDATE agent_execution.schema_migration_history SET migration_digest = repeat('0', 64) WHERE version = 1"),
      /immutable/u,
    );

    await rollbackContainedTurnPostgresSchemaV4(pool);
    current = await pool.query("SELECT version, migration_digest FROM agent_execution.schema_migration");
    assert.equal(current.rows[0]?.version, 3);
    await applyContainedTurnPostgresSchema(pool, {
      allowUnfencedV4ForTest: true, targetVersion: 4,
    });
    await applyContainedTurnPostgresSchema(pool);

    await pool.query("DROP INDEX agent_execution.contained_turn_operation_v1_scoped_effect_key");
    await assert.rejects(applyContainedTurnPostgresSchema(pool), /catalog drift/u);

    await pool.query("DROP SCHEMA agent_execution CASCADE");
    await Promise.all([
      applyContainedTurnPostgresSchema(pool),
      applyContainedTurnPostgresSchema(pool),
      applyContainedTurnPostgresSchema(pool),
    ]);
    current = await pool.query("SELECT version, migration_digest FROM agent_execution.schema_migration");
    assert.equal(current.rows[0]?.version, 9);

    await pool.query("UPDATE agent_execution.schema_migration SET migration_digest = repeat('1', 64)");
    await assert.rejects(applyContainedTurnPostgresSchema(pool), /schema identity mismatch/u);

    await resetSchema(pool, 2);
    await pool.query("DROP TABLE agent_execution.schema_migration_history CASCADE");
    await pool.query("DROP FUNCTION agent_execution.reject_schema_migration_history_mutation() CASCADE");
    await applyContainedTurnPostgresSchema(pool);
    current = await pool.query("SELECT version, migration_digest FROM agent_execution.schema_migration");
    assert.equal(current.rows[0]?.version, 9);
    assert.equal((await pool.query(
      "SELECT 1 FROM agent_execution.schema_migration_history ORDER BY version",
    )).rowCount, 9);
  });
});

postgresTest("expand migration accepts legacy writes before the contract migration", async () => {
  await withPool(async pool => {
    await resetSchema(pool, 2);
    const operation = operationForProject("project:rolling", "rolling-old");
    const legacy = { ...operation, schemaVersion: 1 };
    await pool.query(
      `INSERT INTO agent_execution.contained_turn_operation_v1
         (operation_id,tenant_id,command_id,command_fingerprint,effect_id,revision,state,state_digest,terminal)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,false)`,
      [operation.operationId, operation.scope.tenantId, operation.commandId,
        operation.commandFingerprint, operation.effectId, operation.revision,
        JSON.stringify(legacy), digestContainedTurnPostgresJson(legacy)],
    );
    for (const proof of operation.proofs) {
      await pool.query(
        "INSERT INTO agent_execution.contained_turn_receipt_v1(operation_id,receipt_kind,receipt_ref) VALUES ($1,$2,$3)",
        [operation.operationId, proof.kind, proof.proofId],
      );
    }
    await applyContainedTurnPostgresSchema(pool, { targetVersion: 3 });
    const legacyPreparation = {
      attemptId: containedTurnIdentity("attempt", "attempt:rolling-legacy"),
      custodyId: containedTurnIdentity("custody", "custody:rolling-legacy"),
      kind: "active",
      operationCutoffRevision: operation.operationCutoff.revision,
      operationId: operation.operationId,
      preparationToken: containedTurnIdentity("preparation", "preparation:rolling-legacy"),
      preparedOperationRevision: operation.revision,
      providerAccessGrantRequestId: "provider-access-grant:legacy-placeholder",
      runtimeSecurityGrantRequestId: "runtime-security-grant:legacy-placeholder",
      workspaceId: containedTurnIdentity("workspace", "workspace:rolling-legacy"),
    };
    await pool.query(
      `INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1
         (operation_id,preparation_token,state)
       VALUES ($1,$2,$3::jsonb)`,
      [operation.operationId, legacyPreparation.preparationToken, JSON.stringify(legacyPreparation)],
    );
    const stored = await new PostgresContainedTurnOperationStore({ intentAuthority, pool, runtimeSchemaVersion: 3 }).read({
      operationId: operation.operationId,
      scope: operation.scope,
    });
    assert.equal(stored?.schemaVersion, 2);
    assert.equal(stored?.scope.projectId, operation.scope.projectId);
    const recoveries = await new PostgresContainedTurnOperationStore({ intentAuthority, pool, runtimeSchemaVersion: 3 })
      .listDispatchPreparations({ scope: operation.scope });
    assert.equal(recoveries[0]?.preparation.providerAccessGrantRequestId, null);
    assert.equal(recoveries[0]?.preparation.runtimeSecurityGrantRequestId, null);
    await applyContainedTurnPostgresSchema(pool, { targetVersion: 6 });
    await assert.rejects(applyContainedTurnPostgresSchema(pool), /refuses populated/u);
    const digestColumn = await runtimeQuery(pool,
      `SELECT state_digest FROM agent_execution.contained_turn_dispatch_preparation_v1
        WHERE operation_id=$1 AND preparation_token=$2`,
      [operation.operationId, legacyPreparation.preparationToken], 6,
    );
    assert.match(digestColumn.rows[0]?.state_digest, /^[a-f0-9]{64}$/u);
  });
});

postgresTest("real codec-1 preparation backfill crosses two page boundaries and reaches V7", async () => {
  await withPool(async pool => {
    await resetSchema(pool, 3);
    const operation = operationForProject("project:legacy-pages", "legacy-pages");
    await seedLegacyIntentOperation(pool, operation, 3);
    const legacyRows = Array.from({ length: 9 }, (_unused, index) => {
      const suffix = String(index).padStart(2, "0");
      return {
        attemptId: containedTurnIdentity("attempt", `attempt:legacy-pages:${suffix}`),
        custodyId: containedTurnIdentity("custody", `custody:legacy-pages:${suffix}`),
        kind: "active",
        operationCutoffRevision: operation.operationCutoff.revision,
        operationId: operation.operationId,
        preparationToken: containedTurnIdentity("preparation", `preparation:legacy-pages:${suffix}`),
        preparedOperationRevision: operation.revision,
        providerAccessGrantRequestId: "provider-access-grant:legacy-placeholder",
        runtimeSecurityGrantRequestId: "runtime-security-grant:legacy-placeholder",
        workspaceId: containedTurnIdentity("workspace", `workspace:legacy-pages:${suffix}`),
      };
    });
    await pool.query(
      `INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1
         (operation_id,preparation_token,state_codec_version,state,state_digest)
       SELECT $1,row.preparation_token,1,row.state,NULL
         FROM jsonb_to_recordset($2::jsonb) AS row(preparation_token text,state jsonb)`,
      [operation.operationId, JSON.stringify(legacyRows.map(row => ({
        preparation_token: row.preparationToken,
        state: row,
      })))],
    );

    await applyContainedTurnPostgresSchema(pool, { targetVersion: 7 });

    const migrated = await pool.query<{ count: number; null_digests: number }>(
      `SELECT count(*)::integer AS count,
              count(*) FILTER (WHERE state_digest IS NULL)::integer AS null_digests
         FROM agent_execution.contained_turn_dispatch_preparation_v1
        WHERE operation_id=$1`,
      [operation.operationId],
    );
    assert.deepEqual(migrated.rows[0], { count: 9, null_digests: 0 });
    assert.deepEqual((await pool.query(
      "SELECT version,migration_digest FROM agent_execution.schema_migration WHERE component=$1",
      [CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE.component],
    )).rows[0], {
      migration_digest: CONTAINED_TURN_POSTGRES_MIGRATIONS[6]?.digest,
      version: 7,
    });
  });
});

postgresTest("contract migration waits for old transactions and durably excludes the old binary", async () => {
  await withPool(async pool => {
    await resetSchema(pool, 4);
    const oldStore = new PostgresContainedTurnOperationStore({ intentAuthority, pool, runtimeSchemaVersion: 4 });
    const operation = operationForProject("project:mixed-version", "mixed-version");
    await seedLegacyIntentOperation(pool, operation, 4);

    const oldTransaction = await pool.connect();
    await oldTransaction.query("BEGIN");
    await oldTransaction.query("SELECT pg_advisory_xact_lock_shared($1)", [
      CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE.advisoryLockId,
    ]);
    const migration = applyContainedTurnPostgresSchema(pool, { targetVersion: 6 });
    let beforeRelease: "migrated" | "waiting";
    try {
      beforeRelease = await Promise.race([
        migration.then(() => "migrated" as const),
        new Promise<"waiting">(resolve => {setImmediate(() => {resolve("waiting");});}),
      ]);
    } finally {
      await oldTransaction.query("ROLLBACK");
      oldTransaction.release();
    }
    assert.equal(beforeRelease, "waiting");
    await migration;

    await assert.rejects(
      oldStore.read({ operationId: operation.operationId, scope: operation.scope }),
      /runtime schema fence rejected this binary/u,
    );
    const currentStore = new PostgresContainedTurnOperationStore({ intentAuthority, pool, runtimeSchemaVersion: 6 });
    assert.equal(
      (await currentStore.read({ operationId: operation.operationId, scope: operation.scope }))?.operationId,
      operation.operationId,
    );
  });
});

postgresTest("tenant identity trigger fences tenant_id-only updates", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const operation = operationForProject("project:tenant-trigger", "tenant-trigger");
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
    assert.equal((await store.accept(operation, operationAuthority(operation))).kind, "accepted");
    await assert.rejects(
      runtimeQuery(
        pool,
        "UPDATE agent_execution.contained_turn_operation_v1 SET tenant_id=$2 WHERE operation_id=$1",
        [operation.operationId, "tenant:substituted"],
      ),
      /tenant identity mismatch/u,
    );
    assert.equal(
      (await store.read({ operationId: operation.operationId, scope: operation.scope }))?.scope.tenantId,
      operation.scope.tenantId,
    );
  });
});

postgresTest("acceptance replay is isolated by tenant and project and projections rebuild from authority", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
    const first = operationForProject("project:isolation-a", "isolation-a");
    const second = operationForProject("project:isolation-b", "isolation-b");
    assert.equal((await store.accept(first, operationAuthority(first))).kind, "accepted");
    assert.equal((await store.accept(second, operationAuthority(second))).kind, "accepted");
    assert.equal((await store.accept(first, operationAuthority(first))).kind, "replayed");
    assert.equal(await store.read({ operationId: first.operationId, scope: second.scope }), undefined);

    const conflicting = operationForProject("project:isolation-a", "isolation-conflict");
    const conflictWithDifferentFingerprint = createOperation({
      acceptedAuthorityVector: first.acceptedAuthorityVector,
      commandId: first.commandId,
      effectId: conflicting.effectId,
      intent: { mode: "analysis", prompt: "different fingerprint" },
      operationId: conflicting.operationId,
      providerAccessSnapshot: first.providerAccessSnapshot,
      scope: first.scope,
    });
    assert.equal(
      (await store.accept(conflictWithDifferentFingerprint, operationAuthority(conflictWithDifferentFingerprint))).kind,
      "fingerprint_conflict",
    );

    await runtimeQuery(pool,
      "DELETE FROM agent_execution.contained_turn_receipt_v1 WHERE operation_id=$1",
      [first.operationId],
    );
    await assert.rejects(
      store.read({ operationId: first.operationId, scope: first.scope }),
      /projection cardinality mismatch/u,
    );
    await store.rebuildProjections({ operationId: first.operationId, scope: first.scope });
    assert.equal((await store.read({ operationId: first.operationId, scope: first.scope }))?.operationId, first.operationId);

    await runtimeQuery(pool,
      "UPDATE agent_execution.contained_turn_operation_v1 SET state_digest=repeat('0',64) WHERE operation_id=$1",
      [second.operationId],
    );
    await assert.rejects(
      store.read({ operationId: second.operationId, scope: second.scope }),
      /state digest mismatch/u,
    );
  });
});

postgresTest("lost COMMIT acknowledgement creates separately committed durable reconciliation debt", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const initial = operationForProject("project:commit-loss", "commit-loss");
    const normal = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
    assert.equal((await normal.accept(initial, operationAuthority(initial))).kind, "accepted");

    let loseNextCommit = true;
    const ambiguousPool = new Proxy(pool, {
      get(target, property) {
        if (property !== "connect") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty) {
              if (clientProperty !== "query") {
                const value = Reflect.get(clientTarget, clientProperty, clientTarget);
                return typeof value === "function" ? value.bind(clientTarget) : value;
              }
              return async (...arguments_: Parameters<PoolClient["query"]>) => {
                const statement = arguments_[0];
                if (loseNextCommit && typeof statement === "string" && statement === "COMMIT") {
                  loseNextCommit = false;
                  await (clientTarget.query as (...args: typeof arguments_) => Promise<unknown>)(...arguments_);
                  throw new Error("simulated lost COMMIT acknowledgement");
                }
                return (clientTarget.query as (...args: typeof arguments_) => Promise<unknown>)(...arguments_);
              };
            },
          });
        };
      },
    }) as unknown as Pool;
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool: ambiguousPool });
    const candidate = mutateContainedTurnOperation(initial, {
      kind: "bind_workspace",
      workspaceId: containedTurnIdentity("workspace", "workspace:commit-loss"),
    });
    const result = await store.commit({
      authority: operationAuthority(initial),
      candidate,
      expectedRevision: initial.revision,
    });
    assert.equal(result.kind, "indeterminate");
    assert.equal(loseNextCommit, false);
    if (result.kind === "indeterminate") {
      assert.equal(result.debtOperation.reconciliation.kind, "required");
      assert.ok(result.debtOperation.revision > candidate.revision);
      const restarted = await normal.read({ operationId: initial.operationId, scope: initial.scope });
      assert.equal(restarted?.reconciliation.kind, "required");
      assert.ok(restarted?.reconciliation.evidenceIds.includes(result.evidenceId));
    }
  });
});

postgresTest("two claimers persist exact loser grants and restart-safe cleanup state", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
    const initial = operationForProject("project:claim-race", "claim-race");
    assert.equal((await store.accept(initial, operationAuthority(initial))).kind, "accepted");
    const workspaceId = containedTurnIdentity("workspace", "workspace:claim-race");
    const bound = mutateContainedTurnOperation(initial, { kind: "bind_workspace", workspaceId });
    assert.equal((await store.commit({
      authority: operationAuthority(initial), candidate: bound, expectedRevision: initial.revision,
    })).kind, "applied");

    const prepared = await Promise.all([
      store.prepareDispatch({ authority: operationAuthority(bound), operation: bound }),
      store.prepareDispatch({ authority: operationAuthority(bound), operation: bound }),
    ]);
    const claims = prepared.map((reservation, index) =>
      postgresClaimInput(bound, workspaceId, reservation, `race:${String(index)}`));
    const claimInputs = claims.map(claim => claim.claimInput);
    const outcomes = await Promise.all(claimInputs.map(input => store.claimPreparedDispatch(input)));
    assert.deepEqual(outcomes.map(outcome => outcome.kind).toSorted(), ["claimed", "stale"]);
    const winnerIndex = outcomes.findIndex(outcome => outcome.kind === "claimed");
    const winner = outcomes[winnerIndex];
    assert.ok(winner?.kind === "claimed");
    assert.equal(winner.committedDispatchProof.operationId, bound.operationId);
    assert.equal(winner.committedDispatchProof.committedOperationRevision, bound.revision + 1);
    const loserIndex = outcomes.findIndex(outcome => outcome.kind === "stale");
    assert.equal("committedDispatchProof" in outcomes[loserIndex]!, false);
    const loser = claims[loserIndex];
    assert.ok(loser);

    const replay = await store.claimPreparedDispatch(claimInputs[winnerIndex]!);
    assert.equal(replay.kind, "observed_claim");
    assert.equal("committedDispatchProof" in replay, false);

    const restarted = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
    const recoveries = await restarted.listDispatchPreparations({ scope: bound.scope });
    const recovered = recoveries.find(item => item.preparation.preparationToken === loser.preparationToken);
    assert.equal(recovered?.preparation.kind, "active");
    if (recovered?.preparation.kind !== "active") {throw new Error("loser preparation not recoverable");}
    assert.equal(recovered.preparation.providerAccessGrantRequestId, loser.receipts[0].grantRequestId);
    assert.equal(recovered.preparation.runtimeSecurityGrantRequestId, loser.receipts[1].grantRequestId);

    assert.equal((await restarted.retireDispatchPreparation({
      authority: operationAuthority(bound),
      consumedGrantRequestIds: {
        providerAccessGrantRequestId: loser.receipts[0].grantRequestId,
        runtimeSecurityGrantRequestId: loser.receipts[1].grantRequestId,
      },
      expectedOperationCutoffRevision: bound.operationCutoff.revision,
      expectedOperationRevision: bound.revision + 1,
      preparationToken: loser.preparationToken,
      reason: "claim_lost",
    })).kind, "stale");
    const retired = await restarted.retireDispatchPreparation({
      authority: operationAuthority(bound),
      consumedGrantRequestIds: {
        providerAccessGrantRequestId: loser.receipts[0].grantRequestId,
        runtimeSecurityGrantRequestId: loser.receipts[1].grantRequestId,
      },
      expectedOperationCutoffRevision: bound.operationCutoff.revision,
      expectedOperationRevision: bound.revision,
      preparationToken: loser.preparationToken,
      reason: "claim_lost",
    });
    assert.equal(retired.kind, "retired");
    if (retired.kind === "retired") {
      assert.equal(retired.preparation.providerAccessGrantRequestId, loser.receipts[0].grantRequestId);
      assert.equal(retired.preparation.runtimeSecurityGrantRequestId, loser.receipts[1].grantRequestId);
    }
  });
});
