import type { ContainedTurnDispatchAuthorityV1, DispatchConsumptionReceipt,
  ObserveDispatchConsumptionInput } from
  "../contained-turn-dispatch-authority/contracts/contained-turn-dispatch-authority-v1.js";

export interface TrustedEgressHostIdentityV1 {
  readonly attemptId: string; readonly environmentId: string; readonly gatewayId: string;
  readonly hostInstanceId: string; readonly hostBootId: string; readonly transportMode: "one_shot_https";
}
export type NetworkAddressV1 = Readonly<{family: "ipv4"; bytesHex: string}> |
  Readonly<{family: "ipv6"; bytesHex: string}>;
export interface ContainedTurnEgressRequest {
  readonly scope: Readonly<{tenantId: string; projectId: string; scopeDigest: string}>;
  readonly providerId: string; readonly providerAccountRef: string; readonly providerRouteRef: string;
  readonly credentialBindingRef: string; readonly credentialBindingDigest: string;
  readonly credentialGeneration: string; readonly credentialRevision: string;
  readonly operationId: string; readonly dispatch: ObserveDispatchConsumptionInput;
  readonly requestId: string; readonly requestNonce: string; readonly method: "GET" | "POST";
  /** Ephemeral transport target only. It is represented by pathDigest in authorization evidence. */
  readonly path: string; readonly headers: readonly Readonly<{name: string; value: string}>[];
  readonly body: Uint8Array;
  readonly budgets: Readonly<{requestBytes: number; responseBytes: number; deadlineMs: number}>;
}
export type ContainedTurnEgressResult =
  | Readonly<{status: "completed"; responseDigest: string; responseBytes: number;
      applicationBytesDigest: string; applicationBytesWritten: number}>
  | Readonly<{status: "denied"; reason: "invalid_request" | "route_unavailable" | "route_mismatch" |
      "dispatch_not_committed" | "authority_unavailable" | "authority_drift" | "address_denied" |
      "tls_peer_mismatch" | "expired" | "budget_exceeded" | "authorization_invalid" |
      "transport_denied"; deniedApplicationBytes: 0}>
  | Readonly<{status: "indeterminate"; reason: "first_write_indeterminate" | "response_invalid" | "close_failed"}>;

export interface ProviderRouteAuthoritySnapshotV1 {
  readonly contractVersion: "provider-route-authority/v1";
  readonly tenantId: string; readonly projectId: string; readonly providerId: string;
  readonly providerAccountRef: string; readonly providerRouteRef: string;
  readonly credentialBindingRef: string; readonly credentialBindingDigest: string;
  readonly credentialGeneration: string; readonly credentialRevision: string;
  readonly routeRevision: string; readonly authorityDigest: string; readonly scheme: "https";
  readonly host: string; readonly port: 443; readonly tlsServerName: string; readonly pathConstraint: string;
  readonly allowedTlsSpkiDigests: readonly string[]; readonly tlsPinSetDigest: string;
  readonly tlsPinSetGeneration: string; readonly tlsPinSetRevision: string;
}
export type ProviderRouteRevalidationV1 = Readonly<{status: "current"}> |
  Readonly<{status: "rejected"; reason: "changed" | "revoked" | "not_found"}> |
  Readonly<{status: "indeterminate"}>;
export interface ProviderRouteAuthorityV1 {
  resolveExact(input: Readonly<{tenantId: string; projectId: string; providerId: string;
    providerAccountRef: string; providerRouteRef: string; credentialBindingRef: string;
    credentialBindingDigest: string; credentialGeneration: string;
    credentialRevision: string}>): PromiseLike<ProviderRouteAuthoritySnapshotV1>;
  revalidateExact(expected: ProviderRouteAuthoritySnapshotV1): PromiseLike<ProviderRouteRevalidationV1>;
}
export interface EgressPolicyTimeSnapshotV1 {
  readonly contractVersion: "contained-turn-egress-policy/v1";
  readonly policyId: string; readonly policyRevision: string; readonly policyGeneration: string;
  readonly keyId: string; readonly keyGeneration: string; readonly signerRevision: string;
  readonly timeAuthorityId: string; readonly timeGeneration: string; readonly observedAt: number;
  readonly expiresAt: number; readonly maxRequestBytes: number; readonly maxResponseBytes: number;
  readonly maxDeadlineMs: number;
}
export interface EgressPolicyTimeAuthorityV1 {
  resolve(): PromiseLike<EgressPolicyTimeSnapshotV1>;
  revalidateExact(expected: EgressPolicyTimeSnapshotV1): PromiseLike<Readonly<{status: "current"; observedAt: number}> |
    Readonly<{status: "rejected"}> | Readonly<{status: "indeterminate"}>>;
}
export interface EgressAuthorizationEnvelopeV1 {
  readonly keyId: string; readonly keyGeneration: string; readonly signerRevision: string;
  readonly digest: string; readonly signature: string;
}
export interface EgressAuthorizationSignerV1 {
  sign(canonicalBody: Uint8Array, key: Readonly<{keyId: string; keyGeneration: string;
    signerRevision: string}>): unknown;
  verify(canonicalBody: Uint8Array, envelope: EgressAuthorizationEnvelopeV1): unknown;
}
export interface EgressAuthorizationBodyV1 {
  readonly contractVersion: "contained-turn-egress-authorization-body/v1";
  readonly tenantId: string; readonly projectId: string; readonly scopeDigest: string;
  readonly providerId: string; readonly providerAccountRef: string; readonly providerRouteRef: string;
  readonly credentialBindingRef: string; readonly credentialBindingDigest: string;
  readonly credentialGeneration: string; readonly credentialRevision: string;
  readonly routeRevision: string; readonly routeAuthorityDigest: string; readonly operationId: string;
  readonly attemptId: string; readonly dispatchReceipt: DispatchConsumptionReceipt;
  readonly requestId: string; readonly requestNonce: string; readonly environmentId: string;
  readonly gatewayId: string; readonly hostInstanceId: string; readonly hostBootId: string;
  readonly transportMode: "one_shot_https"; readonly policyId: string; readonly policyRevision: string;
  readonly policyGeneration: string; readonly keyId: string; readonly keyGeneration: string;
  readonly signerRevision: string; readonly timeAuthorityId: string; readonly timeGeneration: string;
  readonly issuedAt: number; readonly expiresAt: number; readonly target: Readonly<{scheme: "https";
    host: string; port: 443; tlsServerName: string; pathDigest: string}>;
  readonly allowedTlsSpkiDigests: readonly string[]; readonly tlsPinSetDigest: string;
  readonly tlsPinSetGeneration: string; readonly tlsPinSetRevision: string;
  readonly resolutionAuthorityId: string; readonly resolutionGeneration: string; readonly answerSetDigest: string;
  readonly addresses: readonly NetworkAddressV1[]; readonly peerAddress: NetworkAddressV1;
  readonly peerPort: 443; readonly tlsSpkiDigest: string; readonly alpn: "http/1.1";
  readonly method: "GET" | "POST"; readonly headerDigest: string; readonly bodyDigest: string;
  readonly requestDigest: string; readonly applicationBytesDigest: string; readonly applicationBytes: number;
  readonly budgets: Readonly<{requestBytes: number; responseBytes: number; deadlineMs: number}>;
  readonly policyMaxima: Readonly<{requestBytes: number; responseBytes: number; deadlineMs: number}>;
}
export interface BufferedEgressRequestV1 {
  readonly method: "GET" | "POST"; readonly headers: readonly Readonly<{name: string; value: string}>[];
  readonly body: Uint8Array;
}
export interface ExactFirstWriteReceiptV1 { readonly status: "written"; readonly authorizationDigest: string;
  readonly applicationBytesDigest: string; readonly applicationBytesWritten: number }
export interface EgressTransportObservationV1 {
  readonly canonicalAddresses: readonly NetworkAddressV1[]; readonly peerAddress: NetworkAddressV1;
  readonly peerPort: 443; readonly tlsServerName: string; readonly tlsSpkiDigest: string; readonly alpn: "http/1.1";
  readonly phase: "immediately_before_first_application_byte"; readonly resolutionAuthorityId: string;
  readonly resolutionGeneration: string; readonly answerSetDigest: string;
  readonly applicationBytesDigest: string; readonly applicationBytes: number;
}
export interface EgressTransportV1 {
  execute(input: Readonly<{target: Readonly<{scheme: "https"; host: string; port: 443;
      tlsServerName: string; path: string}>; request: BufferedEgressRequestV1; responseByteLimit: number;
    deadlineMs: number; beforeFirstWrite(observation: unknown,
      write: (authorization: Readonly<{body: EgressAuthorizationBodyV1; canonicalBody: Uint8Array;
        envelope: EgressAuthorizationEnvelopeV1}>) => unknown): Promise<Readonly<{status: "written"}> |
          Readonly<{status: "denied"}>>}>): PromiseLike<unknown>;
  close(): PromiseLike<void>;
}
export interface EgressTransportGatewayV1 { openOneShotHttps(): PromiseLike<unknown> }
export interface ContainedTurnEgressDependencies {
  readonly routeAuthority: ProviderRouteAuthorityV1;
  readonly dispatchAuthority: Pick<ContainedTurnDispatchAuthorityV1, "observeDispatchConsumption">;
  readonly policyAuthority: EgressPolicyTimeAuthorityV1; readonly signer: EgressAuthorizationSignerV1;
  readonly transportGateway: EgressTransportGatewayV1;
}
export interface ContainedTurnEgress {
  exchange(request: ContainedTurnEgressRequest): Promise<ContainedTurnEgressResult>;
  dispose(): Promise<"closed" | "quarantined">;
}
