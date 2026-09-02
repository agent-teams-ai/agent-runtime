import { createHash } from "node:crypto";

export const CONTAINED_TURN_POSTGRES_SCHEMA_VERSION = 5;

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

export const HISTORY_BOOTSTRAP_SQL = `
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

export const BOOTSTRAP_SQL = `
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

export const V4_DOWN_SQL = `
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

const V3_OPERATION_DIGEST_VALIDATION_REVISION =
  "contained-turn-operation-digest-keyset-validation-v1";
const V4_PREPARATION_DIGEST_BACKFILL_REVISION =
  "contained-turn-preparation-canonical-json-sha256-keyset-v2";

const digest = (sql: string): string => createHash("sha256").update(sql).digest("hex");
const V1_DIGEST = digest(V1_SQL);
const V2_DIGEST = digest(V2_SQL);
export const V3_DIGEST = digest(`${V3_OPERATION_DIGEST_VALIDATION_REVISION}\n${V3_SQL}`);
export const V4_DIGEST = digest(`${V4_PREPARATION_DIGEST_BACKFILL_REVISION}\n${V4_SQL}`);
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

export const migrationFor = (version: number): ContainedTurnPostgresMigrationIdentity & { readonly sql: string } => {
  const identity = CONTAINED_TURN_POSTGRES_MIGRATIONS[version - 1];
  const sql = version === 1 ? V1_SQL : version === 2 ? V2_SQL :
    version === 3 ? V3_SQL : version === 4 ? V4_SQL : version === 5 ? V5_SQL : undefined;
  if (identity === undefined || sql === undefined) {
    throw new RangeError(`unsupported contained turn PostgreSQL migration target ${String(version)}`);
  }
  return { ...identity, sql };
};
