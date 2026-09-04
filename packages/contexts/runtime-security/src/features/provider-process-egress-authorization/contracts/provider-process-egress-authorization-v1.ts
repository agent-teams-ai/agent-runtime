export const PROVIDER_PROCESS_EGRESS_PROVISIONAL_V1 =
  "provider-process-egress-provisional/v1" as const;
export const PROVIDER_PROCESS_EGRESS_FINAL_V1 =
  "provider-process-egress-final/v1" as const;

export interface EgressScopeV1 {
  readonly operationId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly scopeDigest: string;
}

export interface EgressProviderRouteV1 {
  readonly providerRef: string;
  readonly accountRef: string;
  readonly routeRef: string;
  readonly routeDigest: string;
  readonly credentialBindingDigest: string;
}

export interface EgressAuthorityGenerationsV1 {
  readonly policy: string;
  readonly key: string;
  readonly route: string;
  readonly credential: string;
}

export interface EgressTlsOriginV1 {
  readonly scheme: "https";
  readonly hostname: string;
  readonly port: number;
}

export interface EgressResolverObservationV1 {
  readonly resolverIdentity: string;
  readonly resolverEpoch: string;
  readonly resolutionCount: number;
  readonly addresses: readonly EgressCandidateAddressV1[];
}

export interface EgressResolverAuthorityV1 {
  readonly resolverIdentity: string;
  readonly resolverEpoch: string;
}

export interface EgressCandidateAddressV1 {
  readonly family: "ipv4" | "ipv6";
  readonly address: string;
  readonly classification:
    | "public" | "private" | "loopback" | "link-local" | "metadata"
    | "multicast" | "unspecified" | "ula" | "mapped" | "reserved";
}

export interface EgressBudgetsV1 {
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly totalMilliseconds: number;
}

export interface EgressRequestIntentV1 {
  readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly pathAndQuery: string;
  readonly bodyDigest: string;
  readonly mediaType: string;
  readonly applicationProtocol: "http/1.1" | "h2" | "h3";
  readonly transportMode: "direct-tls" | "connect" | "socks" | "generic-proxy";
  readonly upgradeMode: "none" | "websocket" | "generic";
}

export interface EgressCertificateExpectationV1 {
  readonly dnsIdentity: string;
  readonly certificateDigest: string;
}

export interface RequestProvisionalEgressAuthorizationV1 {
  readonly contractVersion: typeof PROVIDER_PROCESS_EGRESS_PROVISIONAL_V1;
  readonly authorizationRequestId: string;
  readonly scope: EgressScopeV1;
  readonly providerRoute: EgressProviderRouteV1;
  readonly generations: EgressAuthorityGenerationsV1;
  readonly origin: EgressTlsOriginV1;
  readonly resolverAuthority: EgressResolverAuthorityV1;
  readonly certificate: EgressCertificateExpectationV1;
  readonly redirectHop: number;
  readonly budgets: EgressBudgetsV1;
  readonly expiresAtControlTime: number;
  readonly requestIntent: EgressRequestIntentV1;
}

export interface ProvisionalEgressAuthorizationV1 {
  readonly contractVersion: "provider-process-egress-provisional-decision/v1";
  readonly authorizationRequestId: string;
  readonly scope: EgressScopeV1;
  readonly providerRoute: EgressProviderRouteV1;
  readonly generations: EgressAuthorityGenerationsV1;
  readonly origin: EgressTlsOriginV1;
  readonly resolverAuthority: EgressResolverAuthorityV1;
  readonly certificate: EgressCertificateExpectationV1;
  readonly redirectHop: 0;
  readonly budgets: EgressBudgetsV1;
  readonly expiresAtControlTime: number;
  readonly requestIntentDigest: string;
  readonly decisionDigest: string;
  readonly signature: {
    readonly keyRef: string;
    readonly keyGeneration: string;
    readonly value: string;
  };
}

export type EgressAuthorizationIssueCode =
  | "invalid_input"
  | "unsupported_transport"
  | "unsupported_protocol"
  | "unsupported_proxy"
  | "unsupported_upgrade"
  | "redirect_denied"
  | "origin_invalid"
  | "address_denied"
  | "address_duplicate"
  | "address_set_mixed"
  | "resolver_mismatch"
  | "address_set_mismatch"
  | "scope_mismatch"
  | "provider_mismatch"
  | "account_mismatch"
  | "route_mismatch"
  | "credential_mismatch"
  | "policy_generation_mismatch"
  | "key_generation_mismatch"
  | "route_generation_mismatch"
  | "credential_generation_mismatch"
  | "revoked"
  | "expired"
  | "control_time_mismatch"
  | "provisional_digest_invalid"
  | "provisional_signature_invalid"
  | "pinned_destination_mismatch"
  | "peer_mismatch"
  | "sni_mismatch"
  | "certificate_invalid"
  | "certificate_mismatch"
  | "alpn_mismatch"
  | "budget_mismatch"
  | "request_intent_mismatch";

export interface EgressDenialEvidenceV1 {
  readonly contractVersion: "provider-process-egress-denial-evidence/v1";
  readonly phase: "provisional" | "final";
  readonly issueCode: EgressAuthorizationIssueCode;
  readonly authorizationRef: string;
  readonly decisionDigest?: string;
}

export type RequestProvisionalEgressAuthorizationOutcomeV1 =
  | { readonly status: "authorized"; readonly decision: ProvisionalEgressAuthorizationV1 }
  | { readonly status: "denied"; readonly evidence: EgressDenialEvidenceV1 };

export interface CurrentEgressAuthorityV1 {
  readonly scope: EgressScopeV1;
  readonly providerRoute: EgressProviderRouteV1;
  readonly generations: EgressAuthorityGenerationsV1;
  readonly revoked: boolean;
  readonly resolverIdentity: string;
  readonly resolverEpoch: string;
  readonly budgets: EgressBudgetsV1;
}

export interface RequestFinalEgressAuthorizationV1 {
  readonly contractVersion: typeof PROVIDER_PROCESS_EGRESS_FINAL_V1;
  readonly provisional: ProvisionalEgressAuthorizationV1;
  readonly boundaryUseId: string;
  readonly connectionAttemptId: string;
  readonly streamId: string;
  readonly transport: "tcp-tls" | "udp-quic";
  readonly pinnedDestination: { readonly address: string; readonly port: number };
  readonly observedPeer: { readonly address: string; readonly port: number };
  readonly sniHostname: string;
  readonly certificate: {
    readonly validated: boolean;
    readonly dnsIdentity: string;
    readonly certificateDigest: string;
  };
  readonly alpn: "http/1.1" | "h2" | "h3";
  readonly observedAtControlTime: number;
  readonly currentAuthority: CurrentEgressAuthorityV1;
  readonly resolver: EgressResolverObservationV1;
  readonly redirectHop: number;
  readonly requestIntent: EgressRequestIntentV1;
}

export interface FirstApplicationByteGrantV1 {
  readonly contractVersion: "provider-process-first-application-byte-grant/v1";
  readonly authorizationRequestId: string;
  readonly boundaryUseId: string;
  readonly connectionAttemptId: string;
  readonly streamId: string;
  readonly decisionDigest: string;
  readonly requestIntentDigest: string;
  readonly finalAuthorizationDigest: string;
  readonly scope: EgressScopeV1;
  readonly providerRoute: EgressProviderRouteV1;
  readonly generations: EgressAuthorityGenerationsV1;
  readonly resolver: EgressResolverAuthorityV1 & {
    readonly resolutionCount: 1;
    readonly addressSetDigest: string;
  };
  readonly selectedPeer: { readonly address: string; readonly port: number };
  readonly sniHostname: string;
  readonly certificate: {
    readonly dnsIdentity: string;
    readonly certificateDigest: string;
  };
  readonly alpn: "http/1.1" | "h2";
  readonly budgets: EgressBudgetsV1;
  readonly authority: "runtime-security-final-authorization-only";
  readonly automaticRetryAuthorized: false;
  readonly poolingAuthorized: false;
  readonly consumption: {
    readonly owner: "host-custody";
    readonly latch: "durable-one-use-first-byte-journal";
    readonly requiredBeforeFirstByte: true;
    readonly grantProvesBytesSent: false;
    readonly exactReplay: "return-original-durable-outcome";
    readonly conflictingReplay: "fail-closed";
    readonly journalKey: string;
    readonly requestFingerprint: string;
  };
  readonly evidence: {
    readonly contractVersion: "provider-process-egress-grant-evidence/v1";
    readonly authorizationRef: string;
    readonly boundaryUseRef: string;
    readonly decisionDigest: string;
    readonly requestIntentDigest: string;
    readonly finalAuthorizationDigest: string;
  };
}

export type RequestFinalEgressAuthorizationOutcomeV1 =
  | { readonly status: "authorized"; readonly grant: FirstApplicationByteGrantV1 }
  | { readonly status: "denied"; readonly evidence: EgressDenialEvidenceV1 };

export interface ProviderProcessEgressAuthorizationV1 {
  requestProvisional(
    input: RequestProvisionalEgressAuthorizationV1,
  ): RequestProvisionalEgressAuthorizationOutcomeV1;
  authorizeFirstApplicationByte(
    input: RequestFinalEgressAuthorizationV1,
  ): RequestFinalEgressAuthorizationOutcomeV1;
}
