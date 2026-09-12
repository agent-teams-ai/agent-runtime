import { canonicalJson, snapshotDispatchId } from "../../../domain/dispatch-consumption.js";
import { detachedDispatchData, exactDispatchDataRecord } from "../../dispatch-consumption-data.js";
import { createSha256DispatchConsumptionDigest } from "../sha256-dispatch-consumption-digest.js";
import type { PaOperationOwner, PaOperationRecordKind, PaOperationStore } from "../dispatch-operation-contracts.js";
import { assertDispatchOperationSchema, migrateDispatchOperationSchema } from "./dispatch-operation-schema.js";
import { assertMaterializationSchema, migrateMaterializationSchema } from "./materialization-postgres-schema.js";
import { bindingSnapshot } from "./materialization-postgres-repository.js";
import { integer, ownerId, ownerSnapshot } from "./dispatch-postgres-data.js";
import { MaterializationPostgresTransactions, type MaterializationPostgresClient, type MaterializationPostgresPool,
  type MaterializationPostgresTimeouts } from "./materialization-postgres-transactions.js";

const digest = createSha256DispatchConsumptionDigest();
const keyId = async (key: string) => (await digest.digest(canonicalJson(snapshotDispatchId("PA record key", key)))).slice(7);
const lockMaterialization = async (client: MaterializationPostgresClient, owner: PaOperationOwner) => {
  await assertMaterializationSchema(client);
  const values = [owner.scope.tenantId, owner.scope.projectId, owner.provider, owner.scope.scopeDigest];
  const id = (await digest.digest(JSON.stringify(values))).slice(7);
  const {rows} = await client.query(`SELECT binding,head_version FROM provider_access.materialization_owner
    WHERE owner_id=$1 AND tenant_id=$2 AND project_id=$3 AND provider=$4 AND scope_digest=$5 FOR UPDATE`, [id, ...values]);
  if (rows.length === 0) {return;}
  if (rows.length !== 1) {throw new Error("PA materialization row count mismatch");}
  if (rows[0]?.binding === null) {return;}
  const binding = bindingSnapshot(rows[0]?.binding);
  if (canonicalJson([binding.tenantId, binding.projectId, binding.provider, binding.scopeDigest]) !== canonicalJson(values)) {
    throw new Error("PA materialization owner mismatch");
  }
  return Object.freeze({binding, version: integer(rows[0]?.head_version)});
};
const recordMethods = (client: MaterializationPostgresClient, id: string, owner: PaOperationOwner, check: () => void) => ({
  async read(kind: PaOperationRecordKind, key: string): Promise<unknown> {
    check();
    const result = await client.query("SELECT record FROM provider_access.dispatch_operation_record_v2 WHERE owner_id=$1 AND kind=$2 AND key_id=$3", [id, kind, await keyId(key)]);
    if (result.rows.length === 0) {return;}
    if (result.rows.length !== 1) {throw new Error("PA operation record row count mismatch");}
    const data = exactDispatchDataRecord("PA operation envelope", detachedDispatchData("PA operation envelope", result.rows[0]?.record),
      ["version", "owner", "kind", "key", "value", "digest"]);
    const {digest: storedDigest, ...unsigned} = data;
    if (data.version !== 2 || data.kind !== kind || data.key !== key || canonicalJson(data.owner) !== canonicalJson(owner) ||
      storedDigest !== await digest.digest(canonicalJson(unsigned))) {throw new Error("PA operation envelope mismatch");}
    return data.value;
  },
  async insert(kind: PaOperationRecordKind, key: string, value: unknown): Promise<void> {
    check();
    const unsigned = {version: 2, owner, kind, key: snapshotDispatchId("PA record key", key), value: detachedDispatchData("PA operation record", value)};
    const record = {...unsigned, digest: await digest.digest(canonicalJson(unsigned))};
    const result = await client.query("INSERT INTO provider_access.dispatch_operation_record_v2 VALUES ($1,$2,$3,$4::jsonb)", [id, kind, await keyId(key), JSON.stringify(record)]);
    if (result.rowCount !== 1) {throw new Error("PA operation insert acknowledgement mismatch");}
  },
});

/** Owner lock serializes even absent request/operation records; materialization is read-only. */
export const createPostgresOperationDispatchStore = (pool: MaterializationPostgresPool, timeouts?: Partial<MaterializationPostgresTimeouts>) => {
  const transactions = new MaterializationPostgresTransactions(pool, timeouts);
  const store: PaOperationStore = Object.freeze<PaOperationStore>({
    async transact(input, work) {
      const owner = ownerSnapshot(input);
      return transactions.write(async (client, checkOpen) => {
        await assertDispatchOperationSchema(client);
        const id = await ownerId(owner);
        await client.query("INSERT INTO provider_access.dispatch_operation_owner_v2(owner_id,owner) VALUES ($1,$2::jsonb) ON CONFLICT DO NOTHING", [id, JSON.stringify(owner)]);
        const {rows} = await client.query("SELECT owner FROM provider_access.dispatch_operation_owner_v2 WHERE owner_id=$1 FOR UPDATE", [id]);
        if (rows.length !== 1 || canonicalJson(rows[0]?.owner) !== canonicalJson(owner)) {throw new Error("PA operation owner collision");}
        // All v2 paths use scope-owner -> materialization -> control-time order.
        const materialization = await lockMaterialization(client, owner);
        const sampled = await client.query(`UPDATE provider_access.dispatch_operation_owner_v2
          SET control_time=GREATEST(control_time,floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
          WHERE owner_id=$1 RETURNING control_time`, [id]);
        if (sampled.rowCount !== 1 || sampled.rows.length !== 1) {throw new Error("PA operation control-time acknowledgement mismatch");}
        let open = true;
        const check = () => {checkOpen(); if (!open) {throw new Error("PA operation transaction closed");}};
        try {return await work(Object.freeze({checkOpen: check, materialization, controlTime: integer(sampled.rows[0]?.control_time), ...recordMethods(client, id, owner, check)}));}
        finally {open = false;}
      });
    },
  });
  return Object.freeze({store,
    async migrate() {await migrateMaterializationSchema(transactions); await migrateDispatchOperationSchema(transactions);},
    dispose() {transactions.dispose();},
  });
};
