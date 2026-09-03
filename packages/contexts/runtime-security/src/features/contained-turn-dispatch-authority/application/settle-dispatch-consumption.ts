import type {
  DispatchConsumeResult,
  DispatchSettlementRecordReceipt,
  DispatchSettlementRequest,
  DispatchSettlementResult,
} from "./dispatch-consumption-models.js";
import { isBoundedDispatchIdentifier } from "./dispatch-consumption-models.js";
import { settlementCanonical } from "./dispatch-canonical.js";
import type { DispatchAuthorityOperations } from "./dispatch-authority-dependencies.js";
import { immutable } from "./immutable.js";
import { sameScope } from "../domain/dispatch-authority-head.js";
import type {
  SettlementTransactionDecision,
  SettlementTransactionSnapshot,
} from "./ports/outbound/dispatch-consumption-repository.js";
import {
  snapshotExactDispatchRecord, snapshotExactDispatchVariant,
} from "../domain/dispatch-exact-record.js";
import { mapConsumeResultToV1, mapSettlementResultToV1 } from
  "./contained-turn-dispatch-authority-v1-mappers.js";

const closeSettlementSnapshot = (
  value: unknown,
  operations: DispatchAuthorityOperations,
): SettlementTransactionSnapshot => {
  const fields = snapshotExactDispatchVariant(value,
    [[], ["priorRequest"], ["consumption"], ["priorRequest", "consumption"]]);
  if (fields === undefined) {throw new TypeError("invalid settlement snapshot");}
  let priorRequest;
  if ("priorRequest" in fields) {
    const prior = snapshotExactDispatchRecord(fields.priorRequest,
      ["scope", "providerId", "authorityGeneration", "operationId", "grantRequestId",
        "settlementRequestId", "consumptionDigest", "settlementDigest", "outcome"]);
    const scope = prior === undefined ? undefined : snapshotExactDispatchRecord(prior.scope,
      ["tenantId", "projectId", "scopeDigest"]);
    if (prior === undefined || scope === undefined ||
        ![scope.tenantId, scope.projectId, scope.scopeDigest, prior.providerId,
          prior.authorityGeneration, prior.operationId, prior.grantRequestId,
          prior.settlementRequestId, prior.consumptionDigest, prior.settlementDigest]
          .every(isBoundedDispatchIdentifier)) {
      throw new TypeError("invalid prior settlement request");
    }
    const outcome = mapSettlementResultToV1(prior.outcome as DispatchSettlementResult);
    if (outcome.status !== "settled" && outcome.status !== "not_found") {
      throw new TypeError("invalid persisted settlement outcome");
    }
    priorRequest = Object.freeze({ scope: Object.freeze({ tenantId: scope.tenantId as string,
      projectId: scope.projectId as string, scopeDigest: scope.scopeDigest as string }),
    providerId: prior.providerId as string, authorityGeneration: prior.authorityGeneration as string,
    operationId: prior.operationId as string, grantRequestId: prior.grantRequestId as string,
    settlementRequestId: prior.settlementRequestId as string,
    consumptionDigest: prior.consumptionDigest as string,
    settlementDigest: prior.settlementDigest as string, outcome });
  }
  let consumption;
  if ("consumption" in fields) {
    const record = snapshotExactDispatchVariant(fields.consumption,
      [["receipt", "lifecycleState"], ["receipt", "lifecycleState", "settlement"]]);
    if (record === undefined || (record.lifecycleState !== "consumed_pending" &&
        record.lifecycleState !== "claim_committed" &&
        record.lifecycleState !== "abandoned_without_claim")) {
      throw new TypeError("invalid persisted consumption");
    }
    const consumed = mapConsumeResultToV1(
      { status: "consumed", receipt: record.receipt } as DispatchConsumeResult,
      operations.digestCanonical,
    );
    if (consumed.status !== "consumed") {throw new TypeError("invalid persisted receipt");}
    if ("settlement" in record) {
      const settled = mapSettlementResultToV1(
        { status: "settled", receipt: record.settlement } as DispatchSettlementResult);
      if (settled.status !== "settled") {throw new TypeError("invalid persisted settlement");}
      consumption = Object.freeze({ receipt: consumed.receipt,
        lifecycleState: record.lifecycleState, settlement: settled.receipt });
    } else {
      consumption = Object.freeze({ receipt: consumed.receipt, lifecycleState: record.lifecycleState });
    }
  }
  return Object.freeze({ ...(priorRequest === undefined ? {} : { priorRequest }),
    ...(consumption === undefined ? {} : { consumption }) });
};

const decideSettlement = (
  request: DispatchSettlementRequest,
  settlementDigest: string,
  now: () => number,
  snapshot: SettlementTransactionSnapshot,
): SettlementTransactionDecision => {
  if (snapshot.priorRequest !== undefined) {
    const prior = snapshot.priorRequest;
    if (!sameScope(prior.scope, request.scope) || prior.providerId !== request.providerId ||
        prior.authorityGeneration !== request.authorityGeneration ||
        prior.operationId !== request.operationId || prior.grantRequestId !== request.grantRequestId ||
        prior.settlementRequestId !== request.settlementRequestId ||
        prior.consumptionDigest !== request.consumptionDigest) {
      throw new TypeError("persisted settlement request identity mismatch");
    }
    if (prior.outcome.status === "settled" &&
        (prior.outcome.receipt.providerId !== request.providerId ||
         prior.outcome.receipt.authorityGeneration !== request.authorityGeneration ||
         prior.outcome.receipt.settlementRequestId !== request.settlementRequestId ||
         prior.outcome.receipt.consumptionDigest !== request.consumptionDigest)) {
      throw new TypeError("persisted settlement receipt identity mismatch");
    }
    return { result: snapshot.priorRequest.settlementDigest === settlementDigest
      ? snapshot.priorRequest.outcome
      : { status: "conflict", reason: "settlement_request_digest_conflict" } };
  }
  if (snapshot.consumption === undefined) {
    const outcome = immutable({ status: "not_found" } as const);
    return { result: outcome, persist: { settlementDigest, settle: false } };
  }
  if (snapshot.consumption.settlement !== undefined ||
      snapshot.consumption.lifecycleState !== "consumed_pending") {
    return { result: { status: "conflict", reason: "consumption_already_settled" } };
  }
  const controlTime = now();
  if (!Number.isSafeInteger(controlTime) || controlTime < 0) {
    return { result: { status: "indeterminate", reason: "owner_unavailable" } };
  }
  const receipt: DispatchSettlementRecordReceipt = immutable({
    contractVersion: "contained-turn-dispatch-settlement/v1",
    settlementRequestId: request.settlementRequestId,
    providerId: request.providerId,
    authorityGeneration: request.authorityGeneration,
    consumptionDigest: request.consumptionDigest,
    disposition: request.disposition,
    settledAtControlTime: controlTime,
  });
  const outcome = immutable({ status: "settled", receipt } as const);
  return {
    result: outcome,
    persist: { settlementDigest, settle: true },
  };
};

export const settleDispatchConsumption = async (
  request: DispatchSettlementRequest,
  operations: DispatchAuthorityOperations,
): Promise<DispatchSettlementResult> => {
  const settlementDigest = operations.digestCanonical(settlementCanonical(request));
  if (!isBoundedDispatchIdentifier(settlementDigest)) {
    return { status: "indeterminate", reason: "owner_unavailable" };
  }
  return operations.settleAtomically(
    { scope: request.scope, providerId: request.providerId,
      authorityGeneration: request.authorityGeneration, operationId: request.operationId,
      grantRequestId: request.grantRequestId, settlementRequestId: request.settlementRequestId,
      consumptionDigest: request.consumptionDigest },
    snapshot => {
      const closed = closeSettlementSnapshot(snapshot, operations);
      if (closed.consumption !== undefined &&
          (!sameScope(closed.consumption.receipt.scope, request.scope) ||
           closed.consumption.receipt.providerId !== request.providerId ||
           closed.consumption.receipt.authorityGeneration !== request.authorityGeneration ||
           closed.consumption.receipt.operationId !== request.operationId ||
           closed.consumption.receipt.grantRequestId !== request.grantRequestId ||
           closed.consumption.receipt.consumptionDigest !== request.consumptionDigest)) {
        throw new TypeError("settlement consumption identity mismatch");
      }
      return decideSettlement(request, settlementDigest, operations.now, closed);
    },
  );
};
