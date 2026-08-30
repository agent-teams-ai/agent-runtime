import type {
  DispatchAuthorityScope,
  DispatchPreventionReason,
} from "../domain/dispatch-authority-head.js";
import { validDispatchOwnerEvidenceRef } from "../domain/dispatch-authority-head.js";

export type DispatchConsumptionLifecycle =
  | "consumed_pending"
  | "claim_committed"
  | "abandoned_without_claim";

export type DispatchSettlementDisposition = Exclude<
  DispatchConsumptionLifecycle,
  "consumed_pending"
>;

export interface DispatchConsumptionRecordReceipt {
  readonly contractVersion: "contained-turn-dispatch-consumption/v1";
  readonly purpose: "contained-turn.provider-dispatch/v1";
  readonly operationId: string;
  readonly scope: DispatchAuthorityScope;
  readonly grantRequestId: string;
  readonly requestDigest: string;
  readonly providerId: string;
  readonly authorityGeneration: string;
  readonly providerBindingDigest: string;
  readonly claimBindingDigest: string;
  readonly acceptedAuthorityDigest: string;
  readonly authorityHeadDigestAtConsumption: string;
  readonly authorityRevision: string;
  readonly constraintsDigest: string;
  readonly containmentPolicyDigest: string;
  readonly consumptionDigest: string;
  readonly claimBeforeControlTime: number;
  readonly consumedAtControlTime: number;
  readonly ownerEvidenceRef: string;
}

export interface DispatchPreventionRecord {
  readonly contractVersion: "contained-turn-dispatch-prevention/v1";
  readonly purpose: "contained-turn.provider-dispatch/v1";
  readonly operationId: string;
  readonly scope: DispatchAuthorityScope;
  readonly grantRequestId: string;
  readonly requestDigest: string;
  readonly reason: DispatchPreventionReason;
  readonly preventedAtControlTime: number;
  readonly ownerEvidenceRef?: string;
}

export type DispatchConsumeResult =
  | { readonly status: "consumed"; readonly receipt: DispatchConsumptionRecordReceipt }
  | { readonly status: "prevented"; readonly evidence: DispatchPreventionRecord }
  | { readonly status: "not_found" }
  | { readonly status: "conflict"; readonly reason: "grant_request_digest_conflict" }
  | { readonly status: "indeterminate"; readonly reason: "owner_unavailable" };

export type PersistedDispatchConsumeResult = Exclude<
  DispatchConsumeResult,
  { readonly status: "conflict" | "indeterminate" }
>;

export interface DispatchSettlementRecordReceipt {
  readonly contractVersion: "contained-turn-dispatch-settlement/v1";
  readonly settlementRequestId: string;
  readonly providerId: string;
  readonly authorityGeneration: string;
  readonly consumptionDigest: string;
  readonly disposition: DispatchSettlementDisposition;
  readonly settledAtControlTime: number;
}

export type DispatchSettlementResult =
  | { readonly status: "settled"; readonly receipt: DispatchSettlementRecordReceipt }
  | { readonly status: "invalid_request" }
  | { readonly status: "not_found" }
  | {
      readonly status: "conflict";
      readonly reason: "settlement_request_digest_conflict" | "consumption_already_settled";
    }
  | { readonly status: "indeterminate"; readonly reason: "owner_unavailable" };

export type PersistedDispatchSettlementResult = Exclude<
  DispatchSettlementResult,
  { readonly status: "conflict" | "indeterminate" | "invalid_request" }
>;

export interface DispatchSettlementRequest {
  readonly scope: DispatchAuthorityScope;
  readonly operationId: string;
  readonly providerId: string;
  readonly authorityGeneration: string;
  readonly grantRequestId: string;
  readonly settlementRequestId: string;
  readonly consumptionDigest: string;
  readonly disposition: DispatchSettlementDisposition;
}

export interface DispatchObservationQuery {
  readonly purpose: "contained-turn.provider-dispatch/v1";
  readonly operationId: string;
  readonly scope: DispatchAuthorityScope;
  readonly grantRequestId: string;
  readonly requestDigest: string;
  readonly providerId: string;
  readonly authorityGeneration: string;
  readonly providerBindingDigest: string;
  readonly claimBindingDigest: string;
  readonly acceptedAuthorityDigest: string;
  readonly expectedAuthorityHeadDigest: string;
  readonly expectedAuthorityRevision: string;
  readonly expectedConstraintsDigest: string;
  readonly expectedContainmentPolicyDigest: string;
}

export const isBoundedDispatchIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");

export const isDispatchLifecycle = (value: unknown): value is DispatchConsumptionLifecycle =>
  value === "consumed_pending" ||
  value === "claim_committed" ||
  value === "abandoned_without_claim";

export const isSettlementDisposition = (value: unknown): value is DispatchSettlementDisposition =>
  value === "claim_committed" || value === "abandoned_without_claim";

const sameDispatchScope = (
  left: DispatchAuthorityScope,
  right: DispatchAuthorityScope,
): boolean => left.tenantId === right.tenantId &&
  left.projectId === right.projectId &&
  left.scopeDigest === right.scopeDigest;

export const validConsumptionReceipt = (
  receipt: DispatchConsumptionRecordReceipt,
): boolean => receipt.contractVersion === "contained-turn-dispatch-consumption/v1" &&
  receipt.purpose === "contained-turn.provider-dispatch/v1" &&
  [
    receipt.operationId, receipt.scope.tenantId, receipt.scope.projectId,
    receipt.scope.scopeDigest, receipt.grantRequestId, receipt.requestDigest,
    receipt.providerId, receipt.authorityGeneration,
    receipt.providerBindingDigest,
    receipt.claimBindingDigest, receipt.acceptedAuthorityDigest,
    receipt.authorityHeadDigestAtConsumption, receipt.authorityRevision,
    receipt.constraintsDigest, receipt.containmentPolicyDigest,
    receipt.consumptionDigest,
  ].every(isBoundedDispatchIdentifier) &&
  validDispatchOwnerEvidenceRef(receipt.ownerEvidenceRef) &&
  Number.isSafeInteger(receipt.claimBeforeControlTime) &&
  receipt.claimBeforeControlTime >= 0 &&
  Number.isSafeInteger(receipt.consumedAtControlTime) &&
  receipt.consumedAtControlTime >= 0;

export const sameConsumptionReceipt = (
  left: DispatchConsumptionRecordReceipt,
  right: DispatchConsumptionRecordReceipt,
): boolean => left.contractVersion === right.contractVersion &&
  left.purpose === right.purpose &&
  left.operationId === right.operationId &&
  sameDispatchScope(left.scope, right.scope) &&
  left.grantRequestId === right.grantRequestId &&
  left.requestDigest === right.requestDigest &&
  left.providerId === right.providerId &&
  left.authorityGeneration === right.authorityGeneration &&
  left.providerBindingDigest === right.providerBindingDigest &&
  left.claimBindingDigest === right.claimBindingDigest &&
  left.acceptedAuthorityDigest === right.acceptedAuthorityDigest &&
  left.authorityHeadDigestAtConsumption === right.authorityHeadDigestAtConsumption &&
  left.authorityRevision === right.authorityRevision &&
  left.constraintsDigest === right.constraintsDigest &&
  left.containmentPolicyDigest === right.containmentPolicyDigest &&
  left.consumptionDigest === right.consumptionDigest &&
  left.claimBeforeControlTime === right.claimBeforeControlTime &&
  left.consumedAtControlTime === right.consumedAtControlTime &&
  left.ownerEvidenceRef === right.ownerEvidenceRef;
