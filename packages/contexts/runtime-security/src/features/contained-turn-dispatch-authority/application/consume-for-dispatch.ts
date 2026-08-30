import type {
  DispatchConsumeResult,
  DispatchConsumptionRecordReceipt,
  DispatchPreventionRecord,
} from "./dispatch-consumption-models.js";
import { isBoundedDispatchIdentifier, sameConsumptionReceipt } from
  "./dispatch-consumption-models.js";
import { consumptionCanonical, requestCanonical } from "./dispatch-canonical.js";
import type { DispatchAuthorityOperations } from "./dispatch-authority-dependencies.js";
import { immutable } from "./immutable.js";
import {
  preventionReason,
  sameScope,
  snapshotDispatchAuthorityHead,
} from "../domain/dispatch-authority-head.js";
import type {
  DispatchAuthorityHead,
  DispatchConsumeRequest,
  DispatchPreventionReason,
} from "../domain/dispatch-authority-head.js";
import type {
  ConsumeTransactionDecision,
  ConsumeTransactionSnapshot,
} from "./ports/outbound/dispatch-consumption-repository.js";
import {
  snapshotExactDispatchRecord, snapshotExactDispatchVariant,
} from "../domain/dispatch-exact-record.js";
import { mapConsumeResultToV1, mapSettlementResultToV1 } from
  "./contained-turn-dispatch-authority-v1-mappers.js";

// oxlint-disable-next-line eslint/complexity -- closed projection enumerates persisted variants.
const closeConsumeSnapshot = (
  value: unknown,
  operations: DispatchAuthorityOperations,
): ConsumeTransactionSnapshot => {
  const variants = [[], ["priorRequest"], ["authority"], ["consumption"],
    ["priorRequest", "authority"], ["priorRequest", "consumption"],
    ["authority", "consumption"], ["priorRequest", "authority", "consumption"]] as const;
  const fields = snapshotExactDispatchVariant(value, variants);
  if (fields === undefined) {throw new TypeError("invalid consume snapshot");}
  let priorRequest;
  if ("priorRequest" in fields) {
    const prior = snapshotExactDispatchRecord(fields.priorRequest,
      ["scope", "providerId", "authorityGeneration", "operationId", "grantRequestId",
        "requestDigest", "requestFingerprint", "outcome"]);
    const scope = prior === undefined ? undefined : snapshotExactDispatchRecord(prior.scope,
      ["tenantId", "projectId", "scopeDigest"]);
    if (prior === undefined || scope === undefined ||
        ![scope.tenantId, scope.projectId, scope.scopeDigest, prior.providerId,
          prior.authorityGeneration, prior.operationId, prior.grantRequestId,
          prior.requestDigest, prior.requestFingerprint].every(isBoundedDispatchIdentifier)) {
      throw new TypeError("invalid prior consume request");
    }
    const outcome = mapConsumeResultToV1(prior.outcome as DispatchConsumeResult,
      operations.digestCanonical);
    if (outcome.status === "conflict" || outcome.status === "indeterminate") {
      throw new TypeError("invalid persisted consume outcome");
    }
    priorRequest = Object.freeze({ scope: Object.freeze({ tenantId: scope.tenantId as string,
      projectId: scope.projectId as string, scopeDigest: scope.scopeDigest as string }),
    providerId: prior.providerId as string, authorityGeneration: prior.authorityGeneration as string,
    operationId: prior.operationId as string, grantRequestId: prior.grantRequestId as string,
    requestDigest: prior.requestDigest as string,
    requestFingerprint: prior.requestFingerprint as string, outcome });
  }
  const authority = "authority" in fields ? snapshotDispatchAuthorityHead(fields.authority) : undefined;
  if ("authority" in fields && authority === undefined) {
    return Object.freeze({ ...(priorRequest === undefined ? {} : { priorRequest }),
      authority: Object.freeze({}) as DispatchAuthorityHead });
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
      operations.digestCanonical);
    if (consumed.status !== "consumed") {throw new TypeError("invalid persisted receipt");}
    if ("settlement" in record) {
      const settled = mapSettlementResultToV1(
        { status: "settled", receipt: record.settlement } as never);
      if (settled.status !== "settled") {throw new TypeError("invalid settlement");}
      consumption = Object.freeze({ receipt: consumed.receipt,
        lifecycleState: record.lifecycleState, settlement: settled.receipt });
    } else {
      consumption = Object.freeze({ receipt: consumed.receipt, lifecycleState: record.lifecycleState });
    }
  }
  return Object.freeze({ ...(priorRequest === undefined ? {} : { priorRequest }),
    ...(authority === undefined ? {} : { authority }),
    ...(consumption === undefined ? {} : { consumption }) });
};

const prevention = (
  request: DispatchConsumeRequest,
  head: DispatchAuthorityHead | undefined,
  reason: DispatchPreventionReason,
  now: number,
): ConsumeTransactionDecision => {
  const evidence: DispatchPreventionRecord = immutable({
    contractVersion: "contained-turn-dispatch-prevention/v1",
    purpose: "contained-turn.provider-dispatch/v1",
    operationId: request.operationId,
    scope: request.scope,
    grantRequestId: request.grantRequestId,
    requestDigest: request.requestDigest,
    reason,
    preventedAtControlTime: now,
    ...(reason === "invalid_request" || head === undefined ? {} :
      { ownerEvidenceRef: head.ownerEvidenceRef }),
  });
  return { outcome: immutable({ status: "prevented", evidence }) };
};

const replayConsume = (
  request: DispatchConsumeRequest,
  requestFingerprint: string,
  snapshot: ConsumeTransactionSnapshot,
): ConsumeTransactionDecision => {
  const prior = snapshot.priorRequest;
  if (prior === undefined) {throw new TypeError("missing persisted consume request");}
  if (!sameScope(prior.scope, request.scope) || prior.providerId !== request.providerId ||
      prior.authorityGeneration !== request.authorityGeneration ||
      prior.operationId !== request.operationId || prior.grantRequestId !== request.grantRequestId) {
    throw new TypeError("persisted consume request identity mismatch");
  }
  const exact = prior.requestDigest === request.requestDigest &&
    prior.requestFingerprint === requestFingerprint;
  if (exact && prior.outcome.status === "consumed") {
    const receipt = prior.outcome.receipt;
    if (!sameScope(receipt.scope, request.scope) || receipt.providerId !== request.providerId ||
        receipt.authorityGeneration !== request.authorityGeneration ||
        receipt.operationId !== request.operationId ||
        receipt.grantRequestId !== request.grantRequestId ||
        receipt.requestDigest !== request.requestDigest ||
        snapshot.consumption === undefined ||
        !sameConsumptionReceipt(receipt, snapshot.consumption.receipt)) {
      throw new TypeError("persisted consumed replay evidence mismatch");
    }
  }
  return { outcome: exact
    ? prior.outcome
    : { status: "conflict", reason: "grant_request_digest_conflict" } };
};

const decideConsume = (
  request: DispatchConsumeRequest,
  requestFingerprint: string,
  operations: DispatchAuthorityOperations,
  snapshot: ConsumeTransactionSnapshot,
): ConsumeTransactionDecision => {
  if (snapshot.priorRequest !== undefined) {
    return replayConsume(request, requestFingerprint, snapshot);
  }
  const now = operations.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    return { outcome: { status: "indeterminate", reason: "owner_unavailable" } };
  }
  const persistedHead = snapshot.authority;
  const head = snapshotDispatchAuthorityHead(persistedHead);
  if (persistedHead !== undefined && head === undefined) {
    const decision = prevention(request, undefined, "invalid_request", now);
    return { ...decision, persistRequest: {
      requestDigest: request.requestDigest,
      requestFingerprint,
      outcome: decision.outcome as Extract<DispatchConsumeResult, { status: "prevented" }>,
    } };
  }
  if (head === undefined || head.operationId !== request.operationId ||
      !sameScope(head.scope, request.scope)) {
    const outcome = immutable({ status: "not_found" } as const);
    return { outcome, persistRequest: { requestDigest: request.requestDigest,
      requestFingerprint, outcome } };
  }
  const reason = snapshot.consumption === undefined
    ? preventionReason(request, head, now)
    : "already_consumed";
  if (reason !== undefined) {
    const decision = prevention(request, head, reason, now);
    return { ...decision, persistRequest: {
      requestDigest: request.requestDigest,
      requestFingerprint,
      outcome: decision.outcome as Extract<DispatchConsumeResult, { status: "prevented" }>,
    } };
  }
  const consumptionDigest = operations.digestCanonical(consumptionCanonical(request, head, now));
  if (!isBoundedDispatchIdentifier(consumptionDigest)) {
    return { outcome: { status: "indeterminate", reason: "owner_unavailable" } };
  }
  const receipt: DispatchConsumptionRecordReceipt = immutable({
    contractVersion: "contained-turn-dispatch-consumption/v1",
    purpose: request.purpose, operationId: request.operationId, scope: request.scope,
    grantRequestId: request.grantRequestId, requestDigest: request.requestDigest,
    providerId: request.providerId, authorityGeneration: request.authorityGeneration,
    providerBindingDigest: request.providerBindingDigest,
    claimBindingDigest: request.claimBindingDigest,
    acceptedAuthorityDigest: head.acceptedAuthorityDigest,
    authorityHeadDigestAtConsumption: head.authorityHeadDigest,
    authorityRevision: head.authorityRevision, constraintsDigest: head.constraintsDigest,
    containmentPolicyDigest: head.containmentPolicyDigest,
    consumptionDigest,
    claimBeforeControlTime: head.claimBeforeControlTime, consumedAtControlTime: now,
    ownerEvidenceRef: head.ownerEvidenceRef,
  });
  const outcome = immutable({ status: "consumed", receipt } as const);
  return {
    outcome,
    persistRequest: { requestDigest: request.requestDigest, requestFingerprint, outcome },
    persistConsumption: { receipt, lifecycleState: "consumed_pending" },
  };
};

export const consumeForDispatch = async (
  request: DispatchConsumeRequest,
  operations: DispatchAuthorityOperations,
): Promise<DispatchConsumeResult> => {
  const requestFingerprint = operations.digestCanonical(requestCanonical(request));
  if (!isBoundedDispatchIdentifier(requestFingerprint)) {
    return { status: "indeterminate", reason: "owner_unavailable" };
  }
  return operations.consumeAtomically(
    { scope: request.scope, providerId: request.providerId,
      authorityGeneration: request.authorityGeneration, operationId: request.operationId,
      grantRequestId: request.grantRequestId },
    snapshot => decideConsume(request, requestFingerprint, operations,
      closeConsumeSnapshot(snapshot, operations)),
  );
};
