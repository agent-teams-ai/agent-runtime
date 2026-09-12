import { createSha256DispatchConsumptionDigest } from "../sha256-dispatch-consumption-digest.js";
import type { MaterializationAuthorizationBinding, MaterializationAuthorizationRepository,
  MaterializationAuthorizationRequestSelector, MaterializationAuthorizationTransaction } from "../../../application/ports/outbound/materialization-authorization-repository.js";
import { snapshotAuthorizationCommand, snapshotAuthorizationOwnerSelector, snapshotAuthorizationRecord,
  type AuthorizationRecord } from "../../../domain/materialization-authorization.js";
import { detachedDispatchData, exactDispatchDataRecord } from "../../dispatch-consumption-data.js";
import { assertMaterializationSchema, migrateMaterializationSchema } from "./materialization-postgres-schema.js";
import { createRouteSelectionPersistence } from "./route-selection-postgres.js";
import { MaterializationPostgresTransactions, type MaterializationPostgresClient, type MaterializationPostgresPool,
  type MaterializationPostgresTimeouts } from "./materialization-postgres-transactions.js";

export type MaterializationPostgresOwner = Pick<MaterializationAuthorizationBinding, "tenantId" | "projectId" | "provider" | "scopeDigest">;
type Owner = MaterializationPostgresOwner;
const ownerWhere = "owner_id = $1 AND tenant_id = $2 AND project_id = $3 AND provider = $4 AND scope_digest = $5";
const selectorSnapshot = (value: MaterializationAuthorizationRequestSelector): MaterializationAuthorizationRequestSelector => {
  const input = exactDispatchDataRecord("PA database selector", value, ["authorizationRequestId", "tenantId", "projectId", "provider", "scopeDigest"]);
  const {requestDigest: _digest, ...selector} = snapshotAuthorizationOwnerSelector({...input, requestDigest: "database:selector"});
  return Object.freeze(selector);
};
export const bindingSnapshot = (value: unknown): MaterializationAuthorizationBinding => {
  const binding = detachedDispatchData("PA database binding", value) as Record<string, unknown>;
  const {authorizationRequestId: _id, requestDigest: _digest, purpose: _purpose, schemaVersion: _schema, ...result} =
    snapshotAuthorizationCommand({...binding, authorizationRequestId: "database:binding", requestDigest: "database:binding",
      purpose: "contained-turn.credential-materialization-authorization/v1", schemaVersion: 1});
  if (Object.keys(binding).length !== Object.keys(result).length) {throw new TypeError("Invalid PA database binding");}
  return Object.freeze(result);
};
const ownerValues = async (owner: Owner): Promise<unknown[]> => {
  const values = [owner.tenantId, owner.projectId, owner.provider, owner.scopeDigest];
  // Bounded digest index avoids PostgreSQL index-size limits for Unicode owner tokens.
  // Every lookup also compares full owner columns, including hash-collision refusal.
  return [(await createSha256DispatchConsumptionDigest().digest(JSON.stringify(values))).slice(7), ...values];
};
const sameOwner = (a: Owner, b: Owner): boolean => a.tenantId === b.tenantId && a.projectId === b.projectId &&
  a.provider === b.provider && a.scopeDigest === b.scopeDigest;
const version = (value: unknown): number => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {throw new TypeError("Invalid PA head version");}
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {throw new TypeError("Invalid PA head version");}
  return result;
};
const lockOwner = async (client: MaterializationPostgresClient, owner: Owner) => {
  const values = await ownerValues(owner);
  await client.query(`INSERT INTO provider_access.materialization_owner(owner_id,tenant_id,project_id,provider,scope_digest)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (owner_id) DO NOTHING`, values);
  const locked = await client.query(`SELECT head_version, binding FROM provider_access.materialization_owner WHERE ${ownerWhere} FOR UPDATE`, values);
  if (locked.rows.length !== 1) {throw new Error("Provider Access owner collision or absence");}
  return locked.rows[0] as {head_version: unknown; binding: unknown};
};
const readRecord = async (client: MaterializationPostgresClient, selector: MaterializationAuthorizationRequestSelector): Promise<AuthorizationRecord | undefined> => {
  const result = await client.query(`SELECT a.receipt FROM provider_access.materialization_authorization a
    JOIN provider_access.materialization_owner o ON o.owner_id = a.owner_id
    WHERE o.owner_id = $1 AND o.tenant_id = $2 AND o.project_id = $3 AND o.provider = $4 AND o.scope_digest = $5 AND a.request_id = $6`,
    [...await ownerValues(selector), selector.authorizationRequestId]);
  if (result.rows.length === 0) {return undefined;}
  if (result.rows.length !== 1) {throw new Error("Invalid PA authorization row count");}
  const record = snapshotAuthorizationRecord(detachedDispatchData("PA database receipt", result.rows[0]?.receipt));
  if (!sameOwner(record, selector) || record.authorizationRequestId !== selector.authorizationRequestId) {
    throw new Error("Provider Access authorization owner mismatch");
  }
  return record;
};

/** PA-M1 persistence only. No raw credentials, dispatch consumption or cross-context transaction. */
export const createPostgresMaterializationRepository = (pool: MaterializationPostgresPool,
  timeouts?: Partial<MaterializationPostgresTimeouts>) => {
  const transactions = new MaterializationPostgresTransactions(pool, timeouts);
  const repository: MaterializationAuthorizationRepository = Object.freeze({
    async observeAuthorizationRequest(input: MaterializationAuthorizationRequestSelector) {
      const selector = selectorSnapshot(input);
      return transactions.write(async client => {await assertMaterializationSchema(client); return readRecord(client, selector);});
    },
    async transact<T>(input: MaterializationAuthorizationRequestSelector,
      work: (transaction: MaterializationAuthorizationTransaction) => Promise<T>): Promise<T> {
      const selector = selectorSnapshot(input);
      return transactions.write(async (client, checkOpen) => {
        await assertMaterializationSchema(client);
        // The owner row also serializes absent binding heads and distinct request IDs.
        const head = await lockOwner(client, selector);
        let open = true;
        const check = () => {checkOpen(); if (!open) {throw new Error("Provider Access transaction callback is closed");}};
        try {
          return await work(Object.freeze({
            async findAuthorizationRequest() {check(); return readRecord(client, selector);},
            async findBinding() {
              check();
              if (head.binding === null) {return;}
              const binding = bindingSnapshot(head.binding);
              if (!sameOwner(binding, selector)) {throw new Error("Provider Access binding owner mismatch");}
              return binding;
            },
            async saveAuthorization(value: AuthorizationRecord) {
              check();
              const record = snapshotAuthorizationRecord(detachedDispatchData("PA database write", value));
              if (!sameOwner(record, selector) || record.authorizationRequestId !== selector.authorizationRequestId) {
                throw new Error("Provider Access authorization write owner mismatch");
              }
              const saved = await client.query("INSERT INTO provider_access.materialization_authorization(owner_id,request_id,receipt) VALUES ($1,$2,$3::jsonb)",
                [(await ownerValues(selector))[0], selector.authorizationRequestId, JSON.stringify(record)]);
              if (saved.rowCount !== 1) {throw new Error("Provider Access receipt insert acknowledgement mismatch");}
            },
          }));
        } finally {open = false;}
      });
    },
  });
  return Object.freeze({
    repository,
    routeSelection: createRouteSelectionPersistence(transactions, {ownerWhere, ownerValues, bindingSnapshot, version}),
    /** Current PA facts only; an observation never creates a head or grants materialization. */
    async observeBinding(input: MaterializationPostgresOwner): Promise<MaterializationAuthorizationBinding | undefined> {
      const values = exactDispatchDataRecord("PA binding owner", input, ["tenantId", "projectId", "provider", "scopeDigest"]);
      const selector = selectorSnapshot({...values, authorizationRequestId: "database:binding-observation"} as MaterializationAuthorizationRequestSelector);
      return transactions.write(async client => {
        await assertMaterializationSchema(client);
        const result = await client.query(`SELECT binding FROM provider_access.materialization_owner WHERE ${ownerWhere}`, await ownerValues(selector));
        if (result.rows.length === 0) {return;}
        if (result.rows.length !== 1) {throw new Error("Invalid PA binding row count");}
        if (result.rows[0]?.binding === null) {return;}
        const binding = bindingSnapshot(result.rows[0]?.binding);
        if (!sameOwner(binding, selector)) {throw new Error("Provider Access binding owner mismatch");}
        return binding;
      });
    },
    migrate: async () => {await migrateMaterializationSchema(transactions);},
    /** Head version is PA persistence CAS authority, distinct from credential/binding generations. */
    async replaceBinding(input: MaterializationAuthorizationBinding, expectedHeadVersion: number): Promise<number | undefined> {
      const binding = bindingSnapshot(input);
      if (!Number.isSafeInteger(expectedHeadVersion) || expectedHeadVersion < 0 || expectedHeadVersion >= Number.MAX_SAFE_INTEGER) {
        throw new TypeError("Invalid PA expected head version");
      }
      return transactions.write(async client => {
        await assertMaterializationSchema(client);
        const current = await lockOwner(client, binding);
        if (version(current.head_version) !== expectedHeadVersion) {return;}
        const next = expectedHeadVersion + 1;
        const updated = await client.query(`UPDATE provider_access.materialization_owner SET binding = $6::jsonb, head_version = $7
          WHERE ${ownerWhere} AND head_version = $8`, [...await ownerValues(binding), JSON.stringify(binding), String(next), String(expectedHeadVersion)]);
        if (updated.rowCount !== 1) {throw new Error("Provider Access head CAS acknowledgement mismatch");}
        return next;
      });
    },
    dispose: () => {transactions.dispose();},
  });
};
