import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

export const CONTAINED_TURN_POSTGRES_SCHEMA_VERSION = 2;

const MIGRATION_SQL = `
CREATE SCHEMA IF NOT EXISTS agent_execution;

CREATE TABLE IF NOT EXISTS agent_execution.schema_migration (
  component text PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  migration_digest text NOT NULL CHECK (migration_digest ~ '^[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS agent_execution.contained_turn_operation_v1 (
  operation_id text PRIMARY KEY CHECK (char_length(operation_id) BETWEEN 1 AND 512),
  tenant_id text NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 512),
  command_id text NOT NULL CHECK (char_length(command_id) BETWEEN 1 AND 256),
  command_fingerprint text NOT NULL,
  effect_id text NOT NULL CHECK (char_length(effect_id) BETWEEN 1 AND 512),
  revision bigint NOT NULL CHECK (revision >= 0),
  state jsonb NOT NULL,
  state_digest text NOT NULL CHECK (state_digest ~ '^[a-f0-9]{64}$'),
  terminal boolean NOT NULL,
  UNIQUE (tenant_id, command_id),
  UNIQUE (tenant_id, effect_id)
);

CREATE TABLE IF NOT EXISTS agent_execution.contained_turn_output_v1 (
  operation_id text NOT NULL REFERENCES agent_execution.contained_turn_operation_v1(operation_id) ON DELETE RESTRICT,
  cursor integer NOT NULL CHECK (cursor >= 0),
  output_kind text NOT NULL CHECK (output_kind IN ('assistant', 'diagnostic', 'progress')),
  output_text text NOT NULL,
  PRIMARY KEY (operation_id, cursor)
);

CREATE TABLE IF NOT EXISTS agent_execution.contained_turn_receipt_v1 (
  operation_id text NOT NULL REFERENCES agent_execution.contained_turn_operation_v1(operation_id) ON DELETE RESTRICT,
  receipt_kind text NOT NULL,
  receipt_ref text NOT NULL CHECK (char_length(receipt_ref) BETWEEN 1 AND 4096),
  PRIMARY KEY (operation_id, receipt_ref)
);

ALTER TABLE agent_execution.contained_turn_operation_v1
  DROP CONSTRAINT IF EXISTS contained_turn_operation_v1_command_fingerprint_check;

ALTER TABLE agent_execution.contained_turn_receipt_v1
  DROP CONSTRAINT IF EXISTS contained_turn_receipt_v1_pkey;
ALTER TABLE agent_execution.contained_turn_receipt_v1
  ADD CONSTRAINT contained_turn_receipt_v1_pkey PRIMARY KEY (operation_id, receipt_ref);

CREATE TABLE IF NOT EXISTS agent_execution.contained_turn_dispatch_preparation_v1 (
  operation_id text NOT NULL REFERENCES agent_execution.contained_turn_operation_v1(operation_id) ON DELETE RESTRICT,
  preparation_token text NOT NULL,
  state jsonb NOT NULL,
  PRIMARY KEY (operation_id, preparation_token)
);
`;

export const CONTAINED_TURN_POSTGRES_MIGRATION_DIGEST = createHash("sha256")
  .update(MIGRATION_SQL)
  .digest("hex");

const applyInsideTransaction = async (client: PoolClient): Promise<void> => {
  await client.query("SELECT pg_advisory_xact_lock($1)", [730_251_001]);
  await client.query(MIGRATION_SQL);
  const existing = await client.query<{ migration_digest: string; version: number }>(
    "SELECT version, migration_digest FROM agent_execution.schema_migration WHERE component = $1 FOR UPDATE",
    ["contained-agent-turn"],
  );
  if (existing.rowCount === 0) {
    await client.query(
      "INSERT INTO agent_execution.schema_migration(component, version, migration_digest) VALUES ($1, $2, $3)",
      ["contained-agent-turn", CONTAINED_TURN_POSTGRES_SCHEMA_VERSION, CONTAINED_TURN_POSTGRES_MIGRATION_DIGEST],
    );
    return;
  }
  const row = existing.rows[0];
  if (row?.version === 1) {
    await client.query(
      "UPDATE agent_execution.schema_migration SET version = $2, migration_digest = $3 WHERE component = $1",
      ["contained-agent-turn", CONTAINED_TURN_POSTGRES_SCHEMA_VERSION, CONTAINED_TURN_POSTGRES_MIGRATION_DIGEST],
    );
    return;
  }
  if (row?.version !== CONTAINED_TURN_POSTGRES_SCHEMA_VERSION || row.migration_digest !== CONTAINED_TURN_POSTGRES_MIGRATION_DIGEST) {
    throw new Error("contained turn PostgreSQL schema identity mismatch");
  }
};

export const applyContainedTurnPostgresSchema = async (pool: Pool): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await applyInsideTransaction(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
