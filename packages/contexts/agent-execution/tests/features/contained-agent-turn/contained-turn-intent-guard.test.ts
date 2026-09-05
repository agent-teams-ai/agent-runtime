import assert from "node:assert/strict";
import test from "node:test";
import { PostgresContainedTurnOperationStore } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { awaitFixtureGate, gate, intentAuthority, intentHarness, prevention, submission } from "./support/intent-guard-fixture.ts";
import { IntentGuardSqlFixture } from "./support/intent-guard-sql-fixture.ts";

test("ADR-0004 prevention-first survives lost receipt, restart and restored delayed submission with zero materialization", async () => {
  const database = new IntentGuardSqlFixture();
  const first = intentHarness(database.pool);
  const input = { prevention: prevention(), scope: submission.scope };
  const cancelled = await first.feature.cancel.execute(input);
  assert.equal(cancelled.kind, "committed");
  if (cancelled.kind !== "committed") {assert.fail();}
  assert.equal(cancelled.receipt.disposition, "intent_guarded");
  assert.equal(cancelled.receipt.operationId, null);
  assert.equal(cancelled.receipt.cutoffProofId, null);
  const restored = new IntentGuardSqlFixture();
  restored.restore(database.tables);
  for (const db of [database, restored]) {
    const restarted = intentHarness(db.pool);
    assert.deepEqual(await restarted.feature.cancel.execute(input), cancelled);
    assert.deepEqual(await restarted.feature.submit.execute(submission), { status: "denied" });
    assert.deepEqual(await restarted.feature.submit.execute(submission), { status: "denied" });
    assert.deepEqual(restarted.counts, { custodyOpen: 0, custodyStart: 0, provider: 0, workspace: 0, access: 0, security: 0 });
    assert.equal(db.tables.operations.length, 0);
    assert.equal(db.tables.proofs.length, 0);
    assert.equal(db.tables.preparations.length, 0);
  }
});

test("prevention racing the in-flight acceptance decision rejects its candidate before persistence", async () => {
  const database = new IntentGuardSqlFixture();
  const entered = gate(); const release = gate();
  const runner = intentHarness(database.pool, { beforeAcceptance: async () => {entered.release(); await release.promise;} });
  const pending = runner.feature.submit.execute(submission);
  await awaitFixtureGate(entered.promise, pending);
  try {
    const outcome = await runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
    assert.equal(outcome.kind, "committed");
    if (outcome.kind === "committed") {assert.equal(outcome.receipt.disposition, "intent_guarded");}
  } finally {release.release();}
  assert.deepEqual(await pending, { status: "denied" });
  assert.equal(database.tables.operations.length, 0);
  assert.equal(runner.counts.workspace, 0);
  assert.equal(runner.counts.provider, 0);
});

test("acceptance-first prevention wins over prepared claim and original replay observes the same fenced operation", async () => {
  const database = new IntentGuardSqlFixture();
  const entered = gate(); const release = gate();
  const runner = intentHarness(database.pool, { beforeClaim: async () => {entered.release(); await release.promise;} });
  const pending = runner.feature.submit.execute(submission);
  await awaitFixtureGate(entered.promise, pending);
  try {
    const outcome = await runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
    assert.equal(outcome.kind, "committed");
    if (outcome.kind !== "committed") {assert.fail();}
    assert.equal(outcome.receipt.disposition, "operation_fenced");
    assert.ok(outcome.receipt.cutoffProofId);
    const current = await runner.store.read({ operationId: outcome.receipt.operationId!, scope: submission.scope });
    assert.equal(current?.dispatch.kind, "prevented");
    assert.equal(current?.admissionFence.kind, "fenced");
    assert.equal(current?.operationCutoff.kind, "closed");
  } finally {release.release();}
  const completed = await pending;
  assert.equal(completed.status, "observed");
  assert.equal(runner.counts.custodyStart, 0);
  assert.equal(runner.counts.provider, 0);
  const restarted = intentHarness(database.pool);
  const replay = await restarted.feature.submit.execute(submission);
  assert.equal(replay.status, "observed");
  if (replay.status === "observed" && completed.status === "observed") {assert.equal(replay.turn.operationId, completed.turn.operationId);}
  assert.equal(restarted.counts.provider, 0);
  assert.equal(restarted.counts.custodyOpen, 0);
});

test("claim-first prevention retains the sole provider attempt and commits normal cutoff plus reconciliation debt", async () => {
  const database = new IntentGuardSqlFixture();
  const entered = gate(); const release = gate();
  const runner = intentHarness(database.pool, { beforeProvider: async () => {entered.release(); await release.promise;} });
  const pending = runner.feature.submit.execute(submission);
  await awaitFixtureGate(entered.promise, pending);
  let receipt;
  try {
    const before = structuredClone(database.tables.operations[0]!.state.payload.dispatch);
    const outcome = await runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
    assert.equal(outcome.kind, "committed");
    if (outcome.kind !== "committed") {assert.fail();}
    receipt = outcome.receipt;
    assert.equal(receipt.disposition, "cutoff_requested");
    const current = await runner.store.read({ operationId: receipt.operationId!, scope: submission.scope });
    assert.deepEqual(current?.dispatch, before);
    assert.equal(current?.operationCutoff.kind, "closed");
    assert.equal(current?.reconciliation.kind, "required");
    assert.equal(current?.terminal.kind, "open");
    assert.notEqual(current?.providerAcceptance.kind, "not_accepted");
  } finally {release.release();}
  assert.equal((await pending).status, "observed");
  assert.equal(runner.counts.provider, 1);
  const restarted = intentHarness(database.pool);
  assert.deepEqual(await restarted.feature.cancel.execute({ prevention: prevention(), scope: submission.scope }), { kind: "committed", receipt });
  assert.equal((await restarted.feature.submit.execute(submission)).status, "observed");
  assert.equal(restarted.counts.provider, 0);
  assert.equal(restarted.counts.custodyStart, 0);
});

test("simultaneous prevention/acceptance transactions honor both serial orders", async () => {
  for (const preventionFirst of [true, false]) {
    const db = new IntentGuardSqlFixture();
    const runner = intentHarness(db.pool);
    const submit = () => runner.feature.submit.execute(submission);
    const prevent = () => runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
    const outcomes = await Promise.all(preventionFirst ? [prevent(), submit()] : [submit(), prevent()]);
    assert.equal(outcomes.length, 2);
    assert.equal(runner.counts.provider, 0);
    assert.equal(db.tables.guards.length, 1);
    assert.ok(db.tables.operations.every(row => row.state.payload.dispatch.kind !== "claimed"));
  }
});

test("original/prevention command fingerprint conflicts never disclose another scoped operation", async () => {
  const db = new IntentGuardSqlFixture(); const runner = intentHarness(db.pool);
  await runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
  assert.deepEqual(await runner.feature.submit.execute({ ...submission, intent: { ...submission.intent, prompt: "changed intent" } }), { code: "command_fingerprint_conflict", status: "conflict" });
  for (const command of [prevention({ commandFingerprint: `sha256:${"f".repeat(64)}` as never }), prevention({ commandId: containedTurnIdentity("command", "command:another") }), prevention({ targetIntentCorrelation: "different-correlation" })]) {
    assert.deepEqual(await runner.feature.cancel.execute({ prevention: command, scope: submission.scope }), { kind: "conflict" });
  }
  const before = db.statements.length;
  for (const scope of [{ ...submission.scope, tenantId: "tenant:other" }, { ...submission.scope, projectId: "project:other" }]) {
    assert.deepEqual(await runner.feature.cancel.execute({ prevention: prevention(), scope }), { kind: "denied" });
  }
  assert.equal(db.statements.length, before);
  assert.equal(db.tables.operations.length, 0);
});

test("every authority field is exact; old incarnation stores cannot accept or claim within a retained namespace", async () => {
  const db = new IntentGuardSqlFixture(); const runner = intentHarness(db.pool);
  await runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
  for (const field of Object.keys(intentAuthority) as (keyof typeof intentAuthority)[]) {
    const authority = { ...intentAuthority, [field]: field === "externalAuthorityDigest" ? `sha256:${"f".repeat(64)}` : "other:authority" };
    assert.deepEqual(await runner.feature.cancel.execute({ prevention: prevention({ authority }), scope: submission.scope }), { kind: "denied" });
    const stale = new PostgresContainedTurnOperationStore({ pool: db.pool, intentAuthority: authority });
    assert.deepEqual(await stale.identifyAcceptance({ ...prevention(), scope: submission.scope }), { kind: "not_found" });
  }
  const missing = new PostgresContainedTurnOperationStore({ pool: db.pool });
  assert.deepEqual(await missing.identifyAcceptance(prevention()), { kind: "not_found" });
  assert.deepEqual(await missing.preventIntent({ command: prevention(), scope: submission.scope }), { kind: "denied" });
});

test("prevention snapshots independently trusted scope before asynchronous store acquisition", async () => {
  const db = new IntentGuardSqlFixture();
  const store = new PostgresContainedTurnOperationStore({ pool: db.pool, intentAuthority });
  const scope = { ...submission.scope };
  const pending = store.preventIntent({ command: prevention(), scope });
  scope.projectId = "project:mutated-after-authentication";
  const outcome = await pending;
  assert.ok(outcome.kind === "committed");
  assert.equal(db.tables.guards[0]?.project_id, submission.scope.projectId);
  assert.equal(outcome.receipt.command.scope.projectId, submission.scope.projectId);
  assert.deepEqual(await intentHarness(db.pool).feature.submit.execute(submission), { status: "denied" });
});

for (const loss of ["before", "after"] as const) {
  test(`lost prevention COMMIT ${loss} durable write returns uncertainty; exact replay establishes truth`, async () => {
    const db = new IntentGuardSqlFixture(); const runner = intentHarness(db.pool);
    db.loseNextGuardCommit = loss;
    assert.deepEqual(await runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope }), { kind: "indeterminate" });
    assert.equal(db.tables.guards.length, loss === "after" ? 1 : 0);
    const replay = intentHarness(db.pool);
    assert.equal((await replay.feature.cancel.execute({ prevention: prevention(), scope: submission.scope })).kind, "committed");
    assert.deepEqual(await replay.feature.submit.execute(submission), { status: "denied" });
    assert.equal(replay.counts.provider, 0);
  });
}

test("simultaneous claim/prevention CAS and two claimers preserve the single committed claim in either order", async () => {
  for (const preventionFirst of [true, false]) {
    const db = new IntentGuardSqlFixture(); const entered = gate(); const release = gate();
    let claimInput!: Parameters<PostgresContainedTurnOperationStore["claimPreparedDispatch"]>[0];
    const runner = intentHarness(db.pool, { beforeClaimCas: async input => {claimInput = input; entered.release(); await release.promise;} });
    const pending = runner.feature.submit.execute(submission);
    await awaitFixtureGate(entered.promise, pending);
    const contender = new PostgresContainedTurnOperationStore({ pool: db.pool, intentAuthority });
    const claim = () => contender.claimPreparedDispatch(claimInput);
    const prevent = () => runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
    try {
      const results = await Promise.all(preventionFirst ? [prevent(), claim(), claim()] : [claim(), prevent(), claim()]);
      const kinds = results.map(result => result.kind);
      assert.equal(kinds.filter(kind => kind === "claimed").length, preventionFirst ? 0 : 1);
      assert.equal(kinds.filter(kind => kind === "observed_claim").length, preventionFirst ? 0 : 1);
      const receipt = results.find(result => result.kind === "committed");
      assert.ok(receipt?.kind === "committed");
      assert.equal(receipt.receipt.disposition, preventionFirst ? "operation_fenced" : "cutoff_requested");
      for (const field of ["deploymentIncarnation", "authorityRevision"] as const) {
        const stale = new PostgresContainedTurnOperationStore({ pool: db.pool, intentAuthority: { ...intentAuthority, [field]: "stale:value" } });
        assert.deepEqual(await stale.claimPreparedDispatch(claimInput), { kind: "not_found" });
      }
    } finally {release.release();}
    assert.equal((await pending).status, "observed");
    assert.equal(runner.counts.provider, 0, "an observed claim never authorizes a second dispatch");
    assert.equal(runner.counts.custodyStart, 0);
  }
});
