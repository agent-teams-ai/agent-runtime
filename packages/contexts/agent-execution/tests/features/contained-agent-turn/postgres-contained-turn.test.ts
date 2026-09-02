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
import { containedTurnPreparationToken } from "../../../dist/features/contained-agent-turn/application/contained-turn-preparation-cleanup.js";
import { normalizeContainedTurnConsumedGrantReceipt } from "../../../dist/features/contained-agent-turn/composition/dispatch-grant-anti-corruption.js";
import {
  containedTurnProviderAccessSnapshotDigest,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { completeContainedTurnDispatchGrantSubject } from "../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-authority.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { mutateContainedTurnOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import {
  createOperation,
  proofId,
} from "../../contained-turn-kernel-fixtures.ts";
import {
  operationAuthority,
  operationForProject,
  postgresTest,
  resetSchema,
  runtimeQuery,
  withPool,
} from "./postgres-contained-turn-test-helpers.ts";

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
  assert.equal(encodedPreparation.codecVersion, 4);
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
  const rejectsBudget = (candidate: unknown) => assert.throws(
    () => digestContainedTurnPostgresJson(candidate),
    (error: unknown) => error instanceof ContainedTurnStateBudgetError &&
      error.message === CONTAINED_TURN_STATE_BUDGET_DIAGNOSTIC,
  );
  rejectsBudget("x".repeat(CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumCanonicalBytes + 1));
  let deep: unknown = null;
  for (let index = 0; index <= CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumDepth; index += 1) {
    deep = { nested: deep };
  }
  rejectsBudget(deep);
  rejectsBudget(Array.from({
    length: CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumCollectionWidth + 1,
  }, () => null));
  rejectsBudget(Array.from({
    length: CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumCollectionWidth,
  }, () => Array.from({ length: 13 }, () => null)));
});

postgresTest("populated genuine v1 fails closed before migration without changing history or data", async () => {
  await withPool(async pool => {
    await resetSchema(pool, 1);
    const operation = operationForProject("project:v1-rejection", "v1-rejection");
    const legacy = { ...operation, schemaVersion: 1 };
    await pool.query(
      `INSERT INTO agent_execution.contained_turn_operation_v1
         (operation_id,tenant_id,command_id,command_fingerprint,effect_id,revision,state,state_digest,terminal)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,false)`,
      [operation.operationId, operation.scope.tenantId, operation.commandId,
        operation.commandFingerprint, operation.effectId, operation.revision,
        JSON.stringify(legacy), digestContainedTurnPostgresJson(legacy)],
    );
    await pool.query(
      "INSERT INTO agent_execution.contained_turn_output_v1(operation_id,cursor,output_kind,output_text) VALUES ($1,0,'diagnostic','legacy-output')",
      [operation.operationId],
    );
    await pool.query(
      "INSERT INTO agent_execution.contained_turn_receipt_v1(operation_id,receipt_kind,receipt_ref) VALUES ($1,'legacy','legacy-receipt')",
      [operation.operationId],
    );
    const snapshot = async () => pool.query(
      `SELECT
        (SELECT row_to_json(m) FROM agent_execution.schema_migration AS m) AS migration,
        (SELECT jsonb_agg(to_jsonb(h) ORDER BY version) FROM agent_execution.schema_migration_history AS h) AS history,
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
    const store = new PostgresContainedTurnOperationStore({ pool });
    assert.equal((await store.accept(operation, operationAuthority(operation))).kind, "accepted");
    await runtimeQuery(
      pool,
      `UPDATE agent_execution.contained_turn_operation_v1
          SET state=jsonb_build_object('oversized',repeat('x',$2)),state_digest=repeat('0',64)
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
    assert.equal(current.rows[0]?.version, 5);

    await pool.query("UPDATE agent_execution.schema_migration SET migration_digest = repeat('1', 64)");
    await assert.rejects(applyContainedTurnPostgresSchema(pool), /schema identity mismatch/u);

    await resetSchema(pool, 2);
    await pool.query("DROP TABLE agent_execution.schema_migration_history CASCADE");
    await pool.query("DROP FUNCTION agent_execution.reject_schema_migration_history_mutation() CASCADE");
    await applyContainedTurnPostgresSchema(pool);
    current = await pool.query("SELECT version, migration_digest FROM agent_execution.schema_migration");
    assert.equal(current.rows[0]?.version, 5);
    assert.equal((await pool.query(
      "SELECT 1 FROM agent_execution.schema_migration_history ORDER BY version",
    )).rowCount, 5);
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
    const stored = await new PostgresContainedTurnOperationStore({ pool, runtimeSchemaVersion: 3 }).read({
      operationId: operation.operationId,
      scope: operation.scope,
    });
    assert.equal(stored?.schemaVersion, 2);
    assert.equal(stored?.scope.projectId, operation.scope.projectId);
    const recoveries = await new PostgresContainedTurnOperationStore({ pool, runtimeSchemaVersion: 3 })
      .listDispatchPreparations({ scope: operation.scope });
    assert.equal(recoveries[0]?.preparation.providerAccessGrantRequestId, null);
    assert.equal(recoveries[0]?.preparation.runtimeSecurityGrantRequestId, null);
    await applyContainedTurnPostgresSchema(pool);
    const digestColumn = await runtimeQuery(pool,
      `SELECT state_digest FROM agent_execution.contained_turn_dispatch_preparation_v1
        WHERE operation_id=$1 AND preparation_token=$2`,
      [operation.operationId, legacyPreparation.preparationToken],
    );
    assert.match(digestColumn.rows[0]?.state_digest, /^[a-f0-9]{64}$/u);
  });
});

postgresTest("contract migration waits for old transactions and durably excludes the old binary", async () => {
  await withPool(async pool => {
    await resetSchema(pool, 4);
    const oldStore = new PostgresContainedTurnOperationStore({ pool, runtimeSchemaVersion: 4 });
    const operation = operationForProject("project:mixed-version", "mixed-version");
    assert.equal((await oldStore.accept(operation, operationAuthority(operation))).kind, "accepted");

    const oldTransaction = await pool.connect();
    await oldTransaction.query("BEGIN");
    await oldTransaction.query("SELECT pg_advisory_xact_lock_shared($1)", [
      CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE.advisoryLockId,
    ]);
    const migration = applyContainedTurnPostgresSchema(pool);
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
    const currentStore = new PostgresContainedTurnOperationStore({ pool });
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
    const store = new PostgresContainedTurnOperationStore({ pool });
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
    const store = new PostgresContainedTurnOperationStore({ pool });
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
    const normal = new PostgresContainedTurnOperationStore({ pool });
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
    const store = new PostgresContainedTurnOperationStore({ pool: ambiguousPool });
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
    const store = new PostgresContainedTurnOperationStore({ pool });
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
    const claims = prepared.map((reservation, index) => {
      const preparationToken = containedTurnPreparationToken({
        attemptId: reservation.attemptId,
        custodyId: reservation.custodyId,
        operationId: bound.operationId,
      });
      const providerBindingDigest = containedTurnProviderAccessSnapshotDigest(bound.providerAccessSnapshot);
      const subject = completeContainedTurnDispatchGrantSubject(Object.freeze({
        attemptId: reservation.attemptId,
        custodyId: reservation.custodyId,
        effectId: bound.effectId,
        executionGenerationId: reservation.executionGenerationId,
        hostBootId: containedTurnIdentity("host_boot", `host-boot:race:${String(index)}`),
        hostInstanceId: containedTurnIdentity("host_instance", `host-instance:race:${String(index)}`),
        operationCutoffRevision: bound.operationCutoff.revision,
        operationId: bound.operationId,
        preparationToken,
        purpose: "contained_turn_provider_start_v1" as const,
        provider: bound.adapterSnapshot.provider,
        providerAccessExpectation: Object.freeze({
          acceptedAuthorityDigest: bound.acceptedAuthorityVectorDigest,
          accessRef: bound.providerAccessSnapshot.accessRef,
          authorityHeadDigest: bound.providerAccessSnapshot.ownerAuthorityDigest,
          bindingDigest: providerBindingDigest,
          bindingRevision: bound.providerAccessSnapshot.revision,
          credentialBindingDigest: bound.providerAccessSnapshot.credentialBindingDigest,
          credentialBindingRef: bound.providerAccessSnapshot.credentialBindingRef,
          credentialGeneration: bound.providerAccessSnapshot.credentialGeneration,
          providerAccountRef: bound.providerAccessSnapshot.providerAccountRef,
          providerRouteRef: bound.providerAccessSnapshot.providerRouteRef,
        }),
        runtimeSecurityExpectation: Object.freeze({
          acceptedAuthorityDigest: bound.acceptedAuthorityVector.securityDecisionDigest,
          authorityGeneration: bound.acceptedAuthorityVector.operationAuthorityRevision,
          authorityHeadDigest: bound.acceptedAuthorityVector.securityDecisionDigest,
          authorityRevision: bound.acceptedAuthorityVector.securityAuthorityRevision,
          constraintsDigest: digestContainedTurnCanonicalValue({
            adapterSnapshot: bound.adapterSnapshot,
            capabilityManifest: bound.capabilityManifest,
            intentMode: bound.intent.mode,
          } as never),
          containmentPolicyDigest: bound.acceptedAuthorityVector.containmentPolicyDigest,
          providerBindingDigest,
          providerId: bound.adapterSnapshot.provider,
        }),
        scope: bound.scope,
        scopeDigest: bound.acceptedAuthorityVector.scopeDigest,
        workspaceId,
      }));
      const receipt = (owner: "provider_access" | "runtime_security") => {
        const request = owner === "provider_access" ? subject.providerAccessRequest : subject.runtimeSecurityRequest;
        return normalizeContainedTurnConsumedGrantReceipt(owner, subject, {
          authorityFacts: owner === "provider_access" ? subject.providerAccessExpectation : subject.runtimeSecurityExpectation,
          claimBeforeControlTime: 100,
          claimBindingDigest: request.claimBindingDigest,
          consumedAtControlTime: 50,
          consumptionDigest: digestContainedTurnCanonicalValue({ index, owner, state: "consumed" }),
          grantRequestId: request.grantRequestId,
          operationId: subject.operationId,
          ownerEvidenceRef: `${owner}:evidence:${String(index)}`,
          provider: subject.provider,
          purpose: "contained-turn.provider-dispatch/v1" as const,
          requestDigest: request.requestDigest,
          scope: Object.freeze({ ...subject.scope, scopeDigest: subject.scopeDigest }),
        });
      };
      const receipts = Object.freeze([receipt("provider_access"), receipt("runtime_security")]) as const;
      return { preparationToken, receipts, subject };
    });
    const outcomes = await Promise.all(claims.map(claim => store.claimPreparedDispatch({
      authority: operationAuthority(bound),
      consumedGrantReceipts: claim.receipts,
      expectedOperationRevision: bound.revision,
      hostCustodyProof: {
        binding: {
          attemptId: claim.subject.attemptId,
          authorityVectorDigest: bound.acceptedAuthorityVectorDigest,
          custodyId: claim.subject.custodyId,
          effectId: bound.effectId,
          operationId: bound.operationId,
        },
        kind: "host_custody",
        proofId: proofId(`proof:host-custody:${claim.subject.attemptId}`),
      },
      subject: claim.subject,
    })));
    assert.deepEqual(outcomes.map(outcome => outcome.kind).toSorted(), ["claimed", "stale"]);
    const loserIndex = outcomes.findIndex(outcome => outcome.kind === "stale");
    const loser = claims[loserIndex];
    assert.ok(loser);

    const restarted = new PostgresContainedTurnOperationStore({ pool });
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
