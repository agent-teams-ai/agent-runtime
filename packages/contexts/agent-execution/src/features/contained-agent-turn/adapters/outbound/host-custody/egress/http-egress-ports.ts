import type { HttpEgressReceipt } from "./http-egress-contracts.js";

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
  selectedPeer?: string;
  sniDigest?: string;
  certificateDigest?: string;
  pinDigest?: string;
  alpn?: string;
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

export type HttpEgressFinalAuthorization = HttpEgressProvisionalAuthorization & Readonly<{
  selectedPeer: string;
  sniDigest: string;
  certificateDigest: string;
  pinDigest: string;
  alpn: string;
}>;

export interface HttpEgressProvisionalAuthorizer {
  authorize(input: HttpEgressProvisionalAuthorization): Promise<HttpEgressAuthorizationDecision>;
}

export interface HttpEgressFinalAuthorizer {
  authorize(input: HttpEgressFinalAuthorization): Promise<HttpEgressAuthorizationDecision>;
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
  tlsProtocol: "TLSv1.2" | "TLSv1.3";
  sni: string;
  sniDigest: string;
  certificateDigest: string;
  pinDigest: string;
  alpn: string;
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
  dispatch(request: Uint8Array, signal?: AbortSignal): Promise<HttpEgressDispatch>;
  close(): Promise<Readonly<{ state: "closed" | "unknown"; receiptDigest: string }>>;
}

export interface HttpEgressUpstreamTransport {
  open(input: Readonly<{
    originHost: string;
    originPort: number;
    selectedAddress: string;
    sni: string;
    alpn: "http/1.1";
  }>): Promise<HttpEgressTransportSession>;
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
