import assert from "node:assert/strict";
import test from "node:test";

import { encodeContainedTurnPreparation } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-preparation-codec.js";
import { ContainedTurnPostgresPreparationRecovery } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-preparation-recovery.js";
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
  claimContainedTurnDispatchPreparation,
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

postgresTest("recovery pages retained history and validates debt and later supported corruption", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const store = new PostgresContainedTurnOperationStore({ pool });
    const operation = operationForProject("project:paged-history", "paged-history");
    assert.equal((await store.accept(operation, operationAuthority(operation))).kind, "accepted");
    const base = {
      attemptId: containedTurnIdentity("attempt", "attempt:paged-history"),
      custodyId: containedTurnIdentity("custody", "custody:paged-history"),
      kind: "active" as const,
      operationCutoffRevision: operation.operationCutoff.revision,
      operationId: operation.operationId,
      preparationToken: containedTurnIdentity("preparation", "preparation:paged-history-base"),
      preparedOperationRevision: operation.revision,
      providerAccessGrantRequestId: null,
      runtimeSecurityGrantRequestId: null,
      workspaceId: containedTurnIdentity("workspace", "workspace:paged-history"),
    };
    const rows = Array.from({ length: 1_002 }, (_unused, index) => {
      const preparationToken = containedTurnIdentity(
        "preparation",
        `preparation:paged-history-${String(index).padStart(4, "0")}`,
      );
      const encoded = encodeContainedTurnPreparation(claimContainedTurnDispatchPreparation({
        ...base,
        preparationToken,
      }));
      return {
        preparationToken,
        state: JSON.parse(encoded.json),
        stateCodecVersion: encoded.codecVersion,
        stateDigest: encoded.digest,
      };
    });
    const activeToken = containedTurnIdentity(
      "preparation", "preparation:paged-history-z-active",
    );
    const active = encodeContainedTurnPreparation({ ...base, preparationToken: activeToken });
    rows.push({
      preparationToken: activeToken,
      state: JSON.parse(active.json),
      stateCodecVersion: active.codecVersion,
      stateDigest: active.digest,
    });
    const corruptToken = containedTurnIdentity(
      "preparation", "preparation:paged-history-zz-corrupt",
    );
    const corruptState = JSON.parse(encodeContainedTurnPreparation({
      ...base,
      preparationToken: corruptToken,
    }).json) as { payload: Record<string, unknown> };
    delete corruptState.payload.kind;
    rows.push({
      preparationToken: corruptToken,
      state: corruptState,
      stateCodecVersion: 4,
      stateDigest: digestContainedTurnPostgresJson(corruptState),
    });
    await runtimeQuery(
      pool,
      `INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1
         (operation_id,preparation_token,state_codec_version,state,state_digest)
       SELECT $1,x.preparation_token,x.state_codec_version,x.state,x.state_digest
         FROM jsonb_to_recordset($2::jsonb) AS x(
           preparation_token text,state jsonb,state_codec_version integer,state_digest text
         )`,
      [operation.operationId, JSON.stringify(rows.map(row => ({
        preparation_token: row.preparationToken,
        state: row.state,
        state_codec_version: row.stateCodecVersion,
        state_digest: row.stateDigest,
      })))],
    );

    const recovered = await store.listDispatchPreparations({ limit: 1, scope: operation.scope });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.preparation.preparationToken, activeToken);
    assert.deepEqual((await runtimeQuery<{ reason: string }>(
      pool,
      `SELECT reason FROM agent_execution.contained_turn_dispatch_preparation_quarantine_v1
        WHERE operation_id=$1 AND preparation_token=$2`,
      [operation.operationId, corruptToken],
    )).rows[0], { reason: "malformed" });
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

test("recovery verifies phase-one identity and size metadata before decoding materialized state", async () => {
  const queries: string[] = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      if (text.includes("octet_length(p.state::text) AS state_bytes")) {
        return { rows: [{
          operation_state_bytes: 256,
          operation_id: "operation:two-phase",
          output_bytes: "0",
          preparation_token: "preparation:two-phase",
          receipt_bytes: "0",
          state_bytes: 128,
          state_codec_version: 4,
          state_digest: "1".repeat(64),
        }] };
      }
      return { rows: [{
        actual_operation_id: "operation:two-phase",
        actual_preparation_token: "preparation:two-phase",
        actual_state_bytes: 129,
        actual_state_codec_version: 4,
        actual_state_digest: "1".repeat(64),
        operation_id: "operation:two-phase",
        preparation_token: "preparation:two-phase",
        project_id: "project:two-phase",
        state: { codecVersion: 4, payload: { kind: "active" } },
        state_bytes: 128,
        state_codec_version: 4,
        state_digest: "1".repeat(64),
        tenant_id: "tenant:two-phase",
      }] };
    },
  };
  const transactions = {
    async write<Result>(work: (selected: typeof client) => Promise<Result>) {return work(client);},
  };
  const recovery = new ContainedTurnPostgresPreparationRecovery(
    {} as never, 5, transactions as never,
  );
  await assert.rejects(
    recovery.list({ scope: { projectId: "project:two-phase", tenantId: "tenant:two-phase" } }),
    /metadata changed during materialization/u,
  );
  assert.equal(queries.length, 3);
  assert.match(queries[0] ?? "", /octet_length\(p\.state::text\) AS state_bytes/u);
  assert.doesNotMatch(queries[0] ?? "", /THEN p\.state|p\.state AS state/u);
  assert.match(queries[0] ?? "", /\(p\.operation_id,p\.preparation_token\) > \(\$3,\$4\)[\s\S]*ORDER BY p\.operation_id,p\.preparation_token[\s\S]*LIMIT \$5 FOR UPDATE OF p,o/u);
  assert.doesNotMatch(queries[0] ?? "", /payload,kind|#>> '\{kind\}'/u);
  assert.match(queries[2] ?? "", /JOIN agent_execution\.contained_turn_dispatch_preparation_v1/u);
  assert.match(
    queries[2] ?? "",
    /expected\.operation_state_bytes,[\s\S]*expected\.output_bytes,expected\.receipt_bytes/u,
  );
});

postgresTest("a later recovery batch violation takes precedence over an earlier digest mismatch", async () => {
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
