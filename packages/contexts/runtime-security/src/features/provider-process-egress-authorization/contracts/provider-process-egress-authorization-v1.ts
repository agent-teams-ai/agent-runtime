export interface TrustedEgressCompositionScopeV1 {
  readonly tenantId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly scopeDigest: string;
}

export interface EgressTlsOriginV1 {
  readonly scheme: "https";
  readonly hostname: string;
  readonly port: number;
}

export interface EgressBudgetsV1 {
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly totalMilliseconds: number;
}

export interface TrustedHostRequestProjectionV1 {
  readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly scheme: "https";
  readonly authority: { readonly hostname: string; readonly port: number };
  readonly requestTarget: { readonly digest: string; readonly byteLength: number };
  readonly headers: {
    readonly canonicalDigest: string;
    readonly fieldCount: number;
    readonly credentialFields: readonly {
      readonly name: string;
      readonly credentialBindingDigest: string;
      readonly valueDigest: string;
      readonly byteLength: number;
    }[];
  };
  readonly body: { readonly digest: string; readonly byteLength: number };
  readonly framing: {
    readonly protocol: "http/1.1" | "h2" | "h3";
    readonly requestTarget: "origin-form" | "pseudo-headers";
    readonly authoritySource: "host" | ":authority";
    readonly contentLength: number | null;
    readonly transferEncoding: "absent" | "present";
    readonly connectionSpecificHeaders: "absent" | "present";
  };
}

export interface EgressCandidateAddressV1 {
  readonly family: "ipv4" | "ipv6";
  readonly address: string;
  readonly classification:
    | "public" | "private" | "loopback" | "link-local" | "metadata"
    | "multicast" | "unspecified" | "ula" | "mapped" | "reserved";
}

export interface TrustedHostResolverObservationV1 {
  readonly resolverIdentity: string;
  readonly resolverEpoch: string;
  readonly resolutionCount: number;
  readonly addresses: readonly EgressCandidateAddressV1[];
}

export type EgressSignatureAlgorithmV1 = "hmac-sha256-synthetic";

export interface EgressSigningKeyMetadataV1 {
  readonly algorithm: EgressSignatureAlgorithmV1;
  readonly keyRef: string;
  readonly keyGeneration: string;
}

export interface EgressCurrentAuthorityV1 {
  readonly authorityRef: string;
  readonly policy: {
    readonly policyRef: string;
    readonly policyRevision: string;
    readonly policyGeneration: string;
    readonly authorizedRequestDigest: string;
    readonly origin: EgressTlsOriginV1;
    readonly dnsIdentity: string;
    readonly tlsPolicyDigest: string;
    readonly limits: EgressBudgetsV1;
    readonly decisionTtlMilliseconds: number;
    readonly signingKey: EgressSigningKeyMetadataV1;
    readonly revoked: boolean;
  };
  readonly providerAccess: {
    readonly accessRef: string;
    readonly providerRef: string;
    readonly accountRef: string;
    readonly routeRef: string;
    readonly routeAuthorityDigest: string;
    readonly credentialBindingDigest: string;
    readonly routeGeneration: string;
    readonly credentialGeneration: string;
  };
}

export type EgressAuthorityReadOutcomeV1 =
  | { readonly status: "current"; readonly authority: EgressCurrentAuthorityV1 }
  | { readonly status: "denied"; readonly reason:
      "policy_denied" | "policy_not_found" | "route_unavailable" | "revoked" }
  | { readonly status: "indeterminate"; readonly reason:
      "owner_unavailable" | "owner_malformed" };

export interface RequestProvisionalEgressAuthorizationV1 {
  readonly contractVersion: "provider-process-egress-provisional/v1";
  readonly authorizationRequestId: string;
  readonly request: TrustedHostRequestProjectionV1;
}

export interface EgressDecisionSignatureV1 extends EgressSigningKeyMetadataV1 {
  readonly value: string;
}

export interface EgressControlTimeV1 {
  readonly authorityId: string;
  readonly epoch: string;
  readonly controlTime: number;
}

export interface ProvisionalEgressAuthorizationV1 {
  readonly contractVersion: "provider-process-egress-provisional-decision/v1";
  readonly authorizationRequestId: string;
  readonly authorityRef: string;
  readonly scope: TrustedEgressCompositionScopeV1;
  readonly policy: EgressCurrentAuthorityV1["policy"];
  readonly providerAccess: EgressCurrentAuthorityV1["providerAccess"];
  readonly request: TrustedHostRequestProjectionV1;
  readonly requestDigest: string;
  readonly time: EgressControlTimeV1 & { readonly expiresAtControlTime: number };
  readonly signingKey: EgressSigningKeyMetadataV1;
  readonly decisionDigest: string;
  readonly signature: EgressDecisionSignatureV1;
}

export interface RequestFinalEgressAuthorizationV1 {
  readonly contractVersion: "provider-process-egress-final/v1";
  readonly provisional: ProvisionalEgressAuthorizationV1;
  readonly boundaryUseId: string;
  readonly connectionAttemptId: string;
  readonly streamId: string;
  readonly transport: "tcp-tls" | "udp-quic";
  readonly resolver: TrustedHostResolverObservationV1;
  readonly pinnedDestination: { readonly address: string; readonly port: number };
  readonly observedPeer: { readonly address: string; readonly port: number };
  readonly tls: {
    readonly sniHostname: string;
    readonly certificateValidated: boolean;
    readonly dnsIdentity: string;
    readonly certificateDigest: string;
    readonly tlsPolicyDigest: string;
    readonly alpn: "http/1.1" | "h2" | "h3";
  };
  readonly request: TrustedHostRequestProjectionV1;
  readonly redirectHop: number;
}

export interface EgressConsumptionJournalKeyV1 {
  readonly namespace: "provider-process-egress/v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly boundaryUseId: string;
}

export interface FirstApplicationByteGrantPayloadV1 {
  readonly contractVersion: "provider-process-first-application-byte-grant/v1";
  readonly authorizationRequestId: string;
  readonly authorityRef: string;
  readonly scope: TrustedEgressCompositionScopeV1;
  readonly policy: EgressCurrentAuthorityV1["policy"];
  readonly providerAccess: EgressCurrentAuthorityV1["providerAccess"];
  readonly resolver: {
    readonly resolverIdentity: string;
    readonly resolverEpoch: string;
    readonly resolutionCount: 1;
    readonly normalizedAddresses: readonly EgressCandidateAddressV1[];
    readonly addressSetDigest: string;
  };
  readonly selectedPeer: { readonly address: string; readonly port: number };
  readonly tls: RequestFinalEgressAuthorizationV1["tls"];
  readonly limits: EgressBudgetsV1;
  readonly request: TrustedHostRequestProjectionV1;
  readonly requestDigest: string;
  readonly time: {
    readonly authorityId: string;
    readonly epoch: string;
    readonly authorizedAtControlTime: number;
    readonly expiresAtControlTime: number;
  };
  readonly boundaryUseId: string;
  readonly connectionAttemptId: string;
  readonly streamId: string;
  readonly redirectHop: 0;
  readonly provisionalDecisionDigest: string;
  readonly automaticRetryAuthorized: false;
  readonly poolingAuthorized: false;
  readonly consumption: {
    readonly owner: "host-custody";
    readonly journalKey: EgressConsumptionJournalKeyV1;
    readonly requestFingerprint: string;
  };
}

export interface SignedFirstApplicationByteGrantV1 {
  readonly payload: FirstApplicationByteGrantPayloadV1;
  readonly finalAuthorizationDigest: string;
  readonly signature: EgressDecisionSignatureV1;
  readonly evidence: {
    readonly contractVersion: "provider-process-egress-grant-evidence/v1";
    readonly authorizationRef: string;
    readonly boundaryUseRef: string;
    readonly decisionDigest: string;
    readonly finalAuthorizationDigest: string;
  };
}

export type EgressAuthorizationIssueCode =
  | "invalid_input" | "unsupported_transport" | "unsupported_protocol"
  | "unsupported_framing" | "redirect_denied" | "origin_invalid"
  | "address_denied" | "address_duplicate" | "address_set_mixed"
  | "owner_unavailable" | "owner_malformed" | "policy_denied"
  | "policy_not_found" | "route_unavailable" | "revoked" | "authority_drift"
  | "expired" | "control_time_invalid" | "control_time_regressed" | "clock_epoch_mismatch"
  | "provisional_digest_invalid" | "provisional_signature_invalid"
  | "final_signature_invalid" | "pinned_destination_mismatch" | "peer_mismatch"
  | "sni_mismatch" | "certificate_invalid" | "certificate_mismatch"
  | "alpn_mismatch" | "request_mismatch";

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

export type RequestFinalEgressAuthorizationOutcomeV1 =
  | { readonly status: "authorized"; readonly grant: SignedFirstApplicationByteGrantV1 }
  | { readonly status: "denied"; readonly evidence: EgressDenialEvidenceV1 };

export interface ProviderProcessEgressAuthorizationV1 {
  requestProvisional(input: RequestProvisionalEgressAuthorizationV1):
    Promise<RequestProvisionalEgressAuthorizationOutcomeV1>;
  authorizeFirstApplicationByte(input: RequestFinalEgressAuthorizationV1):
    Promise<RequestFinalEgressAuthorizationOutcomeV1>;
}
