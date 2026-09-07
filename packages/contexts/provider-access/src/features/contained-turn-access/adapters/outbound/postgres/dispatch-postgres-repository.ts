import type { DispatchConsumptionJournalEntry, DispatchConsumptionRepository, DispatchConsumptionTransaction, DispatchConsumptionTransactionSelector } from "../../../application/ports/outbound/dispatch-consumption-repository.js";
import { verifiedConsumption, verifiedJournalEntry, verifiedSettlement } from "../../../application/persistence-validation.js";
import { canonicalJson, snapshotDispatchConsumedReceipt, snapshotDispatchSettlementOutcome, snapshotDispatchDigest, type DispatchConsumedReceipt, type DispatchSettlementOutcome } from "../../../domain/dispatch-consumption.js";
import { canonicalDispatchJournalEntry, detachedDispatchData } from "../../dispatch-consumption-data.js";
import { createSha256DispatchConsumptionDigest } from "../sha256-dispatch-consumption-digest.js";
import { createDispatchPostgresControl } from "./dispatch-postgres-control.js";
import { assertCurrentMaterialization, lockDispatchOwner, ownerId, ownerSnapshot, selectorSnapshot, type DispatchPostgresOwner } from "./dispatch-postgres-data.js";
import { assertDispatchSchema, migrateDispatchSchema } from "./dispatch-postgres-schema.js";
import { migrateMaterializationSchema } from "./materialization-postgres-schema.js";
import { MaterializationPostgresTransactions, type MaterializationPostgresPool, type MaterializationPostgresTimeouts,
  type MaterializationPostgresClient } from "./materialization-postgres-transactions.js";

const digest = createSha256DispatchConsumptionDigest();
const read = async (client: MaterializationPostgresClient, sql: string, values: unknown[]): Promise<unknown | undefined> => {
  const {rows} = await client.query(sql, values);
  if (!rows.length) {return;}
  if (rows.length !== 1) {throw new Error("Invalid PA dispatch row count");}
  return detachedDispatchData("dispatch persisted record", rows[0]?.record);
};
const settlementKey = async (operationId: string, requestId: string): Promise<string> =>
  (await digest.digest(JSON.stringify([operationId, requestId]))).slice(7);
const insert = async (client: MaterializationPostgresClient, sql: string, values: unknown[]): Promise<void> => {
  if ((await client.query(sql, values)).rowCount !== 1) {throw new Error("PA dispatch insert acknowledgement mismatch");}
};

const transactionFor = (client: MaterializationPostgresClient, selector: DispatchConsumptionTransactionSelector,
  current: Awaited<ReturnType<typeof lockDispatchOwner>>, check: () => void): DispatchConsumptionTransaction => {
  const {id, head} = current;
  return Object.freeze({
    async controlTime() {check(); return current.controlTime;},
    async findBindingHead() {
      check();
      if (head && selector.kind === "consume") {await assertCurrentMaterialization(client, head);}
      return head;
    },
    async findGrantRequest() {
      check(); if (selector.kind !== "consume") {return;}
      const raw = await read(client, "SELECT record FROM provider_access.dispatch_grant WHERE owner_id=$1 AND request_id=$2", [id, selector.grantRequestId]);
      return raw === undefined ? undefined : verifiedJournalEntry(raw, selector, digest);
    },
    async findConsumption() {
      check(); if (selector.kind !== "settle") {return;}
      const raw = await read(client, "SELECT record FROM provider_access.dispatch_consumption WHERE owner_id=$1 AND consumption_digest=$2", [id, selector.consumptionDigest]);
      return raw === undefined ? undefined : verifiedConsumption(raw, selector, digest);
    },
    async findSettlement() {
      check(); if (selector.kind !== "settle") {return;}
      const raw = await read(client, "SELECT record FROM provider_access.dispatch_settlement WHERE owner_id=$1 AND request_key=$2 AND operation_id=$3 AND request_id=$4", [id, await settlementKey(selector.operationId, selector.settlementRequestId), selector.operationId, selector.settlementRequestId]);
      return raw === undefined ? undefined : verifiedSettlement(raw, selector, digest);
    },
    async findSettlementByConsumption() {
      check(); if (selector.kind !== "settle") {return;}
      const raw = await read(client, "SELECT record FROM provider_access.dispatch_settlement WHERE owner_id=$1 AND consumption_digest=$2", [id, selector.consumptionDigest]);
      return raw === undefined ? undefined : verifiedSettlement(raw, selector, digest, false);
    },
    async isBindingConsumed() {
      check(); if (!head) {return false;}
      const result = await client.query("SELECT 1 FROM provider_access.dispatch_consumption WHERE owner_id=$1 AND authority_digest=$2", [id, head.authorityHeadDigest]);
      return result.rows.length !== 0;
    },
    async markBindingConsumed(value: DispatchConsumedReceipt) {
      check(); if (selector.kind !== "consume" || !head) {throw new Error("No consumable PA head");}
      const receipt = snapshotDispatchConsumedReceipt(detachedDispatchData("consumption", value));
      await verifiedConsumption(receipt, {...selector, kind: "settle", consumptionDigest: receipt.consumptionDigest,
        expectedAuthorityHeadDigest: head.authorityHeadDigest, operationId: receipt.operationId, settlementRequestId: "database:validation"}, digest);
      const fields = ["acceptedAuthorityDigest", "accessRef", "bindingDigest", "bindingRevision", "claimBeforeControlTime",
        "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "opaqueOwnerEvidenceRef", "providerAccountRef", "providerRouteRef"] as const;
      if (receipt.grantRequestId !== selector.grantRequestId || receipt.authorityHeadDigestAtConsumption !== head.authorityHeadDigest ||
        fields.some(field => receipt[field] !== head[field]) || receipt.consumedAtControlTime !== current.controlTime ||
        head.revocation !== "active" || head.availability !== "available" ||
        current.controlTime >= head.claimBeforeControlTime || current.controlTime >= head.expiresAtControlTime) {
        throw new Error("PA consumption head mismatch");
      }
      await insert(client, "INSERT INTO provider_access.dispatch_consumption VALUES ($1,$2,$3,$4::jsonb)",
        [id, head.authorityHeadDigest, receipt.consumptionDigest, JSON.stringify(receipt)]);
    },
    async saveGrantRequest(value: DispatchConsumptionJournalEntry) {
      check(); if (selector.kind !== "consume") {throw new Error("Invalid PA grant selector");}
      const entry = await verifiedJournalEntry(canonicalDispatchJournalEntry(value), selector, digest);
      if (entry.outcome.kind === "consumed") {
        const stored = await read(client, "SELECT record FROM provider_access.dispatch_consumption WHERE owner_id=$1 AND consumption_digest=$2", [id, entry.outcome.receipt.consumptionDigest]);
        if (canonicalJson(stored) !== canonicalJson(entry.outcome.receipt)) {throw new Error("PA grant lacks exact consumption");}
      }
      await insert(client, "INSERT INTO provider_access.dispatch_grant VALUES ($1,$2,$3::jsonb)", [id, selector.grantRequestId, JSON.stringify(entry)]);
    },
    async saveSettlement(value: DispatchSettlementOutcome) {
      check(); if (selector.kind !== "settle") {throw new Error("Invalid PA settlement selector");}
      const outcome = await verifiedSettlement(snapshotDispatchSettlementOutcome(detachedDispatchData("settlement", value)), selector, digest);
      if (outcome.kind !== "settled") {throw new Error("Only durable successful settlements are stored by the existing protocol");}
      await insert(client, "INSERT INTO provider_access.dispatch_settlement VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
        [id, await settlementKey(selector.operationId, selector.settlementRequestId), selector.operationId, selector.settlementRequestId, selector.consumptionDigest, JSON.stringify(outcome)]);
    },
  });
};

/** Dispatch decisions remain in the existing use cases; SQL supplies serialization and durability. */
export const createPostgresDispatchConsumptionRepository = (pool: MaterializationPostgresPool,
  timeouts?: Partial<MaterializationPostgresTimeouts>) => {
  const transactions = new MaterializationPostgresTransactions(pool, timeouts);
  const repository: DispatchConsumptionRepository = Object.freeze({
    async transact<T>(input: DispatchConsumptionTransactionSelector, work: (transaction: DispatchConsumptionTransaction) => Promise<T>): Promise<T> {
      const selector = selectorSnapshot(input);
      return transactions.write(async (client, checkOpen) => {
        await assertDispatchSchema(client);
        const current = await lockDispatchOwner(client, ownerSnapshot({provider: selector.provider, scope: selector.scope}));
        let open = true;
        const check = () => {checkOpen(); if (!open) {throw new Error("PA dispatch callback is closed");}};
        try {return await work(transactionFor(client, selector, current, check));}
        finally {open = false;}
      });
    },
    async observeGrantRequest(raw: Parameters<DispatchConsumptionRepository["observeGrantRequest"]>[0]) {
      const input = detachedDispatchData("dispatch observation", raw) as typeof raw;
      const selector = selectorSnapshot({grantRequestId: input.grantRequestId, provider: input.provider, scope: input.scope, kind: "consume"});
      if (selector.kind !== "consume") {throw new Error("Invalid PA observation selector");}
      const owner = ownerSnapshot({provider: selector.provider, scope: selector.scope});
      return transactions.write(async client => {
        await assertDispatchSchema(client);
        const raw = await read(client, `SELECT g.record FROM provider_access.dispatch_grant g JOIN provider_access.dispatch_owner o USING(owner_id)
          WHERE owner_id=$1 AND o.owner=$2::jsonb AND g.request_id=$3`, [await ownerId(owner), JSON.stringify(owner), selector.grantRequestId]);
        return raw === undefined ? undefined : verifiedJournalEntry(raw, selector, digest);
      });
    },
  });
  return Object.freeze({repository, control: Object.freeze({...createDispatchPostgresControl(transactions),
    /** Historical debt survives head rotation and disposal. This is evidence, never fresh dispatch authority. */
    async observeConsumption(input: DispatchPostgresOwner, consumptionDigest: string) {
      const owner = ownerSnapshot(input); const consumptionId = snapshotDispatchDigest("consumptionDigest", consumptionDigest);
      return transactions.write(async client => {
        await assertDispatchSchema(client);
        const id = await ownerId(owner);
        const raw = await read(client, `SELECT c.record FROM provider_access.dispatch_consumption c JOIN provider_access.dispatch_owner o USING(owner_id)
          WHERE owner_id=$1 AND o.owner=$2::jsonb AND c.consumption_digest=$3`, [id, JSON.stringify(owner), consumptionId]);
        if (raw === undefined) {return;}
        const candidate = snapshotDispatchConsumedReceipt(raw);
        const selector = {...owner, kind: "settle" as const, consumptionDigest: consumptionId,
          operationId: candidate.operationId, expectedAuthorityHeadDigest: candidate.authorityHeadDigestAtConsumption,
          settlementRequestId: "database:historical-observation"};
        const receipt = await verifiedConsumption(candidate, selector, digest);
        const settlement = await read(client, "SELECT record FROM provider_access.dispatch_settlement WHERE owner_id=$1 AND consumption_digest=$2", [id, consumptionId]);
        if (settlement === undefined) {return Object.freeze({receipt, state: "consumed_pending" as const});}
        const outcome = await verifiedSettlement(settlement, selector, digest, false);
        if (outcome.kind !== "settled") {throw new Error("Invalid PA settlement evidence");}
        return Object.freeze({receipt, state: outcome.receipt.disposition, settlement: outcome.receipt});
      });
    },
  }),
    async migrate() {await migrateMaterializationSchema(transactions); await migrateDispatchSchema(transactions);},
    dispose: () => {transactions.dispose();},
  });
};
