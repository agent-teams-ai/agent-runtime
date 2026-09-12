import { canonicalJson, snapshotDispatchBindingHead, snapshotDispatchControlTime, snapshotDispatchId,
  type DispatchBindingHead } from "../../../domain/dispatch-consumption.js";
import { snapshotAuthorizationCommand } from "../../../domain/materialization-authorization.js";
import { detachedDispatchData, exactDispatchDataRecord } from "../../dispatch-consumption-data.js";
import { createSha256DispatchConsumptionDigest } from "../sha256-dispatch-consumption-digest.js";
import { assertMaterializationSchema } from "./materialization-postgres-schema.js";
import { assertDispatchSchema } from "./dispatch-postgres-schema.js";
import { expectedVersion, integer, lockDispatchOwner, materializationProjection, ownerSnapshot,
  type DispatchPostgresOwner } from "./dispatch-postgres-data.js";
import type { MaterializationPostgresClient, MaterializationPostgresTransactions } from "./materialization-postgres-transactions.js";

export interface DispatchHeadPublication {
  readonly publicationRequestId: string;
  readonly expectedHeadVersion: number;
  readonly expectedMaterializationHeadVersion: number;
  readonly head: DispatchBindingHead;
}
export interface DispatchHeadPublicationResult { readonly headVersion: number; readonly materializationHeadVersion: number }

// Status changes retain the one-use identity. New authority requires a strictly
// newer binding revision; an old digest can never be republished as fresh use.
type AuthorityBinding = ReturnType<typeof materializationProjection>;
const authorityIdentity = <T extends AuthorityBinding>(binding: T) => {
  const {availability: _availability, revocation: _revocation, ...rest} = binding; return rest;
};
const validateAuthorityAdvance = <T extends AuthorityBinding>(previous: T, next: T, sameIdentity: boolean): void => {
  if (sameIdentity) {
    if (canonicalJson(authorityIdentity(previous)) !== canonicalJson(authorityIdentity(next)) ||
      (previous.revocation === "revoked" && next.revocation !== "revoked") ||
      (previous.availability === "unavailable" && next.availability !== "unavailable")) {
      throw new Error("PA dispatch authority identity cannot be rebound or revived");
    }
  } else if (next.bindingRevision <= previous.bindingRevision || next.credentialGeneration < previous.credentialGeneration) {
    throw new Error("PA dispatch authority generation must advance");
  }
};
export const validateDispatchHeadAdvance = (previous: DispatchBindingHead | undefined, next: DispatchBindingHead): void => {
  if (previous) {validateAuthorityAdvance(previous, next, next.authorityHeadDigest === previous.authorityHeadDigest);}
};

const publishMaterialization = async (client: MaterializationPostgresClient, head: DispatchBindingHead, expected: number): Promise<void> => {
  await assertMaterializationSchema(client);
  const binding = materializationProjection(head);
  const values = [binding.tenantId, binding.projectId, binding.provider, binding.scopeDigest];
  const id = (await createSha256DispatchConsumptionDigest().digest(JSON.stringify(values))).slice(7);
  await client.query(`INSERT INTO provider_access.materialization_owner(owner_id,tenant_id,project_id,provider,scope_digest)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [id, ...values]);
  const where = "owner_id=$1 AND tenant_id=$2 AND project_id=$3 AND provider=$4 AND scope_digest=$5";
  const {rows} = await client.query(`SELECT head_version, binding FROM provider_access.materialization_owner WHERE ${where} FOR UPDATE`, [id, ...values]);
  if (rows.length !== 1 || integer(rows[0]?.head_version) !== expected) {throw new Error("PA materialization head CAS conflict");}
  // CAS serializes writers; the locked binding independently owns monotonic
  // authority. A dispatch head cannot undo a materialization-only revocation.
  if (rows[0]?.binding !== null) {
    const stored = exactDispatchDataRecord("stored materialization binding", rows[0]?.binding, Object.keys(binding));
    const previous = snapshotAuthorizationCommand({...stored, authorizationRequestId: "database:binding",
      requestDigest: "database:binding", purpose: "contained-turn.credential-materialization-authorization/v1", schemaVersion: 1});
    const {authorizationRequestId: _id, requestDigest: _digest, purpose: _purpose, schemaVersion: _schema, ...projection} = previous;
    if (canonicalJson([projection.tenantId, projection.projectId, projection.provider, projection.scopeDigest]) !== canonicalJson(values)) {
      throw new Error("PA materialization binding owner mismatch");
    }
    validateAuthorityAdvance(projection, binding, projection.bindingRevision === binding.bindingRevision);
  }
  const result = await client.query(`UPDATE provider_access.materialization_owner SET binding=$6::jsonb,head_version=$7 WHERE ${where} AND head_version=$8`,
    [id, ...values, JSON.stringify(binding), String(expected + 1), String(expected)]);
  if (result.rowCount !== 1) {throw new Error("PA materialization publication acknowledgement mismatch");}
};

/** Trusted PA owner only. Never bind this control to caller dispatch expectations. */
export const createDispatchPostgresControl = (transactions: MaterializationPostgresTransactions) => Object.freeze({
  async publishHead(input: DispatchHeadPublication): Promise<DispatchHeadPublicationResult> {
    const data = exactDispatchDataRecord("dispatch publication", input,
      ["publicationRequestId", "expectedHeadVersion", "expectedMaterializationHeadVersion", "head"]);
    const head = snapshotDispatchBindingHead(detachedDispatchData("published head", data.head));
    const command = Object.freeze({head, publicationRequestId: snapshotDispatchId("publicationRequestId", data.publicationRequestId),
      expectedHeadVersion: expectedVersion(data.expectedHeadVersion as number),
      expectedMaterializationHeadVersion: expectedVersion(data.expectedMaterializationHeadVersion as number)});
    const owner = ownerSnapshot({provider: head.provider, scope: {tenantId: head.tenantId, projectId: head.projectId, scopeDigest: head.scopeDigest}});
    return transactions.write(async client => {
      await assertDispatchSchema(client);
      const current = await lockDispatchOwner(client, owner);
      const replay = await client.query("SELECT command,result FROM provider_access.dispatch_publication WHERE owner_id=$1 AND request_id=$2", [current.id, command.publicationRequestId]);
      if (replay.rows.length) {
        if (replay.rows.length !== 1 || canonicalJson(replay.rows[0]?.command) !== canonicalJson(command)) {throw new Error("PA publication request conflict");}
        const result = exactDispatchDataRecord("publication result", replay.rows[0]?.result, ["headVersion", "materializationHeadVersion"]);
        if (result.headVersion !== command.expectedHeadVersion + 1 || result.materializationHeadVersion !== command.expectedMaterializationHeadVersion + 1) {
          throw new Error("PA publication result mismatch");
        }
        return Object.freeze({headVersion: result.headVersion as number, materializationHeadVersion: result.materializationHeadVersion as number});
      }
      if (current.version !== command.expectedHeadVersion) {throw new Error("PA dispatch head CAS conflict");}
      validateDispatchHeadAdvance(current.head, head);
      if (current.head?.authorityHeadDigest !== head.authorityHeadDigest) {
        const inserted = await client.query("INSERT INTO provider_access.dispatch_head_identity VALUES ($1,$2)", [current.id, head.authorityHeadDigest]);
        if (inserted.rowCount !== 1) {throw new Error("PA head identity acknowledgement mismatch");}
      }
      // Same transaction, two exact CAS heads. Never silently overwrite an
      // independently changed PA materialization owner or any history table.
      await publishMaterialization(client, head, command.expectedMaterializationHeadVersion);
      const result = Object.freeze({headVersion: current.version + 1, materializationHeadVersion: command.expectedMaterializationHeadVersion + 1});
      const updated = await client.query("UPDATE provider_access.dispatch_owner SET head=$2::jsonb,version=$3 WHERE owner_id=$1 AND version=$4", [current.id, JSON.stringify(head), String(result.headVersion), String(current.version)]);
      if (updated.rowCount !== 1) {throw new Error("PA dispatch publication acknowledgement mismatch");}
      const saved = await client.query("INSERT INTO provider_access.dispatch_publication VALUES ($1,$2,$3::jsonb,$4::jsonb)",
        [current.id, command.publicationRequestId, JSON.stringify(command), JSON.stringify(result)]);
      if (saved.rowCount !== 1) {throw new Error("PA publication journal acknowledgement mismatch");}
      return result;
    });
  },
  async advanceControlTime(input: DispatchPostgresOwner, value: number): Promise<void> {
    const owner = ownerSnapshot(input); const next = snapshotDispatchControlTime(value);
    await transactions.write(async client => {
      await assertDispatchSchema(client);
      const current = await lockDispatchOwner(client, owner);
      if (next < current.controlTime) {throw new Error("PA control time cannot regress");}
      const updated = await client.query("UPDATE provider_access.dispatch_owner SET control_time=$2 WHERE owner_id=$1", [current.id, String(next)]);
      if (updated.rowCount !== 1) {throw new Error("PA control time acknowledgement mismatch");}
    });
  },
  async observeHead(input: DispatchPostgresOwner) {
    const owner = ownerSnapshot(input);
    return transactions.write(async client => {await assertDispatchSchema(client); const current = await lockDispatchOwner(client, owner);
      return Object.freeze({head: current.head, headVersion: current.version, controlTime: current.controlTime,
        materializationBinding: current.head ? materializationProjection(current.head) : undefined});});
  },
});
