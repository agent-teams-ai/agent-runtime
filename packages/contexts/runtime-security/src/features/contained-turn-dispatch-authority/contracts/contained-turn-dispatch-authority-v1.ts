export const CONTAINED_TURN_PROVIDER_DISPATCH_PURPOSE =
  "contained-turn.provider-dispatch/v1" as const;

export interface DispatchAuthorityScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly scopeDigest: string;
}

export interface ConsumeForDispatchInput {
  readonly purpose: typeof CONTAINED_TURN_PROVIDER_DISPATCH_PURPOSE;
  readonly operationId: string;
  readonly scope: DispatchAuthorityScope;
  readonly grantRequestId: string;
  readonly requestDigest: string;
  /** Provider-neutral opaque identity; never a credential, SDK, path, or environment value. */
  readonly providerId: string;
  /** Distinct accepted-authority generation; never inferred from a revision. */
  readonly authorityGeneration: string;
  readonly providerBindingDigest: string;
  readonly claimBindingDigest: string;
  readonly acceptedAuthorityDigest: string;
  readonly expectedAuthorityHeadDigest: string;
  readonly expectedAuthorityRevision: string;
  readonly expectedConstraintsDigest: string;
  readonly expectedContainmentPolicyDigest: string;
}

export type DispatchPreventionReason =
  | "accepted_authority_changed"
  | "already_consumed"
  | "authority_revision_stale"
  | "claim_binding_mismatch"
  | "constraints_drift"
  | "containment_policy_drift"
  | "expired"
  | "invalid_request"
  | "provider_binding_mismatch"
  | "request_digest_mismatch"
  | "revoked";

export interface DispatchConsumptionReceipt {
  readonly contractVersion: "contained-turn-dispatch-consumption/v1";
  readonly purpose: typeof CONTAINED_TURN_PROVIDER_DISPATCH_PURPOSE;
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

export interface DispatchPreventionEvidence {
  readonly contractVersion: "contained-turn-dispatch-prevention/v1";
  readonly purpose: typeof CONTAINED_TURN_PROVIDER_DISPATCH_PURPOSE;
  readonly operationId: string;
  readonly scope: DispatchAuthorityScope;
  readonly grantRequestId: string;
  readonly requestDigest: string;
  readonly reason: DispatchPreventionReason;
  readonly preventedAtControlTime: number;
  readonly ownerEvidenceRef?: string;
}

export type ConsumeForDispatchOutcome =
  | { readonly status: "consumed"; readonly receipt: DispatchConsumptionReceipt }
  | { readonly status: "prevented"; readonly evidence: DispatchPreventionEvidence }
  | { readonly status: "not_found" }
  | { readonly status: "conflict"; readonly reason: "grant_request_digest_conflict" }
  | { readonly status: "indeterminate"; readonly reason: "owner_unavailable" };

export interface ObserveDispatchConsumptionInput extends ConsumeForDispatchInput {}

export type DispatchConsumptionLifecycleState =
  | "consumed_pending"
  | "claim_committed"
  | "abandoned_without_claim";

export type ObserveDispatchConsumptionOutcome =
  | {
      readonly status: "consumed";
      readonly receipt: DispatchConsumptionReceipt;
      readonly lifecycleState: DispatchConsumptionLifecycleState;
    }
  | { readonly status: "prevented"; readonly evidence: DispatchPreventionEvidence }
  | { readonly status: "not_found" }
  | { readonly status: "conflict"; readonly reason: "grant_request_digest_conflict" }
  | { readonly status: "indeterminate"; readonly reason: "owner_unavailable" };

export type DispatchSettlementDisposition =
  | "claim_committed"
  | "abandoned_without_claim";

export interface SettleDispatchConsumptionInput {
  readonly scope: DispatchAuthorityScope;
  readonly operationId: string;
  readonly providerId: string;
  readonly authorityGeneration: string;
  readonly grantRequestId: string;
  readonly settlementRequestId: string;
  readonly consumptionDigest: string;
  readonly disposition: DispatchSettlementDisposition;
}

export interface DispatchConsumptionSettlementReceipt {
  readonly contractVersion: "contained-turn-dispatch-settlement/v1";
  readonly settlementRequestId: string;
  readonly providerId: string;
  readonly authorityGeneration: string;
  readonly consumptionDigest: string;
  readonly disposition: DispatchSettlementDisposition;
  readonly settledAtControlTime: number;
}

export type SettleDispatchConsumptionOutcome =
  | { readonly status: "settled"; readonly receipt: DispatchConsumptionSettlementReceipt }
  | { readonly status: "invalid_request" }
  | { readonly status: "not_found" }
  | {
      readonly status: "conflict";
      readonly reason:
        | "settlement_request_digest_conflict"
        | "consumption_already_settled";
    }
  | { readonly status: "indeterminate"; readonly reason: "owner_unavailable" };

/** The complete, separately versioned V1 capability surface. */
export interface ContainedTurnDispatchAuthorityV1 {
  consumeForDispatch(input: ConsumeForDispatchInput): Promise<ConsumeForDispatchOutcome>;
  observeDispatchConsumption(
    input: ObserveDispatchConsumptionInput,
  ): Promise<ObserveDispatchConsumptionOutcome>;
  settleDispatchConsumption(
    input: SettleDispatchConsumptionInput,
  ): Promise<SettleDispatchConsumptionOutcome>;
}
