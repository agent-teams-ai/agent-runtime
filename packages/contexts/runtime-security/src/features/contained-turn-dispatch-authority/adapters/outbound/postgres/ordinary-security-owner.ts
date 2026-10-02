import {createHash} from "node:crypto";
import type {OrdinarySecurityGrantStore, OrdinarySecurityInsertResult, OrdinarySecurityStoreSettleResult} from "../../../application/ports/ordinary-security-grant-store.js";
import {captureOrdinarySecurityPolicy, captureOrdinarySecurityScope, decideOrdinarySecuritySettle, ordinarySecurityDenied, ordinarySecurityKeyOf, parseOrdinarySecurityRecord, serializeOrdinarySecurityRecord, type OrdinarySecurityGrantRecord, type OrdinarySecurityKey, type OrdinarySecurityPolicy, type OrdinarySecurityScope, type OrdinarySecuritySettlement} from "../../../domain/ordinary-security-policy.js";
import type {DispatchPgPool, DispatchPgTransaction} from "./transaction.js";
import {createOrdinarySecurityTransactions} from "./ordinary-security-transactions.js";
export interface OrdinarySecurityOwnerOptions {readonly pool: DispatchPgPool; readonly allowedScope: OrdinarySecurityScope; readonly policy: OrdinarySecurityPolicy}
export interface PostgresOrdinarySecurityGrantStore extends OrdinarySecurityGrantStore {
  migrate(): Promise<void>;
  /** Aborts in-flight transactions and refuses new ones; never ends the borrowed pool. */
  close(): Promise<void>;
}
/** Canonical sha256 over the JSON text of a value; over a string this is the digest of the exact stored `state` text. */
export const ordinarySecurityDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const table = "runtime_security_ordinary_grants_v1";
const values = (key: OrdinarySecurityKey): unknown[] => [key.tenantId, key.projectId, key.operationId];

/** Postgres grant store: one row per operation, `state` text digested exactly as stored. It never retries and never reads back. */
export const createPostgresOrdinarySecurityGrantStore = (options: OrdinarySecurityOwnerOptions): PostgresOrdinarySecurityGrantStore => {
  const scope = captureOrdinarySecurityScope(options.allowedScope); const policy = captureOrdinarySecurityPolicy(options.policy);
  const transactions = createOrdinarySecurityTransactions(options.pool);
  const read = async (tx: DispatchPgTransaction, key: OrdinarySecurityKey, locked = false): Promise<OrdinarySecurityGrantRecord | undefined> => {
    const row = (await tx.query(`SELECT state, state_digest FROM ${table} WHERE tenant_id=$1 AND project_id=$2 AND operation_id=$3${locked ? " FOR UPDATE" : ""}`, values(key))).rows[0];
    if (row === undefined) {return undefined;}
    if (typeof row.state !== "string" || row.state_digest !== ordinarySecurityDigest(row.state)) {throw ordinarySecurityDenied();}
    const record = parseOrdinarySecurityRecord(row.state, scope, policy, ordinarySecurityDigest);
    if (record.input.scope.tenantId !== key.tenantId || record.input.scope.projectId !== key.projectId || record.input.operationId !== key.operationId) {throw ordinarySecurityDenied();}
    return record;
  };
  return Object.freeze({
    async migrate() {await transactions.run(async tx => {await tx.query(`CREATE TABLE IF NOT EXISTS ${table} (tenant_id text NOT NULL,project_id text NOT NULL,operation_id text NOT NULL,state text NOT NULL,state_digest text NOT NULL,PRIMARY KEY(tenant_id,project_id,operation_id))`);});},
    close: () => transactions.close(),
    async insertIfAbsent(record: OrdinarySecurityGrantRecord): Promise<OrdinarySecurityInsertResult> {
      const state = serializeOrdinarySecurityRecord(record); const key = ordinarySecurityKeyOf(record.input);
      parseOrdinarySecurityRecord(state, scope, policy, ordinarySecurityDigest);
      return transactions.run(async tx => {
        const inserted = await tx.query(`INSERT INTO ${table}(tenant_id,project_id,operation_id,state,state_digest) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [...values(key), state, ordinarySecurityDigest(state)]);
        const stored = await read(tx, key); if (stored === undefined) {throw ordinarySecurityDenied();}
        return {kind: inserted.rowCount === 1 ? "inserted" : "existing", record: stored};
      });
    },
    async observe(key: OrdinarySecurityKey): Promise<OrdinarySecurityGrantRecord | undefined> {return transactions.run(tx => read(tx, key));},
    async settle(key: OrdinarySecurityKey, settlement: OrdinarySecuritySettlement): Promise<OrdinarySecurityStoreSettleResult> {
      return transactions.run(async (tx): Promise<OrdinarySecurityStoreSettleResult> => {
        const prior = await read(tx, key, true); if (prior === undefined) {return {kind: "missing"};}
        const decision = decideOrdinarySecuritySettle(prior, settlement, ordinarySecurityDigest);
        if (decision.kind === "conflict") {return decision;}
        if (decision.kind === "already") {return {kind: "already", settlement: decision.settlement};}
        const state = serializeOrdinarySecurityRecord({...prior, settlement: decision.settlement});
        const result = await tx.query(`UPDATE ${table} SET state=$4,state_digest=$5 WHERE tenant_id=$1 AND project_id=$2 AND operation_id=$3`, [...values(key), state, ordinarySecurityDigest(state)]);
        if (result.rowCount !== 1) {throw ordinarySecurityDenied();}
        return {kind: "settled", settlement: decision.settlement};
      });
    },
  });
};
