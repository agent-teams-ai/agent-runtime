import { createHash } from 'node:crypto';
import { OrdinaryPaUnavailable } from '../../../contracts/ordinary-provider-access.js';
import type { MaterializationPostgresClient, MaterializationPostgresTransactions } from './materialization-postgres-transactions.js';
const ddl = `
CREATE TABLE provider_access.ordinary_grant (
 operation_key text PRIMARY KEY, binding jsonb NOT NULL, snapshot jsonb NOT NULL,
 expires_at bigint NOT NULL, retired_at text, disposition text,
 settlement_id text, requests_started integer NOT NULL DEFAULT 0,
 requests_completed integer NOT NULL DEFAULT 0, requests_failed integer NOT NULL DEFAULT 0,
 CHECK (requests_started BETWEEN 0 AND 64),
 CHECK (requests_completed BETWEEN 0 AND requests_started),
 CHECK (requests_failed BETWEEN 0 AND requests_started),
 CHECK (disposition IS NULL OR disposition IN ('claim_committed','abandoned_without_claim')),
 CHECK ((disposition IS NULL) = (settlement_id IS NULL))
);
CREATE TABLE provider_access.ordinary_request (
 operation_key text NOT NULL REFERENCES provider_access.ordinary_grant(operation_key),
 sequence integer NOT NULL, body_digest text NOT NULL, byte_length integer NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('started','completed','failed')),
 PRIMARY KEY(operation_key,sequence), UNIQUE(operation_key,body_digest)
);
CREATE FUNCTION provider_access.ordinary_grant_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ordinary PA grant identity immutable'; END IF;
 IF (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)
 OR (OLD.disposition IS NOT NULL AND (NEW.disposition IS DISTINCT FROM OLD.disposition OR NEW.settlement_id IS DISTINCT FROM OLD.settlement_id))
 OR NEW.requests_started < OLD.requests_started OR NEW.requests_completed < OLD.requests_completed OR NEW.requests_failed < OLD.requests_failed
 THEN RAISE EXCEPTION 'ordinary PA grant transitions are monotonic'; END IF;
 IF NEW.binding IS DISTINCT FROM OLD.binding OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
 OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
 THEN RAISE EXCEPTION 'ordinary PA grant identity immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ordinary_grant_identity_immutable BEFORE UPDATE OR DELETE ON provider_access.ordinary_grant
FOR EACH ROW EXECUTE FUNCTION provider_access.ordinary_grant_identity_immutable();
CREATE FUNCTION provider_access.ordinary_request_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ordinary PA request identity immutable'; END IF;
 IF NEW.operation_key IS DISTINCT FROM OLD.operation_key OR NEW.sequence IS DISTINCT FROM OLD.sequence
 OR NEW.body_digest IS DISTINCT FROM OLD.body_digest OR NEW.byte_length IS DISTINCT FROM OLD.byte_length
 OR (OLD.outcome <> 'started' AND NEW.outcome IS DISTINCT FROM OLD.outcome)
 THEN RAISE EXCEPTION 'ordinary PA request identity immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ordinary_request_identity_immutable BEFORE UPDATE OR DELETE ON provider_access.ordinary_request
FOR EACH ROW EXECUTE FUNCTION provider_access.ordinary_request_identity_immutable();
`;
export const ordinaryPaSchemaDigest = createHash('sha256').update(ddl).digest('hex');
export async function assertOrdinaryPaSchema(client: MaterializationPostgresClient): Promise<void> {
  const result = await client.query("SELECT version,digest FROM provider_access.materialization_schema WHERE component='ordinary-pa-v1'");
  if (result.rows.length !== 1 || result.rows[0]?.version !== 1 || result.rows[0]?.digest !== ordinaryPaSchemaDigest) { throw new OrdinaryPaUnavailable(); }
}
export async function migrateOrdinaryPaSchema(transactions: MaterializationPostgresTransactions): Promise<void> {
  await transactions.write(async client => {
    await client.query('SELECT pg_advisory_xact_lock(1885433210)');
    await client.query('CREATE SCHEMA IF NOT EXISTS provider_access');
    await client.query('CREATE TABLE IF NOT EXISTS provider_access.materialization_schema (component text PRIMARY KEY, version integer NOT NULL, digest text NOT NULL)');
    const result = await client.query("SELECT version,digest FROM provider_access.materialization_schema WHERE component='ordinary-pa-v1'");
    if (result.rows.length !== 0) { await assertOrdinaryPaSchema(client); return; }
    await client.query(ddl);
    await client.query("INSERT INTO provider_access.materialization_schema(component,version,digest) VALUES ('ordinary-pa-v1',1,$1)", [ordinaryPaSchemaDigest]);
  });
}
