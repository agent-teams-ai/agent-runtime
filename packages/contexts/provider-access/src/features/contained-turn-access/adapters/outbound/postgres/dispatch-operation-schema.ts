import { createSha256DispatchConsumptionDigest } from "../sha256-dispatch-consumption-digest.js";
import type { MaterializationPostgresClient, MaterializationPostgresTransactions } from "./materialization-postgres-transactions.js";

// Separate identity space: v1 global rows remain v1 history and are never read here.
const schema = `
CREATE TABLE provider_access.dispatch_operation_owner_v2 (
 owner_id text PRIMARY KEY, owner jsonb NOT NULL,
 control_time bigint NOT NULL DEFAULT 1 CHECK (control_time BETWEEN 1 AND 9007199254740991)
);
CREATE TABLE provider_access.dispatch_operation_record_v2 (
 owner_id text NOT NULL REFERENCES provider_access.dispatch_operation_owner_v2,
 kind text NOT NULL CHECK (kind IN ('issuance','publication','attempt','grant','consumption','settlement')),
 key_id text NOT NULL, record jsonb NOT NULL,
 PRIMARY KEY(owner_id,kind,key_id)
);
CREATE FUNCTION provider_access.reject_dispatch_operation_mutation_v2() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PA operation dispatch history is immutable'; END $$;
CREATE TRIGGER dispatch_operation_record_immutable_v2 BEFORE UPDATE OR DELETE ON provider_access.dispatch_operation_record_v2
FOR EACH ROW EXECUTE FUNCTION provider_access.reject_dispatch_operation_mutation_v2();
`;
export const dispatchOperationSchemaDigest = async () => (await createSha256DispatchConsumptionDigest().digest(schema)).slice(7);
const query = "SELECT version,digest FROM provider_access.dispatch_operation_schema WHERE component='pa-operation-dispatch-v2'";
export const assertDispatchOperationSchema = async (client: MaterializationPostgresClient): Promise<void> => {
  const result = await client.query(query);
  if (result.rows.length !== 1 || result.rows[0]?.version !== 2 || result.rows[0]?.digest !== await dispatchOperationSchemaDigest()) {
    throw new Error("PA operation dispatch schema mismatch");
  }
};
export const migrateDispatchOperationSchema = async (transactions: MaterializationPostgresTransactions): Promise<void> => {
  await transactions.write(async client => {
    await client.query("SELECT pg_advisory_xact_lock(1885433197)");
    await client.query("CREATE SCHEMA IF NOT EXISTS provider_access");
    await client.query("CREATE TABLE IF NOT EXISTS provider_access.dispatch_operation_schema (component text PRIMARY KEY, version integer NOT NULL, digest text NOT NULL)");
    if ((await client.query(query)).rows.length !== 0) {await assertDispatchOperationSchema(client); return;}
    await client.query(schema);
    const result = await client.query("INSERT INTO provider_access.dispatch_operation_schema VALUES ('pa-operation-dispatch-v2',2,$1)", [await dispatchOperationSchemaDigest()]);
    if (result.rowCount !== 1) {throw new Error("PA operation schema acknowledgement mismatch");}
  });
};
