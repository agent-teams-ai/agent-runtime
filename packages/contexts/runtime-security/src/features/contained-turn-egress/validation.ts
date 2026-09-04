import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type { DispatchConsumptionReceipt, ObserveDispatchConsumptionInput } from
  "../contained-turn-dispatch-authority/contracts/contained-turn-dispatch-authority-v1.js";
import type { BufferedEgressRequestV1, ContainedTurnEgressDependencies, ContainedTurnEgressRequest,
  EgressAuthorizationBodyV1, EgressPolicyTimeSnapshotV1, EgressTransportV1, NetworkAddressV1,
  ProviderRouteAuthoritySnapshotV1, TrustedEgressHostIdentityV1 } from "./composition.js";

export type RouteAuthority = Readonly<ProviderRouteAuthoritySnapshotV1>;
export type PolicyAuthority = Readonly<EgressPolicyTimeSnapshotV1>;
export type BufferedRequest = Readonly<{request: ContainedTurnEgressRequest;
  buffered: BufferedEgressRequestV1; headerDigest: string; bodyDigest: string;
  requestDigest: string; requestBytes: number}>;
export type TransportObservation = Readonly<{canonicalAddresses: readonly NetworkAddressV1[];
  peerAddress: NetworkAddressV1; peerPort: 443; tlsServerName: string; tlsSpkiDigest: string;
  alpn: "http/1.1"; phase: "immediately_before_first_application_byte"}>;
export type TransportResult = Readonly<{status: "completed"; applicationBytesWritten: number;
  responseBytes: number; responseDigest: string; authorizationConsumption: unknown}> |
  Readonly<{status: "not_sent"; applicationBytesWritten: 0}> | Readonly<{status: "write_indeterminate"}>;

const utf8 = new TextEncoder();
const frame = (tag: string, values: readonly (string | number | Uint8Array)[]): Uint8Array => {
  const fields = [utf8.encode(tag), ...values.map(value => value instanceof Uint8Array ? value : utf8.encode(String(value)))];
  const size = fields.reduce((total, value) => total + 4 + value.byteLength, 0);
  const output = new Uint8Array(size); const view = new DataView(output.buffer); let offset = 0;
  for (const value of fields) {view.setUint32(offset, value.byteLength); offset += 4; output.set(value, offset); offset += value.byteLength;}
  return output;
};
const flatten = (values: readonly Uint8Array[]) => frame("sequence/v1", values);
export const hash = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const identifier = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 512 && /^[\x21-\x7e]+$/u.test(value);
export const isDigest = (value: unknown): value is string => typeof value === "string" && /^sha256:[\da-f]{64}$/u.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export const exact = <Name extends string>(value: unknown, names: readonly Name[]) => {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {return;}
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {return;}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length) {return;}
  const result = Object.create(null) as Record<Name, unknown>;
  for (const name of names) {const descriptor = descriptors[name]; if (descriptor === undefined || !("value" in descriptor)) {return;} result[name] = descriptor.value;}
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
  const dispatchAuthority = methods(deps?.dispatchAuthority, ["observeDispatchConsumption"]);
  const policyAuthority = methods(deps?.policyAuthority, ["resolve", "revalidateExact"]);
  const signer = methods(deps?.signer, ["sign", "verify"]);
  const transportGateway = methods(deps?.transportGateway, ["openOneShotHttps"]);
  if (host === undefined || ![host.attemptId, host.environmentId, host.gatewayId, host.hostInstanceId, host.hostBootId].every(identifier) ||
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
  !value.includes("//") && ![...value].some(character => (character.codePointAt(0) ?? 0) <= 32 ||
    character.codePointAt(0) === 127) && !/%(?:2e|2f|5c|25|0[0-9a-f]|7f)/iu.test(value) && !/%(?![0-9a-f]{2})/iu.test(value);
const dangerousHeaders = new Set(["authorization", "connection", "content-length", "cookie", "forwarded", "host",
  "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "x-forwarded-for",
  "x-forwarded-host", "x-forwarded-proto"]);
const dispatchNames = ["purpose", "operationId", "scope", "grantRequestId", "requestDigest", "providerId",
  "authorityGeneration", "providerBindingDigest", "claimBindingDigest", "acceptedAuthorityDigest",
  "expectedAuthorityHeadDigest", "expectedAuthorityRevision", "expectedConstraintsDigest",
  "expectedContainmentPolicyDigest"] as const;
const snapshotDispatch = (value: unknown): ObserveDispatchConsumptionInput | undefined => {
  const dispatch = exact(value, dispatchNames); const scope = exact(dispatch?.scope, ["tenantId", "projectId", "scopeDigest"]);
  if (dispatch === undefined || scope === undefined || dispatch.purpose !== "contained-turn.provider-dispatch/v1" ||
      ![dispatch.operationId, scope.tenantId, scope.projectId, scope.scopeDigest, dispatch.grantRequestId,
        dispatch.requestDigest, dispatch.providerId, dispatch.authorityGeneration, dispatch.providerBindingDigest,
        dispatch.claimBindingDigest, dispatch.acceptedAuthorityDigest, dispatch.expectedAuthorityHeadDigest,
        dispatch.expectedAuthorityRevision, dispatch.expectedConstraintsDigest,
        dispatch.expectedContainmentPolicyDigest].every(identifier)) {return;}
  return Object.freeze({...dispatch, scope: Object.freeze({...scope})}) as ObserveDispatchConsumptionInput;
};
const snapshotHeaders = (value: unknown): readonly Readonly<{name: string; value: string}>[] | undefined => {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > 64) {return;}
  const result: Readonly<{name: string; value: string}>[] = [];
  for (const candidate of value) {const header = exact(candidate, ["name", "value"]);
    if (header === undefined || typeof header.name !== "string" || typeof header.value !== "string" ||
        header.name !== header.name.toLowerCase() || !/^[a-z0-9-]{1,64}$/u.test(header.name) ||
        dangerousHeaders.has(header.name) || header.value.length > 8_192 || /[\r\n\0]/u.test(header.value)) {return;}
    result.push(Object.freeze({name: header.name, value: header.value}));}
  return Object.freeze(result);
};
const snapshotBody = (value: unknown): Uint8Array | undefined => value instanceof Uint8Array &&
  !nodeTypes.isProxy(value) && Object.getPrototypeOf(value) === Uint8Array.prototype && value.buffer instanceof ArrayBuffer &&
  value.byteLength <= 1_048_576 ? Uint8Array.from(value) : undefined;
const canonicalHeaders = (headers: readonly Readonly<{name: string; value: string}>[]) =>
  frame("contained-turn-egress-headers/v1", headers.flatMap(header => [header.name, header.value]));
const canonicalDispatch = (value: ObserveDispatchConsumptionInput) => frame("contained-turn-egress-dispatch/v1", [
  value.purpose, value.operationId, value.scope.tenantId, value.scope.projectId, value.scope.scopeDigest,
  value.grantRequestId, value.requestDigest, value.providerId, value.authorityGeneration, value.providerBindingDigest,
  value.claimBindingDigest, value.acceptedAuthorityDigest, value.expectedAuthorityHeadDigest,
  value.expectedAuthorityRevision, value.expectedConstraintsDigest, value.expectedContainmentPolicyDigest]);
export const snapshotRequest = (value: unknown): BufferedRequest | undefined => {
  const candidate = exact(value, ["scope", "providerId", "providerAccountRef", "providerRouteRef", "credentialBindingRef",
    "credentialBindingDigest", "credentialGeneration", "credentialRevision", "operationId", "dispatch", "requestId",
    "requestNonce", "method", "path", "headers", "body", "budgets"]);
  const scope = exact(candidate?.scope, ["tenantId", "projectId", "scopeDigest"]);
  const budgets = exact(candidate?.budgets, ["requestBytes", "responseBytes", "deadlineMs"]);
  const dispatch = snapshotDispatch(candidate?.dispatch); const headers = snapshotHeaders(candidate?.headers);
  const body = snapshotBody(candidate?.body);
  if ([candidate, scope, budgets, dispatch, headers, body].some(part => part === undefined)) {return;}
  const safeCandidate = candidate as NonNullable<typeof candidate>; const safeScope = scope as NonNullable<typeof scope>;
  const safeBudgets = budgets as NonNullable<typeof budgets>; const safeDispatch = dispatch as NonNullable<typeof dispatch>;
  const safeHeaders = headers as NonNullable<typeof headers>; const safeBody = body as NonNullable<typeof body>;
  const valid = [[safeCandidate.operationId, safeDispatch.operationId], [safeCandidate.providerId, safeDispatch.providerId],
    [safeScope.tenantId, safeDispatch.scope.tenantId], [safeScope.projectId, safeDispatch.scope.projectId],
    [safeScope.scopeDigest, safeDispatch.scope.scopeDigest]].every(([left, right]) => left === right) &&
    [safeScope.tenantId, safeScope.projectId, safeScope.scopeDigest, safeCandidate.providerId,
      safeCandidate.providerAccountRef, safeCandidate.providerRouteRef, safeCandidate.credentialBindingRef,
      safeCandidate.credentialBindingDigest, safeCandidate.credentialGeneration, safeCandidate.credentialRevision,
      safeCandidate.operationId, safeCandidate.requestId, safeCandidate.requestNonce].every(identifier) &&
    isDigest(safeCandidate.credentialBindingDigest) && ["GET", "POST"].includes(safeCandidate.method as string) &&
    normalizedPath(safeCandidate.path) && [safeBudgets.requestBytes, safeBudgets.responseBytes,
      safeBudgets.deadlineMs].every(count) && safeBudgets.responseBytes !== 0 && safeBudgets.deadlineMs !== 0;
  if (!valid) {return;}
  const headerBytes = canonicalHeaders(safeHeaders); const bodyBytes = frame("contained-turn-egress-body/v1", [safeBody]);
  const requestBytes = safeBody.byteLength + safeHeaders.reduce((total, header) => total + utf8.encode(header.name).byteLength +
    utf8.encode(header.value).byteLength + 4, 2);
  if (requestBytes > (safeBudgets.requestBytes as number) || requestBytes > 1_064_962) {return;}
  const safe = Object.freeze({scope: Object.freeze({...safeScope}), providerId: safeCandidate.providerId,
    providerAccountRef: safeCandidate.providerAccountRef, providerRouteRef: safeCandidate.providerRouteRef,
    credentialBindingRef: safeCandidate.credentialBindingRef, credentialBindingDigest: safeCandidate.credentialBindingDigest,
    credentialGeneration: safeCandidate.credentialGeneration, credentialRevision: safeCandidate.credentialRevision,
    operationId: safeCandidate.operationId, dispatch: safeDispatch, requestId: safeCandidate.requestId,
    requestNonce: safeCandidate.requestNonce, method: safeCandidate.method, path: safeCandidate.path,
    headers: safeHeaders, body: safeBody, budgets: Object.freeze({...safeBudgets})}) as ContainedTurnEgressRequest;
  const requestCanonical = frame("contained-turn-egress-request/v1", [safe.scope.tenantId, safe.scope.projectId,
    safe.scope.scopeDigest, safe.providerId, safe.providerAccountRef, safe.providerRouteRef, safe.credentialBindingRef,
    safe.credentialBindingDigest, safe.credentialGeneration, safe.credentialRevision, safe.operationId,
    canonicalDispatch(safeDispatch), safe.requestId, safe.requestNonce, safe.method, safe.path, headerBytes, bodyBytes,
    safe.budgets.requestBytes, safe.budgets.responseBytes, safe.budgets.deadlineMs]);
  return Object.freeze({request: safe, buffered: Object.freeze({method: safe.method, headers: safeHeaders, body: safeBody}),
    headerDigest: hash(headerBytes), bodyDigest: hash(bodyBytes), requestDigest: hash(requestCanonical), requestBytes});
};

export const snapshotRoute = (value: unknown): RouteAuthority | undefined => {
  const route = exact(value, ["contractVersion", "tenantId", "projectId", "providerId", "providerAccountRef",
    "providerRouteRef", "credentialBindingRef", "credentialBindingDigest", "credentialGeneration", "credentialRevision",
    "routeRevision", "authorityDigest", "scheme", "host", "port", "tlsServerName", "pathConstraint"]);
  if (route === undefined || route.contractVersion !== "provider-route-authority/v1" ||
      ![route.tenantId, route.projectId, route.providerId, route.providerAccountRef, route.providerRouteRef,
        route.credentialBindingRef, route.credentialGeneration, route.credentialRevision, route.routeRevision].every(identifier) ||
      !isDigest(route.credentialBindingDigest) || !isDigest(route.authorityDigest) || route.scheme !== "https" ||
      route.port !== 443 || typeof route.host !== "string" || typeof route.tlsServerName !== "string" ||
      route.host !== route.tlsServerName || route.host !== route.host.toLowerCase() || !/^[a-z0-9.-]+$/u.test(route.host) ||
      route.host.endsWith(".") || /^\d+(?:\.\d+){3}$/u.test(route.host) || route.host.split(".").some(label =>
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
      policy.signerRevision, policy.timeAuthorityId, policy.timeGeneration].every(identifier) &&
    [policy.observedAt, policy.expiresAt, policy.maxRequestBytes, policy.maxResponseBytes, policy.maxDeadlineMs].every(count) &&
    (policy.expiresAt as number) > (policy.observedAt as number) && (policy.maxRequestBytes as number) > 0 &&
    (policy.maxResponseBytes as number) > 0 && (policy.maxDeadlineMs as number) > 0 ?
    Object.freeze({...policy}) as PolicyAuthority : undefined;
};

const subnet = (hex: string, network: string, bits: number) => {
  const width = BigInt(hex.length * 4); const shift = width - BigInt(bits);
  return BigInt(`0x${hex}`) >> shift === BigInt(`0x${network}`) >> shift;
};
const deniedV4: readonly [string, number][] = [["00000000", 8], ["0a000000", 8], ["64400000", 10],
  ["7f000000", 8], ["a9fe0000", 16], ["ac100000", 12], ["c0000000", 24], ["c0000200", 24],
  ["c01fc400", 24], ["c034c100", 24], ["c0586300", 24], ["c0a80000", 16], ["c0af3000", 24],
  ["c6120000", 15], ["c6336400", 24], ["cb007100", 24], ["e0000000", 4], ["f0000000", 4]];
const deniedV6: readonly [string, number][] = [["00000000000000000000000000000000", 128],
  ["00000000000000000000000000000001", 128], ["00000000000000000000ffff00000000", 96],
  ["0064ff9b000000000000000000000000", 96], ["0064ff9b000100000000000000000000", 48],
  ["01000000000000000000000000000000", 64], ["20010000000000000000000000000000", 32],
  ["20010002000000000000000000000000", 48], ["20010003000000000000000000000000", 32],
  ["20010010000000000000000000000000", 28], ["20010020000000000000000000000000", 28],
  ["20010db8000000000000000000000000", 32], ["20020000000000000000000000000000", 16],
  ["2620004f800000000000000000000000", 48], ["3fff0000000000000000000000000000", 20],
  ["fc000000000000000000000000000000", 7], ["fe800000000000000000000000000000", 10],
  ["ff000000000000000000000000000000", 8]];
const snapshotAddress = (value: unknown): NetworkAddressV1 | undefined => {
  const address = exact(value, ["family", "bytesHex"]);
  if (address === undefined || (address.family !== "ipv4" && address.family !== "ipv6") ||
      typeof address.bytesHex !== "string" || !/^[0-9a-f]+$/u.test(address.bytesHex) ||
      address.bytesHex.length !== (address.family === "ipv4" ? 8 : 32)) {return;}
  const denied = address.family === "ipv4" ? deniedV4 : deniedV6;
  if (denied.some(([network, bits]) => subnet(address.bytesHex as string, network, bits))) {return;}
  return Object.freeze({family: address.family, bytesHex: address.bytesHex}) as NetworkAddressV1;
};
const addressKey = (value: NetworkAddressV1) => `${value.family}:${value.bytesHex}`;
export const snapshotObservation = (value: unknown): TransportObservation | undefined => {
  const observation = exact(value, ["canonicalAddresses", "peerAddress", "peerPort", "tlsServerName", "tlsSpkiDigest", "alpn", "phase"]);
  if (observation === undefined || !Array.isArray(observation.canonicalAddresses) || nodeTypes.isProxy(observation.canonicalAddresses) ||
      observation.canonicalAddresses.length === 0 || observation.canonicalAddresses.length > 16 ||
      observation.peerPort !== 443 || !identifier(observation.tlsServerName) || !isDigest(observation.tlsSpkiDigest) ||
      observation.alpn !== "http/1.1" || observation.phase !== "immediately_before_first_application_byte") {return;}
  const addresses = observation.canonicalAddresses.map(snapshotAddress); const peer = snapshotAddress(observation.peerAddress);
  if (peer === undefined || addresses.some(address => address === undefined)) {return;}
  const safe = addresses as NetworkAddressV1[]; const keys = safe.map(addressKey);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && key <= keys[index - 1]!) ||
      !keys.includes(addressKey(peer))) {return;}
  return Object.freeze({...observation, canonicalAddresses: Object.freeze(safe), peerAddress: peer}) as TransportObservation;
};

const receiptNames = ["contractVersion", "purpose", "operationId", "scope", "grantRequestId", "requestDigest",
  "providerId", "authorityGeneration", "providerBindingDigest", "claimBindingDigest", "acceptedAuthorityDigest",
  "authorityHeadDigestAtConsumption", "authorityRevision", "constraintsDigest", "containmentPolicyDigest",
  "consumptionDigest", "claimBeforeControlTime", "consumedAtControlTime", "ownerEvidenceRef"] as const;
export const committedReceipt = (value: unknown, expected: ObserveDispatchConsumptionInput): DispatchConsumptionReceipt | undefined => {
  const outcome = exact(value, ["status", "receipt", "lifecycleState"]);
  const receipt = exact(outcome?.receipt, receiptNames); const scope = exact(receipt?.scope, ["tenantId", "projectId", "scopeDigest"]);
  if ([outcome, receipt, scope].some(part => part === undefined)) {return;}
  const safeOutcome = outcome as NonNullable<typeof outcome>; const safeReceipt = receipt as NonNullable<typeof receipt>;
  const safeScope = scope as NonNullable<typeof scope>;
  const pairs = [[safeOutcome.status, "consumed"], [safeOutcome.lifecycleState, "claim_committed"],
    [safeReceipt.contractVersion, "contained-turn-dispatch-consumption/v1"], [safeReceipt.purpose, expected.purpose],
    [safeReceipt.operationId, expected.operationId], [safeScope.tenantId, expected.scope.tenantId],
    [safeScope.projectId, expected.scope.projectId], [safeScope.scopeDigest, expected.scope.scopeDigest],
    [safeReceipt.grantRequestId, expected.grantRequestId], [safeReceipt.requestDigest, expected.requestDigest],
    [safeReceipt.providerId, expected.providerId], [safeReceipt.authorityGeneration, expected.authorityGeneration],
    [safeReceipt.providerBindingDigest, expected.providerBindingDigest], [safeReceipt.claimBindingDigest, expected.claimBindingDigest],
    [safeReceipt.acceptedAuthorityDigest, expected.acceptedAuthorityDigest],
    [safeReceipt.authorityHeadDigestAtConsumption, expected.expectedAuthorityHeadDigest],
    [safeReceipt.authorityRevision, expected.expectedAuthorityRevision],
    [safeReceipt.constraintsDigest, expected.expectedConstraintsDigest],
    [safeReceipt.containmentPolicyDigest, expected.expectedContainmentPolicyDigest]];
  const valid = pairs.every(([left, right]) => left === right) && identifier(safeReceipt.consumptionDigest) &&
    count(safeReceipt.claimBeforeControlTime) && count(safeReceipt.consumedAtControlTime) &&
    (safeReceipt.claimBeforeControlTime as number) >= (safeReceipt.consumedAtControlTime as number) &&
    identifier(safeReceipt.ownerEvidenceRef);
  return valid ? Object.freeze({...safeReceipt, scope: Object.freeze({...safeScope})}) as DispatchConsumptionReceipt : undefined;
};
const canonicalReceipt = (value: DispatchConsumptionReceipt) => frame("contained-turn-egress-dispatch-receipt/v1", [
  value.contractVersion, value.purpose, value.operationId, value.scope.tenantId, value.scope.projectId,
  value.scope.scopeDigest, value.grantRequestId, value.requestDigest, value.providerId, value.authorityGeneration,
  value.providerBindingDigest, value.claimBindingDigest, value.acceptedAuthorityDigest,
  value.authorityHeadDigestAtConsumption, value.authorityRevision, value.constraintsDigest,
  value.containmentPolicyDigest, value.consumptionDigest, value.claimBeforeControlTime,
  value.consumedAtControlTime, value.ownerEvidenceRef]);
const canonicalAddress = (value: NetworkAddressV1) => frame("contained-turn-egress-address/v1", [value.family, value.bytesHex]);
export const canonicalAuthorization = (value: EgressAuthorizationBodyV1) => frame("contained-turn-egress-authorization/v1", [
  value.contractVersion, value.tenantId, value.projectId, value.scopeDigest, value.providerId,
  value.providerAccountRef, value.providerRouteRef, value.credentialBindingRef, value.credentialBindingDigest,
  value.credentialGeneration, value.credentialRevision, value.routeRevision, value.routeAuthorityDigest,
  value.operationId, value.attemptId, canonicalReceipt(value.dispatchReceipt), value.requestId, value.requestNonce,
  value.environmentId, value.gatewayId, value.hostInstanceId, value.hostBootId, value.transportMode,
  value.policyId, value.policyRevision, value.policyGeneration, value.keyId, value.keyGeneration,
  value.signerRevision, value.timeAuthorityId, value.timeGeneration, value.issuedAt, value.expiresAt,
  value.target.scheme, value.target.host, value.target.port, value.target.tlsServerName, value.target.path,
  flatten(value.addresses.map(canonicalAddress)), canonicalAddress(value.peerAddress), value.peerPort,
  value.tlsSpkiDigest, value.alpn, value.method, value.headerDigest, value.bodyDigest, value.requestDigest,
  value.requestBytes, value.budgets.requestBytes, value.budgets.responseBytes, value.budgets.deadlineMs,
  value.policyMaxima.requestBytes, value.policyMaxima.responseBytes, value.policyMaxima.deadlineMs]);
export const captureTransport = (value: unknown): EgressTransportV1 | undefined => methods(value, ["execute", "close"]) as unknown as EgressTransportV1 | undefined;
export const snapshotTransportResult = (value: unknown): TransportResult | undefined => {
  const completed = exact(value, ["status", "applicationBytesWritten", "responseBytes", "responseDigest", "authorizationConsumption"]);
  if (completed?.status === "completed" && count(completed.applicationBytesWritten) && count(completed.responseBytes) &&
      isDigest(completed.responseDigest)) {return Object.freeze({...completed}) as TransportResult;}
  const notSent = exact(value, ["status", "applicationBytesWritten"]);
  if (notSent?.status === "not_sent" && notSent.applicationBytesWritten === 0) {return Object.freeze({...notSent}) as TransportResult;}
  const uncertain = exact(value, ["status"]);
  return uncertain?.status === "write_indeterminate" ? Object.freeze({...uncertain}) as TransportResult : undefined;
};
