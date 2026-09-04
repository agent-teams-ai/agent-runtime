import type { HttpEgressLimits, HttpEgressOperation } from "./http-egress-contracts.js";
import type {
  HttpEgressFinalAuthorization,
  HttpEgressRoute,
  HttpEgressTransportBinding,
} from "./http-egress-ports.js";

const encoder = new TextEncoder();

export type HttpEgressFinalAuthorizationFacts = Omit<HttpEgressFinalAuthorization, "bindingDigest">;

const field = (name: string, value: string | number): Uint8Array => {
  const encoded = encoder.encode(String(value));
  return encoder.encode(`${name}:${encoded.byteLength}:\n${String(value)}\n`);
};

const LIMIT_FIELDS = [
  "maxInboundHeaderBytes",
  "maxInboundBodyBytes",
  "maxUpstreamHeaderBytes",
  "maxOutputBytes",
  "maxBufferedBytes",
  "maxUpstreamWireBytes",
  "deadline",
  "closureDeadline",
] as const satisfies readonly (keyof HttpEgressLimits)[];

/** Closed canonical serialization for correlation; this is not a signature or authentication claim. */
export const canonicalFinalAuthorizationBindingParts = (
  input: HttpEgressFinalAuthorizationFacts,
): readonly Uint8Array[] => Object.freeze([
  encoder.encode("agent-runtime.host-http-egress-final-authorization-binding/v1\npurpose=first-byte-egress-authorization\n"),
  field("operationId", input.operationId),
  field("attemptId", input.attemptId),
  field("requestId", input.requestId),
  field("requestMethod", input.requestMethod),
  field("requestPath", input.requestPath),
  field("requestHost", input.requestHost),
  field("requestDigest", input.requestDigest),
  field("routeReceiptDigest", input.routeReceiptDigest),
  field("materializationReceiptDigest", input.materializationReceiptDigest),
  field("redirectHop", input.redirectHop),
  field("originHost", input.originHost),
  field("originPort", input.originPort),
  field("upstreamMethod", input.upstreamMethod),
  field("upstreamPath", input.upstreamPath),
  field("resolvedAddressCount", input.resolvedAddresses.length),
  ...input.resolvedAddresses.map((address, index) => field(`resolvedAddress[${index}]`, address)),
  field("selectedAddress", input.selectedAddress),
  field("observedPeerAddress", input.observedPeerAddress),
  field("observedPeerPort", input.observedPeerPort),
  field("tlsProtocol", input.tlsProtocol),
  field("sni", input.sni),
  field("sniDigest", input.sniDigest),
  field("certificateDigest", input.certificateDigest),
  field("pinDigest", input.pinDigest),
  field("alpn", input.alpn),
  field("policyGeneration", input.policyGeneration),
  field("keyGeneration", input.keyGeneration),
  field("routeGeneration", input.routeGeneration),
  field("credentialGeneration", input.credentialGeneration),
  ...LIMIT_FIELDS.map(name => field(`limits.${name}`, input.limits[name])),
]);

export const snapshotHttpEgressTransportBinding = (
  binding: HttpEgressTransportBinding,
): HttpEgressTransportBinding => Object.freeze({
  peerAddress: binding.peerAddress,
  peerPort: binding.peerPort,
  tlsProtocol: binding.tlsProtocol,
  sni: binding.sni,
  sniDigest: binding.sniDigest,
  certificateDigest: binding.certificateDigest,
  pinDigest: binding.pinDigest,
  alpn: binding.alpn,
});

export const createHttpEgressFinalAuthorization = (input: Readonly<{
  operation: HttpEgressOperation;
  requestDigest: string;
  route: HttpEgressRoute;
  resolvedAddresses: readonly string[];
  selectedAddress: string;
  binding: HttpEgressTransportBinding;
  digest(parts: readonly Uint8Array[]): string;
}>): HttpEgressFinalAuthorization => {
  const facts = Object.freeze({
    operationId: input.operation.operationId,
    attemptId: input.operation.attemptId,
    requestId: input.operation.expectedRequest.requestId,
    requestMethod: input.operation.expectedRequest.method,
    requestPath: input.operation.expectedRequest.path,
    requestHost: input.operation.expectedRequest.host,
    requestDigest: input.requestDigest,
    routeReceiptDigest: input.route.routeReceiptDigest,
    materializationReceiptDigest: input.route.materializationReceiptDigest,
    redirectHop: 0 as const,
    originHost: input.route.originHost,
    originPort: input.route.originPort,
    upstreamMethod: input.route.upstreamMethod,
    upstreamPath: input.route.upstreamPath,
    resolvedAddresses: Object.freeze([...input.resolvedAddresses]),
    selectedAddress: input.selectedAddress,
    observedPeerAddress: input.binding.peerAddress,
    observedPeerPort: input.binding.peerPort,
    tlsProtocol: input.binding.tlsProtocol,
    sni: input.binding.sni,
    sniDigest: input.binding.sniDigest,
    certificateDigest: input.binding.certificateDigest,
    pinDigest: input.binding.pinDigest,
    alpn: input.binding.alpn,
    policyGeneration: input.route.policyGeneration,
    keyGeneration: input.route.keyGeneration,
    routeGeneration: input.route.routeGeneration,
    credentialGeneration: input.route.credentialGeneration,
    limits: input.operation.limits,
  });
  return Object.freeze({
    ...facts,
    bindingDigest: input.digest(canonicalFinalAuthorizationBindingParts(facts)),
  });
};
