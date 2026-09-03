export type ProviderAccessProvider = "claude" | "codex";

export interface ProviderAccessScope {
  readonly projectId: string;
  readonly tenantId: string;
}

/** Non-secret facts owned by Provider Access for one exact contained-turn route. */
export interface ContainedTurnProviderAccessBinding {
  readonly accessRef: string;
  readonly credentialBindingDigest: string;
  readonly credentialBindingRef: string;
  readonly credentialGeneration: number;
  readonly projectId: string;
  readonly provider: ProviderAccessProvider;
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly revision: number;
  readonly tenantId: string;
}

/** Opaque Provider Access-owned evidence; consumers preserve it through their ACL. */
export interface ProviderAccessAuthorityEvidence {
  readonly authorityDigest: string;
  readonly bindingAuthorityDigest: string;
  readonly purpose: "acceptance" | "dispatch";
  readonly proofRef: string;
}

export type ProviderAccessUnavailableReason =
  | "indeterminate"
  | "not_found"
  | "revoked"
  | "unavailable";

export type ResolveContainedTurnProviderAccessOutcome =
  | { readonly binding: ContainedTurnProviderAccessBinding; readonly evidence: ProviderAccessAuthorityEvidence; readonly kind: "resolved" }
  | { readonly evidence: ProviderAccessAuthorityEvidence; readonly kind: "unavailable"; readonly reason: ProviderAccessUnavailableReason };

export interface ResolveContainedTurnProviderAccessInput {
  readonly provider: ProviderAccessProvider;
  readonly scope: ProviderAccessScope;
}

export interface ResolveContainedTurnProviderAccess {
  execute(input: ResolveContainedTurnProviderAccessInput): Promise<ResolveContainedTurnProviderAccessOutcome>;
}

export type RevalidateContainedTurnProviderAccessRejection =
  | ProviderAccessUnavailableReason
  | "access_changed"
  | "account_changed"
  | "credential_changed"
  | "credential_rotated"
  | "provider_mismatch"
  | "revision_changed"
  | "route_changed"
  | "scope_mismatch";

export type RevalidateContainedTurnProviderAccessOutcome =
  | { readonly binding: ContainedTurnProviderAccessBinding; readonly evidence: ProviderAccessAuthorityEvidence; readonly kind: "valid" }
  | { readonly evidence: ProviderAccessAuthorityEvidence; readonly kind: "rejected"; readonly reason: RevalidateContainedTurnProviderAccessRejection };

export interface RevalidateContainedTurnProviderAccessInput {
  readonly binding: ContainedTurnProviderAccessBinding;
  readonly provider: ProviderAccessProvider;
  readonly scope: ProviderAccessScope;
}

export interface RevalidateContainedTurnProviderAccess {
  execute(input: RevalidateContainedTurnProviderAccessInput): Promise<RevalidateContainedTurnProviderAccessOutcome>;
}

export interface ContainedTurnProviderAccessFeatureApi {
  readonly resolve: ResolveContainedTurnProviderAccess;
  readonly revalidate: RevalidateContainedTurnProviderAccess;
}
