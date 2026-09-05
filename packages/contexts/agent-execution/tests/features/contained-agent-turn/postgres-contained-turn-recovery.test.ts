import { intentAuthority } from "./support/intent-guard-fixture.ts";
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
import { containedTurnApplicationView } from "../../../dist/features/contained-agent-turn/application/contained-turn-engine.js";
import { recoverContainedTurnDispatchPreparations } from "../../../dist/features/contained-agent-turn/application/contained-turn-preparation-recovery.js";
import type { ContainedTurnKernelDependencies } from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { digestContainedTurnCanonicalValue } from "../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {
  containedTurnPreparationClosureBinding,
  claimContainedTurnDispatchPreparation,
  CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT,
  retireContainedTurnDispatchPreparation,
  recordContainedTurnPreparationCleanup,
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
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
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

    const restarted = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
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
      providerAccess: { settleConsumedGrant: async () => {
        calls.push("provider_access");
        return { kind: "settled" as const };
      } },
      security: { settleConsumedGrant: async () => {
        calls.push("runtime_security");
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
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
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

postgresTest("legacy quarantine is linked atomically to scoped owner debt and replay is idempotent", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
    const owned = operationForProject("project:quarantine-owner", "quarantine-owner");
    const other = operationForProject("project:quarantine-other", "quarantine-other");
    assert.equal((await store.accept(owned, operationAuthority(owned))).kind, "accepted");
    assert.equal((await store.accept(other, operationAuthority(other))).kind, "accepted");
    const preparationToken = "preparation:legacy-unlinked-quarantine";
    const corruptState = { codecVersion: 99, payload: { kind: "active" } };
    const corruptDigest = digestContainedTurnPostgresJson(corruptState);
    await runtimeQuery(
      pool,
      `INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1
         (operation_id,preparation_token,state_codec_version,state,state_digest)
       VALUES ($1,$2,99,$3::jsonb,$4)`,
      [owned.operationId, preparationToken, JSON.stringify(corruptState), corruptDigest],
    );
    await runtimeQuery(
      pool,
      `INSERT INTO agent_execution.contained_turn_dispatch_preparation_quarantine_v1
         (operation_id,preparation_token,observed_codec_version,observed_state_digest,
          quarantined_state,reason)
       VALUES ($1,$2,99,$3,$4::jsonb,'unsupported_version')`,
      [owned.operationId, preparationToken, corruptDigest, JSON.stringify(corruptState)],
    );

    assert.deepEqual(await store.listDispatchPreparations({ scope: other.scope }), []);
    assert.equal((await store.read({ operationId: owned.operationId, scope: owned.scope }))?.revision,
      owned.revision);
    assert.equal((await runtimeQuery<{ owner_debt_evidence_id: string | null }>(
      pool,
      `SELECT owner_debt_evidence_id
         FROM agent_execution.contained_turn_dispatch_preparation_quarantine_v1
        WHERE operation_id=$1 AND preparation_token=$2`,
      [owned.operationId, preparationToken],
    )).rows[0]?.owner_debt_evidence_id, null);

    assert.deepEqual(await store.listDispatchPreparations({ scope: owned.scope }), []);
    const indebted = await store.read({ operationId: owned.operationId, scope: owned.scope });
    assert.ok(indebted);
    assert.equal(containedTurnApplicationView(indebted).status, "reconcile_required");
    assert.equal(indebted.reconciliation.kind, "required");
    const evidenceId = indebted.reconciliation.kind === "required"
      ? indebted.reconciliation.evidenceIds[0]
      : undefined;
    assert.ok(evidenceId);
    assert.deepEqual(indebted.providerExecution, owned.providerExecution);
    assert.deepEqual(indebted.cancellation, owned.cancellation);
    assert.deepEqual(indebted.terminal, owned.terminal);
    const linked = await runtimeQuery<{
      observation_count: string;
      owner_debt_evidence_id: string;
    }>(pool,
      `SELECT observation_count::text,owner_debt_evidence_id
         FROM agent_execution.contained_turn_dispatch_preparation_quarantine_v1
        WHERE operation_id=$1 AND preparation_token=$2`,
      [owned.operationId, preparationToken]);
    assert.deepEqual(linked.rows[0], { observation_count: "2", owner_debt_evidence_id: evidenceId });
    assert.deepEqual(await store.listDispatchPreparations({ scope: owned.scope }), []);
    assert.equal((await store.read({ operationId: owned.operationId, scope: owned.scope }))?.revision,
      indebted.revision);
  });
});

postgresTest("recovery pages retained history and validates debt and later supported corruption", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
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
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
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
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
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

postgresTest("closure proof scans complete operation state, rejects stale scope and fences concurrent insertion", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const store = new PostgresContainedTurnOperationStore({ pool });
    // Recovery pagination is deliberately substituted: the closure capability must never use it.
    store.listDispatchPreparations = async () => [];
    const initial = operationForProject("project:closure-proof", "closure-proof");
    await store.accept(initial, operationAuthority(initial));
    const bound = mutateContainedTurnOperation(initial, {
      kind: "bind_workspace", workspaceId: containedTurnIdentity("workspace", "workspace:closure-proof"),
    });
    await store.commit({ authority: operationAuthority(bound), candidate: bound, expectedRevision: initial.revision });
    const authority = operationAuthority(bound);
    const prevention = await store.proofsForPrevention({
      authority, operation: bound, preventionProofId: containedTurnIdentity("proof", "proof:closure-prevention"),
    });
    const prevented = mutateContainedTurnOperation(bound, { kind: "prevent_dispatch", ...prevention });
    const [insertion, fencing] = await Promise.allSettled([
      store.prepareDispatch({ authority, operation: bound }),
      store.commit({ authority, candidate: prevented, expectedRevision: bound.revision }),
    ]);
    assert.equal(fencing.status, "fulfilled");
    if (fencing.status !== "fulfilled") {assert.fail("prevention did not commit");}
    assert.equal(fencing.value.kind, "applied");
    const input = { authority, expectedOperationRevision: prevented.revision,
      expectedOperationCutoffRevision: prevented.operationCutoff.revision };
    const proof = await store.proveDispatchPreparationClosure(input);
    if (insertion.status === "fulfilled") {assert.equal(proof, undefined);}
    else {assert.deepEqual(proof, { ...containedTurnPreparationClosureBinding(prevented, prevented.scope), preparationCount: 0 });}
    await assert.rejects(store.prepareDispatch({ authority, operation: prevented }), /fence/);
    assert.equal(await store.proveDispatchPreparationClosure({ ...input, expectedOperationRevision: bound.revision }), undefined);
    assert.equal(await store.proveDispatchPreparationClosure({ ...input, expectedOperationCutoffRevision: 0 }), undefined);
    for (const scope of [{ ...bound.scope, tenantId: "tenant:foreign" }, { ...bound.scope, projectId: "project:foreign" }]) {
      assert.equal(await store.proveDispatchPreparationClosure({ ...input, authority: { ...authority, scope } }), undefined);
    }
  });
});

postgresTest("closure proof requires custody and both grants, validates every row, and bounds 1,000 preparations", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const store = new PostgresContainedTurnOperationStore({ pool });
    const initial = operationForProject("project:closure-completeness", "closure-completeness");
    await store.accept(initial, operationAuthority(initial));
    const bound = mutateContainedTurnOperation(initial, {
      kind: "bind_workspace", workspaceId: containedTurnIdentity("workspace", "workspace:closure-completeness"),
    });
    const authority = operationAuthority(bound);
    await store.commit({ authority, candidate: bound, expectedRevision: initial.revision });
    await store.prepareDispatch({ authority, operation: bound });
    const active = (await store.listDispatchPreparations({ scope: bound.scope }))[0]!.preparation;
    const retired = await store.retireDispatchPreparation({
      authority, expectedOperationCutoffRevision: bound.operationCutoff.revision,
      expectedOperationRevision: bound.revision, preparationToken: active.preparationToken, reason: "prevention",
      consumedGrantRequestIds: {
        providerAccessGrantRequestId: `grant-request:${digestContainedTurnCanonicalValue({ owner: "provider_access" })}`,
        runtimeSecurityGrantRequestId: `grant-request:${digestContainedTurnCanonicalValue({ owner: "runtime_security" })}`,
      },
    });
    if (retired.kind !== "retired") {assert.fail("expected retired preparation");}
    const prevention = await store.proofsForPrevention({
      authority, operation: bound, preventionProofId: containedTurnIdentity("proof", "proof:complete-prevention"),
    });
    const prevented = mutateContainedTurnOperation(bound, { kind: "prevent_dispatch", ...prevention });
    await store.commit({ authority, candidate: prevented, expectedRevision: bound.revision });
    const input = { authority, expectedOperationRevision: prevented.revision,
      expectedOperationCutoffRevision: prevented.operationCutoff.revision };
    for (const target of ["custody", "provider_access", "runtime_security"] as const) {
      assert.equal(await store.proveDispatchPreparationClosure(input), undefined);
      await store.recordDispatchPreparationCleanup({ authority, permit: retired.preparation.cleanupPermit, target });
    }
    const expected = containedTurnPreparationClosureBinding(prevented, prevented.scope);
    assert.deepEqual(await store.proveDispatchPreparationClosure(input), { ...expected, preparationCount: 1 });
    const writeState = async (token: string, state: ReturnType<typeof encodeContainedTurnPreparation>) => runtimeQuery(pool,
      `INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1
         (operation_id,preparation_token,state_codec_version,state,state_digest)
       VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (operation_id,preparation_token)
       DO UPDATE SET state_codec_version=EXCLUDED.state_codec_version,state=EXCLUDED.state,state_digest=EXCLUDED.state_digest`,
      [bound.operationId, token, state.codecVersion, state.json, state.digest]);
    const closed = ["custody", "provider_access", "runtime_security"].reduce((preparation, target) =>
      recordContainedTurnPreparationCleanup(preparation, { permit: retired.preparation.cleanupPermit,
        target: target as "custody" | "provider_access" | "runtime_security" }), retired.preparation as typeof active);
    const foreign = { ...closed, operationId: containedTurnIdentity("operation", "operation:foreign") };
    await writeState(active.preparationToken, encodeContainedTurnPreparation(foreign));
    assert.equal(await store.proveDispatchPreparationClosure(input), undefined, "foreign row is not absence");
    await writeState(active.preparationToken, encodeContainedTurnPreparation(closed));
    const rows = Array.from({ length: 1_000 }, (_unused, index) => {
      const token = containedTurnIdentity("preparation", `preparation:closure-bound:${index}`);
      const pending = retireContainedTurnDispatchPreparation({ ...active, preparationToken: token }, `bound:${index}`);
      if (pending.kind !== "cleanup_pending") {assert.fail("bound fixture must retire its exact preparation");}
      const encoded = encodeContainedTurnPreparation(recordContainedTurnPreparationCleanup(pending, {
        permit: pending.cleanupPermit, target: "custody",
      }));
      return { token, state: JSON.parse(encoded.json), digest: encoded.digest, version: encoded.codecVersion };
    });
    await runtimeQuery(pool,
      `INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1
         (operation_id,preparation_token,state_codec_version,state,state_digest)
       SELECT $1,r.token,r.version,r.state,r.digest FROM jsonb_to_recordset($2::jsonb)
         AS r(token text,version integer,state jsonb,digest text)`,
      [bound.operationId, JSON.stringify(rows.slice(0, 999))]);
    assert.deepEqual(await store.proveDispatchPreparationClosure(input), { ...expected, preparationCount: 1_000 });
    const extra = rows[999]!;
    await writeState(extra.token, { codecVersion: extra.version, digest: extra.digest, json: JSON.stringify(extra.state) });
    assert.equal(await store.proveDispatchPreparationClosure(input), undefined, "all rows are closed but the proof is over budget");
  });
});
