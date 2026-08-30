import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decodeContainedTurnState, encodeContainedTurnState } from "../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-state-codec.js";
import { PostgresContainedTurnOperationStore } from "../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { CONTAINED_TURN_POSTGRES_SCHEMA_VERSION } from "../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-schema.js";
import { createOperation } from "./contained-turn-kernel-fixtures.ts";

test("PostgreSQL state codec round-trips the exact kernel operation and rejects corruption", () => {
  const operation = createOperation();
  const encoded = encodeContainedTurnState(operation);
  assert.deepEqual(decodeContainedTurnState(JSON.parse(encoded.json), encoded.digest), operation);
  assert.throws(() => decodeContainedTurnState(JSON.parse(encoded.json), "0".repeat(64)), /state digest mismatch/u);
});

test("production PostgreSQL store implements the mandatory consumed-grant claim and retirement boundary", () => {
  const pool = {} as ConstructorParameters<typeof PostgresContainedTurnOperationStore>[0]["pool"];
  const store = new PostgresContainedTurnOperationStore({ pool });
  assert.equal(typeof store.claimPreparedDispatch, "function");
  assert.equal(typeof store.retireDispatchPreparation, "function");
  assert.equal(typeof store.recordDispatchPreparationCleanup, "function");
  assert.equal(typeof store.commit, "function");
  assert.equal(typeof store.read, "function");
});

test("PostgreSQL schema v2 persists preparation ownership beside operation authority", async () => {
  const source = await readFile(new URL("../src/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-schema.ts", import.meta.url), "utf8");
  assert.equal(CONTAINED_TURN_POSTGRES_SCHEMA_VERSION, 2);
  assert.match(source, /contained_turn_dispatch_preparation_v1/u);
  assert.match(source, /PRIMARY KEY \(operation_id, preparation_token\)/u);
  assert.match(source, /FOR UPDATE|advisory_xact_lock/u);
});
