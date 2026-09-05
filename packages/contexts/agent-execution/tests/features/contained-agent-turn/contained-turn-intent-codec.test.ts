import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { decodeContainedTurnIntentGuard, encodeContainedTurnIntentGuard, CONTAINED_TURN_GUARD_SELECTION } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-intent-guard-codec.js";
import { migrationFor } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-migration-artifacts.js";
import { validateContainedTurnIntentCatalog } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-intent-catalog.js";
import { validateContainedTurnPreventionCommand, validateContainedTurnPreventionReceipt } from "../../../dist/features/contained-agent-turn/domain/contained-turn-intent-guard.js";
import { awaitFixtureGate, gate, intentHarness, prevention, submission } from "./support/intent-guard-fixture.ts";
import { IntentGuardSqlFixture } from "./support/intent-guard-sql-fixture.ts";

const catalogClient = (rows: unknown[]) => ({ query: async () => ({ rows }) }) as never;

test("canonical SHA-256 guard roundtrip is versioned, bounded, detached and immutable", async () => {
  const db = new IntentGuardSqlFixture(); const runner = intentHarness(db.pool);
  const outcome = await runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
  assert.equal(outcome.kind, "committed"); if (outcome.kind !== "committed") {assert.fail();}
  const encoded = encodeContainedTurnIntentGuard(outcome.receipt);
  assert.equal(encoded.digest, createHash("sha256").update(encoded.json).digest("hex"));
  const row = { state: JSON.parse(encoded.json), state_codec_version: 1, state_digest: encoded.digest, state_within_budget: true };
  const decoded = decodeContainedTurnIntentGuard(row);
  assert.deepEqual(decoded, outcome.receipt);
  assert.ok(Object.isFrozen(decoded.command.authority));
  row.state.payload.command.authority.authorityRevision = "changed";
  assert.notEqual(decoded.command.authority.authorityRevision, "changed");
  assert.match(CONTAINED_TURN_GUARD_SELECTION, /CASE WHEN octet_length\(state::text\) <= 16384 THEN state END/u);
});

test("strict guard codec rejects malformed/oversized data before getters or canonical hash work", async () => {
  const db = new IntentGuardSqlFixture(); const runner = intentHarness(db.pool);
  const outcome = await runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
  if (outcome.kind !== "committed") {assert.fail();}
  const valid = { state: JSON.parse(encodeContainedTurnIntentGuard(outcome.receipt).json), state_codec_version: 1, state_digest: encodeContainedTurnIntentGuard(outcome.receipt).digest, state_within_budget: true };
  let getters = 0;
  for (const row of [
    { ...valid, state_codec_version: 2 }, { ...valid, state_digest: "0".repeat(64) },
    { ...valid, state_within_budget: false, get state() {getters += 1; throw new Error("must not materialize");} },
    ...[null, [], {}, { ...valid.state, unknown: true }, { ...valid.state, codecVersion: 2 }].map(state => ({ ...valid, state })),
  ]) {assert.throws(() => decodeContainedTurnIntentGuard(row));}
  for (const mutation of [
    (receipt: any) => {receipt.command.authority.audience = "a".repeat(16_385);},
    (receipt: any) => {receipt.command.preventionCommandId = "cancellation-command:" + "x".repeat(513);},
    (receipt: any) => {receipt.command.authority.extra = true;},
    (receipt: any) => {receipt.command.scope.tenantId = {};},
    (receipt: any) => {receipt.command.preventionDigest = "0".repeat(64);},
    (receipt: any) => {receipt.command.commandId = "operation:wrong-namespace";},
    (receipt: any) => {receipt.command.version = 2;},
    (receipt: any) => {receipt.operationId = "operation:fake";},
    (receipt: any) => {receipt.receiptId = "proof:fake";},
    (receipt: any) => {Object.defineProperty(receipt.command, "commandId", { enumerable: true, get() {getters += 1; return "command:one";} });},
  ]) {
    const receipt = structuredClone(outcome.receipt); mutation(receipt);
    assert.throws(() => validateContainedTurnPreventionReceipt(receipt));
    assert.throws(() => decodeContainedTurnIntentGuard({ ...valid, state: { codecVersion: 1, payload: receipt } }));
  }
  assert.equal(getters, 0);
  assert.throws(() => validateContainedTurnPreventionCommand({ ...prevention(), preventionDigest: "sha256:" + "f".repeat(64) } as never));
});

test("corrupt guard persistence fails closed on both acceptance and receipt replay", async () => {
  for (const corrupt of [
    (row: any) => {row.state_within_budget = false;},
    (row: any) => {row.state_digest = "f".repeat(64);},
    (row: any) => {row.state_codec_version = 99;},
    (row: any) => {row.state.payload.command.scope.projectId = "project:another";},
  ]) {
    const db = new IntentGuardSqlFixture(); const runner = intentHarness(db.pool);
    await runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
    corrupt(db.tables.guards[0]);
    await assert.rejects(() => runner.feature.submit.execute(submission));
    await assert.rejects(() => runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope }));
    assert.equal(runner.counts.provider, 0); assert.equal(db.tables.operations.length, 0);
  }
  const db = new IntentGuardSqlFixture(); const runner = intentHarness(db.pool);
  await runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
  db.tables.guards.length = 0;
  await assert.rejects(() => runner.feature.submit.execute(submission), /lost its durable guard/u);
});

test("V7 migration has exact predecessor/digest, rejects unsafe backfill, and retains the namespace", async () => {
  const migration = migrationFor(7);
  assert.equal(migration.predecessorDigest, migrationFor(6).digest);
  assert.equal(migration.digest, createHash("sha256").update(migration.sql).digest("hex"));
  assert.match(migration.sql, /refuses populated authority-incompatible schema/u);
  assert.match(migration.sql, /command_fingerprint ~ '\^sha256:/u);
  assert.match(migration.sql, /BEFORE UPDATE OR DELETE OR TRUNCATE/u);
  const rows = [
    { name: "contained_turn_intent_namespace_v1", columns: 3, constraints: 4 },
    { name: "contained_turn_intent_v1", columns: 6, constraints: 6 },
    { name: "contained_turn_intent_guard_v1", columns: 7, constraints: 7 },
  ].map(row => ({ ...row, rls: true, policy: true, retention: true, write_fence: true }));
  await validateContainedTurnIntentCatalog(catalogClient(rows));
  await assert.rejects(() => validateContainedTurnIntentCatalog(catalogClient(rows.slice(1))));
  for (const field of ["rls", "policy", "retention", "write_fence"] as const) {
    await assert.rejects(() => validateContainedTurnIntentCatalog(catalogClient([{ ...rows[0], [field]: false }, ...rows.slice(1)])));
  }
});

test("generic operation CAS cannot smuggle a dispatch claim past intent serialization", async () => {
  const db = new IntentGuardSqlFixture(); const entered = gate(); const release = gate();
  const runner = intentHarness(db.pool, { beforeClaim: async () => {entered.release(); await release.promise;} });
  const pending = runner.feature.submit.execute(submission);
  await awaitFixtureGate(entered.promise, pending);
  try {
    const operation = db.tables.operations[0]!.state.payload;
    await assert.rejects(() => runner.store.commit({
      authority: { commandId: operation.commandId, effectId: operation.effectId, operationId: operation.operationId, scope: operation.scope },
      candidate: { ...operation, revision: operation.revision + 1, dispatch: { kind: "claimed" } }, expectedRevision: operation.revision,
    } as never), /guarded prepared-claim transaction/u);
    await runner.feature.cancel.execute({ prevention: prevention(), scope: submission.scope });
  } finally {release.release();}
  await pending;
  assert.equal(runner.counts.provider, 0);
});
