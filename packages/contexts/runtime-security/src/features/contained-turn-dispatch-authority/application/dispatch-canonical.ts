import type {
  DispatchConsumptionRecordReceipt,
  DispatchSettlementRequest,
} from "./dispatch-consumption-models.js";
import type {
  DispatchAuthorityHead,
  DispatchConsumeRequest,
} from "../domain/dispatch-authority-head.js";

const canonical = (values: readonly string[]): string =>
  values.map(value => `${value.length}:${value}`).join("");

export const consumptionCanonical = (
  input: DispatchConsumeRequest,
  head: DispatchAuthorityHead,
  consumedAt: number,
): string => canonical([
  "contained-turn-dispatch-consumption/v1", input.purpose, input.operationId,
  input.scope.tenantId, input.scope.projectId, input.scope.scopeDigest,
  input.grantRequestId, input.requestDigest, input.providerId, input.authorityGeneration,
  input.providerBindingDigest,
  input.claimBindingDigest,
  head.acceptedAuthorityDigest, head.authorityHeadDigest, head.authorityRevision,
  head.constraintsDigest, head.containmentPolicyDigest,
  String(head.claimBeforeControlTime), String(consumedAt), head.ownerEvidenceRef,
]);

export const consumptionReceiptCanonical = (
  receipt: Omit<DispatchConsumptionRecordReceipt, "consumptionDigest">,
): string => canonical([
  receipt.contractVersion, receipt.purpose, receipt.operationId,
  receipt.scope.tenantId, receipt.scope.projectId, receipt.scope.scopeDigest,
  receipt.grantRequestId, receipt.requestDigest, receipt.providerId,
  receipt.authorityGeneration, receipt.providerBindingDigest, receipt.claimBindingDigest,
  receipt.acceptedAuthorityDigest, receipt.authorityHeadDigestAtConsumption,
  receipt.authorityRevision, receipt.constraintsDigest, receipt.containmentPolicyDigest,
  String(receipt.claimBeforeControlTime), String(receipt.consumedAtControlTime),
  receipt.ownerEvidenceRef,
]);

export const settlementCanonical = (input: DispatchSettlementRequest): string => canonical([
  "contained-turn-dispatch-settlement-request/v1",
  input.scope.tenantId, input.scope.projectId, input.scope.scopeDigest,
  input.providerId, input.authorityGeneration, input.operationId, input.grantRequestId,
  input.settlementRequestId,
  input.consumptionDigest,
  input.disposition,
]);

export const requestCanonical = (input: DispatchConsumeRequest): string => canonical([
  "contained-turn-dispatch-consume-request/v1", input.purpose, input.operationId,
  input.scope.tenantId, input.scope.projectId, input.scope.scopeDigest,
  input.grantRequestId, input.requestDigest, input.providerId, input.authorityGeneration,
  input.providerBindingDigest,
  input.claimBindingDigest,
  input.acceptedAuthorityDigest, input.expectedAuthorityHeadDigest,
  input.expectedAuthorityRevision, input.expectedConstraintsDigest,
  input.expectedContainmentPolicyDigest,
]);
