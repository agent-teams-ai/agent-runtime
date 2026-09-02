import assert from "node:assert/strict";

import { encodeContainedTurnPreparation } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-preparation-codec.js";
import {
  ContainedTurnStateBudgetError,
  CONTAINED_TURN_STATE_BUDGET_DIAGNOSTIC,
  digestContainedTurnPostgresJson,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-state-codec.js";
import { PostgresContainedTurnOperationStore } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { recoverContainedTurnDispatchPreparations } from "../../../dist/features/contained-agent-turn/application/contained-turn-preparation-recovery.js";
import type { ContainedTurnKernelDependencies } from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { digestContainedTurnCanonicalValue } from "../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {
  CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT,
  retireContainedTurnDispatchPreparation,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-preparation.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { mutateContainedTurnOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import {
  operationAuthority,
  operationForProject,
  postgresTest,
  resetSchema,
  runtimeQuery,
  withPool,
} from "./postgres-contained-turn-test-helpers.ts";

postgresTest("persisted v2 true flags preserve conservative cleanup debt without replaying consumption", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const store = new PostgresContainedTurnOperationStore({ pool });
    const initial = operationForProject("project:v2-cleanup-recovery", "v2-cleanup-recovery");
    assert.equal((await store.accept(initial, operationAuthority(initial))).kind, "accepted");
    const workspaceId = containedTurnIdentity("workspace", "workspace:v2-cleanup-recovery");
    const bound = mutateContainedTurnOperation(initial, { kind: "bind_workspace", workspaceId });
    assert.equal((await store.commit({
      authority: operationAuthority(initial), candidate: bound, expectedRevision: initial.revision,
    })).kind, "applied");
    await store.prepareDispatch({ authority: operationAuthority(bound), operation: bound });
    const active = (await store.listDispatchPreparations({ scope: bound.scope }))[0]?.preparation;
    assert.equal(active?.kind, "active");
    if (active?.kind !== "active") {throw new Error("v2 recovery preparation missing");}
    const providerAccessGrantRequestId = `grant-request:${digestContainedTurnCanonicalValue({
      owner: "provider_access", request: "persisted-v2",
    })}`;
    const runtimeSecurityGrantRequestId = `grant-request:${digestContainedTurnCanonicalValue({
      owner: "runtime_security", request: "persisted-v2",
    })}`;
    const pending = retireContainedTurnDispatchPreparation(active, "persisted-v2", {
      providerAccessGrantRequestId,
      runtimeSecurityGrantRequestId,
    });
    if (pending.kind !== "cleanup_pending") {throw new Error("v2 recovery preparation did not retire");}
    const historicalEvidenceId = containedTurnIdentity("evidence", "evidence:persisted-v2-history");
    const {
      providerAccessConsumptionEvidenceId: _providerEvidence,
      runtimeSecurityConsumptionEvidenceId: _securityEvidence,
      ...legacyPending
    } = pending;
    const v2State = {
      codecVersion: 2,
      payload: {
        ...legacyPending,
        cleanupEvidenceIds: [historicalEvidenceId],
        custodyReleased: true,
        providerAccessSettled: true,
        runtimeSecuritySettled: true,
      },
    };
    await runtimeQuery(
      pool,
      `UPDATE agent_execution.contained_turn_dispatch_preparation_v1
          SET state_codec_version=2,state=$3::jsonb,state_digest=$4
        WHERE operation_id=$1 AND preparation_token=$2`,
      [bound.operationId, active.preparationToken, JSON.stringify(v2State),
        digestContainedTurnPostgresJson(v2State)],
    );

    const restarted = new PostgresContainedTurnOperationStore({ pool });
    const decoded = (await restarted.listDispatchPreparations({ scope: bound.scope }))[0]?.preparation;
    assert.equal(decoded?.kind, "cleanup_pending");
    if (decoded?.kind !== "cleanup_pending") {throw new Error("v2 recovery preparation was not decoded");}
    assert.equal(decoded.custodyReleased, false);
    assert.equal(decoded.providerAccessSettled, false);
    assert.equal(decoded.runtimeSecuritySettled, false);
    assert.deepEqual(decoded.cleanupEvidenceIds, [historicalEvidenceId]);
    const calls: string[] = [];
    const dependencies = {
      custody: { releaseRetiredReservation: async () => {
        calls.push("custody"); return { kind: "released" as const };
      } },
      operationStore: restarted,
      providerAccess: { settleConsumedGrant: async input => {
        calls.push(`provider_access:${input.grantRequestId ?? "missing"}`);
        return { kind: "settled" as const };
      } },
      security: { settleConsumedGrant: async input => {
        calls.push(`runtime_security:${input.grantRequestId ?? "missing"}`);
        return { kind: "settled" as const };
      } },
    } as unknown as ContainedTurnKernelDependencies;
    assert.deepEqual(await recoverContainedTurnDispatchPreparations(dependencies, bound.scope), {
      discovered: 1,
      retired: 0,
    });
    assert.deepEqual(calls, ["custody"]);
    const stored = await runtimeQuery<{ state: unknown }>(
      pool,
      `SELECT state FROM agent_execution.contained_turn_dispatch_preparation_v1
        WHERE operation_id=$1 AND preparation_token=$2`,
      [bound.operationId, active.preparationToken],
    );
    const state = stored.rows[0]?.state as { readonly payload?: { readonly cleanupEvidenceIds?: unknown; readonly kind?: unknown } };
    assert.equal(state.payload?.kind, "cleanup_pending");
    assert.deepEqual(state.payload?.cleanupEvidenceIds, [historicalEvidenceId]);
  });
});
postgresTest("unsupported preparation codecs quarantine independently and recovery keeps progressing", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const store = new PostgresContainedTurnOperationStore({ pool });
    const initial = operationForProject("project:poison-preparation", "poison-preparation");
    assert.equal((await store.accept(initial, operationAuthority(initial))).kind, "accepted");
    const workspaceId = containedTurnIdentity("workspace", "workspace:poison-preparation");
    const bound = mutateContainedTurnOperation(initial, { kind: "bind_workspace", workspaceId });
    assert.equal((await store.commit({
      authority: operationAuthority(initial),
      candidate: bound,
      expectedRevision: initial.revision,
    })).kind, "applied");
    await store.prepareDispatch({ authority: operationAuthority(bound), operation: bound });
    const active = (await store.listDispatchPreparations({ scope: bound.scope }))[0]?.preparation;
    assert.equal(active?.kind, "active");
    if (active?.kind !== "active") {throw new Error("poison preparation fixture missing");}

    const poisonToken = "preparation:000-unsupported-codec";
    const poisonState = { codecVersion: 99, payload: { kind: "active" } };
    await runtimeQuery(
      pool,
      `INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1
         (operation_id,preparation_token,state_codec_version,state,state_digest)
       VALUES ($1,$2,99,$3::jsonb,$4)`,
      [bound.operationId, poisonToken, JSON.stringify(poisonState),
        digestContainedTurnPostgresJson(poisonState)],
    );

    const oversizedToken = containedTurnIdentity("preparation", "preparation:oversized-cleanup-evidence");
    const oversizedPending = retireContainedTurnDispatchPreparation({
      ...active,
      preparationToken: oversizedToken,
    }, "oversized-cleanup-evidence");
    if (oversizedPending.kind !== "cleanup_pending") {throw new Error("oversized preparation did not retire");}
    const oversizedState = {
      codecVersion: 3,
      payload: {
        ...oversizedPending,
        cleanupEvidenceIds: Array.from(
          { length: CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT + 1 },
          (_unused, index) => containedTurnIdentity("evidence", `evidence:postgres-over-limit:${String(index)}`),
        ),
      },
    };
    await runtimeQuery(
      pool,
      `INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1
         (operation_id,preparation_token,state_codec_version,state,state_digest)
       VALUES ($1,$2,3,$3::jsonb,$4)`,
      [bound.operationId, oversizedToken, JSON.stringify(oversizedState),
        digestContainedTurnPostgresJson(oversizedState)],
    );

    const recovered = await store.listDispatchPreparations({ limit: 1, scope: bound.scope });
    assert.equal(recovered.length, 1);
    assert.notEqual(recovered[0]?.preparation.preparationToken, poisonToken);
    const quarantine = await runtimeQuery<{
      observation_count: string;
      reason: string;
  }>(
      pool,
      `SELECT observation_count::text,reason
         FROM agent_execution.contained_turn_dispatch_preparation_quarantine_v1
        WHERE operation_id=$1 AND preparation_token=$2`,
      [bound.operationId, poisonToken],
    );
    assert.deepEqual(quarantine.rows[0], {
      observation_count: "1",
      reason: "unsupported_version",
    });
    const oversizedQuarantine = await runtimeQuery<{ reason: string }>(
      pool,
      `SELECT reason
         FROM agent_execution.contained_turn_dispatch_preparation_quarantine_v1
        WHERE operation_id=$1 AND preparation_token=$2`,
      [bound.operationId, oversizedToken],
    );
    assert.deepEqual(oversizedQuarantine.rows[0], { reason: "malformed" });
    assert.equal((await store.listDispatchPreparations({ limit: 1, scope: bound.scope })).length, 1);
  });
});

postgresTest("retirement rejects a payload token that disagrees with its row key", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const store = new PostgresContainedTurnOperationStore({ pool });
    const initial = operationForProject("project:retirement-token", "retirement-token");
    assert.equal((await store.accept(initial, operationAuthority(initial))).kind, "accepted");
    const workspaceId = containedTurnIdentity("workspace", "workspace:retirement-token");
    const bound = mutateContainedTurnOperation(initial, { kind: "bind_workspace", workspaceId });
    assert.equal((await store.commit({
      authority: operationAuthority(initial),
      candidate: bound,
      expectedRevision: initial.revision,
    })).kind, "applied");
    await store.prepareDispatch({ authority: operationAuthority(bound), operation: bound });
    const recovery = (await store.listDispatchPreparations({ scope: bound.scope }))[0];
    assert.ok(recovery);
    const rowToken = recovery.preparation.preparationToken;
    const payloadToken = containedTurnIdentity("preparation", "preparation:substituted-payload-token");
    const forged = encodeContainedTurnPreparation({
      ...recovery.preparation,
      preparationToken: payloadToken,
    });
    await runtimeQuery(
      pool,
      `UPDATE agent_execution.contained_turn_dispatch_preparation_v1
          SET state=$3::jsonb,state_codec_version=$4,state_digest=$5
        WHERE operation_id=$1 AND preparation_token=$2`,
      [bound.operationId, rowToken, forged.json, forged.codecVersion, forged.digest],
    );

    const retired = await store.retireDispatchPreparation({
      authority: operationAuthority(bound),
      expectedOperationCutoffRevision: bound.operationCutoff.revision,
      expectedOperationRevision: bound.revision,
      preparationToken: rowToken,
      reason: "reconciliation",
    });
    assert.equal(retired.kind, "stale");
  });
});

postgresTest("recovery fails closed before materializing an oversized serialized batch", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const store = new PostgresContainedTurnOperationStore({ pool });
    const operation = operationForProject("project:oversized-recovery", "oversized-recovery");
    assert.equal((await store.accept(operation, operationAuthority(operation))).kind, "accepted");
    for (const suffix of ["a", "b"]) {
      await runtimeQuery(
        pool,
        `INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1
           (operation_id,preparation_token,state_codec_version,state,state_digest)
         VALUES ($1,$2,4,jsonb_build_object(
           'codecVersion',4,'payload',jsonb_build_object('kind','active','padding',repeat('x',$3))
         ),repeat('0',64))`,
        [operation.operationId, `preparation:oversized-batch-${suffix}`, 5 * 1024 * 1024],
      );
    }

    await assert.rejects(
      store.listDispatchPreparations({ limit: 1_000, scope: operation.scope }),
      (error: unknown) => error instanceof ContainedTurnStateBudgetError &&
        error.message === CONTAINED_TURN_STATE_BUDGET_DIAGNOSTIC,
    );
    assert.equal((await runtimeQuery<{ count: string }>(
      pool,
      "SELECT count(*)::text AS count FROM agent_execution.contained_turn_dispatch_preparation_quarantine_v1",
    )).rows[0]?.count, "0");
  });
});
