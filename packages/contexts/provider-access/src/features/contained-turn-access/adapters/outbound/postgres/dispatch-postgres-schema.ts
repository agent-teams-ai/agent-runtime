import { createSha256DispatchConsumptionDigest } from "../sha256-dispatch-consumption-digest.js";
import type { MaterializationPostgresClient, MaterializationPostgresTransactions } from "./materialization-postgres-transactions.js";

const schema = `
CREATE TABLE provider_access.dispatch_owner (
 owner_id text PRIMARY KEY, owner jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
 control_time bigint NOT NULL DEFAULT 1 CHECK (control_time BETWEEN 1 AND 9007199254740991), head jsonb,
 CHECK ((version = 0) = (head IS NULL))
);
CREATE TABLE provider_access.dispatch_publication (
 owner_id text NOT NULL REFERENCES provider_access.dispatch_owner, request_id text NOT NULL,
 command jsonb NOT NULL, result jsonb NOT NULL, PRIMARY KEY(owner_id, request_id)
);
CREATE TABLE provider_access.dispatch_head_identity (
 owner_id text NOT NULL REFERENCES provider_access.dispatch_owner, authority_digest text NOT NULL,
 PRIMARY KEY(owner_id, authority_digest)
);
CREATE TABLE provider_access.dispatch_grant (
 owner_id text NOT NULL REFERENCES provider_access.dispatch_owner, request_id text NOT NULL,
 record jsonb NOT NULL, PRIMARY KEY(owner_id, request_id)
);
CREATE TABLE provider_access.dispatch_consumption (
 owner_id text NOT NULL REFERENCES provider_access.dispatch_owner, authority_digest text NOT NULL,
 consumption_digest text NOT NULL, record jsonb NOT NULL,
 PRIMARY KEY(owner_id, consumption_digest), UNIQUE(owner_id, authority_digest)
);
CREATE TABLE provider_access.dispatch_settlement (
 owner_id text NOT NULL REFERENCES provider_access.dispatch_owner, request_key text NOT NULL, operation_id text NOT NULL,
 request_id text NOT NULL, consumption_digest text NOT NULL, record jsonb NOT NULL,
 PRIMARY KEY(owner_id, request_key), UNIQUE(owner_id, consumption_digest),
 FOREIGN KEY(owner_id, consumption_digest) REFERENCES provider_access.dispatch_consumption(owner_id, consumption_digest)
);
CREATE FUNCTION provider_access.reject_dispatch_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PA dispatch history is immutable'; END $$;
${["publication", "head_identity", "grant", "consumption", "settlement"].map(name => `
CREATE TRIGGER dispatch_${name}_immutable BEFORE UPDATE OR DELETE ON provider_access.dispatch_${name}
FOR EACH ROW EXECUTE FUNCTION provider_access.reject_dispatch_mutation();`).join("\n")}
`;
export const dispatchPostgresSchemaDigest = async () => (await createSha256DispatchConsumptionDigest().digest(schema)).slice(7);
const query = "SELECT version, digest FROM provider_access.dispatch_schema WHERE component = 'pa-dispatch-v1'";
export const assertDispatchSchema = async (client: MaterializationPostgresClient): Promise<void> => {
  const {rows} = await client.query(query);
  if (rows.length !== 1 || rows[0]?.version !== 1 || rows[0]?.digest !== await dispatchPostgresSchemaDigest()) {
    throw new Error("PA dispatch schema revision mismatch");
  }
};
export const migrateDispatchSchema = async (transactions: MaterializationPostgresTransactions): Promise<void> => {
  await transactions.write(async client => {
    await client.query("SELECT pg_advisory_xact_lock(1885433197)");
    await client.query("CREATE SCHEMA IF NOT EXISTS provider_access");
    await client.query("CREATE TABLE IF NOT EXISTS provider_access.dispatch_schema (component text PRIMARY KEY, version integer NOT NULL, digest text NOT NULL)");
    const current = await client.query(query);
    if (current.rows.length) {await assertDispatchSchema(client); return;}
    await client.query(schema);
    await client.query("INSERT INTO provider_access.dispatch_schema VALUES ('pa-dispatch-v1',1,$1)", [await dispatchPostgresSchemaDigest()]);
  });
};
