import { createSha256DispatchConsumptionDigest } from "../sha256-dispatch-consumption-digest.js";
import { assertMaterializationSchema } from "./materialization-postgres-schema.js";
import type { MaterializationPostgresClient, MaterializationPostgresTransactions } from "./materialization-postgres-transactions.js";

// One immutable association per PA owner/revision. No route inventory or independent generation.
const schema = `
CREATE TABLE provider_access.route_selection (
  owner_id text NOT NULL REFERENCES provider_access.materialization_owner(owner_id),
  binding_revision bigint NOT NULL CHECK (binding_revision BETWEEN 1 AND 9007199254740991),
  head_version bigint NOT NULL CHECK (head_version BETWEEN 1 AND 9007199254740991),
  endorsement jsonb NOT NULL,
  PRIMARY KEY (owner_id, binding_revision)
);
CREATE FUNCTION provider_access.reject_route_selection_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PA route selections are immutable'; END $$;
CREATE TRIGGER route_selection_immutable BEFORE UPDATE OR DELETE ON provider_access.route_selection
FOR EACH ROW EXECUTE FUNCTION provider_access.reject_route_selection_mutation();
`;
export const routeSelectionSchemaDigest = async (): Promise<string> =>
  (await createSha256DispatchConsumptionDigest().digest(schema)).slice(7);
const versionQuery = "SELECT version, digest FROM provider_access.materialization_schema WHERE component = 'pa-route-selection-v1'";
const matches = async (row: Record<string, unknown> | undefined) => row?.version === 1 && row.digest === await routeSelectionSchemaDigest();
export const assertRouteSelectionSchema = async (client: MaterializationPostgresClient): Promise<void> => {
  const result = await client.query(versionQuery);
  if (result.rows.length !== 1 || !await matches(result.rows[0])) {throw new Error("PA route schema revision mismatch");}
};
export const migrateRouteSelectionSchema = (transactions: MaterializationPostgresTransactions, check: () => void): Promise<void> =>
  transactions.write(async client => {
    check();
    await client.query("SELECT pg_advisory_xact_lock(1885433197)");
    await assertMaterializationSchema(client);
    const current = await client.query(versionQuery);
    if (current.rows.length !== 0) {
      if (current.rows.length !== 1 || !await matches(current.rows[0])) {throw new Error("PA route schema revision mismatch");}
      return;
    }
    check();
    await client.query(schema);
    check();
    const inserted = await client.query("INSERT INTO provider_access.materialization_schema(component,version,digest) VALUES ('pa-route-selection-v1',1,$1)",
      [await routeSelectionSchemaDigest()]);
    if (inserted.rowCount !== 1) {throw new Error("PA route schema acknowledgement mismatch");}
    check();
  });
