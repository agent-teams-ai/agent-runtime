import type { ProviderRouteAuthoritySnapshotV1, ProviderRouteRevalidationV1 } from
  "../../../domain/provider-route-authority.js";

export interface ProviderRouteAuthorityV1 {
  resolveExact(input: Readonly<{tenantId: string; projectId: string; scopeDigest: string; providerId: string;
    providerAccountRef: string; providerRouteRef: string; credentialBindingRef: string;
    credentialBindingDigest: string; credentialGeneration: string;
    credentialRevision: string; resolutionAuthorityId: string;
    resolutionGeneration: string}>): PromiseLike<ProviderRouteAuthoritySnapshotV1>;
  revalidateExact(expected: ProviderRouteAuthoritySnapshotV1): PromiseLike<ProviderRouteRevalidationV1>;
}
