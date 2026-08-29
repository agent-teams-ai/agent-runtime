import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { Pool } from "pg";

import {
  applyContainedTurnPostgresSchema,
  PostgresContainedTurnOperationStore,
} from "../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import type { ContainedTurnPostgresIdentitySource } from "../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-schema.js";

const connectionString = process.env.AGENT_RUNTIME_TEST_POSTGRES_URL;
if (connectionString === undefined) {
  throw new Error("AGENT_RUNTIME_TEST_POSTGRES_URL is required for the PostgreSQL qualification suite");
}

const pool = new Pool({ connectionString, max: 12 });
let identitySequence = 0;
const identities: ContainedTurnPostgresIdentitySource = Object.freeze({
  nextId(kind) {
    identitySequence += 1;
    return `test:${kind}:${identitySequence}`;
  },
});

const binding = Object.freeze({
  adapterRevision: "codex-app-server-adapter:postgres-test",
  binaryRevision: "codex:postgres-test",
  capabilityManifestRevision: "manifest:postgres-test",
  credentialBindingDigest: "credential:postgres-test",
  provider: "codex" as const,
  providerRouteRef: "route:postgres-test",
});

const acceptInput = (tenantId = "tenant:one", prompt = "inspect disposable state") => ({
  commandId: "command:postgres",
  intent: { mode: "analysis" as const, prompt },
  providerBinding: binding,
  scope: { projectId: "project:postgres", tenantId },
  securityDecision: { authorityRevision: "authority:postgres", decisionDigest: "decision:postgres" },
});

const createStore = () => new PostgresContainedTurnOperationStore({ identities, pool });

await applyContainedTurnPostgresSchema(pool);

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE
    agent_execution.contained_turn_output_v1,
    agent_execution.contained_turn_receipt_v1,
    agent_execution.contained_turn_operation_v1`);
});

after(async () => {
  await pool.end();
});

test("migration is identity-checked and idempotent", async () => {
  await applyContainedTurnPostgresSchema(pool);
  await applyContainedTurnPostgresSchema(pool);
  const migration = await pool.query<{ version: number }>(
    "SELECT version FROM agent_execution.schema_migration WHERE component = $1",
    ["contained-agent-turn"],
  );
  assert.equal(migration.rows[0]?.version, 1);
});

test("command acceptance is tenant-scoped, replayable, and conflict detecting", async () => {
  const store = createStore();
  const accepted = await store.accept(acceptInput());
  const replayed = await store.accept(acceptInput());
  const conflict = await store.accept(acceptInput("tenant:one", "changed intent"));
  const otherTenant = await store.accept(acceptInput("tenant:two"));
  assert.equal(accepted.kind, "accepted");
  assert.equal(replayed.kind, "replayed");
  assert.equal(conflict.kind, "conflict");
  assert.equal(otherTenant.kind, "accepted");
  if (accepted.kind === "accepted" && replayed.kind === "replayed") {
    assert.equal(replayed.operation.operationId, accepted.operation.operationId);
  }
});

test("a restart preserves one dispatch winner and exact cutoff evidence", async () => {
  const firstStore = createStore();
  const accepted = await firstStore.accept(acceptInput());
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind !== "accepted") {return;}
  const bound = await firstStore.compareAndSet({
    expectedRevision: accepted.operation.revision,
    mutation: { kind: "workspace_bound", workspaceRef: "workspace:postgres" },
    operationId: accepted.operation.operationId,
  });
  assert.equal(bound.kind, "applied");
  if (bound.kind !== "applied") {return;}
  const restartedStore = createStore();
  const claims = await Promise.all([
    firstStore.claimDispatch({
      cutoffReceiptRef: "cutoff:postgres",
      expectedRevision: bound.operation.revision,
      operationId: bound.operation.operationId,
    }),
    restartedStore.claimDispatch({
      cutoffReceiptRef: "cutoff:postgres",
      expectedRevision: bound.operation.revision,
      operationId: bound.operation.operationId,
    }),
  ]);
  assert.deepEqual(claims.map(result => result.kind).toSorted(), ["claimed", "stale"]);
  const restored = await restartedStore.read(bound.operation.operationId);
  assert.equal(restored?.dispatch.kind, "claimed");
  assert.deepEqual(restored?.cutoff, {
    disposition: "not_applicable",
    kind: "closed",
    receiptRef: "cutoff:postgres",
  });
});

test("projection or state corruption fails closed", async () => {
  const store = createStore();
  const accepted = await store.accept(acceptInput());
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind !== "accepted") {return;}
  await pool.query(
    `UPDATE agent_execution.contained_turn_receipt_v1
        SET receipt_ref = 'tampered'
      WHERE operation_id = $1 AND receipt_kind = 'command_acceptance'`,
    [accepted.operation.operationId],
  );
  await assert.rejects(store.read(accepted.operation.operationId), /receipt projection mismatch/u);
  await pool.query(
    `UPDATE agent_execution.contained_turn_operation_v1
        SET state_digest = repeat('0', 64)
      WHERE operation_id = $1`,
    [accepted.operation.operationId],
  );
  await assert.rejects(store.read(accepted.operation.operationId), /state digest mismatch/u);
});
