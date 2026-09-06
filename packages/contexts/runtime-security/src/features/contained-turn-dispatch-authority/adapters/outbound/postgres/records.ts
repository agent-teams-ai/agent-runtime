import { createHash } from "node:crypto";
import { isNodeDispatchProxy } from "../../node-dispatch-proxy.js";
import { snapshotExactDispatchRecord } from "../../../domain/dispatch-exact-record.js";
import { sameScope, snapshotDispatchAuthorityHead } from "../../../domain/dispatch-authority-head.js";
import type { DispatchAuthorityHead } from "../../../domain/dispatch-authority-head.js";
import { isBoundedDispatchIdentifier, sameConsumptionReceipt } from
  "../../../application/dispatch-consumption-models.js";
import { mapConsumeResultToV1, mapSettlementResultToV1 } from
  "../../../application/contained-turn-dispatch-authority-v1-mappers.js";
import type {
  ConsumeTransactionSnapshot, DispatchConsumptionRepository, PersistedConsumption,
  SettlementTransactionSnapshot,
} from "../../../application/ports/outbound/dispatch-consumption-repository.js";

export type ConsumeKey = Parameters<DispatchConsumptionRepository["consumeAtomically"]>[0];
export type SettlementKey = Parameters<DispatchConsumptionRepository["settleAtomically"]>[0];
export type OperationKey = Omit<ConsumeKey, "grantRequestId">;
export type ConsumeFact = NonNullable<ConsumeTransactionSnapshot["priorRequest"]>;
export type SettlementFact = NonNullable<SettlementTransactionSnapshot["priorRequest"]>;
type Digest = (canonical: string) => string;

export const invalid = (): never => {throw new TypeError("invalid persisted dispatch fact");};
export const exact = <Name extends string>(value: unknown, names: readonly Name[]) => {
  if (isNodeDispatchProxy(value)) {return invalid();}
  return snapshotExactDispatchRecord(value, names) ?? invalid();
};
export const operationSelector = (value: OperationKey): OperationKey => {
  const scope = exact(value.scope, ["tenantId", "projectId", "scopeDigest"]);
  if (![scope.tenantId, scope.projectId, scope.scopeDigest, value.providerId,
    value.authorityGeneration, value.operationId].every(isBoundedDispatchIdentifier)) {return invalid();}
  return Object.freeze({ scope: Object.freeze({ tenantId: scope.tenantId as string,
    projectId: scope.projectId as string, scopeDigest: scope.scopeDigest as string }),
  providerId: value.providerId, authorityGeneration: value.authorityGeneration,
  operationId: value.operationId });
};
const operationNames = ["scope", "providerId", "authorityGeneration", "operationId"] as const;
export const captureOperation = (value: unknown): OperationKey =>
  operationSelector(exact(value, operationNames) as unknown as OperationKey);
export const captureConsume = (value: unknown): ConsumeKey => {
  const fields = exact(value, [...operationNames, "grantRequestId"]);
  if (!isBoundedDispatchIdentifier(fields.grantRequestId)) {return invalid();}
  return Object.freeze({ ...operationSelector(fields as unknown as OperationKey),
    grantRequestId: fields.grantRequestId });
};
export const captureSettlement = (value: unknown): SettlementKey => {
  const fields = exact(value, [...operationNames, "grantRequestId", "settlementRequestId",
    "consumptionDigest"]);
  if (![fields.grantRequestId, fields.settlementRequestId, fields.consumptionDigest]
    .every(isBoundedDispatchIdentifier)) {return invalid();}
  return Object.freeze({ ...operationSelector(fields as unknown as OperationKey),
    grantRequestId: fields.grantRequestId as string,
    settlementRequestId: fields.settlementRequestId as string,
    consumptionDigest: fields.consumptionDigest as string });
};
export const captureHead = (value: unknown): DispatchAuthorityHead => {
  if (isNodeDispatchProxy(value)) {return invalid();}
  const scope = typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, "scope") : undefined;
  if (scope !== undefined && "value" in scope && isNodeDispatchProxy(scope.value)) {return invalid();}
  return snapshotDispatchAuthorityHead(value) ?? invalid();
};
export const matchesOperation = (fact: OperationKey, key: OperationKey): boolean =>
  sameScope(fact.scope, key.scope) && fact.providerId === key.providerId &&
  fact.authorityGeneration === key.authorityGeneration && fact.operationId === key.operationId;
export const matchesGrant = (fact: ConsumeKey, key: ConsumeKey): boolean =>
  matchesOperation(fact, key) && fact.grantRequestId === key.grantRequestId;

// Hashes bound index width, including maximal Unicode identifiers. The full selectors
// remain in every fact and are checked on read: a hash collision fails closed.
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const parts = (key: OperationKey) => [key.scope.tenantId, key.scope.projectId,
  key.scope.scopeDigest, key.providerId, key.authorityGeneration, key.operationId];
export const operationId = (key: OperationKey) => hash(["rs-dispatch-operation/v1", ...parts(key)]);
export const requestId = (key: ConsumeKey) =>
  hash(["rs-dispatch-consume/v1", ...parts(key), key.grantRequestId]);
export const settlementId = (key: Pick<SettlementKey, keyof ConsumeKey | "settlementRequestId">) =>
  hash(["rs-dispatch-settle/v1", ...parts(key), key.grantRequestId, key.settlementRequestId]);
export const lockId = (key: OperationKey) =>
  BigInt.asIntN(64, BigInt(`0x${operationId(key).slice(0, 16)}`)).toString();
export const parseFact = (value: unknown): unknown => {
  if (typeof value !== "string" || value.length > 65_536) {return invalid();}
  return JSON.parse(value) as unknown;
};
export const headVersion = (value: unknown): string => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/u.test(value) ||
    BigInt(value) > 9_223_372_036_854_775_807n) {return invalid();}
  return value;
};

export const consumeFact = (value: unknown, key: ConsumeKey, digest: Digest): ConsumeFact => {
  const fields = exact(value, [...operationNames, "grantRequestId", "requestDigest",
    "requestFingerprint", "outcome"]);
  const identity = { ...operationSelector(fields as unknown as OperationKey),
    grantRequestId: fields.grantRequestId as string };
  if (!matchesGrant(identity, key) ||
    ![fields.requestDigest, fields.requestFingerprint].every(isBoundedDispatchIdentifier)) {return invalid();}
  const outcome = mapConsumeResultToV1(fields.outcome as ConsumeFact["outcome"], digest);
  if (outcome.status === "conflict" || outcome.status === "indeterminate") {return invalid();}
  if (outcome.status === "consumed" && (!matchesGrant(outcome.receipt, key) ||
    outcome.receipt.requestDigest !== fields.requestDigest)) {return invalid();}
  if (outcome.status === "prevented" && (!sameScope(outcome.evidence.scope, key.scope) ||
    outcome.evidence.operationId !== key.operationId || outcome.evidence.grantRequestId !== key.grantRequestId ||
    outcome.evidence.requestDigest !== fields.requestDigest)) {return invalid();}
  return Object.freeze({ ...identity, requestDigest: fields.requestDigest as string,
    requestFingerprint: fields.requestFingerprint as string, outcome });
};
export const settlementFact = (value: unknown, key: ConsumeKey,
  expectedRequestId?: string): SettlementFact => {
  const fields = exact(value, [...operationNames, "grantRequestId", "settlementRequestId",
    "consumptionDigest", "settlementDigest", "outcome"]);
  const identity = { ...operationSelector(fields as unknown as OperationKey),
    grantRequestId: fields.grantRequestId as string };
  if (!matchesGrant(identity, key) || ![fields.settlementRequestId, fields.consumptionDigest,
    fields.settlementDigest].every(isBoundedDispatchIdentifier) ||
    (expectedRequestId !== undefined && fields.settlementRequestId !== expectedRequestId)) {return invalid();}
  const outcome = mapSettlementResultToV1(fields.outcome as SettlementFact["outcome"]);
  if (outcome.status !== "settled" && outcome.status !== "not_found") {return invalid();}
  if (outcome.status === "settled" && (outcome.receipt.providerId !== key.providerId ||
    outcome.receipt.authorityGeneration !== key.authorityGeneration ||
    outcome.receipt.settlementRequestId !== fields.settlementRequestId ||
    outcome.receipt.consumptionDigest !== fields.consumptionDigest)) {return invalid();}
  return Object.freeze({ ...identity, settlementRequestId: fields.settlementRequestId as string,
    consumptionDigest: fields.consumptionDigest as string,
    settlementDigest: fields.settlementDigest as string, outcome });
};
export const consumptionRecord = (receiptValue: unknown, settlementValue: unknown,
  key: OperationKey, digest: Digest): PersistedConsumption => {
  const result = mapConsumeResultToV1({ status: "consumed", receipt: receiptValue as never }, digest);
  if (result.status !== "consumed" || !matchesOperation(result.receipt, key)) {return invalid();}
  if (settlementValue === null) {
    return Object.freeze({ receipt: result.receipt, lifecycleState: "consumed_pending" });
  }
  const fact = settlementFact(settlementValue, result.receipt);
  if (fact.outcome.status !== "settled" ||
    fact.consumptionDigest !== result.receipt.consumptionDigest) {return invalid();}
  return Object.freeze({ receipt: result.receipt, lifecycleState: fact.outcome.receipt.disposition,
    settlement: fact.outcome.receipt });
};
export const bindConsumedRequest = (fact: ConsumeFact | undefined,
  consumption: PersistedConsumption | undefined): void => {
  if (fact?.outcome.status === "consumed" && (consumption === undefined ||
    !sameConsumptionReceipt(fact.outcome.receipt, consumption.receipt))) {invalid();}
};
