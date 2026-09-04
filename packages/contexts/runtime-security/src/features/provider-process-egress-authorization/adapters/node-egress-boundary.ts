import { types as nodeUtilTypes } from "node:util";

type Schema =
  | ((value: unknown) => boolean)
  | { readonly array: Schema }
  | { readonly object: Readonly<Record<string, Schema>> };

const text = (value: unknown): boolean => typeof value === "string";
const number = (value: unknown): boolean => typeof value === "number";
const boolean = (value: unknown): boolean => typeof value === "boolean";
const literal = (...values: readonly unknown[]) => (value: unknown): boolean => values.includes(value);
const object = (members: Readonly<Record<string, Schema>>): Schema => ({ object: members });
const array = (member: Schema): Schema => ({ array: member });

const scope = object({ operationId: text, tenantId: text, projectId: text, scopeDigest: text });
const providerRoute = object({ providerRef: text, accountRef: text, routeRef: text,
  routeDigest: text, credentialBindingDigest: text });
const generations = object({ policy: text, key: text, route: text, credential: text });
const origin = object({ scheme: literal("https"), hostname: text, port: number });
const address = object({ family: literal("ipv4", "ipv6"), address: text,
  classification: literal("public", "private", "loopback", "link-local", "metadata", "multicast",
    "unspecified", "ula", "mapped", "reserved") });
const resolver = object({ resolverIdentity: text, resolverEpoch: text, resolutionCount: number,
  addresses: array(address) });
const resolverAuthority = object({ resolverIdentity: text, resolverEpoch: text });
const certificateExpectation = object({ dnsIdentity: text, certificateDigest: text });
const budgets = object({ requestBytes: number, responseBytes: number, totalMilliseconds: number });
const intent = object({ method: literal("DELETE", "GET", "PATCH", "POST", "PUT"),
  pathAndQuery: text, bodyDigest: text, mediaType: text,
  applicationProtocol: literal("http/1.1", "h2", "h3"),
  transportMode: literal("direct-tls", "connect", "socks", "generic-proxy"),
  upgradeMode: literal("none", "websocket", "generic") });
const signature = object({ keyRef: text, keyGeneration: text, value: text });
const provisionalDecision = object({
  contractVersion: literal("provider-process-egress-provisional-decision/v1"),
  authorizationRequestId: text, scope, providerRoute, generations, origin, resolverAuthority,
  certificate: certificateExpectation, redirectHop: number, budgets,
  expiresAtControlTime: number, requestIntentDigest: text, decisionDigest: text, signature,
});

const provisionalSchema = object({
  contractVersion: literal("provider-process-egress-provisional/v1"),
  authorizationRequestId: text, scope, providerRoute, generations, origin, resolverAuthority,
  certificate: certificateExpectation, redirectHop: number, budgets,
  expiresAtControlTime: number, requestIntent: intent,
});

const finalSchema = object({
  contractVersion: literal("provider-process-egress-final/v1"), provisional: provisionalDecision,
  boundaryUseId: text, connectionAttemptId: text, streamId: text,
  transport: literal("tcp-tls", "udp-quic"),
  pinnedDestination: object({ address: text, port: number }),
  observedPeer: object({ address: text, port: number }), sniHostname: text,
  certificate: object({ validated: boolean, dnsIdentity: text, certificateDigest: text }),
  alpn: literal("http/1.1", "h2", "h3"), observedAtControlTime: number,
  currentAuthority: object({ scope, providerRoute, generations, revoked: boolean,
    resolverIdentity: text, resolverEpoch: text, budgets }),
  resolver, redirectHop: number, requestIntent: intent,
});

const detachArray = (value: object, schema: { readonly array: Schema }, seen: WeakSet<object>) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("invalid boundary array");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const indexKeys = Object.keys(descriptors).filter(key => key !== "length");
  if (indexKeys.length !== value.length ||
    indexKeys.some((key, index) => key !== String(index))) {throw new TypeError("sparse array");}
  return indexKeys.map(key => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("invalid array property");
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
  const actual = Object.keys(descriptors).toSorted();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new TypeError("inexact boundary record");
  }
  const clone: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("invalid boundary property");
    }
    const memberSchema = schema.object[key];
    if (memberSchema === undefined) {throw new TypeError("unknown boundary property");}
    clone[key] = detach(descriptor.value, memberSchema, seen);
  }
  return clone;
};

const detach = (value: unknown, schema: Schema, seen: WeakSet<object>): unknown => {
  if (typeof schema === "function") {
    if (!schema(value)) {throw new TypeError("invalid boundary value");}
    return value;
  }
  if (value === null || typeof value !== "object" || nodeUtilTypes.isProxy(value)) {
    throw new TypeError("invalid boundary object");
  }
  if (seen.has(value)) {throw new TypeError("cyclic boundary value");}
  seen.add(value);
  try {
    return "array" in schema
      ? detachArray(value, schema, seen)
      : detachRecord(value, schema, seen);
  } finally {
    seen.delete(value);
  }
};

export const detachProvisionalEgressInput = (value: unknown): unknown =>
  detach(value, provisionalSchema, new WeakSet());
export const detachFinalEgressInput = (value: unknown): unknown =>
  detach(value, finalSchema, new WeakSet());
export const isNodeProxy = (value: unknown): boolean =>
  value !== null && typeof value === "object" && nodeUtilTypes.isProxy(value);
