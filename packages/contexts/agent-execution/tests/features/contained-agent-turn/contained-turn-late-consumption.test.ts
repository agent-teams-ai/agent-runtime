import assert from "node:assert/strict";
import test from "node:test";
import { decodeContainedTurnPreparation, encodeContainedTurnPreparation } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-preparation-codec.js";
import { recoverContainedTurnDispatchPreparations } from "../../../dist/features/contained-agent-turn/application/contained-turn-preparation-recovery.js";
import { containedTurnOwnerStoreAuthority } from "../../../dist/features/contained-agent-turn/application/contained-turn-store-authority.js";
import { createContainedTurnFeature } from "../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import {
  bindContainedTurnPreparationGrantRequests,
  claimContainedTurnDispatchPreparation,
  recordContainedTurnPreparationCleanup,
  retireContainedTurnDispatchPreparation,
  type ContainedTurnDispatchPreparation,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-preparation.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { attemptId, custodyId, operationId, preparationToken, workspaceId } from "../../contained-turn-kernel-fixtures.ts";
import { consumedReceipt, grantSubject } from "./support/dispatch-grant-fixture.ts";
import { awaitFixtureGate, gate, intentHarness, submission } from "./support/intent-guard-fixture.ts";
import { IntentGuardSqlFixture } from "./support/intent-guard-sql-fixture.ts";

const active = Object.freeze({
  attemptId, custodyId, kind: "active" as const, operationCutoffRevision: 0, operationId,
  preparationToken, preparedOperationRevision: 1, providerAccessGrantRequestId: null,
  runtimeSecurityGrantRequestId: null, workspaceId,
});
const pending = (value: ContainedTurnDispatchPreparation) => {
  assert.ok(value.kind === "cleanup_pending");
  return value;
};
const roundTrip = (value: ContainedTurnDispatchPreparation) => {
  const encoded = encodeContainedTurnPreparation(value);
  return decodeContainedTurnPreparation(JSON.parse(encoded.json), encoded.digest, encoded.codecVersion);
};

for (const releasedFirst of [false, true]) {
  test(`late prevention retains the recovery permit and closes cleanup with custody first=${String(releasedFirst)}`, () => {
    let retired = pending(retireContainedTurnDispatchPreparation(active, "recovery", {}, {}, "reconciliation"));
    const permit = retired.cleanupPermit;
    if (releasedFirst) {
      retired = pending(recordContainedTurnPreparationCleanup(retired, { permit, target: "custody" }));
    }
    const late = pending(retireContainedTurnDispatchPreparation(roundTrip(retired), "late", {}, {}, "prevention"));
    assert.equal(late.providerAccessNotConsumed, true);
    assert.equal(late.runtimeSecurityNotConsumed, true);
    assert.deepEqual(late.cleanupPermit, permit);
    assert.equal(late.custodyReleased, releasedFirst);
    assert.equal(late.providerAccessSettled, false);
    assert.equal(late.runtimeSecuritySettled, false);
    assert.deepEqual(retireContainedTurnDispatchPreparation(late, "replay", {}, {}, "prevention"), late);
    assert.deepEqual(retireContainedTurnDispatchPreparation(late, "recovery-replay"), late);
    assert.throws(() => claimContainedTurnDispatchPreparation(late), /never be claimed/u);
    const closed = recordContainedTurnPreparationCleanup(late, { permit, target: "custody" });
    assert.equal(closed.kind, "cleanup_closed");
    assert.deepEqual(roundTrip(closed), closed);
    assert.strictEqual(recordContainedTurnPreparationCleanup(closed, { permit, target: "custody" }), closed);
  });
}

for (const owner of ["providerAccess", "runtimeSecurity"] as const) {
  const receiptKey = `${owner}ConsumptionReceipt` as const;
  const requestKey = `${owner}GrantRequestId` as const;
  const evidenceKey = `${owner}EvidenceId` as const;
  const storedEvidenceKey = `${owner}ConsumptionEvidenceId` as const;
  const negativeKey = `${owner}NotConsumed` as const;
  const receipt = consumedReceipt(owner === "providerAccess" ? "provider_access" : "runtime_security", grantSubject());
  const evidenceId = containedTurnIdentity("evidence", `evidence:late-${owner}`);

  test(`late ${owner} ambiguity is durable and never becomes negative consumption proof`, () => {
    const retired = pending(retireContainedTurnDispatchPreparation(active, "recovery"));
    const late = pending(retireContainedTurnDispatchPreparation(retired, "late", {}, { [evidenceKey]: evidenceId }, "prevention"));
    assert.equal(late[storedEvidenceKey], evidenceId);
    assert.equal(late[negativeKey], false);
    assert.ok(late.cleanupEvidenceIds.includes(evidenceId));
    assert.deepEqual(late.cleanupPermit, retired.cleanupPermit);
    const replay = pending(retireContainedTurnDispatchPreparation(roundTrip(late), "replay", {}, {}, "prevention"));
    assert.equal(replay[negativeKey], false, "absence in a later call cannot erase earlier ambiguity");
    assert.deepEqual(replay, late);
    assert.equal(recordContainedTurnPreparationCleanup(replay, { permit: replay.cleanupPermit, target: "custody" }).kind, "cleanup_pending");
    assert.throws(() => retireContainedTurnDispatchPreparation(late, "conflict", {}, {
      [evidenceKey]: containedTurnIdentity("evidence", "evidence:substituted"),
    }, "prevention"), /substitution/u);
    const consumed = pending(retireContainedTurnDispatchPreparation(late, "receipt", { [receiptKey]: receipt }));
    assert.deepEqual(consumed[receiptKey], receipt);
    assert.equal(consumed[negativeKey], false);
    assert.equal(consumed[storedEvidenceKey], evidenceId);
    assert.deepEqual(consumed.cleanupPermit, retired.cleanupPermit);
    assert.deepEqual(roundTrip(consumed), consumed);
  });

  test(`${owner} negative consumption rejects contradictory receipts, requests and ambiguity`, () => {
    const negative = pending(retireContainedTurnDispatchPreparation(active, "prevention", {}, {}, "prevention"));
    for (const facts of [{ [receiptKey]: receipt }, { [requestKey]: receipt.grantRequestId }]) {
      assert.throws(() => retireContainedTurnDispatchPreparation(negative, "contradiction", facts), /not.consumed|contradict/u);
      assert.throws(() => bindContainedTurnPreparationGrantRequests(negative, facts), /not.consumed|contradict/u);
    }
    assert.throws(() => retireContainedTurnDispatchPreparation(negative, "contradiction", {}, { [evidenceKey]: evidenceId }), /not.consumed|contradict/u);
    assert.deepEqual(roundTrip(negative), negative);
  });

  test(`${owner} late receipt replay preserves settlement and rejects substitution`, () => {
    const recovered = pending(retireContainedTurnDispatchPreparation(active, "recovery"));
    const unknown = pending(retireContainedTurnDispatchPreparation(recovered, "unknown", { [requestKey]: receipt.grantRequestId }));
    const withoutProof = pending(retireContainedTurnDispatchPreparation(unknown, "prevention", {}, {}, "prevention"));
    assert.equal(withoutProof[negativeKey], false, "a request identity without a receipt is still unresolved");
    const facts = { [receiptKey]: receipt, [requestKey]: receipt.grantRequestId };
    const consumed = pending(retireContainedTurnDispatchPreparation(withoutProof, "receipt", facts, {}, "prevention"));
    const settled = pending(recordContainedTurnPreparationCleanup(consumed, {
      permit: recovered.cleanupPermit, target: owner === "providerAccess" ? "provider_access" : "runtime_security",
    }));
    const replay = pending(retireContainedTurnDispatchPreparation(roundTrip(settled), "replay", facts, {}, "prevention"));
    assert.equal(replay[`${owner}Settled`], true);
    assert.deepEqual(replay, settled);
    assert.deepEqual(replay.cleanupPermit, recovered.cleanupPermit);
    assert.throws(() => retireContainedTurnDispatchPreparation(replay, "conflict", {
      [receiptKey]: { ...receipt, ownerEvidenceRef: "evidence:substituted-receipt" },
    }), /receipt substitution/u);
    assert.throws(() => retireContainedTurnDispatchPreparation(replay, "conflict", {
      [requestKey]: `grant-request:sha256:${"f".repeat(64)}`,
    }), /identity substitution/u);
    assert.equal(recordContainedTurnPreparationCleanup(replay, { permit: recovered.cleanupPermit, target: "custody" }).kind, "cleanup_closed");
  });
}

for (const consumedOwner of ["neither", "provider_access", "runtime_security"] as const) {
  test(`recovery races outstanding owner outcomes with ${consumedOwner} consumed`, { timeout: 5_000 }, async t => {
    const database = new IntentGuardSqlFixture();
    const runner = intentHarness(database.pool);
    // The existing SQL double implements point reads, so supply its recovery
    // enumeration from codec-validated rows; retirement and cleanup use the store.
    runner.store.listDispatchPreparations = async input => {
      const rows = [];
      for (const row of database.tables.preparations) {
        const preparation = decodeContainedTurnPreparation(row.state, row.state_digest, row.state_codec_version);
        if (preparation.kind !== "active" && preparation.kind !== "cleanup_pending") {continue;}
        const operation = await runner.store.read({ operationId: preparation.operationId, scope: input.scope });
        assert.ok(operation);
        rows.push({ operation, preparation });
      }
      return rows;
    };
    const accessEntered = gate(); const securityEntered = gate(); const resume = gate();
    t.after(resume.release);
    const prevention = { kind: "prevented" as const, preventionProofId: containedTurnIdentity("proof", "proof:late-owner-prevention") };
    const feature = createContainedTurnFeature({
      ...runner.dependencies,
      providerAccess: { ...runner.dependencies.providerAccess, consumeForDispatch: async input => {
        accessEntered.release(); await resume.promise;
        return consumedOwner === "provider_access" ? runner.dependencies.providerAccess.consumeForDispatch(input) : prevention;
      } },
      security: { ...runner.dependencies.security, consumeForDispatch: async input => {
        securityEntered.release(); await resume.promise;
        return consumedOwner === "runtime_security" ? runner.dependencies.security.consumeForDispatch(input) : prevention;
      } },
    });
    const submitting = feature.submit.execute(submission);
    await awaitFixtureGate(Promise.all([accessEntered.promise, securityEntered.promise]), submitting);
    assert.deepEqual(await recoverContainedTurnDispatchPreparations(runner.dependencies, submission.scope), { discovered: 1, retired: 1 });
    const [row] = await runner.store.listDispatchPreparations({ scope: submission.scope });
    assert.ok(row);
    const recovery = pending(row.preparation);
    assert.equal(recovery.custodyReleased, true);
    assert.equal(recovery.providerAccessNotConsumed, false);
    assert.equal(recovery.runtimeSecurityNotConsumed, false);
    resume.release();
    await submitting;
    assert.deepEqual(await runner.store.listDispatchPreparations({ scope: submission.scope }), [], "late owner facts must discharge the retired preparation");
    const closed = await runner.store.recordDispatchPreparationCleanup({
      authority: containedTurnOwnerStoreAuthority(row.operation, submission.scope),
      permit: recovery.cleanupPermit, target: "custody",
    });
    assert.ok(closed.kind === "cleanup_closed");
    assert.equal(closed.cleanupPermitId, recovery.cleanupPermit.permitId);
    assert.equal(closed.providerAccessNotConsumed, consumedOwner !== "provider_access");
    assert.equal(closed.runtimeSecurityNotConsumed, consumedOwner !== "runtime_security");
    assert.equal(runner.counts.provider, 0);
    assert.equal(runner.counts.custodyStart, 0);
    assert.deepEqual(await recoverContainedTurnDispatchPreparations(runner.dependencies, submission.scope), { discovered: 0, retired: 0 });
  });
}
