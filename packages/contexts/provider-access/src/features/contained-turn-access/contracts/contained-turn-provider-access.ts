export type ProviderAccessProvider = "claude" | "codex";

export interface ProviderAccessScope {
  readonly projectId: string;
  readonly tenantId: string;
}

export interface ContainedTurnProviderAccessBinding {
  readonly accessRef: string;
  readonly adapterRevision: string;
  readonly binaryRevision: string;
  readonly capabilityManifestRevision: string;
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

export type ResolveContainedTurnProviderAccessOutcome =
  | { readonly kind: "resolved"; readonly binding: ContainedTurnProviderAccessBinding }
  | { readonly kind: "unavailable"; readonly reason: "not_found" | "revoked" };

export interface ResolveContainedTurnProviderAccess {
  execute(input: {
    readonly provider: ProviderAccessProvider;
    readonly scope: ProviderAccessScope;
  }): Promise<ResolveContainedTurnProviderAccessOutcome>;
}

export interface ContainedTurnProviderAccessFeatureApi {
  readonly resolve: ResolveContainedTurnProviderAccess;
}
