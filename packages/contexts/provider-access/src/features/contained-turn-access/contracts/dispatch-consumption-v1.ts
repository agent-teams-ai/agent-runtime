export const CONTAINED_TURN_PROVIDER_DISPATCH_PURPOSE = "contained-turn.provider-dispatch/v1" as const;

export interface DispatchConsumptionScope { readonly projectId: string; readonly scopeDigest: string; readonly tenantId: string }
export interface DispatchConsumptionBindingExpectation {
  readonly acceptedAuthorityDigest: string; readonly accessRef: string; readonly authorityHeadDigest: string;
  readonly bindingDigest: string; readonly bindingRevision: number; readonly credentialBindingDigest: string;
  readonly credentialBindingRef: string; readonly credentialGeneration: number;
  readonly providerAccountRef: string; readonly providerRouteRef: string;
}
export interface ConsumeForDispatchInput {
  readonly binding: DispatchConsumptionBindingExpectation; readonly claimBindingDigest: string;
  readonly grantRequestId: string; readonly operationId: string; readonly provider: "claude" | "codex";
  readonly purpose: typeof CONTAINED_TURN_PROVIDER_DISPATCH_PURPOSE; readonly requestDigest: string;
  readonly scope: DispatchConsumptionScope;
}
export interface DispatchConsumptionReceipt {
  readonly acceptedAuthorityDigest: string; readonly accessRef: string; readonly authorityHeadDigestAtConsumption: string;
  readonly bindingDigest: string; readonly bindingRevision: number; readonly claimBeforeControlTime: number;
  readonly claimBindingDigest: string; readonly consumedAtControlTime: number; readonly consumptionDigest: string;
  readonly credentialBindingDigest: string; readonly credentialBindingRef: string; readonly credentialGeneration: number;
  readonly grantRequestId: string; readonly opaqueOwnerEvidenceRef: string; readonly operationId: string;
  readonly provider: "claude" | "codex"; readonly providerAccountRef: string; readonly providerRouteRef: string;
  readonly purpose: typeof CONTAINED_TURN_PROVIDER_DISPATCH_PURPOSE; readonly requestDigest: string;
  readonly scope: DispatchConsumptionScope;
}
export type DispatchConsumptionPreventedReason =
  | "accepted_authority_changed" | "access_changed" | "account_changed" | "already_consumed" | "authority_head_changed"
  | "binding_changed" | "claim_binding_mismatch" | "credential_changed" | "credential_rotated"
  | "expired" | "invalid_request" | "provider_mismatch" | "request_digest_mismatch"
  | "revision_changed" | "revoked" | "route_changed" | "scope_mismatch" | "unavailable";
export interface DispatchConsumptionPrevention {
  readonly grantRequestId: string; readonly observedAtControlTime: number; readonly opaqueOwnerEvidenceRef: string;
  readonly reason: DispatchConsumptionPreventedReason; readonly requestDigest: string; readonly scope: DispatchConsumptionScope;
}
export type ConsumeForDispatchOutcome =
  | { readonly kind: "conflict"; readonly reason: "grant_request_digest_conflict" }
  | { readonly kind: "consumed"; readonly receipt: DispatchConsumptionReceipt }
  | { readonly kind: "invalid"; readonly reason: "invalid_request" }
  | { readonly kind: "indeterminate" } | { readonly kind: "not_found" }
  | { readonly kind: "prevented"; readonly prevention: DispatchConsumptionPrevention };
export interface ObserveDispatchConsumptionInput { readonly grantRequestId: string; readonly requestDigest: string; readonly scope: DispatchConsumptionScope }
export type ObserveDispatchConsumptionOutcome = ConsumeForDispatchOutcome;
export type DispatchConsumptionDisposition = "abandoned_without_claim" | "claim_committed";
export interface SettleDispatchConsumptionInput {
  readonly consumptionDigest: string; readonly disposition: DispatchConsumptionDisposition; readonly settlementRequestId: string;
}
export interface DispatchConsumptionSettlementReceipt {
  readonly consumptionDigest: string; readonly disposition: DispatchConsumptionDisposition;
  readonly settledAtControlTime: number; readonly settlementDigest: string; readonly settlementRequestId: string;
}
export type SettleDispatchConsumptionOutcome =
  | { readonly kind: "conflict"; readonly reason: "settlement_request_conflict" }
  | { readonly kind: "invalid"; readonly reason: "invalid_request" }
  | { readonly kind: "indeterminate" } | { readonly kind: "not_found" }
  | { readonly kind: "settled"; readonly receipt: DispatchConsumptionSettlementReceipt };
/** Provider Access-owned V1 contract. No member issues, renews, releases, or reopens access. */
export interface ContainedTurnDispatchConsumptionV1 {
  consumeForDispatch(input: ConsumeForDispatchInput): Promise<ConsumeForDispatchOutcome>;
  observeDispatchConsumption(input: ObserveDispatchConsumptionInput): Promise<ObserveDispatchConsumptionOutcome>;
  settleDispatchConsumption(input: SettleDispatchConsumptionInput): Promise<SettleDispatchConsumptionOutcome>;
}
