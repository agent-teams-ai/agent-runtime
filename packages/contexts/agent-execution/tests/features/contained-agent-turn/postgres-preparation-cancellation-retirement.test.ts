import assert from "node:assert/strict";

import { encodeContainedTurnPreparation } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-preparation-codec.js";
import { applyContainedTurnPostgresSchema, CONTAINED_TURN_POSTGRES_MIGRATIONS } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-schema.js";
import { digestContainedTurnPostgresJson } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-state-codec.js";
import { PostgresContainedTurnOperationStore } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { containedTurnPreparationToken } from "../../../dist/features/contained-agent-turn/application/contained-turn-preparation-cleanup.js";
import { recoverContainedTurnDispatchPreparations } from "../../../dist/features/contained-agent-turn/application/contained-turn-preparation-recovery.js";
import { claimContainedTurnWithConsumedGrants } from "../../../dist/features/contained-agent-turn/application/contained-turn-grant-claim.js";
import type { ContainedTurnKernelDependencies } from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { mutateContainedTurnOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import {
  operationAuthority, operationForProject, postgresTest, resetSchema, runtimeQuery, withPool,
} from "./postgres-contained-turn-test-helpers.ts";
import { postgresClaimInput, preparePostgresClaim } from "./support/postgres-committed-dispatch-fixture.ts";

import { createPostgresReplayApplication } from "./support/postgres-replay-application.ts";
import { intentAuthority } from "./support/intent-guard-fixture.ts";
import { seedLegacyIntentOperation } from "./support/intent-guard-legacy-fixture.ts";

type Fixture = Awaited<ReturnType<typeof preparePostgresClaim>>;

postgresTest("delayed claim after both consumptions cannot close cancelled preparation before both settlements", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const { bound, claim, store } = await preparePostgresClaim(pool, "delayed-claim-settlement");
    const reachedClaim = Promise.withResolvers<void>();
    const resumeClaim = Promise.withResolvers<void>();
    const consumed: string[] = [];
    const settled = new Set<string>();
    const settlementIds = new Map<string, string>();
    let loseAccessAcknowledgement = true;
    let allowedSettlements = 0;
    let releases = 0;
    let delayedKind: string | undefined;
    const owner = (index: 0 | 1) => ({
      consumeForDispatch: async () => {
        consumed.push(claim.receipts[index].owner);
        return { kind: "consumed", receipt: claim.receipts[index] };
      },
      settleConsumedGrant: async ({ receipt, disposition, settlementRequestId }) => {
        assert.deepEqual(receipt, claim.receipts[index]);
        assert.equal(disposition, "abandoned_without_claim");
        if (index >= allowedSettlements) {throw new Error("disposable owner unavailable");}
        const replay = settled.has(receipt.owner);
        if (replay) {assert.equal(settlementIds.get(receipt.owner), settlementRequestId);}
        settlementIds.set(receipt.owner, settlementRequestId);
        settled.add(receipt.owner);
        if (index === 0 && loseAccessAcknowledgement) {
          loseAccessAcknowledgement = false;
          throw new Error("disposable lost settlement acknowledgement");
        }
        return { kind: replay ? "already_settled" : "settled" };
      },
    });
    const dependencies = {
      custody: { releaseRetiredReservation: async () => { releases += 1; return { kind: "released" }; } },
      operationStore: { claimPreparedDispatch: async input => {
        reachedClaim.resolve();
        await resumeClaim.promise;
        const result = await store.claimPreparedDispatch(input);
        delayedKind = result.kind;
        throw new Error("disposable lost stale-claim acknowledgement");
      } },
      provider: { execute: async () => assert.fail("no provider attempt permitted") },
      providerAccess: owner(0), security: owner(1),
    } as unknown as ContainedTurnKernelDependencies;
    const submitting = claimContainedTurnWithConsumedGrants(
      dependencies, bound, bound.scope, claim.subject, claim.claimInput.hostCustodyProof,
    );
    await reachedClaim.promise;
    try {
      assert.equal(consumed.length, 2);
      const active = (await store.listDispatchPreparations({ scope: bound.scope }))[0]!.preparation;
      assert.equal(active.providerAccessGrantRequestId, null);
      assert.equal(active.runtimeSecurityGrantRequestId, null);
      const cancelled = await cancel(store, bound);
      const restarted = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
      const recovering = { ...dependencies, operationStore: restarted };
      await recoverContainedTurnDispatchPreparations(recovering, bound.scope);
      const durable = await runtimeQuery<{ state: { payload: { kind: string } } }>(pool,
        "SELECT state FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1", [bound.operationId]);
      assert.equal(settled.size, 0);
      assert.equal(durable.rows[0]?.state.payload.kind, "cleanup_pending", "two consumed receipts with zero settlements must remain cleanup_pending");
      const pending = (await restarted.listDispatchPreparations({ scope: bound.scope }))[0]?.preparation;
      assert.equal(pending?.kind, "cleanup_pending", "two consumed receipts with zero settlements must remain cleanup_pending");
      if (pending?.kind !== "cleanup_pending") {throw new Error("missing owner obligations");}
      assert.equal(pending.providerAccessSettled, false);
      assert.equal(pending.runtimeSecuritySettled, false);
      assert.equal(pending.custodyReleased, true);
      assert.equal(settled.size, 0);
      resumeClaim.resolve();
      assert.equal((await submitting).kind, "unavailable");
      assert.equal(delayedKind, "stale");
      allowedSettlements = 1;
      await recoverContainedTurnDispatchPreparations(recovering, bound.scope);
      const lostAck = (await restarted.listDispatchPreparations({ scope: bound.scope }))[0]?.preparation;
      assert.equal(lostAck?.kind, "cleanup_pending");
      if (lostAck?.kind !== "cleanup_pending") {throw new Error("lost acknowledgement cannot prove settlement");}
      assert.equal(lostAck.providerAccessSettled, false);
      assert.equal(settled.size, 1);
      await recoverContainedTurnDispatchPreparations(recovering, bound.scope);
      const partial = (await restarted.listDispatchPreparations({ scope: bound.scope }))[0]?.preparation;
      assert.equal(partial?.kind, "cleanup_pending");
      if (partial?.kind !== "cleanup_pending") {throw new Error("second obligation disappeared");}
      assert.equal(partial.providerAccessSettled, true);
      assert.equal(partial.runtimeSecuritySettled, false);
      assert.deepEqual(partial.cleanupPermit, pending.cleanupPermit);
      allowedSettlements = 2;
      await recoverContainedTurnDispatchPreparations({ ...recovering, operationStore: new PostgresContainedTurnOperationStore({ intentAuthority, pool }) }, bound.scope);
      const closed = await runtimeQuery<{ state: { payload: { kind: string } } }>(pool,
        "SELECT state FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1", [bound.operationId]);
      assert.equal(closed.rows[0]?.state.payload.kind, "cleanup_closed");
      assert.equal(settled.size, 2);
      assert.equal(releases, 1);
      assert.equal((await store.claimPreparedDispatch(claim.claimInput)).kind, "stale");
      assert.deepEqual(await store.read({ operationId: bound.operationId, scope: bound.scope }), cancelled);
    } finally { resumeClaim.resolve(); await submitting; }
  });
});

postgresTest("settlement migration rejects legacy unproved closure and fences the previous runtime", async () => {
  await withPool(async pool => {
    await resetSchema(pool, 6);
    const oldStore = new PostgresContainedTurnOperationStore({ pool, runtimeSchemaVersion: 6 });
    const initial = operationForProject("project:settlement-migration", "settlement-migration");
    const bound = mutateContainedTurnOperation(initial, {
      kind: "bind_workspace", workspaceId: containedTurnIdentity("workspace", "workspace:settlement-migration"),
    });
    await seedLegacyIntentOperation(pool, bound, 6);
    const reservation = {
      attemptId: containedTurnIdentity("attempt", "attempt:settlement-migration"),
      custodyId: containedTurnIdentity("custody", "custody:settlement-migration"),
    };
    const preparationToken = containedTurnPreparationToken({ ...reservation, operationId: bound.operationId });
    const active = {
      ...reservation,
      kind: "active" as const,
      operationCutoffRevision: bound.operationCutoff.revision,
      operationId: bound.operationId,
      preparationToken,
      preparedOperationRevision: bound.revision,
      providerAccessGrantRequestId: null,
      runtimeSecurityGrantRequestId: null,
      workspaceId: bound.workspaceId!,
    };
    const encodedActive = encodeContainedTurnPreparation(active);
    await runtimeQuery(pool,
      `INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1
         (operation_id,preparation_token,state_codec_version,state,state_digest)
       VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [bound.operationId, preparationToken, encodedActive.codecVersion, encodedActive.json, encodedActive.digest], 6);
    const retired = await oldStore.retireDispatchPreparation({
      authority: operationAuthority(bound), expectedOperationCutoffRevision: 0,
      expectedOperationRevision: bound.revision, preparationToken, reason: "reconciliation",
    });
    if (retired.kind !== "retired") {throw new Error("missing legacy preparation");}
    const writeLegacy = async (payload: object) => {
      const envelope = { codecVersion: 4, payload };
      await runtimeQuery(pool,
        "UPDATE agent_execution.contained_turn_dispatch_preparation_v1 SET state=$2::jsonb,state_codec_version=4,state_digest=$3 WHERE operation_id=$1",
        [bound.operationId, JSON.stringify(envelope), digestContainedTurnPostgresJson(envelope)], 6);
    };
    const { cleanupPermit, custodyReleased: _custody, providerAccessSettled: _access, runtimeSecuritySettled: _security, ...rest } = retired.preparation;
    await writeLegacy({ ...rest, cleanupPermitId: cleanupPermit.permitId, kind: "cleanup_closed" });
    const history = await pool.query("SELECT * FROM agent_execution.schema_migration_history ORDER BY version");
    await assert.rejects(applyContainedTurnPostgresSchema(pool), /contained_turn_preparation_owner_closure/u);
    assert.deepEqual((await pool.query("SELECT * FROM agent_execution.schema_migration_history ORDER BY version")).rows, history.rows);
    assert.equal((await pool.query("SELECT version FROM agent_execution.schema_migration")).rows[0].version, 6);
    await writeLegacy({ ...retired.preparation, custodyReleased: true, providerAccessSettled: true, runtimeSecuritySettled: true });
    await applyContainedTurnPostgresSchema(pool, { targetVersion: 7 });
    await applyContainedTurnPostgresSchema(pool, { targetVersion: 7 });
    const identity = (await pool.query("SELECT version,migration_digest FROM agent_execution.schema_migration")).rows[0];
    assert.deepEqual(identity, { version: 7, migration_digest: CONTAINED_TURN_POSTGRES_MIGRATIONS[6]!.digest });
    await assert.rejects(oldStore.read({ operationId: bound.operationId, scope: bound.scope }), /schema/u);
    const restarted = new PostgresContainedTurnOperationStore({ intentAuthority, pool, runtimeSchemaVersion: 7 });
    const pending = (await restarted.listDispatchPreparations({ scope: bound.scope }))[0]?.preparation;
    assert.equal(pending?.kind, "cleanup_pending");
    if (pending?.kind !== "cleanup_pending") {throw new Error("legacy obligations disappeared");}
    assert.equal(pending.providerAccessSettled, false);
    assert.equal(pending.runtimeSecuritySettled, false);
    assert.deepEqual(pending.cleanupPermit, cleanupPermit);
  });
});

const cancel = async (store: Fixture["store"], operation: Fixture["bound"]) => {
  const authority = operationAuthority(operation);
  const { command, cutoffProof, proof } = await store.prepareCancellation({ authority, operation });
  const candidate = mutateContainedTurnOperation(operation, {
    command, cutoffProof, kind: "request_cancellation", proof,
  });
  assert.equal((await store.requestCancellation({
    authority, candidate, expectedRevision: operation.revision,
  })).kind, "applied");
  return candidate;
};

const retirementInput = ({ bound, claim }: Fixture) => ({
  authority: operationAuthority(bound),
  expectedOperationCutoffRevision: bound.operationCutoff.revision,
  expectedOperationRevision: bound.revision,
  preparationToken: claim.preparationToken,
  reason: "reconciliation" as const,
});

postgresTest("cancelled cutoff-zero preparation retires and recovers without a provider attempt", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const fixture = await preparePostgresClaim(pool, "cancelled-preparation");
    const { bound, store, claim } = fixture;
    assert.equal(bound.operationCutoff.revision, 0);
    const cancelled = await cancel(store, bound);
    assert.equal(cancelled.operationCutoff.revision, 1);
    assert.equal(cancelled.cancellation.kind, "requested");
    assert.equal(cancelled.dispatch.kind, "unclaimed");

    const restarted = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
    // Even valid consumed receipts cannot authorize the original active preparation.
    assert.equal((await restarted.claimPreparedDispatch(claim.claimInput)).kind, "stale");
    const input = retirementInput(fixture);
    let releases = 0;
    let providerAttempts = 0;
    const settlements: string[] = [];
    const dependencies = {
      custody: { releaseRetiredReservation: async ({ cleanupPermit }) => {
        releases += 1;
        assert.equal(cleanupPermit.operationCutoffRevision, 0);
        assert.equal(cleanupPermit.preparedOperationRevision, bound.revision);
        assert.equal(cleanupPermit.preparationToken, claim.preparationToken);
        assert.equal(cleanupPermit.workspaceId, bound.workspaceId);
        // Simulate a crash after durable retirement and before cleanup succeeds.
        if (releases === 1) {throw new Error("disposable cleanup interruption");}
        return { kind: "released" as const };
      } },
      operationStore: restarted,
      provider: { execute: async () => {providerAttempts += 1; assert.fail("unexpected provider attempt");} },
      providerAccess: { settleConsumedGrant: async ({ disposition, receipt }) => {
        assert.equal(disposition, "abandoned_without_claim");
        assert.deepEqual(receipt, claim.receipts[0]);
        settlements.push("provider_access");
        return { kind: "settled" as const };
      } },
      security: { settleConsumedGrant: async ({ disposition, receipt }) => {
        assert.equal(disposition, "abandoned_without_claim");
        assert.deepEqual(receipt, claim.receipts[1]);
        settlements.push("runtime_security");
        return { kind: "settled" as const };
      } },
    } as unknown as ContainedTurnKernelDependencies;
    assert.deepEqual(await recoverContainedTurnDispatchPreparations(dependencies, bound.scope), {
      discovered: 1, retired: 1,
    });
    const pending = (await restarted.listDispatchPreparations({ scope: bound.scope }))[0]?.preparation;
    assert.equal(pending?.kind, "cleanup_pending");
    const replay = await restarted.retireDispatchPreparation(input);
    assert.equal(replay.kind, "retired");
    if (replay.kind !== "retired") {throw new Error("retirement replay missing");}
    assert.deepEqual(replay.preparation, pending);
    // Valid original receipts cannot turn the retired preparation into a claim.
    assert.equal((await restarted.claimPreparedDispatch(claim.claimInput)).kind, "stale");
    assert.deepEqual(await recoverContainedTurnDispatchPreparations(dependencies, bound.scope), {
      discovered: 1, retired: 0,
    });
    assert.deepEqual(await recoverContainedTurnDispatchPreparations(dependencies, bound.scope), {
      discovered: 0, retired: 0,
    });
    assert.equal(releases, 2);
    assert.deepEqual(settlements, ["provider_access", "runtime_security"]);
    assert.equal(providerAttempts, 0);
    assert.deepEqual(await restarted.read({ operationId: bound.operationId, scope: bound.scope }), cancelled);
    const rows = await runtimeQuery<{ state: { payload: { kind: string; operationCutoffRevision: number } } }>(
      pool, "SELECT state FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1 AND preparation_token=$2",
      [bound.operationId, claim.preparationToken],
    );
    assert.equal(rows.rows[0]?.state.payload.kind, "cleanup_closed");
    assert.equal(rows.rows[0]?.state.payload.operationCutoffRevision, 0);
  });
});

postgresTest("cancellation retirement retains exact scope, token, revision, cutoff and workspace fences", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const fixture = await preparePostgresClaim(pool, "cancelled-preparation-fences");
    const { bound, store } = fixture;
    const active = (await store.listDispatchPreparations({ scope: bound.scope }))[0]!.preparation;
    // An unmatched cutoff is insufficient without durable cancellation facts.
    assert.equal((await store.retireDispatchPreparation({
      ...retirementInput(fixture), expectedOperationCutoffRevision: 1,
    })).kind, "stale");
    const cancelled = await cancel(store, bound);
    const input = retirementInput(fixture);
    for (const scope of [
      { ...bound.scope, tenantId: "tenant:foreign" },
      { ...bound.scope, projectId: "project:foreign" },
    ]) {
      assert.deepEqual(await store.listDispatchPreparations({ scope }), []);
      // Wrong scope remains unavailable under the existing owner-store contract.
      assert.equal((await store.retireDispatchPreparation({
        ...input, authority: { ...input.authority, scope },
      })).kind, "indeterminate");
    }
    for (const invalid of [
      { ...input, preparationToken: containedTurnIdentity("preparation", "preparation:wrong") },
      { ...input, expectedOperationRevision: cancelled.revision },
      { ...input, expectedOperationRevision: bound.revision - 1 },
      { ...input, expectedOperationCutoffRevision: 1 },
    ]) {
      assert.equal((await store.retireDispatchPreparation(invalid)).kind, "stale");
    }
    for (const authority of [
      { ...input.authority, commandId: containedTurnIdentity("command", "command:wrong") },
      { ...input.authority, effectId: containedTurnIdentity("effect", "effect:wrong") },
    ]) {
      await assert.rejects(store.retireDispatchPreparation({ ...input, authority }), /authority mismatch/u);
    }
    const writePreparation = async (preparation: typeof active) => {
      const encoded = encodeContainedTurnPreparation(preparation);
      await runtimeQuery(pool,
        "UPDATE agent_execution.contained_turn_dispatch_preparation_v1 SET state=$3::jsonb,state_codec_version=$4,state_digest=$5 WHERE operation_id=$1 AND preparation_token=$2",
        [bound.operationId, input.preparationToken, encoded.json, encoded.codecVersion, encoded.digest]);
    };
    for (const changed of [
      { ...active, operationId: containedTurnIdentity("operation", "operation:foreign") },
      { ...active, preparationToken: containedTurnIdentity("preparation", "preparation:payload-wrong") },
      { ...active, workspaceId: containedTurnIdentity("workspace", "workspace:foreign") },
      { ...active, kind: "claimed" as const },
    ]) {
      await writePreparation(changed);
      assert.equal((await store.retireDispatchPreparation(input)).kind, "stale");
    }
    await writePreparation({ ...active, preparedOperationRevision: cancelled.revision });
    assert.equal((await store.retireDispatchPreparation({
      ...input, expectedOperationRevision: cancelled.revision,
    })).kind, "stale");
    await writePreparation(active);
    assert.deepEqual((await store.listDispatchPreparations({ scope: bound.scope }))[0]?.preparation, active);
    assert.equal((await store.retireDispatchPreparation(input)).kind, "retired");
  });
});

postgresTest("claim plus cancellation retires only the losing preparation across recovery and replay", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const fixture = await preparePostgresClaim(pool, "claimed-cancelled-preparation");
    const { store, claim, bound } = fixture;
    const reservation = await store.prepareDispatch({ authority: operationAuthority(bound), operation: bound });
    const loser = postgresClaimInput(bound, bound.workspaceId!, reservation, "cancelled-loser");
    for (const index of [0, 1] as const) {
      assert.notEqual(loser.receipts[index].grantRequestId, claim.receipts[index].grantRequestId);
    }
    const reachedClaim = Promise.withResolvers<void>();
    const resumeClaim = Promise.withResolvers<void>();
    const consumed: string[] = [];
    const submitting = claimContainedTurnWithConsumedGrants({
      operationStore: { claimPreparedDispatch: async input => {
        reachedClaim.resolve();
        await resumeClaim.promise;
        const result = await store.claimPreparedDispatch(input);
        assert.equal(result.kind, "stale");
        assert.equal("committedDispatchProof" in result, false);
        return result;
      } },
      providerAccess: { consumeForDispatch: async () => {
        consumed.push("provider_access"); return { kind: "consumed", receipt: loser.receipts[0] };
      } },
      security: { consumeForDispatch: async () => {
        consumed.push("runtime_security"); return { kind: "consumed", receipt: loser.receipts[1] };
      } },
    } as unknown as ContainedTurnKernelDependencies, bound, bound.scope, loser.subject, loser.claimInput.hostCustodyProof);
    await Promise.race([reachedClaim.promise, submitting.then(() => assert.fail("loser stopped before the claim barrier"))]);
    try {
      assert.deepEqual(consumed, ["provider_access", "runtime_security"]);
      const claimed = await store.claimPreparedDispatch(claim.claimInput);
      if (claimed.kind !== "claimed") {throw new Error("durable claim missing");}
      const cancelled = await cancel(store, claimed.operation);
      assert.deepEqual(cancelled.dispatch, claimed.operation.dispatch);
      assert.equal(cancelled.terminal.kind, "open");
      assert.equal(cancelled.operationCutoff.revision, bound.operationCutoff.revision + 1);
      // B's receipts have not reached PostgreSQL yet; it still cannot adopt A's grants.
      for (const consumedGrantRequestIds of [
        { providerAccessConsumptionReceipt: claim.receipts[0] },
        { runtimeSecurityConsumptionReceipt: claim.receipts[1] },
      ]) {
        await assert.rejects(store.retireDispatchPreparation({ ...retirementInput(fixture),
          preparationToken: loser.preparationToken, consumedGrantRequestIds }), /claimed grant/u);
      }
      resumeClaim.resolve();
      assert.equal((await submitting).kind, "unavailable", "a losing claim cannot authorize provider start");
      const winnerRow = async () => (await runtimeQuery(pool,
        "SELECT state,state_digest,state_codec_version FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1 AND preparation_token=$2",
        [bound.operationId, claim.preparationToken])).rows;
      const winnerBefore = await winnerRow();
      const input = { ...retirementInput(fixture), preparationToken: loser.preparationToken };
      assert.equal((await store.retireDispatchPreparation(retirementInput(fixture))).kind, "claimed");
      for (const patch of [
        { expectedOperationRevision: cancelled.revision },
        { expectedOperationCutoffRevision: cancelled.operationCutoff.revision },
        { preparationToken: containedTurnIdentity("preparation", "preparation:missing-loser") },
      ]) {assert.equal((await store.retireDispatchPreparation({ ...input, ...patch })).kind, "stale");}
      for (const scope of [{ ...bound.scope, tenantId: "tenant:foreign" }, { ...bound.scope, projectId: "project:foreign" }]) {
        assert.equal((await store.retireDispatchPreparation({ ...input, authority: { ...input.authority, scope } })).kind, "indeterminate");
      }
      await assert.rejects(store.retireDispatchPreparation({ ...input, consumedGrantRequestIds: {
        providerAccessConsumptionReceipt: claim.receipts[0], runtimeSecurityConsumptionReceipt: claim.receipts[1],
      } }), /substitution/u);
      let allowSecurity = false;
      let released = false;
      const settled = new Set<string>();
      const settlementIds = new Map<string, string>();
      const calls: string[] = [];
      const owner = (index: 0 | 1) => ({ settleConsumedGrant: async ({ receipt, disposition, settlementRequestId }) => {
        assert.deepEqual(receipt, loser.receipts[index]);
        assert.equal(disposition, "abandoned_without_claim");
        if (index === 1 && !allowSecurity) {throw new Error("disposable owner unavailable");}
        calls.push(receipt.owner);
        if (settled.has(receipt.owner)) {
          assert.equal(settlementIds.get(receipt.owner), settlementRequestId);
          return { kind: "already_settled" };
        }
        settled.add(receipt.owner);
        settlementIds.set(receipt.owner, settlementRequestId);
        if (index === 0) {throw new Error("disposable lost settlement acknowledgement");}
        return { kind: "settled" };
      } });
      const restarted = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
      const dependencies = {
        custody: { releaseRetiredReservation: async ({ cleanupPermit }) => {
          assert.equal(cleanupPermit.preparationToken, loser.preparationToken);
          assert.equal(cleanupPermit.attemptId, loser.subject.attemptId);
          assert.equal(cleanupPermit.custodyId, loser.subject.custodyId);
          assert.equal(cleanupPermit.workspaceId, bound.workspaceId);
          assert.equal(cleanupPermit.operationCutoffRevision, bound.operationCutoff.revision);
          assert.equal(cleanupPermit.preparedOperationRevision, bound.revision);
          calls.push("custody");
          if (released) {return { kind: "already_released" };}
          released = true;
          throw new Error("disposable lost custody acknowledgement");
        } },
        operationStore: restarted,
        provider: { execute: async () => assert.fail("cleanup cannot start a provider") },
        providerAccess: owner(0), security: owner(1),
      } as unknown as ContainedTurnKernelDependencies;
      const pendingPreparation = async () => (await restarted.listDispatchPreparations({ scope: bound.scope }))[0]?.preparation;
      assert.deepEqual(await recoverContainedTurnDispatchPreparations(dependencies, bound.scope), { discovered: 1, retired: 1 });
      const pending = await pendingPreparation();
      if (pending?.kind !== "cleanup_pending") {throw new Error("loser retirement missing");}
      assert.equal(pending.custodyReleased, false);
      assert.equal(pending.providerAccessSettled, false);
      assert.equal(pending.runtimeSecuritySettled, false);
      const retirementReplay = await restarted.retireDispatchPreparation(input);
      assert.equal(retirementReplay.kind, "retired");
      if (retirementReplay.kind === "retired") {assert.deepEqual(retirementReplay.preparation, pending);}
      for (const patch of [
        { preparationToken: claim.preparationToken }, { custodyId: claim.subject.custodyId },
        { preparedOperationRevision: cancelled.revision }, { operationCutoffRevision: cancelled.operationCutoff.revision },
      ]) {
        await assert.rejects(restarted.recordDispatchPreparationCleanup({ authority: input.authority,
          permit: { ...pending.cleanupPermit, ...patch }, target: "custody" }), /exact retired preparation permit/u);
      }
      assert.deepEqual(await recoverContainedTurnDispatchPreparations(dependencies, bound.scope), { discovered: 1, retired: 0 });
      const partial = await pendingPreparation();
      if (partial?.kind !== "cleanup_pending") {throw new Error("security obligation disappeared");}
      assert.equal(partial.custodyReleased, true);
      assert.equal(partial.providerAccessSettled, true);
      assert.equal(partial.runtimeSecuritySettled, false);
      assert.deepEqual(partial.cleanupPermit, pending.cleanupPermit);
      allowSecurity = true;
      const recovered = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
      assert.deepEqual(await recoverContainedTurnDispatchPreparations({ ...dependencies, operationStore: recovered }, bound.scope), { discovered: 1, retired: 0 });
      const closed = await recovered.recordDispatchPreparationCleanup({ authority: input.authority,
        permit: pending.cleanupPermit, target: "runtime_security" });
      assert.equal(closed.kind, "cleanup_closed", "exact cleanup acknowledgement replay is idempotent");
      assert.deepEqual(await recoverContainedTurnDispatchPreparations({ ...dependencies, operationStore: recovered }, bound.scope), { discovered: 0, retired: 0 });
      assert.deepEqual(calls, ["custody", "provider_access", "custody", "provider_access", "runtime_security"]);
      assert.equal((await recovered.claimPreparedDispatch(loser.claimInput)).kind, "stale");
      const replay = await recovered.claimPreparedDispatch(claim.claimInput);
      assert.equal(replay.kind, "observed_claim");
      assert.equal("committedDispatchProof" in replay, false);
      const application = createPostgresReplayApplication(recovered, bound.scope);
      for (let index = 0; index < 2; index += 1) {
        const result = await application.application.submit({ commandId: bound.commandId,
          expectedProvider: bound.adapterSnapshot.provider, intent: bound.intent, scope: bound.scope });
        assert.equal(result.status, "observed");
      }
      assert.equal(application.providerCalls.value, 0, "recovery and duplicate submit cannot create a second attempt");
      assert.equal(application.starts.value, 0);
      assert.equal(application.claims.length, 0);
      assert.deepEqual(await winnerRow(), winnerBefore);
      assert.deepEqual(await recovered.read({ operationId: bound.operationId, scope: bound.scope }), cancelled);
    } finally {resumeClaim.resolve(); await submitting;}
  });
});
