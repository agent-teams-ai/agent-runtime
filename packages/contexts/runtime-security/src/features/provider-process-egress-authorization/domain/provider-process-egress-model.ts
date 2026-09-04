export interface TrustedEgressCompositionScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly scopeDigest: string;
}

export interface EgressTlsOrigin {
  readonly scheme: "https";
  readonly hostname: string;
  readonly port: number;
}

export interface EgressBudgets {
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly totalMilliseconds: number;
}

export interface TrustedHostRequestProjection {
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

export interface EgressCandidateAddress {
  readonly family: "ipv4" | "ipv6";
  readonly address: string;
  readonly classification:
    | "public" | "private" | "loopback" | "link-local" | "metadata"
    | "multicast" | "unspecified" | "ula" | "mapped" | "reserved";
}

export interface TrustedHostResolverObservation {
  readonly resolverIdentity: string;
  readonly resolverEpoch: string;
  readonly resolutionCount: number;
  readonly addresses: readonly EgressCandidateAddress[];
}

export type EgressSignatureAlgorithm = "hmac-sha256-synthetic";
export interface EgressSigningKeyMetadata {
  readonly algorithm: EgressSignatureAlgorithm;
  readonly keyRef: string;
  readonly keyGeneration: string;
}
export interface EgressDecisionSignature extends EgressSigningKeyMetadata { readonly value: string; }

export interface EgressCurrentAuthority {
  readonly authorityRef: string;
  readonly policy: {
    readonly policyRef: string;
    readonly policyRevision: string;
    readonly policyGeneration: string;
    readonly authorizedRequestDigest: string;
    readonly origin: EgressTlsOrigin;
    readonly dnsIdentity: string;
    readonly tlsPolicyDigest: string;
    readonly limits: EgressBudgets;
    readonly decisionTtlMilliseconds: number;
    readonly signingKey: EgressSigningKeyMetadata;
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

export type EgressAuthorityReadOutcome =
  | { readonly status: "current"; readonly authority: EgressCurrentAuthority }
  | { readonly status: "denied"; readonly reason:
      "policy_denied" | "policy_not_found" | "route_unavailable" | "revoked" }
  | { readonly status: "indeterminate"; readonly reason:
      "owner_unavailable" | "owner_malformed" };

export interface RequestProvisionalEgressAuthorization {
  readonly authorizationRequestId: string;
  readonly request: TrustedHostRequestProjection;
}

export interface EgressControlTime {
  readonly authorityId: string;
  readonly epoch: string;
  readonly controlTime: number;
}

export interface ProvisionalEgressAuthorization {
  readonly authorizationRequestId: string;
  readonly authorityRef: string;
  readonly scope: TrustedEgressCompositionScope;
  readonly policy: EgressCurrentAuthority["policy"];
  readonly providerAccess: EgressCurrentAuthority["providerAccess"];
  readonly request: TrustedHostRequestProjection;
  readonly requestDigest: string;
  readonly time: EgressControlTime & { readonly expiresAtControlTime: number };
  readonly signingKey: EgressSigningKeyMetadata;
  readonly decisionDigest: string;
  readonly signature: EgressDecisionSignature;
}

export interface RequestFinalEgressAuthorization {
  readonly provisional: ProvisionalEgressAuthorization;
  readonly boundaryUseId: string;
  readonly connectionAttemptId: string;
  readonly streamId: string;
  readonly transport: "tcp-tls" | "udp-quic";
  readonly resolver: TrustedHostResolverObservation;
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
  readonly request: TrustedHostRequestProjection;
  readonly redirectHop: number;
}

export interface EgressConsumptionJournalKey {
  readonly namespace: "provider-process-egress/v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly boundaryUseId: string;
}

export interface FirstApplicationByteGrantPayload {
  readonly authorizationRequestId: string;
  readonly authorityRef: string;
  readonly scope: TrustedEgressCompositionScope;
  readonly policy: EgressCurrentAuthority["policy"];
  readonly providerAccess: EgressCurrentAuthority["providerAccess"];
  readonly resolver: {
    readonly resolverIdentity: string;
    readonly resolverEpoch: string;
    readonly resolutionCount: 1;
    readonly normalizedAddresses: readonly EgressCandidateAddress[];
    readonly addressSetDigest: string;
  };
  readonly selectedPeer: { readonly address: string; readonly port: number };
  readonly tls: RequestFinalEgressAuthorization["tls"];
  readonly limits: EgressBudgets;
  readonly request: TrustedHostRequestProjection;
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
    readonly journalKey: EgressConsumptionJournalKey;
    readonly requestFingerprint: string;
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

export interface EgressDenialEvidence {
  readonly phase: "provisional" | "final";
  readonly issueCode: EgressAuthorizationIssueCode;
  readonly authorizationRef: string;
  readonly decisionDigest?: string;
}

export type RequestProvisionalEgressAuthorizationOutcome =
  | { readonly status: "authorized"; readonly decision: ProvisionalEgressAuthorization }
  | { readonly status: "denied"; readonly evidence: EgressDenialEvidence };
export type RequestFinalEgressAuthorizationOutcome =
  | { readonly status: "authorized"; readonly grant: {
      readonly payload: FirstApplicationByteGrantPayload;
      readonly finalAuthorizationDigest: string;
      readonly signature: EgressDecisionSignature;
    } }
  | { readonly status: "denied"; readonly evidence: EgressDenialEvidence };

export interface ProviderProcessEgressAuthorization {
  requestProvisional(input: RequestProvisionalEgressAuthorization):
    Promise<RequestProvisionalEgressAuthorizationOutcome>;
  authorizeFirstApplicationByte(input: RequestFinalEgressAuthorization):
    Promise<RequestFinalEgressAuthorizationOutcome>;
}
