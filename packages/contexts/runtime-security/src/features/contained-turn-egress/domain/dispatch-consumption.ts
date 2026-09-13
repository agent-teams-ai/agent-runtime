export const EGRESS_DISPATCH_PURPOSE = "contained-turn.provider-dispatch/v1" as const;

export interface EgressDispatchScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly scopeDigest: string;
}

export interface EgressDispatchObservation {
  readonly purpose: typeof EGRESS_DISPATCH_PURPOSE;
  readonly operationId: string;
  readonly scope: EgressDispatchScope;
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

export interface EgressDispatchConsumptionReceipt {
  readonly contractVersion: "contained-turn-dispatch-consumption/v1";
  readonly purpose: typeof EGRESS_DISPATCH_PURPOSE;
  readonly operationId: string;
  readonly scope: EgressDispatchScope;
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
