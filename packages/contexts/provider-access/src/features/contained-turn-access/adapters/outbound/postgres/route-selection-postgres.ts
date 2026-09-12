import { canonicalJson } from "../../../domain/dispatch-consumption.js";
import { exactDispatchDataRecord } from "../../dispatch-consumption-data.js";
import { routeSelectionDigest, snapshotRouteSelectionFacts, snapshotRouteSelectionCurrent, type RouteSelectionCurrent } from "./route-selection-data.js";
import { assertMaterializationSchema } from "./materialization-postgres-schema.js";
import type { MaterializationAuthorizationBinding as Binding } from "../../../application/ports/outbound/materialization-authorization-repository.js";
import type { MaterializationPostgresTransactions } from "./materialization-postgres-transactions.js";
import { assertRouteSelectionSchema, migrateRouteSelectionSchema } from "./route-selection-schema.js";

type BindingTools = Readonly<{
  ownerWhere: string; ownerValues(binding: Binding): Promise<unknown[]>;
  bindingSnapshot(value: unknown): Binding; version(value: unknown): number;
}>;
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

const historicalIdentity = async (saved: Record<string, unknown>, endorsement: Readonly<Record<string, unknown>>,
  values: unknown[], headVersion: number, helpers: BindingTools): Promise<void> => {
  const prior = snapshotRouteSelectionFacts({binding: endorsement.binding, recipe: endorsement.recipe, descriptor: endorsement.descriptor});
  const revision = helpers.version(saved.binding_revision);
  const priorVersion = helpers.version(saved.head_version);
  if (!equal(await helpers.ownerValues(prior.binding), values) || prior.binding.bindingRevision !== revision ||
    priorVersion < 1 || priorVersion >= headVersion || endorsement.routeGeneration !== String(revision) ||
    endorsement.routeAuthorityDigest !== await routeSelectionDigest(prior)) {throw new Error("Invalid PA historical route identity");}
};

/** The existing PA head lock serializes endorsement and generic binding replacement. */
export const createRouteSelectionPersistence = (transactions: MaterializationPostgresTransactions, helpers: BindingTools) => {
  const access = (input: RouteSelectionCurrent, check: () => void, expectedHeadVersion?: number) =>
    transactions.write(async client => {
      check();
      const expected = await snapshotRouteSelectionCurrent(input);
      check();
      await assertMaterializationSchema(client);
      await assertRouteSelectionSchema(client);
      const values = await helpers.ownerValues(expected.binding);
      const head = await client.query(`SELECT head_version, binding FROM provider_access.materialization_owner
        WHERE ${helpers.ownerWhere} FOR UPDATE`, values);
      if (head.rows.length === 0) {return;}
      if (head.rows.length !== 1) {throw new Error("Invalid PA route head row count");}
      const row = head.rows[0]!;
      if (row.binding === null) {return;}
      const binding = helpers.bindingSnapshot(row.binding);
      const headVersion = helpers.version(row.head_version);
      if (headVersion < 1) {throw new Error("Invalid PA route head version");}
      if (!equal(binding, expected.binding) || binding.revocation !== "active" || binding.availability !== "available") {return;}
      if (expectedHeadVersion !== undefined && expectedHeadVersion !== headVersion) {return;}
      const latest = await client.query(`SELECT binding_revision, head_version, endorsement FROM provider_access.route_selection
        WHERE owner_id = $1 ORDER BY binding_revision DESC LIMIT 1`, [values[0]]);
      check();
      if (latest.rows.length > 1) {throw new Error("Invalid PA route row count");}
      const saved = latest.rows[0];
      if (saved) {
        const revision = helpers.version(saved.binding_revision);
        const endorsement = exactDispatchDataRecord("PA stored route", saved.endorsement,
          ["binding", "recipe", "descriptor", "routeGeneration", "routeAuthorityDigest"]);
        // Compare every stored identity and descriptor field, not just an opaque digest.
        if (revision >= binding.bindingRevision) {
          if (revision !== binding.bindingRevision || helpers.version(saved.head_version) !== headVersion || !equal(endorsement, expected)) {return;}
          return expected;
        }
        // Even historical facts must belong to this full owner, and be self-consistent.
        await historicalIdentity(saved, endorsement, values, headVersion, helpers);
      }
      if (expectedHeadVersion === undefined) {return;}
      check();
      const inserted = await client.query(`INSERT INTO provider_access.route_selection(owner_id,binding_revision,head_version,endorsement)
        VALUES ($1,$2,$3,$4::jsonb)`, [values[0], String(binding.bindingRevision), String(headVersion), JSON.stringify(expected)]);
      if (inserted.rowCount !== 1) {throw new Error("PA route insert acknowledgement mismatch");}
      check();
      return expected;
    });
  return Object.freeze({
    readCurrent: (expected: RouteSelectionCurrent, check: () => void) => access(expected, check),
    endorse: (expected: RouteSelectionCurrent, headVersion: number, check: () => void) => access(expected, check, headVersion),
    migrate: (check: () => void) => migrateRouteSelectionSchema(transactions, check),
  });
};
