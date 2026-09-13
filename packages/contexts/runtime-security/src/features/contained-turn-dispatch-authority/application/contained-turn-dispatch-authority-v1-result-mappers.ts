import type {
  DispatchConsumeResult,
  DispatchConsumptionRecordReceipt,
  DispatchObserveResult,
  DispatchSettlementResult,
} from "./dispatch-consumption-models.js";
import {
  isBoundedDispatchIdentifier, isDispatchLifecycle, isSettlementDisposition,
  validConsumptionReceipt,
} from "./dispatch-consumption-models.js";
import { consumptionReceiptCanonical } from "./dispatch-canonical.js";
import type {
  DispatchAuthorityScope, DispatchPreventionReason,
} from "../domain/dispatch-authority-head.js";
import { validDispatchOwnerEvidenceRef } from "../domain/dispatch-authority-head.js";
import {
  snapshotExactDispatchRecord, snapshotExactDispatchVariant,
} from "../domain/dispatch-exact-record.js";

type DigestCanonical = (value: string) => string;

const scopeFrom = (value: unknown): DispatchAuthorityScope | undefined => {
  const fields = snapshotExactDispatchRecord(value, ["tenantId", "projectId", "scopeDigest"]);
  if (fields === undefined || ![fields.tenantId, fields.projectId, fields.scopeDigest]
    .every(isBoundedDispatchIdentifier)) {return undefined;}
  return Object.freeze({ tenantId: fields.tenantId as string, projectId: fields.projectId as string,
    scopeDigest: fields.scopeDigest as string });
};

const receiptNames = ["contractVersion", "purpose", "operationId", "scope", "grantRequestId",
  "requestDigest", "providerId", "authorityGeneration", "providerBindingDigest",
  "claimBindingDigest", "acceptedAuthorityDigest", "authorityHeadDigestAtConsumption",
  "authorityRevision", "constraintsDigest", "containmentPolicyDigest", "consumptionDigest",
  "claimBeforeControlTime", "consumedAtControlTime", "ownerEvidenceRef"] as const;

const receiptToV1 = (value: unknown, digestCanonical: DigestCanonical): DispatchConsumptionRecordReceipt => {
  const fields = snapshotExactDispatchRecord(value, receiptNames);
  const scope = fields === undefined ? undefined : scopeFrom(fields.scope);
  if (fields === undefined || scope === undefined) {throw new TypeError("invalid consumption receipt");}
  const receipt: DispatchConsumptionRecordReceipt = { ...fields, scope } as unknown as
    DispatchConsumptionRecordReceipt;
  if (!validConsumptionReceipt(receipt)) {throw new TypeError("invalid consumption receipt");}
  const { consumptionDigest, ...consumed } = receipt;
  if (digestCanonical(consumptionReceiptCanonical(consumed)) !== consumptionDigest) {
    throw new TypeError("invalid consumption digest");
  }
  return Object.freeze({ contractVersion: receipt.contractVersion, purpose: receipt.purpose,
    operationId: receipt.operationId, scope, grantRequestId: receipt.grantRequestId,
    requestDigest: receipt.requestDigest, providerId: receipt.providerId,
    authorityGeneration: receipt.authorityGeneration,
    providerBindingDigest: receipt.providerBindingDigest, claimBindingDigest: receipt.claimBindingDigest,
    acceptedAuthorityDigest: receipt.acceptedAuthorityDigest,
    authorityHeadDigestAtConsumption: receipt.authorityHeadDigestAtConsumption,
    authorityRevision: receipt.authorityRevision, constraintsDigest: receipt.constraintsDigest,
    containmentPolicyDigest: receipt.containmentPolicyDigest, consumptionDigest,
    claimBeforeControlTime: receipt.claimBeforeControlTime,
    consumedAtControlTime: receipt.consumedAtControlTime, ownerEvidenceRef: receipt.ownerEvidenceRef });
};

const preventionReasons: readonly DispatchPreventionReason[] = [
  "accepted_authority_changed", "already_consumed", "authority_revision_stale",
  "claim_binding_mismatch", "constraints_drift", "containment_policy_drift", "expired",
  "invalid_request", "provider_binding_mismatch", "request_digest_mismatch", "revoked",
];

const preventionToV1 = (value: unknown) => {
  const requiredNames = ["contractVersion", "purpose", "operationId", "scope", "grantRequestId",
    "requestDigest", "reason", "preventedAtControlTime"] as const;
  const required = snapshotExactDispatchVariant(value,
    [requiredNames, [...requiredNames, "ownerEvidenceRef"]]);
  const scope = required === undefined ? undefined : scopeFrom(required.scope);
  if (required === undefined || scope === undefined ||
      required.contractVersion !== "contained-turn-dispatch-prevention/v1" ||
      required.purpose !== "contained-turn.provider-dispatch/v1" ||
      ![required.operationId, required.grantRequestId, required.requestDigest]
        .every(isBoundedDispatchIdentifier) ||
      !preventionReasons.includes(required.reason as DispatchPreventionReason) ||
      !Number.isSafeInteger(required.preventedAtControlTime) ||
      (required.preventedAtControlTime as number) < 0 ||
      ("ownerEvidenceRef" in required && !validDispatchOwnerEvidenceRef(required.ownerEvidenceRef))) {
    throw new TypeError("invalid prevention evidence");
  }
  const base = { contractVersion: "contained-turn-dispatch-prevention/v1" as const,
    purpose: "contained-turn.provider-dispatch/v1" as const,
    operationId: required.operationId as string, scope, grantRequestId: required.grantRequestId as string,
    requestDigest: required.requestDigest as string, reason: required.reason as DispatchPreventionReason,
    preventedAtControlTime: required.preventedAtControlTime as number };
  return Object.freeze("ownerEvidenceRef" in required
    ? { ...base, ownerEvidenceRef: required.ownerEvidenceRef as string } : base);
};

export const mapConsumeResultToV1 = (
  result: DispatchConsumeResult,
  digestCanonical: DigestCanonical,
): DispatchConsumeResult => {
  const variant = snapshotExactDispatchVariant(result, [["status"], ["status", "receipt"],
    ["status", "evidence"], ["status", "reason"]]);
  if (variant?.status === "not_found" && !("receipt" in variant) && !("reason" in variant) &&
      !("evidence" in variant)) {return Object.freeze({ status: "not_found" });}
  if (variant?.status === "consumed" && "receipt" in variant) {
    return Object.freeze({ status: "consumed", receipt: receiptToV1(variant.receipt, digestCanonical) });
  }
  if (variant?.status === "prevented" && "evidence" in variant) {
    return Object.freeze({ status: "prevented", evidence: preventionToV1(variant.evidence) });
  }
  if (variant?.status === "conflict" && variant.reason === "grant_request_digest_conflict") {
    return Object.freeze({ status: "conflict", reason: variant.reason });
  }
  if (variant?.status === "indeterminate" && variant.reason === "owner_unavailable") {
    return Object.freeze({ status: "indeterminate", reason: variant.reason });
  }
  throw new TypeError("invalid consume result");
};

export const mapObservedResultToV1 = (result: DispatchConsumeResult,
  lifecycleState: "consumed_pending" | "claim_committed" | "abandoned_without_claim",
  digestCanonical: DigestCanonical): DispatchObserveResult => {
  if (!isDispatchLifecycle(lifecycleState)) {throw new TypeError("invalid lifecycle");}
  const mapped = mapConsumeResultToV1(result, digestCanonical);
  return mapped.status === "consumed"
    ? Object.freeze({ status: "consumed", receipt: mapped.receipt, lifecycleState }) : mapped;
};

// oxlint-disable-next-line eslint/complexity -- exact result variants are intentionally closed here.
export const mapSettlementResultToV1 = (
  result: DispatchSettlementResult,
): DispatchSettlementResult => {
  const variant = snapshotExactDispatchVariant(result,
    [["status"], ["status", "receipt"], ["status", "reason"]]);
  if (variant?.status === "invalid_request" || variant?.status === "not_found") {
    return Object.freeze({ status: variant.status });
  }
  if (variant?.status === "settled" && "receipt" in variant) {
    const receipt = snapshotExactDispatchRecord(variant.receipt, ["contractVersion", "settlementRequestId",
      "providerId", "authorityGeneration", "consumptionDigest", "disposition",
      "settledAtControlTime"]);
    if (receipt === undefined || receipt.contractVersion !== "contained-turn-dispatch-settlement/v1" ||
        ![receipt.settlementRequestId, receipt.providerId, receipt.authorityGeneration,
          receipt.consumptionDigest].every(isBoundedDispatchIdentifier) ||
        !isSettlementDisposition(receipt.disposition) || !Number.isSafeInteger(receipt.settledAtControlTime) ||
        (receipt.settledAtControlTime as number) < 0) {throw new TypeError("invalid settlement receipt");}
    return Object.freeze({ status: "settled", receipt: Object.freeze({
      contractVersion: "contained-turn-dispatch-settlement/v1" as const,
      settlementRequestId: receipt.settlementRequestId as string,
      providerId: receipt.providerId as string, authorityGeneration: receipt.authorityGeneration as string,
      consumptionDigest: receipt.consumptionDigest as string, disposition: receipt.disposition,
      settledAtControlTime: receipt.settledAtControlTime as number }) });
  }
  if (variant?.status === "conflict" && (variant.reason === "settlement_request_digest_conflict" ||
      variant.reason === "consumption_already_settled")) {
    return Object.freeze({ status: "conflict", reason: variant.reason });
  }
  if (variant?.status === "indeterminate" && variant.reason === "owner_unavailable") {
    return Object.freeze({ status: "indeterminate", reason: variant.reason });
  }
  throw new TypeError("invalid settlement result");
};
