import { createSha256DispatchConsumptionDigest } from "../sha256-dispatch-consumption-digest.js";
import type { MaterializationPostgresClient, MaterializationPostgresTransactions } from "./materialization-postgres-transactions.js";

const schema = `
CREATE TABLE provider_access.materialization_owner (
  owner_id text PRIMARY KEY CHECK (owner_id ~ '^[0-9a-f]{64}$'),
  tenant_id text NOT NULL, project_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('claude','codex')), scope_digest text NOT NULL,
  head_version bigint NOT NULL DEFAULT 0 CHECK (head_version BETWEEN 0 AND 9007199254740991),
  binding jsonb,
  CHECK ((head_version = 0) = (binding IS NULL))
);
CREATE TABLE provider_access.materialization_authorization (
  owner_id text NOT NULL REFERENCES provider_access.materialization_owner(owner_id),
  request_id text NOT NULL, receipt jsonb NOT NULL,
  PRIMARY KEY (owner_id, request_id)
);
CREATE FUNCTION provider_access.reject_materialization_receipt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PA authorization receipts are immutable'; END $$;
CREATE TRIGGER materialization_receipt_immutable BEFORE UPDATE OR DELETE
ON provider_access.materialization_authorization FOR EACH ROW
EXECUTE FUNCTION provider_access.reject_materialization_receipt_mutation();
`;
// Exact full-text pin for disposable qualification; editing schema changes the
// digest and fails closed for databases retaining the prior revision.
// TODO: Add explicit versioned migrations before evolving a durable production
// schema; preserve prior revision validation rather than replacing its pin.
export const materializationPostgresSchemaDigest = async (): Promise<string> =>
  (await createSha256DispatchConsumptionDigest().digest(schema)).slice(7);
const versionQuery = "SELECT version, digest FROM provider_access.materialization_schema WHERE component = 'pa-m1'";

const matches = async (row: Record<string, unknown> | undefined): Promise<boolean> =>
  row?.version === 1 && row.digest === await materializationPostgresSchemaDigest();

export const assertMaterializationSchema = async (client: MaterializationPostgresClient): Promise<void> => {
  const result = await client.query(versionQuery);
  if (result.rows.length !== 1 || !await matches(result.rows[0])) {throw new Error("Provider Access schema revision mismatch");}
};

/** Explicit owner migration; construction and ordinary reads never migrate. */
export const migrateMaterializationSchema = async (transactions: MaterializationPostgresTransactions): Promise<void> => {
  await transactions.write(async client => {
    await client.query("SELECT pg_advisory_xact_lock(1885433197)");
    await client.query("CREATE SCHEMA IF NOT EXISTS provider_access");
    await client.query("CREATE TABLE IF NOT EXISTS provider_access.materialization_schema (component text PRIMARY KEY, version integer NOT NULL, digest text NOT NULL)");
    const current = await client.query(versionQuery);
    if (current.rows.length !== 0) {
      if (current.rows.length !== 1 || !await matches(current.rows[0])) {throw new Error("Provider Access schema revision mismatch");}
      return;
    }
    // Existing unversioned tables are not adopted by IF NOT EXISTS.
    await client.query(schema);
    await client.query("INSERT INTO provider_access.materialization_schema(component,version,digest) VALUES ('pa-m1',1,$1)",
      [await materializationPostgresSchemaDigest()]);
  });
};
