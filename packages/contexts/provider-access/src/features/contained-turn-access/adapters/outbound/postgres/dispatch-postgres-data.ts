import { detachedDispatchData, exactDispatchDataRecord } from "../../dispatch-consumption-data.js";
import { canonicalJson, snapshotDispatchScope, snapshotDispatchId, snapshotDispatchDigest,
  snapshotDispatchBindingHead, type DispatchBindingHead, type DispatchProvider, type DispatchScopeValue } from "../../../domain/dispatch-consumption.js";
import type { DispatchConsumptionTransactionSelector } from "../../../application/ports/outbound/dispatch-consumption-repository.js";
import { createSha256DispatchConsumptionDigest } from "../sha256-dispatch-consumption-digest.js";
import { assertMaterializationSchema } from "./materialization-postgres-schema.js";
import type { MaterializationPostgresClient } from "./materialization-postgres-transactions.js";

export interface DispatchPostgresOwner { readonly provider: DispatchProvider; readonly scope: DispatchScopeValue }
export const ownerSnapshot = (input: DispatchPostgresOwner): DispatchPostgresOwner => {
  const data = exactDispatchDataRecord("dispatch owner", input, ["provider", "scope"]);
  if (data.provider !== "codex" && data.provider !== "claude") {throw new TypeError("Invalid dispatch provider");}
  return Object.freeze({provider: data.provider, scope: snapshotDispatchScope(data.scope)});
};
export const selectorSnapshot = (input: DispatchConsumptionTransactionSelector): DispatchConsumptionTransactionSelector => {
  const raw = detachedDispatchData("dispatch selector", input) as DispatchConsumptionTransactionSelector;
  const keys = raw.kind === "consume" ? ["kind", "provider", "scope", "grantRequestId"] :
    ["kind", "provider", "scope", "consumptionDigest", "expectedAuthorityHeadDigest", "operationId", "settlementRequestId"];
  exactDispatchDataRecord("dispatch selector", raw, keys);
  const owner = ownerSnapshot({provider: raw.provider, scope: raw.scope});
  if (raw.kind === "consume") {return Object.freeze({...owner, kind: "consume", grantRequestId: snapshotDispatchId("grantRequestId", raw.grantRequestId)});}
  if (raw.kind !== "settle") {throw new TypeError("Invalid dispatch selector kind");}
  return Object.freeze({...owner, kind: "settle", consumptionDigest: snapshotDispatchDigest("consumptionDigest", raw.consumptionDigest),
    expectedAuthorityHeadDigest: snapshotDispatchDigest("expectedAuthorityHeadDigest", raw.expectedAuthorityHeadDigest),
    operationId: snapshotDispatchId("operationId", raw.operationId), settlementRequestId: snapshotDispatchId("settlementRequestId", raw.settlementRequestId)});
};
export const ownerId = async (owner: DispatchPostgresOwner): Promise<string> =>
  (await createSha256DispatchConsumptionDigest().digest(canonicalJson(owner))).slice(7);
export const integer = (value: unknown): number => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new TypeError("Invalid dispatch database integer");
  }
  return Number(value);
};
export const expectedVersion = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {throw new TypeError("Invalid dispatch CAS version");}
  return value;
};
export const lockDispatchOwner = async (client: MaterializationPostgresClient, owner: DispatchPostgresOwner) => {
  const id = await ownerId(owner);
  await client.query("INSERT INTO provider_access.dispatch_owner(owner_id,owner) VALUES ($1,$2::jsonb) ON CONFLICT DO NOTHING", [id, JSON.stringify(owner)]);
  const {rows} = await client.query("SELECT owner,version,control_time,head FROM provider_access.dispatch_owner WHERE owner_id=$1 FOR UPDATE", [id]);
  if (rows.length !== 1 || canonicalJson(rows[0]?.owner) !== canonicalJson(owner)) {throw new Error("PA dispatch owner collision or absence");}
  const row = rows[0]!;
  const head = row.head === null ? undefined : snapshotDispatchBindingHead(detachedDispatchData("stored head", row.head));
  if (head && canonicalJson({provider: head.provider, scope: snapshotDispatchScope({tenantId: head.tenantId, projectId: head.projectId, scopeDigest: head.scopeDigest})}) !== canonicalJson(owner)) {
    throw new Error("PA dispatch head owner mismatch");
  }
  // Same lock order as publication. Acquire both rows before sampling time so
  // a materialization writer cannot make the dispatch deadline sample stale.
  if (head) {await lockMaterializationRow(client, head);}
  // Sample only after the row locks have been acquired, including after a wait.
  const advanced = await client.query(`UPDATE provider_access.dispatch_owner
    SET control_time=GREATEST(control_time, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
    WHERE owner_id=$1 RETURNING control_time`, [id]);
  if (advanced.rowCount !== 1 || advanced.rows.length !== 1) {throw new Error("PA control time acknowledgement mismatch");}
  return {id, head, version: integer(row.version), controlTime: integer(advanced.rows[0]?.control_time)};
};
export const materializationProjection = (head: DispatchBindingHead) => Object.freeze({
  accessRef: head.accessRef, availability: head.availability, bindingRevision: head.bindingRevision,
  credentialBindingDigest: head.credentialBindingDigest, credentialBindingRef: head.credentialBindingRef,
  credentialGeneration: head.credentialGeneration, projectId: head.projectId, provider: head.provider,
  providerAccountRef: head.providerAccountRef, providerRouteRef: head.providerRouteRef, revocation: head.revocation,
  scopeDigest: head.scopeDigest, tenantId: head.tenantId,
});

const lockMaterializationRow = async (client: MaterializationPostgresClient, head: DispatchBindingHead) => {
  await assertMaterializationSchema(client);
  const values = [head.tenantId, head.projectId, head.provider, head.scopeDigest];
  const id = (await createSha256DispatchConsumptionDigest().digest(JSON.stringify(values))).slice(7);
  const {rows} = await client.query(`SELECT binding FROM provider_access.materialization_owner
    WHERE owner_id=$1 AND tenant_id=$2 AND project_id=$3 AND provider=$4 AND scope_digest=$5 FOR UPDATE`, [id, ...values]);
  return rows;
};
/** Check the same PA materialization head before admitting a new consumption. */
export const assertCurrentMaterialization = async (client: MaterializationPostgresClient, head: DispatchBindingHead): Promise<void> => {
  const rows = await lockMaterializationRow(client, head);
  if (rows.length !== 1 || canonicalJson(rows[0]?.binding) !== canonicalJson(materializationProjection(head))) {
    throw new Error("PA dispatch and materialization authority diverged");
  }
};
