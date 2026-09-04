import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { types as nodeTypes } from "node:util";

import type { BufferedEgressRequestV1, ContainedTurnEgressDependencies, ContainedTurnEgressRequest,
  EgressPolicyTimeSnapshotV1, EgressTransportV1, ProviderRouteAuthoritySnapshotV1,
  TrustedEgressHostIdentityV1 } from "./composition.js";

export type RouteAuthority = Readonly<ProviderRouteAuthoritySnapshotV1>;
export type PolicyAuthority = Readonly<EgressPolicyTimeSnapshotV1>;
export type BufferedRequest = Readonly<{request: ContainedTurnEgressRequest;
  buffered: BufferedEgressRequestV1; headerDigest: string; bodyDigest: string;
  requestDigest: string; requestBytes: number}>;
export type TransportObservation = Readonly<{canonicalAddresses: readonly string[];
  peerAddress: string; peerPort: 443; tlsServerName: string; tlsSpkiDigest: string;
  alpn: "http/1.1"; phase: "immediately_before_first_application_byte"}>;
export type TransportResult = Readonly<{status: "completed"; applicationBytesWritten: number;
  responseBytes: number; responseDigest: string}> | Readonly<{status: "not_sent";
  applicationBytesWritten: 0}> | Readonly<{status: "write_indeterminate"}>;

const id = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 512 && /^[\x21-\x7e]+$/u.test(value);
export const isDigest = (value: unknown): value is string => typeof value === "string" &&
  /^sha256:[\da-f]{64}$/u.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export const hash = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

export const exact = <Name extends string>(value: unknown, names: readonly Name[]) => {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {return;}
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {return;}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length) {return;}
  const result = Object.create(null) as Record<Name, unknown>;
  for (const name of names) {
    const descriptor = descriptors[name];
    if (descriptor === undefined || !("value" in descriptor)) {return;}
    result[name] = descriptor.value;
  }
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !names.includes(key as Name))) {return;}
  return result as Readonly<Record<Name, unknown>>;
};
const methods = <Name extends string>(value: unknown, names: readonly Name[]) => {
  const owner = exact(value, names);
  if (owner === undefined || names.some(name => typeof owner[name] !== "function" || nodeTypes.isProxy(owner[name]))) {return;}
  return Object.freeze(Object.fromEntries(names.map(name => [name, (...args: unknown[]) =>
    Reflect.apply(owner[name] as (...values: unknown[]) => unknown, value, args)]))) as unknown as
    Readonly<Record<Name, (...args: never[]) => unknown>>;
};
export const captureComposition = (identity: unknown, dependencies: unknown) => {
  const host = exact(identity, ["attemptId", "environmentId", "gatewayId", "hostInstanceId", "hostBootId", "transportMode"]);
  const deps = exact(dependencies, ["routeAuthority", "dispatchAuthority", "policyAuthority", "signer", "transportGateway"]);
  const routeAuthority = methods(deps?.routeAuthority, ["resolveExact", "revalidateExact"]);
  const dispatchAuthority = methods(deps?.dispatchAuthority, ["revalidateClaimCommitted"]);
  const policyAuthority = methods(deps?.policyAuthority, ["resolve", "revalidateExact"]);
  const signer = methods(deps?.signer, ["sign", "verify"]);
  const transportGateway = methods(deps?.transportGateway, ["openOneShotHttps"]);
  if (host === undefined || ![host.attemptId, host.environmentId, host.gatewayId, host.hostInstanceId, host.hostBootId].every(id) ||
      host.transportMode !== "one_shot_https" || routeAuthority === undefined || dispatchAuthority === undefined ||
      policyAuthority === undefined || signer === undefined || transportGateway === undefined) {
    throw new TypeError("invalid contained turn egress composition");
  }
  return Object.freeze({identity: Object.freeze({...host}) as TrustedEgressHostIdentityV1,
    dependencies: Object.freeze({routeAuthority, dispatchAuthority, policyAuthority, signer,
      transportGateway}) as unknown as ContainedTurnEgressDependencies});
};

const normalizedPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 2_048 && value.startsWith("/") && !value.includes("\\") && !value.includes("#") &&
  !value.includes("//") && ![...value].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 32 || code === 127;
  }) && !/%(?:2e|2f|5c|25|0[0-9a-f]|7f)/iu.test(value) && !/%(?![0-9a-f]{2})/iu.test(value);
const dangerousHeaders = new Set(["authorization", "connection", "content-length", "cookie", "forwarded",
  "host", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]);

const snapshotRequestParts = (value: unknown) => {
  const request = exact(value, ["scope", "providerId", "providerAccountRef", "providerRouteRef", "operationId",
    "dispatch", "requestId", "requestNonce", "method", "path", "headers", "body", "budgets"]);
  const scope = exact(request?.scope, ["tenantId", "projectId", "scopeDigest"]);
  const dispatch = exact(request?.dispatch, ["grantRequestId", "grantProofId", "claimProofId", "claimBindingDigest", "consumptionDigest"]);
  const budgets = exact(request?.budgets, ["requestBytes", "responseBytes", "deadlineMs"]);
  if (request === undefined || scope === undefined || dispatch === undefined || budgets === undefined ||
      ![scope.tenantId, scope.projectId, scope.scopeDigest, request.providerId, request.providerAccountRef,
        request.providerRouteRef, request.operationId, dispatch.grantRequestId,
        dispatch.grantProofId, dispatch.claimProofId, request.requestId, request.requestNonce].every(id) ||
      !isDigest(dispatch.claimBindingDigest) || !isDigest(dispatch.consumptionDigest) ||
      (request.method !== "GET" && request.method !== "POST") || !normalizedPath(request.path) ||
      ![budgets.requestBytes, budgets.responseBytes, budgets.deadlineMs].every(count) ||
      (budgets.responseBytes as number) === 0 || (budgets.deadlineMs as number) === 0) {return;}
  return {request, scope, dispatch, budgets};
};
const snapshotHeaders = (value: unknown): readonly Readonly<{name: string; value: string}>[] | undefined => {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > 64) {return;}
  const headers: {name: string; value: string}[] = [];
  for (const candidate of value) {
    const header = exact(candidate, ["name", "value"]);
    if (header === undefined || typeof header.name !== "string" || typeof header.value !== "string" ||
        header.name !== header.name.toLowerCase() || !/^[a-z0-9-]{1,64}$/u.test(header.name) ||
        dangerousHeaders.has(header.name) || header.value.length > 8_192 || /[\r\n\0]/u.test(header.value)) {return;}
    headers.push(Object.freeze({name: header.name, value: header.value}));
  }
  return Object.freeze(headers);
};
const snapshotBody = (value: unknown): Uint8Array | undefined => value instanceof Uint8Array &&
  !nodeTypes.isProxy(value) && Object.getPrototypeOf(value) === Uint8Array.prototype &&
  value.buffer instanceof ArrayBuffer && value.byteLength <= 1_048_576 ? Uint8Array.from(value) : undefined;

export const snapshotRequest = (value: unknown): BufferedRequest | undefined => {
  const parts = snapshotRequestParts(value);
  if (parts === undefined) {return;}
  const {request, scope, dispatch, budgets} = parts;
  const headers = snapshotHeaders(request.headers);
  const body = snapshotBody(request.body);
  if (headers === undefined || body === undefined) {return;}
  const headerDigest = hash(JSON.stringify(headers));
  const bodyDigest = hash(body);
  const requestBytes = body.byteLength + headers.reduce((total, header) => total +
    Buffer.byteLength(header.name) + Buffer.byteLength(header.value) + 4, 2);
  if (requestBytes > (budgets.requestBytes as number) || requestBytes > 1_064_962) {return;}
  const safe = Object.freeze({scope: Object.freeze({...scope}), providerId: request.providerId,
    providerAccountRef: request.providerAccountRef, providerRouteRef: request.providerRouteRef,
    operationId: request.operationId, dispatch: Object.freeze({...dispatch}),
    requestId: request.requestId, requestNonce: request.requestNonce, method: request.method, path: request.path,
    headers, body, budgets: Object.freeze({...budgets})}) as ContainedTurnEgressRequest;
  const requestDigest = hash(JSON.stringify({method: safe.method, path: safe.path, headerDigest, bodyDigest,
    requestBytes}));
  return Object.freeze({request: safe, buffered: Object.freeze({method: safe.method, headers: safe.headers, body}),
    headerDigest, bodyDigest, requestDigest, requestBytes});
};

export const snapshotRoute = (value: unknown): RouteAuthority | undefined => {
  const route = exact(value, ["contractVersion", "tenantId", "projectId", "providerId", "providerAccountRef",
    "providerRouteRef", "routeRevision", "authorityDigest", "scheme", "host", "port", "tlsServerName", "pathConstraint"]);
  if (route === undefined || route.contractVersion !== "provider-route-authority/v1" ||
      ![route.tenantId, route.projectId, route.providerId, route.providerAccountRef, route.providerRouteRef,
        route.routeRevision].every(id) || !isDigest(route.authorityDigest) || route.scheme !== "https" ||
      route.port !== 443 || typeof route.host !== "string" || typeof route.tlsServerName !== "string" ||
      route.host !== route.tlsServerName || isIP(route.host) !== 0 || route.host !== route.host.toLowerCase() ||
      !/^[a-z0-9.-]+$/u.test(route.host) || route.host.endsWith(".") || route.host.split(".").some(label =>
        label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-")) ||
      !normalizedPath(route.pathConstraint)) {return;}
  return Object.freeze({...route}) as RouteAuthority;
};
export const snapshotPolicy = (value: unknown): PolicyAuthority | undefined => {
  const policy = exact(value, ["contractVersion", "policyId", "policyRevision", "policyGeneration", "keyId",
    "keyGeneration", "signerRevision", "timeAuthorityId", "timeGeneration", "observedAt", "expiresAt",
    "maxRequestBytes", "maxResponseBytes", "maxDeadlineMs"]);
  return policy !== undefined && policy.contractVersion === "contained-turn-egress-policy/v1" &&
    [policy.policyId, policy.policyRevision, policy.policyGeneration, policy.keyId, policy.keyGeneration,
      policy.signerRevision, policy.timeAuthorityId, policy.timeGeneration].every(id) &&
    [policy.observedAt, policy.expiresAt, policy.maxRequestBytes, policy.maxResponseBytes,
      policy.maxDeadlineMs].every(count) && (policy.expiresAt as number) > (policy.observedAt as number) &&
    (policy.maxRequestBytes as number) > 0 && (policy.maxResponseBytes as number) > 0 &&
    (policy.maxDeadlineMs as number) > 0 ? Object.freeze({...policy}) as PolicyAuthority : undefined;
};

const deniedV4 = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
  deniedV4.addSubnet(address, prefix, "ipv4");
}
const deniedV6 = new BlockList();
for (const [address, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32],
  ["2001:2::", 48], ["2001:10::", 28], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {deniedV6.addSubnet(address, prefix, "ipv6");}
export const snapshotObservation = (value: unknown): TransportObservation | undefined => {
  const observation = exact(value, ["canonicalAddresses", "peerAddress", "peerPort", "tlsServerName", "tlsSpkiDigest", "alpn", "phase"]);
  if (observation === undefined || !Array.isArray(observation.canonicalAddresses) ||
      nodeTypes.isProxy(observation.canonicalAddresses) || observation.canonicalAddresses.length === 0 ||
      observation.canonicalAddresses.length > 16 || typeof observation.peerAddress !== "string" ||
      observation.peerPort !== 443 || typeof observation.tlsServerName !== "string" ||
      !isDigest(observation.tlsSpkiDigest) || observation.alpn !== "http/1.1" ||
      observation.phase !== "immediately_before_first_application_byte") {return;}
  const addresses = observation.canonicalAddresses.map(item => typeof item === "string" ? item.toLowerCase() : "");
  if (new Set(addresses).size !== addresses.length || addresses.some(address => {
    const version = isIP(address);
    return version === 0 || address.includes("%") || (version === 6 && (address.includes(".") || address.startsWith("::ffff:"))) ||
      (version === 4 ? deniedV4.check(address, "ipv4") : deniedV6.check(address, "ipv6"));
  }) || JSON.stringify(addresses) !== JSON.stringify(addresses.toSorted()) || !addresses.includes(observation.peerAddress)) {return;}
  return Object.freeze({...observation, canonicalAddresses: Object.freeze(addresses)}) as TransportObservation;
};
export const captureTransport = (value: unknown): EgressTransportV1 | undefined =>
  methods(value, ["execute", "close"]) as unknown as EgressTransportV1 | undefined;
export const snapshotTransportResult = (value: unknown): TransportResult | undefined => {
  const completed = exact(value, ["status", "applicationBytesWritten", "responseBytes", "responseDigest"]);
  if (completed?.status === "completed" && count(completed.applicationBytesWritten) &&
      (completed.applicationBytesWritten as number) > 0 && count(completed.responseBytes) && isDigest(completed.responseDigest)) {
    return Object.freeze({...completed}) as TransportResult;
  }
  const notSent = exact(value, ["status", "applicationBytesWritten"]);
  if (notSent?.status === "not_sent" && notSent.applicationBytesWritten === 0) {return Object.freeze({...notSent}) as TransportResult;}
  const uncertain = exact(value, ["status"]);
  return uncertain?.status === "write_indeterminate" ? Object.freeze({...uncertain}) as TransportResult : undefined;
};
