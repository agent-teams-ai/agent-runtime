import type {
  DispatchConsumeResult,
  DispatchConsumptionLifecycle,
  DispatchObservationQuery,
  DispatchSettlementResult,
} from "./dispatch-consumption-models.js";
import type { DispatchAuthorityOperations } from "./dispatch-authority-dependencies.js";
import { sameScope } from "../domain/dispatch-authority-head.js";
import { requestCanonical } from "./dispatch-canonical.js";
import {
  isBoundedDispatchIdentifier,
  isDispatchLifecycle,
  isSettlementDisposition,
  sameConsumptionReceipt,
  validConsumptionReceipt,
} from "./dispatch-consumption-models.js";
import { mapConsumeResultToV1, mapSettlementResultToV1 } from
  "./contained-turn-dispatch-authority-v1-mappers.js";
import {
  snapshotExactDispatchRecord, snapshotExactDispatchVariant,
} from "../domain/dispatch-exact-record.js";

const closedObservation = (
  value: unknown,
  operations: DispatchAuthorityOperations,
): Awaited<ReturnType<DispatchAuthorityOperations["observe"]>> => {
  const names = ["scope", "providerId", "authorityGeneration", "operationId", "grantRequestId",
    "requestDigest", "requestFingerprint", "outcome"] as const;
  const fields = snapshotExactDispatchVariant(value, [names, [...names, "consumption"]]);
  if (fields === undefined) {throw new TypeError("invalid observed consumption");}
  const scopeFields = snapshotExactDispatchRecord(fields.scope,
    ["tenantId", "projectId", "scopeDigest"]);
  if (scopeFields === undefined || ![scopeFields.tenantId, scopeFields.projectId,
    scopeFields.scopeDigest, fields.providerId, fields.authorityGeneration, fields.operationId,
    fields.grantRequestId, fields.requestDigest, fields.requestFingerprint]
    .every(isBoundedDispatchIdentifier)) {throw new TypeError("invalid observed selector");}
  const scope = Object.freeze({ tenantId: scopeFields.tenantId as string,
    projectId: scopeFields.projectId as string, scopeDigest: scopeFields.scopeDigest as string });
  const outcome = mapConsumeResultToV1(fields.outcome as DispatchConsumeResult,
    operations.digestCanonical) as DispatchConsumeResult;
  if (outcome.status === "conflict" || outcome.status === "indeterminate") {
    throw new TypeError("invalid persisted outcome");
  }
  let consumption;
  if ("consumption" in fields) {
    const consumptionFields = snapshotExactDispatchVariant(fields.consumption,
      [["receipt", "lifecycleState"], ["receipt", "lifecycleState", "settlement"]]);
    if (consumptionFields === undefined || !isDispatchLifecycle(consumptionFields.lifecycleState)) {
      throw new TypeError("invalid persisted consumption");
    }
    const receiptOutcome = mapConsumeResultToV1(
      { status: "consumed", receipt: consumptionFields.receipt } as DispatchConsumeResult,
      operations.digestCanonical,
    );
    if (receiptOutcome.status !== "consumed") {throw new TypeError("invalid persisted receipt");}
    if ("settlement" in consumptionFields) {
      const settlementOutcome = mapSettlementResultToV1(
        { status: "settled", receipt: consumptionFields.settlement } as DispatchSettlementResult);
      if (settlementOutcome.status !== "settled") {throw new TypeError("invalid settlement");}
      consumption = Object.freeze({ receipt: receiptOutcome.receipt,
        lifecycleState: consumptionFields.lifecycleState, settlement: settlementOutcome.receipt });
    } else {
      consumption = Object.freeze({ receipt: receiptOutcome.receipt,
        lifecycleState: consumptionFields.lifecycleState });
    }
  }
  return Object.freeze({ scope, providerId: fields.providerId as string,
    authorityGeneration: fields.authorityGeneration as string, operationId: fields.operationId as string,
    grantRequestId: fields.grantRequestId as string, requestDigest: fields.requestDigest as string,
    requestFingerprint: fields.requestFingerprint as string, outcome,
    ...(consumption === undefined ? {} : { consumption }) });
};

export type DispatchObservationResult =
  | { readonly outcome: DispatchConsumeResult; readonly lifecycleState?: never }
  | {
      readonly outcome: Extract<DispatchConsumeResult, { readonly status: "consumed" }>;
      readonly lifecycleState: DispatchConsumptionLifecycle;
    };

const receiptBindsObservation = (
  observed: Awaited<ReturnType<DispatchAuthorityOperations["observe"]>> & object,
  query: DispatchObservationQuery,
): boolean => observed.outcome.status === "consumed" &&
  validConsumptionReceipt(observed.outcome.receipt) &&
  sameScope(observed.outcome.receipt.scope, query.scope) &&
  observed.outcome.receipt.operationId === observed.operationId &&
  observed.outcome.receipt.grantRequestId === observed.grantRequestId &&
  observed.outcome.receipt.requestDigest === observed.requestDigest &&
  observed.outcome.receipt.operationId === query.operationId &&
  observed.outcome.receipt.purpose === query.purpose &&
  observed.outcome.receipt.requestDigest === query.requestDigest &&
  observed.outcome.receipt.providerId === query.providerId &&
  observed.outcome.receipt.authorityGeneration === query.authorityGeneration &&
  observed.outcome.receipt.providerBindingDigest === query.providerBindingDigest &&
  observed.outcome.receipt.claimBindingDigest === query.claimBindingDigest &&
  observed.outcome.receipt.acceptedAuthorityDigest === query.acceptedAuthorityDigest &&
  observed.outcome.receipt.authorityHeadDigestAtConsumption === query.expectedAuthorityHeadDigest &&
  observed.outcome.receipt.authorityRevision === query.expectedAuthorityRevision &&
  observed.outcome.receipt.constraintsDigest === query.expectedConstraintsDigest &&
  observed.outcome.receipt.containmentPolicyDigest === query.expectedContainmentPolicyDigest;

const lifecycleBindsReceipt = (
  consumption: NonNullable<
    NonNullable<Awaited<ReturnType<DispatchAuthorityOperations["observe"]>>>["consumption"]
  >,
): boolean => {
  if (!isDispatchLifecycle(consumption.lifecycleState)) {return false;}
  if (consumption.lifecycleState === "consumed_pending") {
    return consumption.settlement === undefined;
  }
  const settlement = consumption.settlement;
  return settlement !== undefined &&
    settlement.contractVersion === "contained-turn-dispatch-settlement/v1" &&
    isBoundedDispatchIdentifier(settlement.settlementRequestId) &&
    settlement.providerId === consumption.receipt.providerId &&
    settlement.authorityGeneration === consumption.receipt.authorityGeneration &&
    settlement.consumptionDigest === consumption.receipt.consumptionDigest &&
    isSettlementDisposition(settlement.disposition) &&
    settlement.disposition === consumption.lifecycleState &&
    Number.isSafeInteger(settlement.settledAtControlTime) &&
    settlement.settledAtControlTime >= 0;
};

const observationSelectorMatches = (
  observed: NonNullable<Awaited<ReturnType<DispatchAuthorityOperations["observe"]>>>,
  query: DispatchObservationQuery,
  expectedFingerprint: string,
): boolean => sameScope(observed.scope, query.scope) &&
  observed.providerId === query.providerId &&
  observed.authorityGeneration === query.authorityGeneration &&
  observed.operationId === query.operationId &&
  observed.grantRequestId === query.grantRequestId &&
  observed.requestFingerprint === expectedFingerprint;

export const observeDispatchConsumption = async (
  query: DispatchObservationQuery,
  operations: DispatchAuthorityOperations,
): Promise<DispatchObservationResult> => {
  const repositoryValue = await operations.observe({
    scope: query.scope,
    providerId: query.providerId,
    authorityGeneration: query.authorityGeneration,
    operationId: query.operationId,
    grantRequestId: query.grantRequestId,
  });
  const observed = repositoryValue === undefined ? undefined : closedObservation(repositoryValue, operations);
  const expectedFingerprint = operations.digestCanonical(requestCanonical(query));
  if (!isBoundedDispatchIdentifier(expectedFingerprint)) {
    return { outcome: { status: "indeterminate", reason: "owner_unavailable" } };
  }
  if (observed === undefined ||
      !observationSelectorMatches(observed, query, expectedFingerprint)) {
    return { outcome: { status: "not_found" } };
  }
  if (observed.requestDigest !== query.requestDigest) {
    return { outcome: { status: "conflict", reason: "grant_request_digest_conflict" } };
  }
  if (observed.outcome.status === "consumed") {
    const receipt = observed.outcome.receipt;
    if (!receiptBindsObservation(observed, query)) {
      return { outcome: { status: "not_found" } };
    }
    if (
      observed.consumption === undefined ||
      !validConsumptionReceipt(observed.consumption.receipt) ||
      !sameConsumptionReceipt(receipt, observed.consumption.receipt) ||
      !lifecycleBindsReceipt(observed.consumption)
    ) {
      return { outcome: { status: "indeterminate", reason: "owner_unavailable" } };
    }
    return {
      outcome: observed.outcome,
      lifecycleState: observed.consumption.lifecycleState,
    };
  }
  if (observed.outcome.status === "prevented") {
    const evidence = observed.outcome.evidence;
    if (!sameScope(evidence.scope, query.scope) ||
        evidence.operationId !== query.operationId ||
        evidence.grantRequestId !== observed.grantRequestId ||
        evidence.requestDigest !== observed.requestDigest) {
      return { outcome: { status: "not_found" } };
    }
  }
  return { outcome: observed.outcome };
};
