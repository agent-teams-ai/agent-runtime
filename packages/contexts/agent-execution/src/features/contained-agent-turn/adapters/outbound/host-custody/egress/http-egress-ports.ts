import type { HttpEgressLimits, HttpEgressReceipt } from "./http-egress-contracts.js";

export type HttpEgressRoute = Readonly<{
  routeReceiptDigest: string;
  materializationReceiptDigest: string;
  originHost: string;
  originPort: number;
  upstreamMethod: string;
  upstreamPath: string;
  sni: string;
  sniDigest: string;
  certificateDigest: string;
  pinDigest: string;
  alpn: "http/1.1";
  policyGeneration: string;
  keyGeneration: string;
  routeGeneration: string;
  credentialGeneration: string;
  forwardedRequestHeaderNames: readonly string[];
}>;

export type HttpEgressRouteObservation =
  | Readonly<{ status: "available"; route: HttpEgressRoute }>
  | Readonly<{ status: "denied" }>;

export type HttpEgressGenerationObservation = Readonly<{
  status: "current" | "revoked";
  policyGeneration: string;
  keyGeneration: string;
  routeGeneration: string;
  credentialGeneration: string;
  materializationReceiptDigest: string;
}>;

/** ACL over Provider Access facts and the trusted Host route manifest, never secrets. */
export interface HttpEgressRouteAuthority {
  observe(operationId: string, attemptId: string): Promise<HttpEgressRouteObservation>;
  revalidate(materializationReceiptDigest: string): Promise<HttpEgressGenerationObservation>;
  /** Current Host-enforced revocation cut, not a synchronous distributed DB query. */
  revalidateAtFirstByte(materializationReceiptDigest: string): HttpEgressGenerationObservation;
}

/** Host-owned private materialization only. This is not a Provider Access port. */
export interface HttpEgressCredentialCustody {
  renderAuthorization(input: Readonly<{
    operationId: string;
    attemptId: string;
    materializationReceiptDigest: string;
  }>): Promise<Uint8Array>;
}

export type HttpEgressAuthorizationDecision = Readonly<{
  decision: "allow" | "deny";
  receiptDigest: string;
  validUntil: number;
  policyGeneration: string;
  keyGeneration: string;
  routeGeneration: string;
  credentialGeneration: string;
  materializationReceiptDigest: string;
}>;

export type HttpEgressFinalAuthorizationDecision = HttpEgressAuthorizationDecision & Readonly<{
  /** Correlation binding only; authenticity remains the authorizer's responsibility. */
  bindingDigest: string;
}>;

export type HttpEgressProvisionalAuthorization = Readonly<{
  operationId: string;
  attemptId: string;
  requestDigest: string;
  routeReceiptDigest: string;
  materializationReceiptDigest: string;
  originHost: string;
  originPort: number;
  policyGeneration: string;
  keyGeneration: string;
  routeGeneration: string;
  credentialGeneration: string;
}>;

export type HttpEgressFinalAuthorization = Readonly<{
  operationId: string;
  attemptId: string;
  requestId: string;
  requestMethod: string;
  requestPath: string;
  requestHost: string;
  requestDigest: string;
  routeReceiptDigest: string;
  materializationReceiptDigest: string;
  redirectHop: 0;
  originHost: string;
  originPort: number;
  upstreamMethod: string;
  upstreamPath: string;
  resolvedAddresses: readonly string[];
  selectedAddress: string;
  observedPeerAddress: string;
  observedPeerPort: number;
  tlsProtocol: "TLSv1.2" | "TLSv1.3";
  sni: string;
  sniDigest: string;
  certificateDigest: string;
  pinDigest: string;
  alpn: "http/1.1";
  policyGeneration: string;
  keyGeneration: string;
  routeGeneration: string;
  credentialGeneration: string;
  limits: HttpEgressLimits;
  /** Versioned, purpose-bound canonical correlation over every other field. */
  bindingDigest: string;
}>;

export interface HttpEgressProvisionalAuthorizer {
  authorize(input: HttpEgressProvisionalAuthorization): Promise<HttpEgressAuthorizationDecision>;
}

export interface HttpEgressFinalAuthorizer {
  authorize(input: HttpEgressFinalAuthorization): Promise<HttpEgressFinalAuthorizationDecision>;
}

export type HttpEgressResolution = Readonly<{
  addresses: readonly string[];
  selectedAddress: string;
}>;

export interface HttpEgressTrustedResolver {
  resolve(host: string): Promise<HttpEgressResolution>;
}

export type HttpEgressTransportBinding = Readonly<{
  peerAddress: string;
  peerPort: number;
  tlsProtocol: "TLSv1.2" | "TLSv1.3";
  sni: string;
  sniDigest: string;
  certificateDigest: string;
  pinDigest: string;
  alpn: "http/1.1";
}>;

export type HttpEgressDispatch =
  | Readonly<{
      status: "response";
      acceptedRequestBytes: number;
      acknowledgement: "acknowledged" | "lost";
      response: AsyncIterable<Uint8Array>;
    }>
  | Readonly<{
      status: "failed";
      acceptedRequestBytes: number | "unknown";
      acknowledgement: "acknowledged" | "lost";
    }>;

export interface HttpEgressTransportSession {
  readonly binding: HttpEgressTransportBinding;
  /**
   * Acquire the Host dispatch lane/journal latch first. Consume exactly once,
   * immediately before the first write, with no await between consume and write.
   * Undefined denies the write. No request bytes are available before consume.
   */
  dispatch(consumeAuthorizedRequest: () => Uint8Array | undefined, signal?: AbortSignal): Promise<HttpEgressDispatch>;
}

/**
 * Synchronously acquired Host custody for one transport open. The attempt owns
 * connecting and late-created resources until close proves their disposition.
 * close is idempotent and prevents a ready session from dispatching afterwards.
 */
export interface HttpEgressTransportAttempt {
  ready(): Promise<HttpEgressTransportSession>;
  close(): Promise<Readonly<{ state: "closed" | "unknown"; receiptDigest: string }>>;
}

export interface HttpEgressUpstreamTransport {
  /** A thrown begin proves that no transport resource was started. */
  beginOpen(input: Readonly<{
    originHost: string;
    originPort: number;
    selectedAddress: string;
    sni: string;
    alpn: "http/1.1";
  }>): HttpEgressTransportAttempt;
}

export interface HttpEgressClock {
  now(): number;
  within<T>(deadline: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface HttpEgressEvidence {
  digest(parts: readonly Uint8Array[]): string;
  record(receipt: HttpEgressReceipt): Promise<"recorded" | "conflict" | "unknown">;
}

/** Named Host-private dependencies; the seven Agent Execution use-case ports are unchanged. */
export type HttpEgressBrokerPorts = Readonly<{
  resolver: HttpEgressTrustedResolver;
  transport: HttpEgressUpstreamTransport;
  provisionalAuthorization: HttpEgressProvisionalAuthorizer;
  finalAuthorization: HttpEgressFinalAuthorizer;
  routeAuthority: HttpEgressRouteAuthority;
  credentialCustody: HttpEgressCredentialCustody;
  clock: HttpEgressClock;
  evidence: HttpEgressEvidence;
}>;
