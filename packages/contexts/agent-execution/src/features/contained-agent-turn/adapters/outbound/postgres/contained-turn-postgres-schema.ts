/* oxlint-disable max-lines -- migration history and compatibility SQL are one audited artifact. */

import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  canonicalContainedTurnPostgresJson,
  digestContainedTurnPostgresJson,
} from "./contained-turn-state-codec.js";
import { decodeContainedTurnPreparation } from "./contained-turn-preparation-codec.js";

export const CONTAINED_TURN_POSTGRES_SCHEMA_VERSION = 5;
const MIGRATION_ADVISORY_NAMESPACE = 730;
const MIGRATION_ADVISORY_COMPONENT = 251_001;
export const CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE = Object.freeze({
  advisoryComponent: MIGRATION_ADVISORY_COMPONENT,
  /** Preserves serialization with the v1/v2 one-key lock while naming its components. */
  advisoryLockId: MIGRATION_ADVISORY_NAMESPACE * 1_000_000 + MIGRATION_ADVISORY_COMPONENT,
  advisoryNamespace: MIGRATION_ADVISORY_NAMESPACE,
  component: "contained-agent-turn",
});
export const CONTAINED_TURN_POSTGRES_MIGRATION_TIMEOUTS = Object.freeze({
  connectionTimeoutMs: 5_000,
  idleInTransactionTimeoutMs: 30_000,
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
});

const V1_SQL = `
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
  command_fingerprint text NOT NULL CHECK (command_fingerprint ~ '^[a-f0-9]{64}$'),
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
  PRIMARY KEY (operation_id, receipt_kind)
);
`;

/** Exact schema identity v2 migration artifact shipped by 375dbb6. */
const V2_SQL = `
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

const HISTORY_BOOTSTRAP_SQL = `
CREATE TABLE agent_execution.schema_migration_history (
  component text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  migration_digest text NOT NULL CHECK (migration_digest ~ '^[a-f0-9]{64}$'),
  predecessor_digest text CHECK (predecessor_digest IS NULL OR predecessor_digest ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (component, version)
);

CREATE OR REPLACE FUNCTION agent_execution.reject_schema_migration_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'schema migration history is immutable';
END
$$;

DROP TRIGGER IF EXISTS schema_migration_history_immutable ON agent_execution.schema_migration_history;
CREATE TRIGGER schema_migration_history_immutable
BEFORE UPDATE OR DELETE ON agent_execution.schema_migration_history
FOR EACH STATEMENT EXECUTE FUNCTION agent_execution.reject_schema_migration_history_mutation();
`;

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS agent_execution;

CREATE TABLE agent_execution.schema_migration (
  component text PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  migration_digest text NOT NULL CHECK (migration_digest ~ '^[a-f0-9]{64}$')
);

${HISTORY_BOOTSTRAP_SQL}
`;

const V3_SQL = `
ALTER TABLE agent_execution.contained_turn_operation_v1 ADD COLUMN project_id text;
ALTER TABLE agent_execution.contained_turn_operation_v1
  ADD COLUMN state_codec_version integer NOT NULL DEFAULT 1 CHECK (state_codec_version > 0);
UPDATE agent_execution.contained_turn_operation_v1
   SET project_id = COALESCE(state #>> '{payload,scope,projectId}', state #>> '{scope,projectId}')
 WHERE project_id IS NULL;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM agent_execution.contained_turn_operation_v1
     WHERE tenant_id IS DISTINCT FROM COALESCE(state #>> '{payload,scope,tenantId}', state #>> '{scope,tenantId}')
        OR project_id IS DISTINCT FROM COALESCE(state #>> '{payload,scope,projectId}', state #>> '{scope,projectId}')
  ) THEN
    RAISE EXCEPTION 'contained turn legacy scope identity mismatch';
  END IF;
END
$$;
ALTER TABLE agent_execution.contained_turn_operation_v1
  ADD CONSTRAINT contained_turn_operation_v1_project_id_check
  CHECK (char_length(project_id) BETWEEN 1 AND 512) NOT VALID;
ALTER TABLE agent_execution.contained_turn_operation_v1
  VALIDATE CONSTRAINT contained_turn_operation_v1_project_id_check;

CREATE FUNCTION agent_execution.contained_turn_fill_project_id()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM COALESCE(NEW.state #>> '{payload,scope,tenantId}', NEW.state #>> '{scope,tenantId}') THEN
    RAISE EXCEPTION 'contained turn operation tenant identity mismatch';
  END IF;
  IF NEW.project_id IS NULL THEN
    NEW.project_id := COALESCE(NEW.state #>> '{payload,scope,projectId}', NEW.state #>> '{scope,projectId}');
  ELSIF NEW.project_id IS DISTINCT FROM COALESCE(NEW.state #>> '{payload,scope,projectId}', NEW.state #>> '{scope,projectId}') THEN
    RAISE EXCEPTION 'contained turn operation scope identity mismatch';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER contained_turn_fill_project_id
BEFORE INSERT OR UPDATE OF state, project_id
ON agent_execution.contained_turn_operation_v1
FOR EACH ROW EXECUTE FUNCTION agent_execution.contained_turn_fill_project_id();

ALTER TABLE agent_execution.contained_turn_operation_v1 ALTER COLUMN project_id SET NOT NULL;
CREATE UNIQUE INDEX contained_turn_operation_v1_scoped_command_key
  ON agent_execution.contained_turn_operation_v1(tenant_id, project_id, command_id);
CREATE UNIQUE INDEX contained_turn_operation_v1_scoped_effect_key
  ON agent_execution.contained_turn_operation_v1(tenant_id, project_id, effect_id);

ALTER TABLE agent_execution.contained_turn_dispatch_preparation_v1
  ADD COLUMN state_codec_version integer NOT NULL DEFAULT 1 CHECK (state_codec_version > 0);
ALTER TABLE agent_execution.contained_turn_dispatch_preparation_v1
  ADD COLUMN state_digest text
  CHECK (state_digest ~ '^[a-f0-9]{64}$');
`;

const V4_SQL = `
ALTER TABLE agent_execution.contained_turn_dispatch_preparation_v1
  ALTER COLUMN state_digest SET NOT NULL;
ALTER TABLE agent_execution.contained_turn_operation_v1
  DROP CONSTRAINT contained_turn_operation_v1_tenant_id_command_id_key;
ALTER TABLE agent_execution.contained_turn_operation_v1
  DROP CONSTRAINT contained_turn_operation_v1_tenant_id_effect_id_key;
`;

const V5_SQL = `
DROP TRIGGER contained_turn_fill_project_id
ON agent_execution.contained_turn_operation_v1;
CREATE TRIGGER contained_turn_fill_project_id
BEFORE INSERT OR UPDATE OF state, project_id, tenant_id
ON agent_execution.contained_turn_operation_v1
FOR EACH ROW EXECUTE FUNCTION agent_execution.contained_turn_fill_project_id();

CREATE TABLE agent_execution.contained_turn_dispatch_preparation_quarantine_v1 (
  operation_id text NOT NULL,
  preparation_token text NOT NULL,
  observed_codec_version integer NOT NULL,
  observed_state_digest text,
  quarantined_state jsonb NOT NULL,
  reason text NOT NULL CHECK (reason IN ('malformed', 'unsupported_version')),
  first_observed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  last_observed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  observation_count bigint NOT NULL DEFAULT 1 CHECK (observation_count > 0),
  PRIMARY KEY (operation_id, preparation_token)
);

CREATE FUNCTION agent_execution.contained_turn_runtime_schema_compatible()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, agent_execution
AS $$
  SELECT CASE
    WHEN current_setting('agent_execution.contained_turn_schema_version', true) ~ '^[1-9][0-9]*$'
      THEN current_setting('agent_execution.contained_turn_schema_version', true)::integer = (
        SELECT version
          FROM agent_execution.schema_migration
         WHERE component = 'contained-agent-turn'
      )
    ELSE false
  END
$$;

CREATE FUNCTION agent_execution.reject_incompatible_contained_turn_runtime_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT agent_execution.contained_turn_runtime_schema_compatible() THEN
    RAISE EXCEPTION 'contained turn runtime schema fence rejected this binary';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE agent_execution.contained_turn_operation_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_execution.contained_turn_operation_v1 FORCE ROW LEVEL SECURITY;
CREATE POLICY contained_turn_runtime_schema_fence
ON agent_execution.contained_turn_operation_v1
USING (agent_execution.contained_turn_runtime_schema_compatible())
WITH CHECK (agent_execution.contained_turn_runtime_schema_compatible());
CREATE TRIGGER contained_turn_runtime_schema_write_fence
BEFORE INSERT OR UPDATE OR DELETE ON agent_execution.contained_turn_operation_v1
FOR EACH ROW EXECUTE FUNCTION agent_execution.reject_incompatible_contained_turn_runtime_write();

ALTER TABLE agent_execution.contained_turn_output_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_execution.contained_turn_output_v1 FORCE ROW LEVEL SECURITY;
CREATE POLICY contained_turn_runtime_schema_fence
ON agent_execution.contained_turn_output_v1
USING (agent_execution.contained_turn_runtime_schema_compatible())
WITH CHECK (agent_execution.contained_turn_runtime_schema_compatible());
CREATE TRIGGER contained_turn_runtime_schema_write_fence
BEFORE INSERT OR UPDATE OR DELETE ON agent_execution.contained_turn_output_v1
FOR EACH ROW EXECUTE FUNCTION agent_execution.reject_incompatible_contained_turn_runtime_write();

ALTER TABLE agent_execution.contained_turn_receipt_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_execution.contained_turn_receipt_v1 FORCE ROW LEVEL SECURITY;
CREATE POLICY contained_turn_runtime_schema_fence
ON agent_execution.contained_turn_receipt_v1
USING (agent_execution.contained_turn_runtime_schema_compatible())
WITH CHECK (agent_execution.contained_turn_runtime_schema_compatible());
CREATE TRIGGER contained_turn_runtime_schema_write_fence
BEFORE INSERT OR UPDATE OR DELETE ON agent_execution.contained_turn_receipt_v1
FOR EACH ROW EXECUTE FUNCTION agent_execution.reject_incompatible_contained_turn_runtime_write();

ALTER TABLE agent_execution.contained_turn_dispatch_preparation_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_execution.contained_turn_dispatch_preparation_v1 FORCE ROW LEVEL SECURITY;
CREATE POLICY contained_turn_runtime_schema_fence
ON agent_execution.contained_turn_dispatch_preparation_v1
USING (agent_execution.contained_turn_runtime_schema_compatible())
WITH CHECK (agent_execution.contained_turn_runtime_schema_compatible());
CREATE TRIGGER contained_turn_runtime_schema_write_fence
BEFORE INSERT OR UPDATE OR DELETE ON agent_execution.contained_turn_dispatch_preparation_v1
FOR EACH ROW EXECUTE FUNCTION agent_execution.reject_incompatible_contained_turn_runtime_write();

ALTER TABLE agent_execution.contained_turn_dispatch_preparation_quarantine_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_execution.contained_turn_dispatch_preparation_quarantine_v1 FORCE ROW LEVEL SECURITY;
CREATE POLICY contained_turn_runtime_schema_fence
ON agent_execution.contained_turn_dispatch_preparation_quarantine_v1
USING (agent_execution.contained_turn_runtime_schema_compatible())
WITH CHECK (agent_execution.contained_turn_runtime_schema_compatible());
CREATE TRIGGER contained_turn_runtime_schema_write_fence
BEFORE INSERT OR UPDATE OR DELETE ON agent_execution.contained_turn_dispatch_preparation_quarantine_v1
FOR EACH ROW EXECUTE FUNCTION agent_execution.reject_incompatible_contained_turn_runtime_write();
`;

const V4_DOWN_SQL = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_execution.contained_turn_operation_v1 WHERE state_codec_version <> 1
  ) OR EXISTS (
    SELECT 1 FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE state_codec_version <> 1
  ) THEN
    RAISE EXCEPTION 'contained turn PostgreSQL v4 rollback is unsafe after current-codec writes';
  END IF;
END
$$;

ALTER TABLE agent_execution.contained_turn_operation_v1
  ADD CONSTRAINT contained_turn_operation_v1_tenant_id_command_id_key UNIQUE (tenant_id, command_id);
ALTER TABLE agent_execution.contained_turn_operation_v1
  ADD CONSTRAINT contained_turn_operation_v1_tenant_id_effect_id_key UNIQUE (tenant_id, effect_id);
ALTER TABLE agent_execution.contained_turn_dispatch_preparation_v1
  ALTER COLUMN state_digest DROP NOT NULL;
`;

const V4_PREPARATION_DIGEST_BACKFILL_REVISION =
  "contained-turn-preparation-canonical-json-sha256-v1";

const digest = (sql: string): string => createHash("sha256").update(sql).digest("hex");
const V1_DIGEST = digest(V1_SQL);
const V2_DIGEST = digest(V2_SQL);
const V3_DIGEST = digest(V3_SQL);
const V4_DIGEST = digest(`${V4_PREPARATION_DIGEST_BACKFILL_REVISION}\n${V4_SQL}`);
const V5_DIGEST = digest(V5_SQL);

export interface ContainedTurnPostgresMigrationIdentity {
  readonly digest: string;
  readonly predecessorDigest?: string;
  readonly version: number;
}

export const CONTAINED_TURN_POSTGRES_MIGRATIONS: readonly ContainedTurnPostgresMigrationIdentity[] =
  Object.freeze([
    Object.freeze({ digest: V1_DIGEST, version: 1 }),
    Object.freeze({ digest: V2_DIGEST, predecessorDigest: V1_DIGEST, version: 2 }),
    Object.freeze({ digest: V3_DIGEST, predecessorDigest: V2_DIGEST, version: 3 }),
    Object.freeze({ digest: V4_DIGEST, predecessorDigest: V3_DIGEST, version: 4 }),
    Object.freeze({ digest: V5_DIGEST, predecessorDigest: V4_DIGEST, version: 5 }),
  ]);

export const CONTAINED_TURN_POSTGRES_MIGRATION_DIGEST = V5_DIGEST;

interface MigrationRow {
  readonly migration_digest: string;
  readonly version: number;
}

interface MigrationHistoryRow extends MigrationRow {
  readonly predecessor_digest: string | null;
}

const migrationFor = (version: number): ContainedTurnPostgresMigrationIdentity & { readonly sql: string } => {
  const identity = CONTAINED_TURN_POSTGRES_MIGRATIONS[version - 1];
  const sql = version === 1 ? V1_SQL : version === 2 ? V2_SQL :
    version === 3 ? V3_SQL : version === 4 ? V4_SQL : version === 5 ? V5_SQL : undefined;
  if (identity === undefined || sql === undefined) {
    throw new RangeError(`unsupported contained turn PostgreSQL migration target ${String(version)}`);
  }
  return { ...identity, sql };
};

const beginMigration = async (client: PoolClient): Promise<void> => {
  await client.query("BEGIN");
  await client.query(
    `SELECT set_config('lock_timeout', $1, true),
            set_config('statement_timeout', $2, true),
            set_config('idle_in_transaction_session_timeout', $3, true)`,
    [`${String(CONTAINED_TURN_POSTGRES_MIGRATION_TIMEOUTS.lockTimeoutMs)}ms`,
      `${String(CONTAINED_TURN_POSTGRES_MIGRATION_TIMEOUTS.statementTimeoutMs)}ms`,
      `${String(CONTAINED_TURN_POSTGRES_MIGRATION_TIMEOUTS.idleInTransactionTimeoutMs)}ms`],
  );
  await client.query("SELECT pg_advisory_xact_lock($1)", [
    CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE.advisoryLockId,
  ]);
};

const rollbackQuietly = async (client: PoolClient): Promise<boolean> => {
  try {await client.query("ROLLBACK"); return true;} catch {return false;}
};

const connectForMigration = async (pool: Pool): Promise<PoolClient> => {
  const pending = pool.connect();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("contained turn PostgreSQL migration pool acquisition timed out")),
      CONTAINED_TURN_POSTGRES_MIGRATION_TIMEOUTS.connectionTimeoutMs,
    );
  });
  try {
    return await Promise.race([pending, timeout]);
  } catch (error) {
    void pending.then(client => client.release(true)).catch(() => {});
    throw error;
  } finally {
    if (timer !== undefined) {clearTimeout(timer);}
  }
};

const currentMigration = (client: PoolClient): Promise<import("pg").QueryResult<MigrationRow>> =>
  client.query(
    "SELECT version, migration_digest FROM agent_execution.schema_migration WHERE component = $1 FOR UPDATE",
    [CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE.component],
  );

const ensureBootstrap = async (client: PoolClient): Promise<void> => {
  const catalog = await client.query<{ history: string | null; migration: string | null }>(
    `SELECT to_regclass('agent_execution.schema_migration')::text AS migration,
            to_regclass('agent_execution.schema_migration_history')::text AS history`,
  );
  const current = catalog.rows[0];
  if (current === undefined) {
    throw new Error("contained turn PostgreSQL migration catalog lookup failed");
  }
  if (current.migration === null && current.history === null) {
    await client.query(BOOTSTRAP_SQL);
    return;
  }
  if (current.migration !== null && current.history === null) {
    const legacy = await currentMigration(client);
    const row = legacy.rows[0];
    const identity = row === undefined
      ? undefined
      : CONTAINED_TURN_POSTGRES_MIGRATIONS[row.version - 1];
    if (row === undefined || row.version > 2 || identity?.digest !== row.migration_digest) {
      throw new Error("contained turn PostgreSQL legacy migration identity mismatch");
    }
    await client.query(HISTORY_BOOTSTRAP_SQL);
    for (const migration of CONTAINED_TURN_POSTGRES_MIGRATIONS.slice(0, row.version)) {
      await client.query(
        `INSERT INTO agent_execution.schema_migration_history
           (component, version, migration_digest, predecessor_digest)
         VALUES ($1, $2, $3, $4)`,
        [CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE.component, migration.version,
          migration.digest, migration.predecessorDigest ?? null],
      );
    }
    return;
  }
  if (current.migration === null || current.history === null) {
    throw new Error("contained turn PostgreSQL migration catalog is incomplete");
  }
};

const verifyHistory = async (client: PoolClient, currentVersion: number): Promise<void> => {
  const rows = await client.query<MigrationHistoryRow>(
    `SELECT version, migration_digest, predecessor_digest
       FROM agent_execution.schema_migration_history
      WHERE component = $1 AND version <= $2
      ORDER BY version`,
    [CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE.component, currentVersion],
  );
  if (rows.rows.length !== currentVersion) {
    throw new Error("contained turn PostgreSQL migration history is incomplete");
  }
  for (const expected of CONTAINED_TURN_POSTGRES_MIGRATIONS.slice(0, currentVersion)) {
    const actual = rows.rows[expected.version - 1];
    if (actual?.version !== expected.version || actual.migration_digest !== expected.digest ||
        actual.predecessor_digest !== (expected.predecessorDigest ?? null)) {
      throw new Error("contained turn PostgreSQL migration history identity mismatch");
    }
  }
};

const validateCurrentCatalog = async (client: PoolClient, version: number): Promise<void> => {
  if (version < 3) {return;}
  const columns = await client.query<{ column_name: string; is_nullable: "NO" | "YES" }>(
    `SELECT column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'agent_execution'
        AND table_name = 'contained_turn_dispatch_preparation_v1'
        AND column_name IN ('state_codec_version', 'state_digest')`,
  );
  const operationColumns = await client.query<{ column_name: string; is_nullable: "NO" | "YES" }>(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'agent_execution'
        AND table_name = 'contained_turn_operation_v1'
        AND column_name IN ('project_id', 'state_codec_version')`,
  );
  const indexes = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'agent_execution'
        AND tablename = 'contained_turn_operation_v1'
        AND indexname IN ('contained_turn_operation_v1_scoped_command_key', 'contained_turn_operation_v1_scoped_effect_key')`,
  );
  const triggers = await client.query<{ definition: string; tgname: string }>(
    `SELECT tgname, pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid = 'agent_execution.contained_turn_operation_v1'::regclass
        AND NOT tgisinternal AND tgname = 'contained_turn_fill_project_id'`,
  );
  const historyTriggers = await client.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'agent_execution.schema_migration_history'::regclass
        AND NOT tgisinternal AND tgname = 'schema_migration_history_immutable'`,
  );
  const expectedPreparationNullability = version < 4 ? "YES" : "NO";
  const stateDigest = columns.rows.find(row => row.column_name === "state_digest");
  const stateCodecVersion = columns.rows.find(row => row.column_name === "state_codec_version");
  if (columns.rows.length !== 2 || stateDigest?.is_nullable !== expectedPreparationNullability ||
      stateCodecVersion?.is_nullable !== "NO" ||
      operationColumns.rows.length !== 2 ||
      operationColumns.rows.some(row => row.is_nullable !== "NO") || indexes.rows.length !== 2 ||
      triggers.rowCount !== 1 || historyTriggers.rowCount !== 1) {
    throw new Error("contained turn PostgreSQL catalog drift detected");
  }
  const legacy = await client.query(
    `SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_schema = 'agent_execution'
        AND table_name = 'contained_turn_operation_v1'
        AND constraint_name IN (
          'contained_turn_operation_v1_tenant_id_command_id_key',
          'contained_turn_operation_v1_tenant_id_effect_id_key'
        )`,
  );
  if (legacy.rowCount !== (version < 4 ? 2 : 0)) {
    throw new Error("contained turn PostgreSQL contract migration drift detected");
  }
  if (version >= 5) {
    const triggerDefinition = triggers.rows[0]?.definition;
    const quarantine = await client.query<{ relforcerowsecurity: boolean; relrowsecurity: boolean }>(
      `SELECT relforcerowsecurity, relrowsecurity
         FROM pg_class
        WHERE oid = 'agent_execution.contained_turn_dispatch_preparation_quarantine_v1'::regclass`,
    );
    const fencedTables = await client.query(
      `SELECT policyname
         FROM pg_policies
        WHERE schemaname = 'agent_execution'
          AND policyname = 'contained_turn_runtime_schema_fence'
          AND tablename IN (
            'contained_turn_operation_v1',
            'contained_turn_output_v1',
            'contained_turn_receipt_v1',
            'contained_turn_dispatch_preparation_v1',
            'contained_turn_dispatch_preparation_quarantine_v1'
          )`,
    );
    const writeFences = await client.query(
      `SELECT tgname
         FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname = 'contained_turn_runtime_schema_write_fence'
          AND tgrelid IN (
            'agent_execution.contained_turn_operation_v1'::regclass,
            'agent_execution.contained_turn_output_v1'::regclass,
            'agent_execution.contained_turn_receipt_v1'::regclass,
            'agent_execution.contained_turn_dispatch_preparation_v1'::regclass,
            'agent_execution.contained_turn_dispatch_preparation_quarantine_v1'::regclass
          )`,
    );
    if (triggerDefinition === undefined || !triggerDefinition.includes("tenant_id") ||
        quarantine.rows[0]?.relrowsecurity !== true ||
        quarantine.rows[0]?.relforcerowsecurity !== true || fencedTables.rowCount !== 5 ||
        writeFences.rowCount !== 5) {
      throw new Error("contained turn PostgreSQL v5 runtime fence drift detected");
    }
  }
};

const backfillPreparationDigests = async (client: PoolClient): Promise<void> => {
  const rows = await client.query<{
    operation_id: string;
    preparation_token: string;
    state: unknown;
    state_codec_version: number;
  }>(
    `SELECT operation_id, preparation_token, state, state_codec_version
       FROM agent_execution.contained_turn_dispatch_preparation_v1
      WHERE state_digest IS NULL
      ORDER BY operation_id, preparation_token
      FOR UPDATE`,
  );
  for (const row of rows.rows) {
    decodeContainedTurnPreparation(row.state, null, row.state_codec_version);
    const stateDigest = createHash("sha256")
      .update(canonicalContainedTurnPostgresJson(row.state))
      .digest("hex");
    const updated = await client.query(
      `UPDATE agent_execution.contained_turn_dispatch_preparation_v1
          SET state_digest = $3
        WHERE operation_id = $1 AND preparation_token = $2 AND state_digest IS NULL`,
      [row.operation_id, row.preparation_token, stateDigest],
    );
    if (updated.rowCount !== 1) {
      throw new Error("contained turn PostgreSQL preparation digest backfill lost its row fence");
    }
  }
};

const validateLegacyOperationDigests = async (client: PoolClient): Promise<void> => {
  const rows = await client.query<{ state: unknown; state_digest: string }>(
    "SELECT state, state_digest FROM agent_execution.contained_turn_operation_v1 ORDER BY operation_id",
  );
  for (const row of rows.rows) {
    if (digestContainedTurnPostgresJson(row.state) !== row.state_digest) {
      throw new Error("contained turn PostgreSQL legacy operation digest mismatch");
    }
  }
};

const applyMigration = async (
  client: PoolClient,
  migration: ReturnType<typeof migrationFor>,
): Promise<void> => {
  const current = await currentMigration(client);
  const row = current.rows[0];
  if (migration.version === 1 ? row !== undefined :
      row?.version !== migration.version - 1 || row.migration_digest !== migration.predecessorDigest) {
    throw new Error("contained turn PostgreSQL migration predecessor identity mismatch");
  }
  const history = await client.query<MigrationHistoryRow>(
    `SELECT version, migration_digest, predecessor_digest
       FROM agent_execution.schema_migration_history
      WHERE component = $1 AND version = $2`,
    [CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE.component, migration.version],
  );
  const recorded = history.rows[0];
  if (recorded !== undefined && (recorded.migration_digest !== migration.digest ||
      recorded.predecessor_digest !== (migration.predecessorDigest ?? null))) {
    throw new Error("contained turn PostgreSQL migration history cannot be rewritten");
  }
  if (migration.version === 3) {await validateLegacyOperationDigests(client);}
  if (migration.version === 4) {await backfillPreparationDigests(client);}
  await client.query(migration.sql);
  if (recorded === undefined) {
    await client.query(
      `INSERT INTO agent_execution.schema_migration_history
         (component, version, migration_digest, predecessor_digest)
       VALUES ($1, $2, $3, $4)`,
      [CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE.component, migration.version,
        migration.digest, migration.predecessorDigest ?? null],
    );
  }
  await client.query(
    `INSERT INTO agent_execution.schema_migration(component, version, migration_digest)
     VALUES ($1, $2, $3)
     ON CONFLICT (component) DO UPDATE
       SET version = EXCLUDED.version, migration_digest = EXCLUDED.migration_digest`,
    [CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE.component, migration.version, migration.digest],
  );
};

export interface ApplyContainedTurnPostgresSchemaOptions {
  /** V4 is an internal rollback fixture only; production contract migration must commit V4 and V5 atomically. */
  readonly allowUnfencedV4ForTest?: true;
  /** Used only by migration/rolling-binary tests and staged deploys. */
  readonly targetVersion?: 1 | 2 | 3 | 4 | 5;
}

export const applyContainedTurnPostgresSchema = async (
  pool: Pool,
  options: ApplyContainedTurnPostgresSchemaOptions = {},
): Promise<void> => {
  const targetVersion = options.targetVersion ?? CONTAINED_TURN_POSTGRES_SCHEMA_VERSION;
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1 ||
      targetVersion > CONTAINED_TURN_POSTGRES_SCHEMA_VERSION) {
    throw new RangeError(`unsupported contained turn PostgreSQL migration target ${String(targetVersion)}`);
  }
  if ((targetVersion === 4) !== (options.allowUnfencedV4ForTest === true)) {
    throw new TypeError("contained turn PostgreSQL v4 requires the explicit disposable-test fence bypass");
  }
  const client = await connectForMigration(pool);
  let discardClient = false;
  try {
    await beginMigration(client);
    await ensureBootstrap(client);
    const current = await currentMigration(client);
    const row = current.rows[0];
    if (row !== undefined) {
      const identity = CONTAINED_TURN_POSTGRES_MIGRATIONS[row.version - 1];
      if (identity === undefined || identity.digest !== row.migration_digest) {
        throw new Error("contained turn PostgreSQL schema identity mismatch");
      }
      if (row.version > targetVersion) {
        throw new Error("contained turn PostgreSQL schema is newer than this binary target");
      }
      await verifyHistory(client, row.version);
    }
    for (let version = (row?.version ?? 0) + 1; version <= targetVersion; version += 1) {
      await applyMigration(client, migrationFor(version));
    }
    await verifyHistory(client, targetVersion);
    await validateCurrentCatalog(client, targetVersion);
    await client.query("COMMIT");
  } catch (error) {
    discardClient = !(await rollbackQuietly(client));
    throw error;
  } finally {
    client.release(discardClient);
  }
};

/** Rolls back v4 only before current-codec or cross-project writes make it unsafe. */
export const rollbackContainedTurnPostgresSchemaV4 = async (pool: Pool): Promise<void> => {
  const client = await connectForMigration(pool);
  let discardClient = false;
  try {
    await beginMigration(client);
    await ensureBootstrap(client);
    const current = await currentMigration(client);
    const row = current.rows[0];
    if (row?.version !== 4 || row.migration_digest !== V4_DIGEST) {
      throw new Error("contained turn PostgreSQL rollback requires exact v4 identity");
    }
    await verifyHistory(client, 4);
    await client.query(V4_DOWN_SQL);
    await client.query(
      "UPDATE agent_execution.schema_migration SET version = 3, migration_digest = $2 WHERE component = $1",
      [CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE.component, V3_DIGEST],
    );
    await validateCurrentCatalog(client, 3);
    await client.query("COMMIT");
  } catch (error) {
    discardClient = !(await rollbackQuietly(client));
    throw error;
  } finally {
    client.release(discardClient);
  }
};
