import { types as nodeUtilTypes } from "node:util";

type Schema = ((value: unknown) => boolean) |
  { readonly array: Schema; readonly maximumItems: number } |
  { readonly object: Readonly<Record<string, Schema>> } | { readonly oneOf: readonly Schema[] };
const text = (value: unknown): boolean => typeof value === "string";
const number = (value: unknown): boolean => typeof value === "number";
const boolean = (value: unknown): boolean => typeof value === "boolean";
const nullableNumber = (value: unknown): boolean => value === null || typeof value === "number";
const literal = (...values: readonly unknown[]) => (value: unknown): boolean => values.includes(value);
const object = (members: Readonly<Record<string, Schema>>): Schema => ({ object: members });
const array = (member: Schema, maximumItems: number): Schema => ({ array: member, maximumItems });
const oneOf = (...schemas: readonly Schema[]): Schema => ({ oneOf: schemas });

const scope = object({ tenantId: text, projectId: text, operationId: text, scopeDigest: text });
const origin = object({ scheme: literal("https"), hostname: text, port: number });
const budgets = object({ requestBytes: number, responseBytes: number, totalMilliseconds: number });
const signingKey = object({ algorithm: literal("hmac-sha256-synthetic"), keyRef: text,
  keyGeneration: text });
const signature = object({ algorithm: literal("hmac-sha256-synthetic"), keyRef: text,
  keyGeneration: text, value: text });
const credentialField = object({ name: text, credentialBindingDigest: text, valueDigest: text,
  byteLength: number });
const request = object({
  method: literal("DELETE", "GET", "PATCH", "POST", "PUT"), scheme: literal("https"),
  authority: object({ hostname: text, port: number }), pathAndQuery: text,
  headers: object({ canonicalDigest: text, fieldCount: number,
    credentialFields: array(credentialField, 256) }),
  body: object({ digest: text, byteLength: number }),
  framing: object({ protocol: literal("http/1.1", "h2", "h3"),
    requestTarget: literal("origin-form", "pseudo-headers"),
    authoritySource: literal("host", ":authority"), contentLength: nullableNumber,
    transferEncoding: literal("absent", "present"),
    connectionSpecificHeaders: literal("absent", "present") }),
});
const policy = object({ policyRef: text, policyRevision: text, policyGeneration: text,
  authorizedRequestDigest: text, origin, dnsIdentity: text, tlsPolicyDigest: text, limits: budgets,
  decisionTtlMilliseconds: number, signingKey, revoked: boolean });
const providerAccess = object({ accessRef: text, providerRef: text, accountRef: text, routeRef: text,
  routeAuthorityDigest: text, credentialBindingDigest: text, routeGeneration: text,
  credentialGeneration: text });
const authority = object({ authorityRef: text, policy, providerAccess });
const clockView = object({ authorityId: text, epoch: text, controlTime: number });
const time = object({ authorityId: text, epoch: text, controlTime: number,
  expiresAtControlTime: number });
const provisionalDecision = object({
  contractVersion: literal("provider-process-egress-provisional-decision/v1"),
  authorizationRequestId: text, authorityRef: text, scope, policy, providerAccess, request,
  requestDigest: text, time, signingKey, decisionDigest: text, signature,
});
const address = object({ family: literal("ipv4", "ipv6"), address: text,
  classification: literal("public", "private", "loopback", "link-local", "metadata", "multicast",
    "unspecified", "ula", "mapped", "reserved") });

const provisionalSchema = object({ contractVersion: literal("provider-process-egress-provisional/v1"),
  authorizationRequestId: text, request });
const finalSchema = object({
  contractVersion: literal("provider-process-egress-final/v1"), provisional: provisionalDecision,
  boundaryUseId: text, connectionAttemptId: text, streamId: text,
  transport: literal("tcp-tls", "udp-quic"),
  resolver: object({ resolverIdentity: text, resolverEpoch: text, resolutionCount: number,
    addresses: array(address, 32) }),
  pinnedDestination: object({ address: text, port: number }),
  observedPeer: object({ address: text, port: number }),
  tls: object({ sniHostname: text, certificateValidated: boolean, dnsIdentity: text,
    certificateDigest: text, tlsPolicyDigest: text, alpn: literal("http/1.1", "h2", "h3") }),
  request, redirectHop: number,
});
const ownerOutcome = oneOf(
  object({ status: literal("current"), authority }),
  object({ status: literal("denied"),
    reason: literal("policy_denied", "policy_not_found", "route_unavailable", "revoked") }),
  object({ status: literal("indeterminate"), reason: literal("owner_unavailable", "owner_malformed") }),
);

const ownStringKeysOnly = (descriptors: object): string[] => {
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key === "symbol")) {throw new TypeError("symbol boundary property");}
  return keys as string[];
};

const detachArray = (value: object,
  schema: { readonly array: Schema; readonly maximumItems: number }, seen: WeakSet<object>) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("invalid boundary array");
  }
  if (value.length > schema.maximumItems) {throw new TypeError("oversized boundary array");}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = ownStringKeysOnly(descriptors).filter(key => key !== "length");
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new TypeError("sparse boundary array");
  }
  return keys.map(key => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("invalid boundary array property");
    }
    return detach(descriptor.value, schema.array, seen);
  });
};

const detachRecord = (value: object, schema: { readonly object: Readonly<Record<string, Schema>> },
  seen: WeakSet<object>) => {
  if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("invalid boundary record");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = Object.keys(schema.object).toSorted();
  const actual = ownStringKeysOnly(descriptors).toSorted();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new TypeError("inexact boundary record");
  }
  const clone: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("invalid boundary property");
    }
    clone[key] = detach(descriptor.value, schema.object[key]!, seen);
  }
  return clone;
};

const detach = (value: unknown, schema: Schema, seen: WeakSet<object>): unknown => {
  if (typeof schema === "function") {
    if (!schema(value)) {throw new TypeError("invalid boundary value");}
    return value;
  }
  if ("oneOf" in schema) {
    for (const candidate of schema.oneOf) {
      try { return detach(value, candidate, new WeakSet()); } catch { /* try the next exact variant */ }
    }
    throw new TypeError("invalid boundary variant");
  }
  if (value === null || typeof value !== "object" || nodeUtilTypes.isProxy(value)) {
    throw new TypeError("invalid boundary object");
  }
  if (seen.has(value)) {throw new TypeError("cyclic boundary value");}
  seen.add(value);
  try {
    return "array" in schema ? detachArray(value, schema, seen) : detachRecord(value, schema, seen);
  } finally { seen.delete(value); }
};

export const detachProvisionalEgressInput = (value: unknown): unknown =>
  detach(value, provisionalSchema, new WeakSet());
export const detachFinalEgressInput = (value: unknown): unknown =>
  detach(value, finalSchema, new WeakSet());
export const detachEgressAuthorityOutcome = (value: unknown): unknown =>
  detach(value, ownerOutcome, new WeakSet());
export const detachEgressClockView = (value: unknown): unknown =>
  detach(value, clockView, new WeakSet());
export const detachEgressDecisionSignature = (value: unknown): unknown =>
  detach(value, signature, new WeakSet());
export const detachEgressScope = (value: unknown): unknown =>
  detach(value, scope, new WeakSet());
export const isNodeProxy = (value: unknown): boolean =>
  value !== null && typeof value === "object" && nodeUtilTypes.isProxy(value);
