/** Explicit PostgreSQL 18 migration. Nothing invokes this during construction or reads. */
export const dispatchSchemaV1 = `
CREATE SCHEMA IF NOT EXISTS runtime_security_dispatch_v1;
CREATE TABLE IF NOT EXISTS runtime_security_dispatch_v1.schema_version (
  singleton boolean PRIMARY KEY CHECK (singleton), version integer NOT NULL CHECK (version = 1)
);
INSERT INTO runtime_security_dispatch_v1.schema_version VALUES (true, 1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS runtime_security_dispatch_v1.authority_heads (
  operation_key text PRIMARY KEY,
  selector jsonb NOT NULL,
  head_version bigint NOT NULL CHECK (head_version > 0),
  authority jsonb
);
CREATE TABLE IF NOT EXISTS runtime_security_dispatch_v1.consume_requests (
  request_key text PRIMARY KEY,
  operation_key text NOT NULL,
  fact jsonb NOT NULL,
  UNIQUE (operation_key, request_key)
);
CREATE TABLE IF NOT EXISTS runtime_security_dispatch_v1.consumptions (
  operation_key text PRIMARY KEY,
  request_key text NOT NULL UNIQUE,
  receipt jsonb NOT NULL,
  FOREIGN KEY (operation_key, request_key)
    REFERENCES runtime_security_dispatch_v1.consume_requests (operation_key, request_key)
);
CREATE TABLE IF NOT EXISTS runtime_security_dispatch_v1.settlement_requests (
  request_key text PRIMARY KEY,
  operation_key text NOT NULL,
  applies boolean NOT NULL,
  fact jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_dispatch_settlement
  ON runtime_security_dispatch_v1.settlement_requests (operation_key) WHERE applies;
CREATE OR REPLACE FUNCTION runtime_security_dispatch_v1.immutable_fact() RETURNS trigger
LANGUAGE plpgsql AS $fn$ BEGIN
  RAISE EXCEPTION 'immutable dispatch fact';
END $fn$;
CREATE OR REPLACE FUNCTION runtime_security_dispatch_v1.advance_head() RETURNS trigger
LANGUAGE plpgsql AS $fn$ BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'dispatch head cannot be removed'; END IF;
  IF NEW.operation_key IS DISTINCT FROM OLD.operation_key
    OR NEW.selector IS DISTINCT FROM OLD.selector
    OR NEW.head_version <> OLD.head_version + 1
  THEN RAISE EXCEPTION 'invalid dispatch head version'; END IF;
  RETURN NEW;
END $fn$;
CREATE OR REPLACE TRIGGER dispatch_head_advance BEFORE UPDATE OR DELETE
  ON runtime_security_dispatch_v1.authority_heads FOR EACH ROW
  EXECUTE FUNCTION runtime_security_dispatch_v1.advance_head();
CREATE OR REPLACE TRIGGER dispatch_head_retain BEFORE TRUNCATE
  ON runtime_security_dispatch_v1.authority_heads FOR EACH STATEMENT
  EXECUTE FUNCTION runtime_security_dispatch_v1.immutable_fact();
CREATE OR REPLACE TRIGGER dispatch_request_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON runtime_security_dispatch_v1.consume_requests FOR EACH STATEMENT
  EXECUTE FUNCTION runtime_security_dispatch_v1.immutable_fact();
CREATE OR REPLACE TRIGGER dispatch_consumption_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON runtime_security_dispatch_v1.consumptions FOR EACH STATEMENT
  EXECUTE FUNCTION runtime_security_dispatch_v1.immutable_fact();
CREATE OR REPLACE TRIGGER dispatch_settlement_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON runtime_security_dispatch_v1.settlement_requests FOR EACH STATEMENT
  EXECUTE FUNCTION runtime_security_dispatch_v1.immutable_fact();
`;
