import assert from "node:assert/strict";
import { PostgresContainedTurnOperationStore } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { applyContainedTurnPostgresSchema } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-schema.js";
import { operationForProject, postgresTest, resetSchema, runtimeQuery, withPool } from "./postgres-contained-turn-test-helpers.ts";
import { awaitFixtureGate, gate, intentAuthority, intentHarness, prevention, submission } from "./support/intent-guard-fixture.ts";
import { seedLegacyIntentOperation } from "./support/intent-guard-legacy-fixture.ts";

postgresTest("V7 durable negative receipt prevents restored submission with no operation or effect materialization", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const initial = intentHarness(pool);
    const input = { prevention: prevention(), scope: submission.scope };
    const receipt = await initial.feature.cancel.execute(input);
    assert.equal(receipt.kind, "committed");
    const reconstructed = intentHarness(pool);
    assert.deepEqual(await reconstructed.feature.cancel.execute(input), receipt);
    assert.deepEqual(await reconstructed.feature.submit.execute(submission), { status: "denied" });
    assert.deepEqual(reconstructed.counts, { custodyOpen: 0, custodyStart: 0, provider: 0, workspace: 0, access: 0, security: 0 });
    assert.equal((await runtimeQuery(pool, "SELECT 1 FROM agent_execution.contained_turn_operation_v1")).rowCount, 0);
    assert.equal((await runtimeQuery(pool, "SELECT 1 FROM agent_execution.contained_turn_receipt_v1")).rowCount, 0);
    for (const table of ["contained_turn_intent_guard_v1", "contained_turn_intent_v1", "contained_turn_intent_namespace_v1"]) {
      await assert.rejects(runtimeQuery(pool, `DELETE FROM agent_execution.${table}`), /retained/u);
      await assert.rejects(runtimeQuery(pool, `TRUNCATE agent_execution.${table} CASCADE`), /retained/u);
    }
    await applyContainedTurnPostgresSchema(pool);
    await pool.query("ALTER TABLE agent_execution.contained_turn_intent_guard_v1 DISABLE TRIGGER contained_turn_intent_retention");
    await assert.rejects(applyContainedTurnPostgresSchema(pool), /intent catalog drift/u);
  });
});

postgresTest("V7 concurrent claimers and prevention serialize on the same namespace and operation transaction", async () => {
  await withPool(async pool => {
    for (let iteration = 0; iteration < 8; iteration += 1) {
      await resetSchema(pool);
      const entered = gate(); const release = gate();
      let input!: Parameters<PostgresContainedTurnOperationStore["claimPreparedDispatch"]>[0];
      const runner = intentHarness(pool, { beforeClaimCas: async claim => {input = claim; entered.release(); await release.promise;} });
      const pending = runner.feature.submit.execute(submission);
      await awaitFixtureGate(entered.promise, pending);
      try {
        const other = new PostgresContainedTurnOperationStore({ pool, intentAuthority });
        const claim = () => other.claimPreparedDispatch(input);
        const prevent = () => runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
        const results = await Promise.all(iteration % 2 ? [claim(), prevent(), claim()] : [prevent(), claim(), claim()]);
        const claims = results.filter(result => result.kind === "claimed");
        const receipt = results.find(result => result.kind === "committed");
        assert.ok(receipt?.kind === "committed");
        assert.ok(claims.length <= 1);
        assert.equal(receipt.receipt.disposition, claims.length === 1 ? "cutoff_requested" : "operation_fenced");
      } finally {release.release();}
      await pending;
      assert.equal(runner.counts.provider, 0);
      const replay = intentHarness(pool);
      assert.equal((await replay.feature.submit.execute(submission)).status, "observed");
      assert.equal(replay.counts.provider, 0);
    }
  });
});

postgresTest("V7 claim-first application cancellation preserves provider uncertainty across store reconstruction", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const entered = gate(); const release = gate();
    const runner = intentHarness(pool, { beforeProvider: async () => {entered.release(); await release.promise;} });
    const pending = runner.feature.submit.execute(submission);
    await awaitFixtureGate(entered.promise, pending);
    try {
      const result = await runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
      assert.ok(result.kind === "committed");
      assert.equal(result.receipt.disposition, "cutoff_requested");
      const operation = await runner.store.read({ operationId: result.receipt.operationId!, scope: submission.scope });
      assert.equal(operation?.dispatch.kind, "claimed");
      assert.equal(operation?.reconciliation.kind, "required");
      assert.equal(operation?.terminal.kind, "open");
    } finally {release.release();}
    await pending;
    const restarted = intentHarness(pool);
    assert.equal((await restarted.feature.submit.execute(submission)).status, "observed");
    assert.equal(runner.counts.provider, 1);
    assert.equal(restarted.counts.provider, 0);
  });
});

postgresTest("V7 refuses populated V6 without changing its migration identity or guessing deployment authority", async () => {
  await withPool(async pool => {
    await resetSchema(pool, 6);
    await seedLegacyIntentOperation(pool, operationForProject("project:unsafe-legacy", "unsafe-legacy"), 6);
    const before = await pool.query("SELECT version,migration_digest FROM agent_execution.schema_migration");
    await assert.rejects(applyContainedTurnPostgresSchema(pool), /refuses populated authority-incompatible schema/u);
    assert.deepEqual((await pool.query("SELECT version,migration_digest FROM agent_execution.schema_migration")).rows, before.rows);
    assert.equal((await pool.query("SELECT to_regclass('agent_execution.contained_turn_intent_v1') AS intent")).rows[0]?.intent, null);
  });
});
