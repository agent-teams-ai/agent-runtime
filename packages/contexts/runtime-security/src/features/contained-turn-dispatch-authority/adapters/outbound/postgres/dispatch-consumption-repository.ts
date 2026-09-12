import type { DispatchDigest } from "../../../application/ports/outbound/dispatch-digest.js";
import type { DispatchConsumptionRepository, PersistedConsumption } from
  "../../../application/ports/outbound/dispatch-consumption-repository.js";
import type { DispatchAuthorityHead } from "../../../domain/dispatch-authority-head.js";
import { snapshotExactDispatchVariant } from "../../../domain/dispatch-exact-record.js";
import { mapConsumeResultToV1, mapSettlementResultToV1 } from
  "../../../application/contained-turn-dispatch-authority-v1-result-mappers.js";
import { isNodeDispatchProxy } from "../../node-dispatch-proxy.js";
import { dispatchSchemaV1 } from "./schema.js";
import { createDispatchPgTransactions } from "./transaction.js";
import type { DispatchPgDeadlines, DispatchPgPool, DispatchPgTransaction } from "./transaction.js";
import { bindConsumedRequest, captureConsume, captureHead, captureOperation, captureSettlement,
  consumeFact, consumptionRecord, exact, headVersion, invalid, lockId, matchesGrant,
  matchesOperation, operationId, operationSelector, parseFact, requestId, settlementFact,
  settlementId, serializeFact } from "./records.js";
import type { ConsumeKey, OperationKey, SettlementKey } from "./records.js";

type Transaction = DispatchPgTransaction;
type Head = { readonly headVersion: string; readonly authority?: DispatchAuthorityHead };
type HeadChange = { readonly status: "applied" | "conflict"; readonly headVersion: string };
const schema = "runtime_security_dispatch_v1";
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const variant = (value: unknown, names: readonly (readonly string[])[]) => {
  if (isNodeDispatchProxy(value)) {return invalid();}
  return snapshotExactDispatchVariant(value, names) ?? invalid();
};
const oneOrNone = (rows: Record<string, unknown>[]) => {
  if (rows.length > 1) {return invalid();}
  return rows[0];
};
const insertOne = async (tx: Transaction, sql: string, values: unknown[]) => {
  const result = await tx.query(sql, values);
  if (result.rowCount !== 1) {invalid();}
};
const version = async (tx: Transaction) => {
  const { rows } = await tx.query(`SELECT version FROM ${schema}.schema_version WHERE singleton`);
  if (rows.length !== 1 || rows[0]?.version !== 1) {invalid();}
};
const lock = async (tx: Transaction, key: OperationKey) => {
  await version(tx);
  // One operation lock covers ALL its absent/current heads, grant requests and
  // settlement requests. Hash collisions only over-serialize; selectors still bind reads.
  await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockId(key)]);
};
const readHead = async (tx: Transaction, key: OperationKey): Promise<Head> => {
  const row = oneOrNone((await tx.query(`SELECT operation_key, selector::text, head_version::text,
    authority::text FROM ${schema}.authority_heads WHERE operation_key = $1 FOR UPDATE`,
  [operationId(key)])).rows);
  if (row === undefined) {return Object.freeze({ headVersion: "0" });}
  const fields = exact(row, ["operation_key", "selector", "head_version", "authority"]);
  if (fields.operation_key !== operationId(key) ||
    !matchesOperation(captureOperation(parseFact(fields.selector)), key)) {return invalid();}
  const currentVersion = headVersion(fields.head_version);
  if (currentVersion === "0") {return invalid();}
  if (fields.authority === null) {return Object.freeze({ headVersion: currentVersion });}
  const authority = captureHead(parseFact(fields.authority));
  if (!matchesOperation(authority, key)) {return invalid();}
  return Object.freeze({ headVersion: currentVersion, authority });
};

const assertPriorSettlement = (
  prior: Awaited<ReturnType<ReturnType<typeof createRecordReaders>["readSettlement"]>>,
  consumption: PersistedConsumption | undefined,
) => {
  if (prior?.outcome.status === "settled" && (consumption === undefined ||
    !same(prior.outcome.receipt, consumption.settlement))) {invalid();}
};
const assertPendingSettlement = (settle: unknown, consumption: PersistedConsumption | undefined) => {
  if (settle && (consumption === undefined || consumption.lifecycleState !== "consumed_pending" ||
    consumption.settlement !== undefined)) {invalid();}
};

const createRecordReaders = (digest: DispatchDigest["digestCanonical"]) => {
  const readAppliedSettlement = async (tx: Transaction, key: OperationKey) => {
    const { rows } = await tx.query(`SELECT request_key, operation_key, applies, fact::text
      FROM ${schema}.settlement_requests WHERE operation_key = $1`, [operationId(key)]);
    let applied: ReturnType<typeof settlementFact> | null = null;
    for (const row of rows) {
      const fields = exact(row, ["request_key", "operation_key", "applies", "fact"]);
      const parsed = exact(parseFact(fields.fact), ["scope", "providerId", "authorityGeneration",
        "operationId", "grantRequestId", "settlementRequestId", "consumptionDigest", "settlementDigest", "outcome"]);
      const selector = captureConsume({ ...operationSelector(key), grantRequestId: parsed.grantRequestId });
      const fact = settlementFact(parsed, selector, digest);
      if (fields.request_key !== settlementId(fact) || fields.operation_key !== operationId(key) ||
        fields.applies !== (fact.outcome.status === "settled")) {return invalid();}
      if (fact.outcome.status === "settled") {
        if (applied !== null) {return invalid();}
        applied = fact;
      }
    }
    return applied;
  };
  const readConsumption = async (tx: Transaction, key: OperationKey): Promise<PersistedConsumption | undefined> => {
    const row = oneOrNone((await tx.query(`SELECT c.operation_key, c.request_key, c.receipt::text,
      r.fact::text AS consume_fact FROM ${schema}.consumptions c
      LEFT JOIN ${schema}.consume_requests r ON r.request_key = c.request_key AND r.operation_key = c.operation_key
      WHERE c.operation_key = $1`, [operationId(key)])).rows);
    if (row === undefined) {return;}
    const fields = exact(row, ["operation_key", "request_key", "receipt", "consume_fact"]);
    if (fields.operation_key !== operationId(key)) {return invalid();}
    const settled = await readAppliedSettlement(tx, key);
    const consumption = consumptionRecord(parseFact(fields.receipt), settled, key, digest);
    if (fields.request_key !== requestId(consumption.receipt)) {return invalid();}
    const request = consumeFact(parseFact(fields.consume_fact), consumption.receipt, digest);
    if (request.outcome.status !== "consumed") {return invalid();}
    bindConsumedRequest(request, consumption);
    return consumption;
  };
  const readRequest = async (tx: Transaction, key: ConsumeKey) => {
    const row = oneOrNone((await tx.query(`SELECT request_key, operation_key, fact::text
      FROM ${schema}.consume_requests WHERE request_key = $1`, [requestId(key)])).rows);
    if (row === undefined) {return;}
    const fields = exact(row, ["request_key", "operation_key", "fact"]);
    if (fields.request_key !== requestId(key) || fields.operation_key !== operationId(key)) {return invalid();}
    return consumeFact(parseFact(fields.fact), key, digest);
  };
  const readSettlement = async (tx: Transaction, key: SettlementKey) => {
    const row = oneOrNone((await tx.query(`SELECT request_key, operation_key, applies, fact::text
      FROM ${schema}.settlement_requests WHERE request_key = $1`, [settlementId(key)])).rows);
    if (row === undefined) {return;}
    const fields = exact(row, ["request_key", "operation_key", "applies", "fact"]);
    const fact = settlementFact(parseFact(fields.fact), key, digest, key.settlementRequestId);
    if (fields.request_key !== settlementId(key) || fields.operation_key !== operationId(key) ||
      fields.applies !== (fact.outcome.status === "settled")) {return invalid();}
    return fact;
  };
  return { readConsumption, readRequest, readSettlement };
};

export interface PostgresDispatchConsumptionRepository extends DispatchConsumptionRepository {
  migrate(): Promise<void>;
  readAuthority(key: OperationKey): Promise<Head>;
  replaceAuthority(head: DispatchAuthorityHead, expectedHeadVersion: string): Promise<HeadChange>;
  revokeAuthority(key: OperationKey, expectedHeadVersion: string): Promise<HeadChange>;
  close(): void;
}

/** Private owner adapter. The caller supplies the SAME digest used by the RS factory.
 * Construction is inert. Migrate and head control are explicit trusted composition
 * actions. Version "0" means no head row; revoking absence persists a CAS tombstone.
 * All runtime calls use one RS-owned transaction; there are no automatic retries.
 */
export const createPostgresDispatchConsumptionRepository = (options: DispatchPgDeadlines & {
  readonly pool: DispatchPgPool; readonly digest: DispatchDigest;
}): PostgresDispatchConsumptionRepository => {
  const transactions = createDispatchPgTransactions(options.pool, options);
  const digest = options.digest.digestCanonical.bind(options.digest);
  const { readConsumption, readRequest, readSettlement } = createRecordReaders(digest);
  const changeHead = async (key: OperationKey, expected: string,
    replace?: DispatchAuthorityHead): Promise<HeadChange> => transactions.run(async tx => {
    await lock(tx, key);
    const current = await readHead(tx, key);
    if (current.headVersion !== expected) {
      return Object.freeze({ status: "conflict", headVersion: current.headVersion });
    }
    const next = headVersion((BigInt(current.headVersion) + 1n).toString());
    const authority = replace ?? (current.authority === undefined ? null :
      captureHead({ ...current.authority, revoked: true }));
    const values = [operationId(key), serializeFact(operationSelector(key)), next,
      authority === null ? null : serializeFact(authority)];
    const result = current.headVersion === "0"
      ? await tx.query(`INSERT INTO ${schema}.authority_heads
          (operation_key, selector, head_version, authority) VALUES ($1, $2, $3::bigint, $4)`, values)
      : await tx.query(`UPDATE ${schema}.authority_heads SET head_version = $3::bigint, authority = $4
          WHERE operation_key = $1 AND selector = $2 AND head_version = $5::bigint`, [...values, expected]);
    if (result.rowCount !== 1) {return invalid();}
    return Object.freeze({ status: "applied", headVersion: next });
  });
  const repository: PostgresDispatchConsumptionRepository = {
    close: transactions.close,
    async migrate() {
      await transactions.run(async tx => {
        await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", ["-693137001"]);
        await tx.query(dispatchSchemaV1);
        await version(tx);
      });
    },
    async readAuthority(value) {
      const key = captureOperation(value);
      return transactions.run(async tx => {await lock(tx, key); return readHead(tx, key);});
    },
    async replaceAuthority(value, expected) {
      const head = captureHead(value);
      return changeHead(operationSelector(head), headVersion(expected), head);
    },
    async revokeAuthority(value, expected) {
      return changeHead(captureOperation(value), headVersion(expected));
    },
    async consumeAtomically(value, decide) {
      const key = captureConsume(value);
      return transactions.run(async tx => {
        await lock(tx, key);
        const { authority } = await readHead(tx, key);
        const priorRequest = await readRequest(tx, key);
        const consumption = await readConsumption(tx, key);
        bindConsumedRequest(priorRequest, consumption);
        tx.assertOpen();
        const raw = decide(Object.freeze({ ...(authority === undefined ? {} : { authority }),
          ...(priorRequest === undefined ? {} : { priorRequest }),
          ...(consumption === undefined ? {} : { consumption }) }));
        tx.assertOpen();
        const fields = variant(raw, [["outcome"], ["outcome", "persistRequest"],
          ["outcome", "persistRequest", "persistConsumption"]]);
        const outcome = mapConsumeResultToV1(fields.outcome as typeof raw.outcome, digest);
        if (!("persistRequest" in fields)) {
          if (["consumed", "prevented", "not_found"].includes(outcome.status) &&
            (priorRequest === undefined || !same(priorRequest.outcome, outcome))) {return invalid();}
          return outcome;
        }
        if (priorRequest !== undefined) {return invalid();}
        const persistence = exact(fields.persistRequest, ["requestDigest", "requestFingerprint", "outcome"]);
        const fact = consumeFact({ ...key, ...persistence }, key, digest);
        if (!same(fact.outcome, outcome)) {return invalid();}
        let receipt;
        if ("persistConsumption" in fields) {
          const pending = exact(fields.persistConsumption, ["receipt", "lifecycleState"]);
          const record = consumptionRecord(pending.receipt, null, key, digest);
          if (pending.lifecycleState !== "consumed_pending" || consumption !== undefined ||
            fact.outcome.status !== "consumed" || !matchesGrant(record.receipt, key)) {return invalid();}
          bindConsumedRequest(fact, record);
          receipt = record.receipt;
        }
        if ((fact.outcome.status === "consumed") !== (receipt !== undefined)) {return invalid();}
        await insertOne(tx, `INSERT INTO ${schema}.consume_requests (request_key, operation_key, fact)
          VALUES ($1, $2, $3)`, [requestId(key), operationId(key), serializeFact(fact)]);
        if (receipt !== undefined) {
          await insertOne(tx, `INSERT INTO ${schema}.consumptions (operation_key, request_key, receipt)
            VALUES ($1, $2, $3)`, [operationId(key), requestId(key), serializeFact(receipt)]);
        }
        return outcome;
      });
    },
    async observe(value) {
      const key = captureConsume(value);
      return transactions.run(async tx => {
        await lock(tx, key);
        const request = await readRequest(tx, key);
        if (request === undefined) {return;}
        const consumption = await readConsumption(tx, key);
        bindConsumedRequest(request, consumption);
        return Object.freeze({ ...request, ...(consumption === undefined ? {} : { consumption }) });
      });
    },
    async settleAtomically(value, decide) {
      const key = captureSettlement(value);
      return transactions.run(async tx => {
        await lock(tx, key);
        const priorRequest = await readSettlement(tx, key);
        const record = await readConsumption(tx, key);
        const consumption = record !== undefined && matchesGrant(record.receipt, key) &&
          record.receipt.consumptionDigest === key.consumptionDigest ? record : undefined;
        assertPriorSettlement(priorRequest, consumption);
        tx.assertOpen();
        const raw = decide(Object.freeze({ ...(priorRequest === undefined ? {} : { priorRequest }),
          ...(consumption === undefined ? {} : { consumption }) }));
        tx.assertOpen();
        const fields = variant(raw, [["result"], ["result", "persist"]]);
        const result = mapSettlementResultToV1(fields.result as typeof raw.result);
        if (!("persist" in fields)) {
          if ((result.status === "settled" || result.status === "not_found") &&
            (priorRequest === undefined || !same(priorRequest.outcome, result))) {return invalid();}
          return result;
        }
        const persistence = exact(fields.persist, ["settlementDigest", "settle"]);
        if (priorRequest !== undefined || (result.status !== "settled" && result.status !== "not_found") ||
          persistence.settle !== (result.status === "settled")) {return invalid();}
        assertPendingSettlement(persistence.settle, consumption);
        const fact = settlementFact({ ...key, settlementDigest: persistence.settlementDigest,
          outcome: result }, key, digest, key.settlementRequestId);
        if (result.status === "settled" && result.receipt.consumptionDigest !== key.consumptionDigest) {return invalid();}
        await insertOne(tx, `INSERT INTO ${schema}.settlement_requests (request_key, operation_key, applies, fact)
          VALUES ($1, $2, $3, $4)`,
        [settlementId(key), operationId(key), persistence.settle, serializeFact(fact)]);
        return result;
      });
    },
  };
  return Object.freeze(repository);
};
