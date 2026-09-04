export const HTTP_EGRESS_ANOMALY_CODES = [
  "none",
  "inbound_cancelled",
  "inbound_deadline",
  "inbound_headers_oversized",
  "inbound_body_oversized",
  "inbound_malformed",
  "inbound_smuggling",
  "inbound_route_mismatch",
  "provider_access_denied",
  "provisional_denied",
  "provisional_timeout",
  "resolution_denied",
  "transport_open_failed",
  "transport_binding_drift",
  "provider_generation_drift",
  "final_denied",
  "final_timeout",
  "credential_render_failed",
  "upstream_write_failed",
  "upstream_ack_lost",
  "redirect_rejected",
  "upstream_auth_rejected",
  "upstream_rate_limited",
  "upstream_server_error",
  "upstream_malformed",
  "upstream_truncated",
  "upstream_stalled",
  "output_oversized",
  "output_backpressure_failed",
  "closure_unproved",
  "evidence_ack_lost",
  "conflicting_replay",
] as const;

export type HttpEgressAnomalyCode = (typeof HTTP_EGRESS_ANOMALY_CODES)[number];
export type HttpEgressOutcome =
  | "completed"
  | "rejected"
  | "denied"
  | "cancelled"
  | "reconcile_required";

export type HttpEgressClosureState = "not_opened" | "closed" | "unknown";
export type HttpEgressFirstByteState = "not_sent" | "sent" | "uncertain";

export type HttpEgressLimits = Readonly<{
  maxInboundHeaderBytes: number;
  maxInboundBodyBytes: number;
  maxUpstreamHeaderBytes: number;
  maxOutputBytes: number;
  maxBufferedBytes: number;
  maxUpstreamWireBytes: number;
  deadline: number;
  closureDeadline: number;
}>;

export type HttpEgressExpectedRequest = Readonly<{
  requestId: string;
  method: string;
  path: string;
  host: string;
}>;

export type HttpEgressConnection = Readonly<{
  request: AsyncIterable<Uint8Array>;
  write(chunk: Uint8Array): Promise<void>;
  close(disposition: "complete" | "abort"): Promise<Readonly<{
    state: "closed" | "unknown";
    receiptDigest: string;
  }>>;
}>;

export type HttpEgressOperation = Readonly<{
  operationId: string;
  attemptId: string;
  expectedRequest: HttpEgressExpectedRequest;
  connection: HttpEgressConnection;
  limits: HttpEgressLimits;
  signal?: AbortSignal;
}>;

export type HttpEgressReceipt = Readonly<{
  schema: "agent-runtime.host-http-egress-receipt/v1";
  operationId: string;
  attemptId: string;
  requestId: string;
  requestDigest: string;
  outcome: HttpEgressOutcome;
  anomalyCode: HttpEgressAnomalyCode;
  provisionalAuthorizationReceiptDigest: string;
  finalAuthorizationReceiptDigest: string;
  routeReceiptDigest: string;
  materializationReceiptDigest: string;
  selectedPeer: string;
  tlsProtocol: string;
  sniDigest: string;
  certificateDigest: string;
  pinDigest: string;
  alpn: string;
  policyGeneration: string;
  keyGeneration: string;
  routeGeneration: string;
  credentialGeneration: string;
  inboundRequestBytes: number;
  upstreamRequestBytes: number;
  upstreamResponseBytes: number;
  outboundResponseBytes: number;
  firstByteState: HttpEgressFirstByteState;
  inboundClosure: HttpEgressClosureState;
  upstreamClosure: HttpEgressClosureState;
  inboundClosureReceiptDigest: string;
  upstreamClosureReceiptDigest: string;
  attemptCount: 0 | 1;
}>;
