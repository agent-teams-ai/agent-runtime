/** No legacy row contains the deployment/incarnation authority needed for an honest backfill. */
export const CONTAINED_TURN_INTENT_GUARD_V8_SQL = `
DO $$
BEGIN
  PERFORM set_config('agent_execution.contained_turn_schema_version', '7', true);
  IF EXISTS (SELECT 1 FROM agent_execution.contained_turn_operation_v1)
    OR EXISTS (SELECT 1 FROM agent_execution.contained_turn_dispatch_preparation_quarantine_v1) THEN
    RAISE EXCEPTION 'contained turn v8 refuses populated authority-incompatible schema';
  END IF;
END
$$;

CREATE TABLE agent_execution.contained_turn_intent_namespace_v1 (
  tenant_id text NOT NULL CHECK (octet_length(tenant_id) BETWEEN 1 AND 512),
  project_id text NOT NULL CHECK (octet_length(project_id) BETWEEN 1 AND 512),
  authority_digest text NOT NULL CHECK (authority_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, project_id)
);
CREATE TABLE agent_execution.contained_turn_intent_v1 (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  command_id text NOT NULL CHECK (octet_length(command_id) BETWEEN 1 AND 256),
  command_fingerprint text NOT NULL CHECK (command_fingerprint ~ '^[a-f0-9]{64}$'),
  authority_digest text NOT NULL CHECK (authority_digest ~ '^[a-f0-9]{64}$'),
  operation_id text REFERENCES agent_execution.contained_turn_operation_v1(operation_id) ON DELETE RESTRICT,
  PRIMARY KEY (tenant_id, project_id, command_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES agent_execution.contained_turn_intent_namespace_v1 ON DELETE RESTRICT
);
CREATE TABLE agent_execution.contained_turn_intent_guard_v1 (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  command_id text NOT NULL,
  prevention_command_id text NOT NULL CHECK (octet_length(prevention_command_id) BETWEEN 1 AND 512),
  state_codec_version integer NOT NULL CHECK (state_codec_version = 1),
  state jsonb NOT NULL CHECK (octet_length(state::text) <= 16384),
  state_digest text NOT NULL CHECK (state_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, project_id, prevention_command_id),
  UNIQUE (tenant_id, project_id, command_id),
  FOREIGN KEY (tenant_id, project_id, command_id) REFERENCES agent_execution.contained_turn_intent_v1 ON DELETE RESTRICT
);

CREATE FUNCTION agent_execution.reject_contained_turn_intent_retirement()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'contained turn intent authority and guards are retained for the complete V1 namespace';
END
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['contained_turn_intent_namespace_v1', 'contained_turn_intent_v1', 'contained_turn_intent_guard_v1'] LOOP
    EXECUTE format('ALTER TABLE agent_execution.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE agent_execution.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY contained_turn_runtime_schema_fence ON agent_execution.%I USING (agent_execution.contained_turn_runtime_schema_compatible()) WITH CHECK (agent_execution.contained_turn_runtime_schema_compatible())', table_name);
    EXECUTE format('CREATE TRIGGER contained_turn_runtime_schema_write_fence BEFORE INSERT OR UPDATE OR DELETE ON agent_execution.%I FOR EACH ROW EXECUTE FUNCTION agent_execution.reject_incompatible_contained_turn_runtime_write()', table_name);
    EXECUTE format('CREATE TRIGGER contained_turn_intent_retention BEFORE UPDATE OR DELETE OR TRUNCATE ON agent_execution.%I FOR EACH STATEMENT EXECUTE FUNCTION agent_execution.reject_contained_turn_intent_retirement()', table_name);
  END LOOP;
END
$$;
`;
