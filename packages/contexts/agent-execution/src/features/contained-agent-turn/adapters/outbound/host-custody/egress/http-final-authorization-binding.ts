import type { HttpEgressLimits, HttpEgressOperation } from "./http-egress-contracts.js";
import type {
  HttpEgressFinalAuthorization,
  HttpEgressRoute,
  HttpEgressTransportBinding,
} from "./http-egress-ports.js";
import { snapshotHttpTransportBinding } from "./http-ingress-validation.js";

const encoder = new TextEncoder();

class HttpFinalAuthorizationBindingError extends TypeError {
  public constructor(fieldName: string) {
    super(`invalid HTTP final authorization binding field: ${fieldName}`);
    this.name = "HttpFinalAuthorizationBindingError";
  }
}

export type HttpEgressFinalAuthorizationFacts = Omit<HttpEgressFinalAuthorization, "bindingDigest">;

const assertCanonicalString = (name: string, value: unknown, maxBytes: number): void => {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBytes || !value.isWellFormed()
    || encoder.encode(value).byteLength > maxBytes) {
    throw new HttpFinalAuthorizationBindingError(name);
  }
};

const field = (name: string, value: string | number): Uint8Array => {
  const encoded = encoder.encode(String(value));
  return encoder.encode(`${name}:${encoded.byteLength}:\n${String(value)}\n`);
};

const assertCanonicalFacts = (input: HttpEgressFinalAuthorizationFacts): void => {
  const strings: readonly (readonly [name: string, value: unknown, maxBytes: number])[] = [
    ["operationId", input.operationId, 512],
    ["attemptId", input.attemptId, 512],
    ["requestId", input.requestId, 512],
    ["requestMethod", input.requestMethod, 128],
    ["requestPath", input.requestPath, 16_384],
    ["requestHost", input.requestHost, 512],
    ["requestDigest", input.requestDigest, 512],
    ["routeReceiptDigest", input.routeReceiptDigest, 512],
    ["materializationReceiptDigest", input.materializationReceiptDigest, 512],
    ["originHost", input.originHost, 512],
    ["upstreamMethod", input.upstreamMethod, 128],
    ["upstreamPath", input.upstreamPath, 16_384],
    ["selectedAddress", input.selectedAddress, 64],
    ["observedPeerAddress", input.observedPeerAddress, 64],
    ["tlsProtocol", input.tlsProtocol, 16],
    ["sni", input.sni, 512],
    ["sniDigest", input.sniDigest, 512],
    ["certificateDigest", input.certificateDigest, 512],
    ["pinDigest", input.pinDigest, 512],
    ["alpn", input.alpn, 16],
    ["policyGeneration", input.policyGeneration, 512],
    ["keyGeneration", input.keyGeneration, 512],
    ["routeGeneration", input.routeGeneration, 512],
    ["credentialGeneration", input.credentialGeneration, 512],
  ];
  for (const [name, value, maxBytes] of strings) {
    assertCanonicalString(name, value, maxBytes);
  }
  assertCanonicalAddresses(input.resolvedAddresses);
  assertCanonicalTransport(input);
  assertCanonicalLimits(input.limits);
};

const assertCanonicalAddresses = (addresses: readonly string[]): void => {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 32) {
    throw new HttpFinalAuthorizationBindingError("resolvedAddresses");
  }
  for (let index = 0; index < addresses.length; index += 1) {
    if (!Object.hasOwn(addresses, index)) {
      throw new HttpFinalAuthorizationBindingError(`resolvedAddress[${index}]`);
    }
    assertCanonicalString(`resolvedAddress[${index}]`, addresses[index], 64);
  }
};

const assertCanonicalTransport = (input: HttpEgressFinalAuthorizationFacts): void => {
  if (input.redirectHop !== 0) {throw new HttpFinalAuthorizationBindingError("redirectHop");}
  if (input.tlsProtocol !== "TLSv1.2" && input.tlsProtocol !== "TLSv1.3") {
    throw new HttpFinalAuthorizationBindingError("tlsProtocol");
  }
  if (input.alpn !== "http/1.1") {throw new HttpFinalAuthorizationBindingError("alpn");}
  if (!Number.isSafeInteger(input.originPort) || input.originPort < 1 || input.originPort > 65_535) {
    throw new HttpFinalAuthorizationBindingError("originPort");
  }
  if (!Number.isSafeInteger(input.observedPeerPort) || input.observedPeerPort < 1
    || input.observedPeerPort > 65_535) {
    throw new HttpFinalAuthorizationBindingError("observedPeerPort");
  }
};

const assertCanonicalLimits = (limits: HttpEgressLimits): void => {
  for (const name of LIMIT_FIELDS) {
    const value = limits[name];
    const allowsZero = name === "maxInboundBodyBytes" || name === "maxOutputBytes"
      || name === "deadline" || name === "closureDeadline";
    if (!Number.isSafeInteger(value) || (allowsZero ? value < 0 : value <= 0)) {
      throw new HttpFinalAuthorizationBindingError(`limits.${name}`);
    }
  }
  if (limits.closureDeadline < limits.deadline) {
    throw new HttpFinalAuthorizationBindingError("limits.closureDeadline");
  }
  if (!Number.isSafeInteger(limits.maxInboundHeaderBytes + limits.maxInboundBodyBytes)) {
    throw new HttpFinalAuthorizationBindingError("limits.maxInboundBodyBytes");
  }
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
): readonly Uint8Array[] => {
  assertCanonicalFacts(input);
  return Object.freeze([
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
};

export const snapshotHttpEgressTransportBinding = (
  binding: HttpEgressTransportBinding,
): HttpEgressTransportBinding => {
  const snapshot = snapshotHttpTransportBinding(binding);
  if (snapshot === undefined) {throw new HttpFinalAuthorizationBindingError("transportBinding");}
  return snapshot;
};

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
