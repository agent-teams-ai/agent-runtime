export interface ProviderRouteAuthoritySnapshotV1 {
  readonly contractVersion: "provider-route-authority/v1";
  readonly tenantId: string; readonly projectId: string; readonly scopeDigest: string; readonly providerId: string;
  readonly providerAccountRef: string; readonly providerRouteRef: string;
  readonly credentialBindingRef: string; readonly credentialBindingDigest: string;
  readonly credentialGeneration: string; readonly credentialRevision: string;
  readonly accessRef: string; readonly accessRevision: string;
  readonly routeRevision: string; readonly authorityDigest: string; readonly scheme: "https";
  readonly host: string; readonly port: 443; readonly tlsServerName: string; readonly pathConstraint: string;
  readonly allowedTlsSpkiDigests: readonly string[]; readonly tlsPinSetDigest: string;
  readonly tlsPinSetGeneration: string; readonly tlsPinSetRevision: string;
  readonly resolutionAuthorityId: string; readonly resolutionGeneration: string;
}
export type ProviderRouteRevalidationV1 = Readonly<{status: "current"}> |
  Readonly<{status: "rejected"; reason: "changed" | "revoked" | "not_found"}> |
  Readonly<{status: "indeterminate"}>;
