import {
  isBoundedDispatchIdentifier,
  isSettlementDisposition,
} from "../../application/dispatch-consumption-models.js";
import { isNodeDispatchProxy } from "../node-dispatch-proxy.js";
import type {
  ConsumeTransactionDecision,
  ConsumeTransactionSnapshot,
  DispatchConsumptionRepository,
  ObservedConsumptionRecord,
  PersistedConsumption,
  SettlementTransactionDecision,
  SettlementTransactionSnapshot,
} from "../../application/ports/outbound/dispatch-consumption-repository.js";
import type { DispatchAuthorityScope } from "../../domain/dispatch-authority-head.js";
import {
  snapshotExactDispatchRecord, snapshotExactDispatchVariant,
} from "../../domain/dispatch-exact-record.js";
import type { InMemoryDispatchConsumptionState } from "./in-memory-dispatch-consumption-state.js";
import {
  consumptionKey, operationKey, requestKey, settlementRequestKey,
} from "./in-memory-dispatch-consumption-state.js";

const snapshotScope = (value: unknown): DispatchAuthorityScope | undefined => {
  if (isNodeDispatchProxy(value)) {return undefined;}
  const fields = snapshotExactDispatchRecord(value, ["tenantId", "projectId", "scopeDigest"]);
  if (fields === undefined || ![fields.tenantId, fields.projectId, fields.scopeDigest]
    .every(isBoundedDispatchIdentifier)) {return undefined;}
  return Object.freeze({ tenantId: fields.tenantId as string, projectId: fields.projectId as string,
    scopeDigest: fields.scopeDigest as string });
};

const snapshotKey = (value: unknown, settlement: boolean) => {
  if (isNodeDispatchProxy(value)) {return;}
  const names = settlement
    ? ["scope", "providerId", "authorityGeneration", "operationId", "grantRequestId",
      "settlementRequestId", "consumptionDigest"] as const
    : ["scope", "providerId", "authorityGeneration", "operationId", "grantRequestId"] as const;
  const fields = snapshotExactDispatchRecord(value, names);
  const scope = fields === undefined ? undefined : snapshotScope(fields.scope);
  if (fields === undefined || scope === undefined || names.slice(1)
    .some(name => !isBoundedDispatchIdentifier(fields[name]))) {return;}
  return Object.freeze({ ...fields, scope }) as Parameters<
    DispatchConsumptionRepository["settleAtomically"]
  >[0];
};

const validSettlement = (
  settlement: unknown,
  key: { readonly settlementRequestId: string; readonly consumptionDigest: string;
    readonly providerId: string; readonly authorityGeneration: string },
): Extract<
  SettlementTransactionDecision["result"],
  { readonly status: "settled" }
>["receipt"] | undefined => {
  const fields = snapshotExactDispatchRecord(settlement, ["contractVersion", "settlementRequestId",
    "providerId", "authorityGeneration", "consumptionDigest", "disposition",
    "settledAtControlTime"]);
  if (fields === undefined || fields.contractVersion !== "contained-turn-dispatch-settlement/v1" ||
      fields.settlementRequestId !== key.settlementRequestId ||
      fields.consumptionDigest !== key.consumptionDigest ||
      fields.providerId !== key.providerId ||
      fields.authorityGeneration !== key.authorityGeneration ||
      !isSettlementDisposition(fields.disposition) || !Number.isSafeInteger(fields.settledAtControlTime) ||
      (fields.settledAtControlTime as number) < 0) {return undefined;}
  return Object.freeze({ contractVersion: fields.contractVersion,
    settlementRequestId: fields.settlementRequestId, providerId: fields.providerId,
    authorityGeneration: fields.authorityGeneration, consumptionDigest: fields.consumptionDigest,
    disposition: fields.disposition, settledAtControlTime: fields.settledAtControlTime as number });
};

const validSettlementResult = (
  result: unknown,
  key: { readonly settlementRequestId: string; readonly consumptionDigest: string;
    readonly providerId: string; readonly authorityGeneration: string },
): SettlementTransactionDecision["result"] | undefined => {
  const variant = snapshotExactDispatchVariant(result,
    [["status"], ["status", "receipt"], ["status", "reason"]]);
  if (variant?.status === "invalid_request" || variant?.status === "not_found") {
    return Object.freeze({ status: variant.status });
  }
  if (variant?.status === "settled" && "receipt" in variant) {
    const receipt = validSettlement(variant.receipt, key);
    return receipt === undefined ? undefined : Object.freeze({ status: "settled", receipt });
  }
  if (variant?.status === "conflict" && (variant.reason === "settlement_request_digest_conflict" ||
      variant.reason === "consumption_already_settled")) {
    return Object.freeze({ status: "conflict", reason: variant.reason });
  }
  if (variant?.status === "indeterminate" && variant.reason === "owner_unavailable") {
    return Object.freeze({ status: "indeterminate", reason: variant.reason });
  }
  return undefined;
};

type SettlementPersistence = Exclude<SettlementTransactionDecision["persist"], undefined>;

const validPersistence = (
  value: unknown,
  result: SettlementTransactionDecision["result"],
): SettlementPersistence | undefined => {
  const persistence = snapshotExactDispatchRecord(value, ["settlementDigest", "settle"]);
  return persistence !== undefined && isBoundedDispatchIdentifier(persistence.settlementDigest) &&
    typeof persistence.settle === "boolean" &&
    persistence.settle === (result.status === "settled")
    ? Object.freeze({ settlementDigest: persistence.settlementDigest,
      settle: persistence.settle }) : undefined;
};

const missingRequiredPersistence = (
  result: SettlementTransactionDecision["result"],
  priorRequest: SettlementTransactionSnapshot["priorRequest"],
  persistence: SettlementPersistence | undefined,
): boolean => (result.status === "settled" || result.status === "not_found") &&
  priorRequest === undefined && persistence === undefined;

const cannotApplySettlement = (
  persistence: SettlementPersistence | undefined,
  consumption: PersistedConsumption | undefined,
): boolean => persistence?.settle === true &&
  (consumption === undefined || consumption.lifecycleState !== "consumed_pending" ||
   consumption.settlement !== undefined);

const consumptionMatchesSettlementKey = (
  consumption: PersistedConsumption,
  key: { readonly scope: DispatchAuthorityScope; readonly providerId: string;
    readonly authorityGeneration: string; readonly operationId: string;
    readonly grantRequestId: string; readonly consumptionDigest: string },
): boolean => consumption.receipt.scope.tenantId === key.scope.tenantId &&
  consumption.receipt.scope.projectId === key.scope.projectId &&
  consumption.receipt.scope.scopeDigest === key.scope.scopeDigest &&
  consumption.receipt.providerId === key.providerId &&
  consumption.receipt.authorityGeneration === key.authorityGeneration &&
  consumption.receipt.operationId === key.operationId &&
  consumption.receipt.grantRequestId === key.grantRequestId &&
  consumption.receipt.consumptionDigest === key.consumptionDigest;

const validateSettlementDecision = (
  decision: SettlementTransactionDecision,
  key: { readonly settlementRequestId: string; readonly consumptionDigest: string;
    readonly providerId: string; readonly authorityGeneration: string },
  priorRequest: SettlementTransactionSnapshot["priorRequest"],
  consumption: PersistedConsumption | undefined,
): { readonly result: SettlementTransactionDecision["result"];
  readonly persistence?: SettlementPersistence } | undefined => {
  const candidate = snapshotExactDispatchVariant(decision, [["result"], ["result", "persist"]]);
  if (candidate === undefined) {return undefined;}
  const result = validSettlementResult(candidate.result, key);
  if (result === undefined) {return undefined;}
  const persistence = "persist" in candidate ? validPersistence(candidate.persist, result) : undefined;
  if ("persist" in candidate && persistence === undefined) {return undefined;}
  if (missingRequiredPersistence(result, priorRequest, persistence)) {return undefined;}
  if (persistence !== undefined && priorRequest !== undefined) {return undefined;}
  if (cannotApplySettlement(persistence, consumption)) {return undefined;}
  return persistence === undefined ? { result } : { result, persistence };
};

export const consumeInMemory = (
  state: InMemoryDispatchConsumptionState,
  key: { readonly scope: DispatchAuthorityScope; readonly operationId: string;
    readonly grantRequestId: string },
  decide: (snapshot: ConsumeTransactionSnapshot) => ConsumeTransactionDecision,
): ReturnType<DispatchConsumptionRepository["consumeAtomically"]> => {
  const accepted = snapshotKey(key, false);
  if (accepted === undefined) {return Promise.resolve({ status: "indeterminate", reason: "owner_unavailable" });}
  return state.exclusive(() => {
  const scopedOperationKey = operationKey(accepted.scope, accepted.providerId,
    accepted.authorityGeneration, accepted.operationId);
  const scopedRequestKey = requestKey(accepted.scope, accepted.providerId,
    accepted.authorityGeneration, accepted.operationId, accepted.grantRequestId);
  const prior = state.consumeRequests.get(scopedRequestKey);
  const authority = state.authorities.get(scopedOperationKey);
  const consumption = state.consumptionsByOperation.get(scopedOperationKey);
  const decision = decide({
    ...(prior === undefined ? {} : { priorRequest: {
      scope: prior.scope, providerId: prior.providerId,
      authorityGeneration: prior.authorityGeneration, operationId: prior.operationId,
      grantRequestId: prior.grantRequestId, requestDigest: prior.requestDigest,
      requestFingerprint: prior.requestFingerprint, outcome: prior.outcome,
    } }),
    ...(authority === undefined ? {} : { authority }),
    ...(consumption === undefined ? {} : { consumption }),
  });
  if (decision.persistRequest !== undefined) {
    state.consumeRequests.set(scopedRequestKey, {
      ...decision.persistRequest,
      scope: accepted.scope, providerId: accepted.providerId,
      authorityGeneration: accepted.authorityGeneration, operationId: accepted.operationId,
      grantRequestId: accepted.grantRequestId,
      operationKey: scopedOperationKey,
    });
  }
  if (decision.persistConsumption !== undefined &&
      decision.persistConsumption.lifecycleState === "consumed_pending") {
    state.consumptionsByOperation.set(scopedOperationKey, decision.persistConsumption);
    state.consumptionsByDigest.set(
      consumptionKey({ ...accepted,
        consumptionDigest: decision.persistConsumption.receipt.consumptionDigest }),
      decision.persistConsumption,
    );
  }
  return decision.outcome;
  });
};

export const observeInMemory = (
  state: InMemoryDispatchConsumptionState,
  key: { readonly scope: DispatchAuthorityScope; readonly operationId: string;
    readonly grantRequestId: string },
): Promise<ObservedConsumptionRecord | undefined> => {
  const accepted = snapshotKey(key, false);
  if (accepted === undefined) {
    return Promise.resolve() as Promise<ObservedConsumptionRecord | undefined>;
  }
  return state.exclusive(() => {
  const request = state.consumeRequests.get(requestKey(accepted.scope, accepted.providerId,
    accepted.authorityGeneration, accepted.operationId, accepted.grantRequestId));
  if (request === undefined) {return;}
  const consumption = state.consumptionsByOperation.get(request.operationKey);
  return {
    scope: request.scope,
    operationId: request.operationId,
    providerId: request.providerId, authorityGeneration: request.authorityGeneration,
    grantRequestId: accepted.grantRequestId,
    requestDigest: request.requestDigest,
    requestFingerprint: request.requestFingerprint,
    outcome: request.outcome,
    ...(consumption === undefined ? {} : { consumption }),
  };
  });
};

export const settleInMemory = (
  state: InMemoryDispatchConsumptionState,
  key: Parameters<DispatchConsumptionRepository["settleAtomically"]>[0],
  decide: (snapshot: SettlementTransactionSnapshot) => SettlementTransactionDecision,
): ReturnType<DispatchConsumptionRepository["settleAtomically"]> => {
  const accepted = snapshotKey(key, true);
  if (accepted === undefined) {
    return Promise.resolve({ status: "invalid_request" });
  }
  return state.exclusive(() => {
  const scopedSettlementKey = settlementRequestKey(accepted);
  const scopedConsumptionKey = consumptionKey(accepted);
  const priorRequest = state.settlementRequests.get(scopedSettlementKey);
  const consumption = state.consumptionsByDigest.get(scopedConsumptionKey);
  if (consumption !== undefined && !consumptionMatchesSettlementKey(consumption, accepted)) {
    return { status: "invalid_request" };
  }
  const decision = decide({
    ...(priorRequest === undefined ? {} : { priorRequest }),
    ...(consumption === undefined ? {} : { consumption }),
  });
  const validated = validateSettlementDecision(decision, accepted, priorRequest, consumption);
  if (validated === undefined) {return { status: "invalid_request" };}
  const { result, persistence } = validated;
  if (persistence !== undefined) {
    if (result.status !== "settled" && result.status !== "not_found") {
      return { status: "invalid_request" };
    }
    state.settlementRequests.set(scopedSettlementKey, {
      scope: accepted.scope, providerId: accepted.providerId,
      authorityGeneration: accepted.authorityGeneration, operationId: accepted.operationId,
      grantRequestId: accepted.grantRequestId,
      settlementRequestId: accepted.settlementRequestId,
      consumptionDigest: accepted.consumptionDigest,
      settlementDigest: persistence.settlementDigest,
      outcome: result,
    });
  }
  const settlement = result.status === "settled" && persistence?.settle
    ? result.receipt
    : undefined;
  if (settlement !== undefined && consumption !== undefined &&
      consumption.lifecycleState === "consumed_pending" &&
      consumption.settlement === undefined &&
      consumptionMatchesSettlementKey(consumption, accepted) &&
      validSettlement(settlement, key) !== undefined) {
    const settled: PersistedConsumption = {
      receipt: consumption.receipt,
      lifecycleState: settlement.disposition,
      settlement,
    };
    state.consumptionsByDigest.set(scopedConsumptionKey, settled);
    state.consumptionsByOperation.set(
      operationKey(consumption.receipt.scope, consumption.receipt.providerId,
        consumption.receipt.authorityGeneration, consumption.receipt.operationId),
      settled,
    );
  }
  return result;
  });
};
