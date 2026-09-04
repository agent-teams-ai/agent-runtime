import type {
  EgressAuthorizationIssueCode,
} from "../domain/provider-process-egress-model.js";
import type {
  EgressBudgetsV1,
  EgressCandidateAddressV1,
  EgressTlsOriginV1,
  TrustedEgressCompositionScopeV1,
  TrustedHostRequestProjectionV1,
  TrustedHostResolverObservationV1,
} from "./provider-process-egress-authorization-v1.js";

export type TrustedEgressCompositionScopeV2 = TrustedEgressCompositionScopeV1;
export type TrustedHostRequestProjectionV2 = TrustedHostRequestProjectionV1;
export type EgressTlsOriginV2 = EgressTlsOriginV1;
export type EgressBudgetsV2 = EgressBudgetsV1;
export type EgressCandidateAddressV2 = EgressCandidateAddressV1;
export type TrustedHostResolverObservationV2 = TrustedHostResolverObservationV1;

export type EgressSignatureAlgorithmV2 = "ed25519";
export type EgressSignatureEncodingV2 = "hex-lower";

export interface EgressSigningKeyMetadataV2 {
  readonly algorithm: EgressSignatureAlgorithmV2;
  readonly signatureEncoding: EgressSignatureEncodingV2;
  readonly keyRef: string;
  readonly publicKeyDigest: string;
  readonly keyGeneration: string;
  readonly signerRevision: string;
  readonly hostReservationId: string;
}

export interface EgressDecisionSignatureV2 extends EgressSigningKeyMetadataV2 {
  readonly value: string;
}

export interface EgressCurrentAuthorityV2 {
  readonly authorityRef: string;
  readonly policy: {
    readonly policyRef: string;
    readonly policyRevision: string;
    readonly policyGeneration: string;
    readonly authorizedRequestDigest: string;
    readonly origin: EgressTlsOriginV2;
    readonly dnsIdentity: string;
    readonly tlsPolicyDigest: string;
    readonly limits: EgressBudgetsV2;
    readonly decisionTtlMilliseconds: number;
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

export type EgressAuthorityReadOutcomeV2 =
  | { readonly status: "current"; readonly authority: EgressCurrentAuthorityV2 }
  | { readonly status: "denied"; readonly reason:
      "policy_denied" | "policy_not_found" | "route_unavailable" | "revoked" }
  | { readonly status: "indeterminate"; readonly reason:
      "owner_unavailable" | "owner_malformed" };

export interface RequestProvisionalEgressAuthorizationV2 {
  readonly contractVersion: "provider-process-egress-provisional/v2";
  readonly authorizationRequestId: string;
  readonly request: TrustedHostRequestProjectionV2;
}

export interface ProvisionalEgressAuthorizationV2 {
  readonly contractVersion: "provider-process-egress-provisional-decision/v2";
  readonly authorizationRequestId: string;
  readonly authorityRef: string;
  readonly scope: TrustedEgressCompositionScopeV2;
  readonly policy: EgressCurrentAuthorityV2["policy"];
  readonly providerAccess: EgressCurrentAuthorityV2["providerAccess"];
  readonly request: TrustedHostRequestProjectionV2;
  readonly requestDigest: string;
  readonly time: {
    readonly authorityId: string;
    readonly epoch: string;
    readonly controlTime: number;
    readonly expiresAtControlTime: number;
  };
  readonly signingKey: EgressSigningKeyMetadataV2;
  readonly decisionDigest: string;
  readonly signature: EgressDecisionSignatureV2;
}

export interface RequestFinalEgressAuthorizationV2 {
  readonly contractVersion: "provider-process-egress-final/v2";
  readonly provisional: ProvisionalEgressAuthorizationV2;
  readonly boundaryUseId: string;
  readonly connectionAttemptId: string;
  readonly streamId: string;
  readonly transport: "tcp-tls" | "udp-quic";
  readonly resolver: TrustedHostResolverObservationV2;
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
  readonly request: TrustedHostRequestProjectionV2;
  readonly redirectHop: number;
}

export interface FirstApplicationByteGrantPayloadV2 {
  readonly contractVersion: "provider-process-first-application-byte-grant/v2";
  readonly authorizationRequestId: string;
  readonly authorityRef: string;
  readonly scope: TrustedEgressCompositionScopeV2;
  readonly policy: EgressCurrentAuthorityV2["policy"];
  readonly providerAccess: EgressCurrentAuthorityV2["providerAccess"];
  readonly resolver: {
    readonly resolverIdentity: string;
    readonly resolverEpoch: string;
    readonly resolutionCount: 1;
    readonly normalizedAddresses: readonly EgressCandidateAddressV2[];
    readonly addressSetDigest: string;
  };
  readonly selectedPeer: { readonly address: string; readonly port: number };
  readonly tls: RequestFinalEgressAuthorizationV2["tls"];
  readonly limits: EgressBudgetsV2;
  readonly request: TrustedHostRequestProjectionV2;
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
    readonly journalKey: {
      readonly namespace: "provider-process-egress/v2";
      readonly tenantId: string;
      readonly projectId: string;
      readonly operationId: string;
      readonly boundaryUseId: string;
    };
    readonly requestFingerprint: string;
  };
}

export interface SignedFirstApplicationByteGrantV2 {
  readonly payload: FirstApplicationByteGrantPayloadV2;
  readonly finalAuthorizationDigest: string;
  readonly signature: EgressDecisionSignatureV2;
  readonly evidence: {
    readonly contractVersion: "provider-process-egress-grant-evidence/v2";
    readonly authorizationRef: string;
    readonly boundaryUseRef: string;
    readonly decisionDigest: string;
    readonly finalAuthorizationDigest: string;
    readonly signingKey: EgressSigningKeyMetadataV2;
  };
}

export interface EgressDenialEvidenceV2 {
  readonly contractVersion: "provider-process-egress-denial-evidence/v2";
  readonly phase: "provisional" | "final";
  readonly issueCode: EgressAuthorizationIssueCode;
  readonly authorizationRef: string;
  readonly decisionDigest?: string;
}

export type RequestProvisionalEgressAuthorizationOutcomeV2 =
  | { readonly status: "authorized"; readonly decision: ProvisionalEgressAuthorizationV2 }
  | { readonly status: "denied"; readonly evidence: EgressDenialEvidenceV2 };

export type RequestFinalEgressAuthorizationOutcomeV2 =
  | { readonly status: "authorized"; readonly grant: SignedFirstApplicationByteGrantV2 }
  | { readonly status: "denied"; readonly evidence: EgressDenialEvidenceV2 };

export interface ProviderProcessEgressAuthorizationV2 {
  requestProvisional(input: RequestProvisionalEgressAuthorizationV2):
    Promise<RequestProvisionalEgressAuthorizationOutcomeV2>;
  authorizeFirstApplicationByte(input: RequestFinalEgressAuthorizationV2):
    Promise<RequestFinalEgressAuthorizationOutcomeV2>;
}

export interface HostEgressVerifierV2 {
  readonly signingKey: EgressSigningKeyMetadataV2;
  verifyProvisionalDecision(decision: ProvisionalEgressAuthorizationV2): boolean;
  verifyGrant(grant: SignedFirstApplicationByteGrantV2): boolean;
}
