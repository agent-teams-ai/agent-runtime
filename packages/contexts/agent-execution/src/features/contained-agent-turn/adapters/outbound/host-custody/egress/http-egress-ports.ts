import type { HttpEgressReceipt } from "./http-egress-contracts.js";
import type { HostHttpAdmissionGuard } from "./host-http-admission-guard.js";
import type { HttpPresentationHeaderName, NativeHttpRequestProfileId } from "./native-http-request-profile.js";

export type HttpEgressRoute = Readonly<{
  /** Absent retains the established two-header contract. Native factories remain internal. */
  requestProfile?: NativeHttpRequestProfileId;
  routeReceiptDigest: string;
  originHost: string;
  originPort: number;
  upstreamMethod: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  upstreamPath: string;
  forwardedRequestHeaderNames: readonly HttpPresentationHeaderName[];
  credentialFieldNames: readonly string[];
}>;

/** Detached AE-owned view. The outer composition maps PA's public contract into it. */
export type HostHttpProviderAccessSnapshot = Readonly<{
  tenantId: string; projectId: string; scopeDigest: string;
  accessRef: string; provider: "claude" | "codex"; providerAccountRef: string;
  providerRouteRef: string; credentialBindingRef: string;
  /** The original PA digest. Never substitute AE's normalized credentialBindingDigest. */
  ownerAuthorityDigest: string;
  revision: number; credentialGeneration: number;
  availability: "available" | "unavailable"; revocation: "active" | "revoked";
}>;

export type HostHttpMaterializationReceipt = Readonly<{
  schemaVersion: 1; purpose: "contained-turn.credential-materialization-authorization/v1";
  accessRef: string; authorizationRequestId: string; availability: "available" | "unavailable";
  bindingRevision: number; credentialBindingDigest: string; credentialBindingRef: string;
  credentialGeneration: number; decision: "authorized" | "rejected"; rejectionReason: string | null;
  projectId: string; provider: "claude" | "codex"; providerAccountRef: string;
  providerRouteRef: string; requestDigest: string; revocation: "active" | "revoked";
  scopeDigest: string; tenantId: string;
}>;

export type HostHttpMaterializationOutcome =
  | Readonly<{kind: "authorized" | "observed" | "rejected"; receipt: HostHttpMaterializationReceipt}>
  | Readonly<{kind: "conflict" | "indeterminate" | "invalid" | "unsupported"}>;

export type HostHttpMaterializationAuthorizationRequest = Omit<
  HostHttpMaterializationReceipt,
  "decision" | "rejectionReason"
>;
export type HostHttpUnsignedMaterializationAuthorizationRequest = Omit<
  HostHttpMaterializationAuthorizationRequest,
  "requestDigest"
>;

export interface HostHttpProviderAccessAuthorization {
  /** Provider Access remains the sole owner of its canonical request digest. */
  createRequestDigest(input: HostHttpUnsignedMaterializationAuthorizationRequest): Promise<string>;
  authorize(input: HostHttpMaterializationAuthorizationRequest): Promise<HostHttpMaterializationOutcome>;
  observe(input: Readonly<{authorizationRequestId: string; projectId: string; provider: "claude" | "codex";
    requestDigest: string; scopeDigest: string; tenantId: string}>): Promise<HostHttpMaterializationOutcome>;
}

export interface HostHttpCredentialMaterializer {
  render(receipt: HostHttpMaterializationReceipt): Promise<readonly Readonly<{name: string; valueBytes: Uint8Array}>[]>;
}

export type HostHttpRequestProjection = Readonly<{
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT"; scheme: "https";
  authority: Readonly<{hostname: string; port: number}>;
  requestTarget: Readonly<{digest: string; byteLength: number}>;
  headers: Readonly<{canonicalDigest: string; fieldCount: number; credentialFields: readonly Readonly<{
    name: string; credentialBindingDigest: string; valueDigest: string; byteLength: number;
  }>[]}>;
  body: Readonly<{digest: string; byteLength: number}>;
  framing: Readonly<{protocol: "http/1.1"; requestTarget: "origin-form"; authoritySource: "host";
    contentLength: number; transferEncoding: "absent"; connectionSpecificHeaders: "absent"}>;
}>;

export type HostHttpSigningKey = Readonly<{algorithm: "ed25519"; signatureEncoding: "hex-lower";
  keyRef: string; publicKeyDigest: string; keyGeneration: string; signerRevision: string; hostReservationId: string}>;
export type HostHttpSignature = HostHttpSigningKey & Readonly<{value: string}>;
export type HostHttpScope = Readonly<{tenantId: string; projectId: string; operationId: string; scopeDigest: string}>;
export type HostHttpPolicy = Readonly<{policyRef: string; policyRevision: string; policyGeneration: string;
  authorizedRequestDigest: string; origin: Readonly<{scheme: "https"; hostname: string; port: number}>;
  dnsIdentity: string; tlsPolicyDigest: string; limits: Readonly<{requestBytes: number; responseBytes: number;
    totalMilliseconds: number}>; decisionTtlMilliseconds: number; revoked: boolean}>;
export type HostHttpProviderAccessProof = Readonly<{accessRef: string; providerRef: string; accountRef: string;
  routeRef: string; routeAuthorityDigest: string; credentialBindingDigest: string;
  routeGeneration: string; credentialGeneration: string}>;

export type HostHttpProvisionalDecision = Readonly<{
  contractVersion: "provider-process-egress-provisional-decision/v2"; authorizationRequestId: string;
  authorityRef: string; scope: HostHttpScope; policy: HostHttpPolicy; providerAccess: HostHttpProviderAccessProof;
  request: HostHttpRequestProjection; requestDigest: string; time: Readonly<{authorityId: string; epoch: string;
    controlTime: number; expiresAtControlTime: number}>; signingKey: HostHttpSigningKey;
  decisionDigest: string; signature: HostHttpSignature;
}>;

export type HostHttpResolverObservation = Readonly<{resolverIdentity: string; resolverEpoch: string; resolutionCount: 1;
  addresses: readonly Readonly<{family: "ipv4" | "ipv6"; address: string; classification: "public"}>[];
  selectedAddress: string}>;

export type HostHttpTlsObservation = Readonly<{peerAddress: string; peerPort: number;
  tlsProtocol: "TLSv1.2" | "TLSv1.3"; requestedSni: string; observedSni: string;
  chainValidated: true; dnsIdentity: string; certificateDigest: `sha256:${string}`;
  tlsPolicyDigest: string; spkiDigest?: `sha256:${string}`; alpn: "http/1.1"}>;

export type HostHttpGrant = Readonly<{payload: Readonly<{
  contractVersion: "provider-process-first-application-byte-grant/v2"; authorizationRequestId: string;
  authorityRef: string; scope: HostHttpScope; policy: HostHttpPolicy; providerAccess: HostHttpProviderAccessProof;
  resolver: Readonly<{resolverIdentity: string; resolverEpoch: string; resolutionCount: 1;
    normalizedAddresses: HostHttpResolverObservation["addresses"]; addressSetDigest: string}>;
  selectedPeer: Readonly<{address: string; port: number}>; tls: Readonly<{sniHostname: string;
    certificateValidated: boolean; dnsIdentity: string; certificateDigest: string; tlsPolicyDigest: string; alpn: "http/1.1"}>;
  limits: HostHttpPolicy["limits"]; request: HostHttpRequestProjection; requestDigest: string;
  time: Readonly<{authorityId: string; epoch: string; authorizedAtControlTime: number; expiresAtControlTime: number}>;
  boundaryUseId: string; connectionAttemptId: string; streamId: string; redirectHop: 0;
  provisionalDecisionDigest: string; automaticRetryAuthorized: false; poolingAuthorized: false;
  consumption: Readonly<{owner: "host-custody"; journalKey: Readonly<{namespace: "provider-process-egress/v2";
    tenantId: string; projectId: string; operationId: string; boundaryUseId: string}>; requestFingerprint: string}>;
}>; finalAuthorizationDigest: string; signature: HostHttpSignature; evidence: Readonly<{
  contractVersion: "provider-process-egress-grant-evidence/v2"; authorizationRef: string; boundaryUseRef: string;
  decisionDigest: string; finalAuthorizationDigest: string; signingKey: HostHttpSigningKey}>}>;

export interface HostHttpRuntimeSecurityV2 {
  requestProvisional(input: Readonly<{contractVersion: "provider-process-egress-provisional/v2";
    authorizationRequestId: string; request: HostHttpRequestProjection}>): Promise<Readonly<
      {status: "authorized"; decision: HostHttpProvisionalDecision} | {status: "denied"}>>;
  authorizeFirstApplicationByte(input: Readonly<{contractVersion: "provider-process-egress-final/v2";
    provisional: HostHttpProvisionalDecision; boundaryUseId: string; connectionAttemptId: string; streamId: string;
    transport: "tcp-tls"; resolver: Omit<HostHttpResolverObservation, "selectedAddress">;
    pinnedDestination: Readonly<{address: string; port: number}>; observedPeer: Readonly<{address: string; port: number}>;
    tls: Readonly<{sniHostname: string; certificateValidated: boolean; dnsIdentity: string;
      certificateDigest: string; tlsPolicyDigest: string; alpn: "http/1.1"}>;
    request: HostHttpRequestProjection; redirectHop: 0}>): Promise<Readonly<
      {status: "authorized"; grant: HostHttpGrant} | {status: "denied"}>>;
}

export interface HostHttpVerifierV2 { readonly signingKey: HostHttpSigningKey;
  verifyProvisionalDecision(value: HostHttpProvisionalDecision): boolean; verifyGrant(value: HostHttpGrant): boolean }
export interface HostHttpLocalAuthorityCut { read(): Readonly<{status: "current" | "revoked" | "unknown";
  authorityId: string; epoch: string; controlTime: number}> }
export interface HostHttpConsumptionJournal { consume(key: HostHttpGrant["payload"]["consumption"]["journalKey"],
  requestFingerprint: string): "consumed" | "duplicate" | "mismatch" | "unknown" }

export type HttpEgressResolution = HostHttpResolverObservation;
export interface HttpEgressTrustedResolver { resolve(host: string): Promise<HttpEgressResolution> }
export type HttpEgressTransportBinding = HostHttpTlsObservation;
export type HttpEgressDispatch = Readonly<{status: "response"; acceptedRequestBytes: number;
  acknowledgement: "acknowledged" | "lost"; response: AsyncIterable<Uint8Array>}> | Readonly<{
  status: "failed"; acceptedRequestBytes: number | "unknown"; acknowledgement: "acknowledged" | "lost"}>;
export interface HttpEgressTransportSession { readonly binding: HttpEgressTransportBinding;
  dispatch(consume: () => Uint8Array | undefined, signal?: AbortSignal): Promise<HttpEgressDispatch> }
export interface HttpEgressTransportAttempt { ready(): Promise<HttpEgressTransportSession>;
  close(): Promise<Readonly<{state: "closed" | "unknown"; receiptDigest: string}>> }
export interface HttpEgressUpstreamTransport { beginOpen(input: Readonly<{originHost: string; originPort: number;
  selectedAddress: string; sni: string; alpn: "http/1.1"}>): HttpEgressTransportAttempt }
export interface HttpEgressClock { now(): number;
  within<T>(deadline: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> }
export interface HttpEgressEvidence { digest(parts: readonly Uint8Array[]): string;
  record(receipt: HttpEgressReceipt): Promise<"recorded" | "conflict" | "unknown"> }
export interface HostHttpBoundaryIds { fresh(): Readonly<{materializationAuthorizationId: string;
  runtimeAuthorizationId: string; boundaryUseId: string; connectionAttemptId: string; streamId: string}> }

/**
 * Adapter-internal broker port, not an eighth ADR-0012 contained-turn port and
 * never a caller capability. An installed exclusive route lease reserves one
 * first-write authority per inbound request and consumes it synchronously,
 * adjacent to the application-byte emission and after every signed HTTP
 * authorization. Absence means no route owner is wired into this session, so
 * the broker enforces no kernel cut of its own and says so instead of implying
 * one. The lease is the only authority here: it may refuse a reservation and it
 * may refuse the consumption it already issued.
 */
export interface HttpEgressRouteFirstWriteReservation { consume(): boolean }
export interface HttpEgressRouteFirstWrite {
  /** Refuses by throwing, including for a requestId this lease already reserved. */
  reserve(requestId: string): HttpEgressRouteFirstWriteReservation;
}

export type HttpEgressBrokerPorts = Readonly<{
  identity: Readonly<{operationId: string; attemptId: string; custodyId: string; hostBootId: string;
    liveProcessSessionIdentity: object}>; guard: HostHttpAdmissionGuard; ids: HostHttpBoundaryIds;
  providerAccessSnapshot: HostHttpProviderAccessSnapshot; route: HttpEgressRoute;
  providerAccess: HostHttpProviderAccessAuthorization; materializer: HostHttpCredentialMaterializer;
  runtimeSecurity: HostHttpRuntimeSecurityV2; verifier: HostHttpVerifierV2;
  localAuthorityCut: HostHttpLocalAuthorityCut; journal: HostHttpConsumptionJournal;
  resolver: HttpEgressTrustedResolver; transport: HttpEgressUpstreamTransport;
  clock: HttpEgressClock; evidence: HttpEgressEvidence;
  routeFirstWrite?: HttpEgressRouteFirstWrite;
}>;
