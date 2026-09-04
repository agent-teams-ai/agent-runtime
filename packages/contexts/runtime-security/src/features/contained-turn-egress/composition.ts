import type { KeyObject } from "node:crypto";

export interface TrustedEgressHostIdentityV1 {
  readonly attemptId: string;
  readonly environmentId: string;
  readonly gatewayId: string;
  readonly hostInstanceId: string;
  readonly hostBootId: string;
  readonly transportMode: "one_shot_https";
}

export interface ContainedTurnEgressRequest {
  readonly scope: Readonly<{tenantId: string; projectId: string; scopeDigest: string}>;
  readonly providerId: string;
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly operationId: string;
  readonly dispatch: Readonly<{
    grantRequestId: string;
    grantProofId: string;
    claimProofId: string;
    claimBindingDigest: string;
    consumptionDigest: string;
  }>;
  readonly requestId: string;
  readonly requestNonce: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly headers: readonly Readonly<{name: string; value: string}>[];
  readonly body: Uint8Array;
  readonly budgets: Readonly<{requestBytes: number; responseBytes: number; deadlineMs: number}>;
}

export type ContainedTurnEgressResult =
  | Readonly<{status: "completed"; responseDigest: string; responseBytes: number}>
  | Readonly<{status: "denied"; reason: "invalid_request" | "route_unavailable" |
      "route_mismatch" | "dispatch_not_committed" | "authority_unavailable" |
      "authority_drift" | "address_denied" | "tls_peer_mismatch" | "expired" |
      "budget_exceeded" | "authorization_invalid" | "transport_denied";
      deniedApplicationBytes: 0}>
  | Readonly<{status: "indeterminate"; reason: "first_write_indeterminate" |
      "response_invalid" | "close_failed"}>;

export interface ProviderRouteAuthoritySnapshotV1 {
  readonly contractVersion: "provider-route-authority/v1";
  readonly tenantId: string; readonly projectId: string; readonly providerId: string;
  readonly providerAccountRef: string; readonly providerRouteRef: string;
  readonly routeRevision: string; readonly authorityDigest: string; readonly scheme: "https";
  readonly host: string; readonly port: 443; readonly tlsServerName: string;
  readonly pathConstraint: string;
}
export type ProviderRouteRevalidationV1 = Readonly<{status: "current"}> |
  Readonly<{status: "rejected"; reason: "changed" | "revoked" | "not_found"}> |
  Readonly<{status: "indeterminate"}>;
export interface ProviderRouteAuthorityV1 {
  resolveExact(input: Readonly<{tenantId: string; projectId: string; providerId: string;
    providerAccountRef: string; providerRouteRef: string}>): Promise<ProviderRouteAuthoritySnapshotV1>;
  revalidateExact(expected: ProviderRouteAuthoritySnapshotV1): Promise<ProviderRouteRevalidationV1>;
}

export interface ConsumedDispatchAuthorityV1 {
  revalidateClaimCommitted(expected: Readonly<{tenantId: string; projectId: string;
    scopeDigest: string; providerId: string; operationId: string; attemptId: string;
    grantRequestId: string; grantProofId: string; claimProofId: string;
    claimBindingDigest: string; consumptionDigest: string}>): Promise<Readonly<{status: "claim_committed"}> |
      Readonly<{status: "rejected"}> | Readonly<{status: "indeterminate"}>>;
}

export interface EgressPolicyTimeSnapshotV1 {
  readonly contractVersion: "contained-turn-egress-policy/v1";
  readonly policyId: string; readonly policyRevision: string; readonly policyGeneration: string;
  readonly keyId: string; readonly keyGeneration: string; readonly signerRevision: string;
  readonly timeAuthorityId: string; readonly timeGeneration: string;
  readonly observedAt: number; readonly expiresAt: number; readonly maxRequestBytes: number;
  readonly maxResponseBytes: number; readonly maxDeadlineMs: number;
}
export interface EgressPolicyTimeAuthorityV1 {
  resolve(): Promise<EgressPolicyTimeSnapshotV1>;
  revalidateExact(expected: EgressPolicyTimeSnapshotV1): Promise<Readonly<{
    status: "current"; observedAt: number}> | Readonly<{status: "rejected"}> |
    Readonly<{status: "indeterminate"}>>;
}

export interface EgressAuthorizationEnvelopeV1 {
  readonly keyId: string;
  readonly keyGeneration: string;
  readonly signerRevision: string;
  readonly digest: string;
  readonly signature: string;
}

export interface EgressAuthorizationSignerV1 {
  sign(canonicalBody: string, key: Readonly<{keyId: string; keyGeneration: string;
    signerRevision: string}>): unknown;
  verify(canonicalBody: string, envelope: EgressAuthorizationEnvelopeV1): boolean;
}

export interface EgressAuthorizationBodyV1 {
  readonly contractVersion: "contained-turn-egress-authorization-body/v1";
  readonly tenantId: string; readonly projectId: string; readonly scopeDigest: string;
  readonly providerId: string; readonly providerAccountRef: string; readonly providerRouteRef: string;
  readonly routeRevision: string; readonly routeAuthorityDigest: string; readonly operationId: string;
  readonly attemptId: string; readonly grantRequestId: string; readonly grantProofId: string;
  readonly claimProofId: string; readonly claimBindingDigest: string; readonly consumptionDigest: string;
  readonly requestId: string; readonly requestNonce: string; readonly environmentId: string;
  readonly gatewayId: string; readonly hostInstanceId: string; readonly hostBootId: string;
  readonly transportMode: "one_shot_https"; readonly policyId: string; readonly policyRevision: string;
  readonly policyGeneration: string; readonly keyId: string; readonly keyGeneration: string;
  readonly signerRevision: string; readonly timeAuthorityId: string; readonly timeGeneration: string;
  readonly issuedAt: number; readonly expiresAt: number; readonly target: Readonly<{scheme: "https";
    host: string; port: 443; tlsServerName: string; path: string}>; readonly addresses: readonly string[];
  readonly peerAddress: string; readonly peerPort: 443; readonly tlsSpkiDigest: string;
  readonly alpn: "http/1.1"; readonly method: "GET" | "POST"; readonly headerDigest: string;
  readonly bodyDigest: string; readonly requestDigest: string; readonly requestBytes: number;
  readonly budgets: Readonly<{requestBytes: number; responseBytes: number; deadlineMs: number}>;
  readonly policyMaxima: Readonly<{requestBytes: number; responseBytes: number; deadlineMs: number}>;
}

export interface BufferedEgressRequestV1 {
  readonly method: "GET" | "POST";
  readonly headers: readonly Readonly<{name: string; value: string}>[];
  readonly body: Uint8Array;
}

export interface EgressTransportV1 {
  execute(input: Readonly<{
    target: Readonly<{scheme: "https"; host: string; port: 443; tlsServerName: string; path: string}>;
    request: BufferedEgressRequestV1;
    responseByteLimit: number;
    deadlineMs: number;
    beforeFirstByte(observation: unknown): Promise<Readonly<{
      status: "authorized"; body: string; envelope: EgressAuthorizationEnvelopeV1;
    }> | Readonly<{status: "denied"}>>;
  }>): Promise<unknown>;
  close(): Promise<void>;
}

export interface EgressTransportGatewayV1 {
  openOneShotHttps(): Promise<unknown>;
}

export interface ContainedTurnEgressDependencies {
  readonly routeAuthority: ProviderRouteAuthorityV1;
  readonly dispatchAuthority: ConsumedDispatchAuthorityV1;
  readonly policyAuthority: EgressPolicyTimeAuthorityV1;
  readonly signer: EgressAuthorizationSignerV1;
  readonly transportGateway: EgressTransportGatewayV1;
}

export interface ContainedTurnEgress {
  exchange(request: ContainedTurnEgressRequest): Promise<ContainedTurnEgressResult>;
  dispose(): Promise<"closed" | "quarantined">;
}

export interface NodeEd25519SignerIdentity {
  readonly keyId: string;
  readonly keyGeneration: string;
  readonly signerRevision: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}
