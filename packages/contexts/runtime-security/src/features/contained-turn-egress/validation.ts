import type { DispatchConsumptionReceipt, ObserveDispatchConsumptionInput } from
  "../contained-turn-dispatch-authority/contracts/contained-turn-dispatch-authority-v1.js";
import type { BufferedEgressRequestV1, ContainedTurnEgressDependencies, ContainedTurnEgressRequest,
  EgressAuthorizationBodyV1, EgressPolicyTimeSnapshotV1, EgressTransportV1, NetworkAddressV1,
  ProviderRouteAuthoritySnapshotV1, TrustedEgressHostIdentityV1 } from "./composition.js";

export interface EgressSecurityPrimitives {
  readonly sha256: (bytes: Uint8Array) => string;
  readonly exactObject: <Name extends string>(value: unknown, names: readonly Name[]) =>
    Readonly<Record<Name, unknown>> | undefined;
  readonly callable: (value: unknown) => value is (...args: never[]) => unknown;
  readonly copyBytes: (value: unknown, maximumByteLength: number) => Uint8Array | undefined;
  readonly array: (value: unknown) => value is unknown[];
  readonly canonicalEd25519Signature: (value: unknown) => value is string;
}
export type RouteAuthority = Readonly<ProviderRouteAuthoritySnapshotV1>;
export type PolicyAuthority = Readonly<EgressPolicyTimeSnapshotV1>;
export type BufferedRequest = Readonly<{request: ContainedTurnEgressRequest; buffered: BufferedEgressRequestV1;
  pathDigest: string; headerDigest: string; bodyDigest: string; requestDigest: string;
  applicationBytesDigest: string; applicationBytes: number; applicationBuffer: Uint8Array}>;
export type TransportObservation = Readonly<{canonicalAddresses: readonly NetworkAddressV1[];
  peerAddress: NetworkAddressV1; peerPort: 443; tlsServerName: string; tlsSpkiDigest: string;
  alpn: "http/1.1"; phase: "immediately_before_first_application_byte";
  resolutionAuthorityId: string; resolutionGeneration: string; answerSetDigest: string;
  applicationBytesDigest: string; applicationBytes: number}>;
export type TransportResult = Readonly<{status: "completed"; responseBytes: number; responseDigest: string;
  boundaryReceipt: unknown}> | Readonly<{status: "not_sent"}> | Readonly<{status: "write_indeterminate"}>;

const utf8 = new TextEncoder();
const concat = (values: readonly Uint8Array[]) => {const size = values.reduce((n, v) => n + v.byteLength, 0);
  const output = new Uint8Array(size); let offset = 0;
  for (const value of values) {output.set(value, offset); offset += value.byteLength;} return output;};
const frame = (tag: string, values: readonly (string | number | Uint8Array)[]) => {
  const fields = [utf8.encode(tag), ...values.map(value => value instanceof Uint8Array ? value : utf8.encode(String(value)))];
  const output = new Uint8Array(fields.reduce((n, value) => n + 4 + value.byteLength, 0));
  const view = new DataView(output.buffer); let offset = 0;
  for (const value of fields) {view.setUint32(offset, value.byteLength); offset += 4; output.set(value, offset); offset += value.byteLength;}
  return output;
};
const flatten = (values: readonly Uint8Array[]) => frame("sequence/v1", values);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 512 && /^[\x21-\x7e]+$/u.test(value);
export const isDigest = (value: unknown): value is string => typeof value === "string" && /^sha256:[\da-f]{64}$/u.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const normalizedPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 2_048 && value.startsWith("/") && !value.includes("\\") && !value.includes("#") &&
  !value.includes("//") && ![...value].some(character => (character.codePointAt(0) ?? 0) <= 32 ||
    character.codePointAt(0) === 127) && !/%(?:2e|2f|5c|25|0[0-9a-f]|7f)/iu.test(value) && !/%(?![0-9a-f]{2})/iu.test(value);
const dangerousHeaders = new Set(["authorization", "connection", "content-length", "cookie", "forwarded", "host",
  "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "x-forwarded-for",
  "x-forwarded-host", "x-forwarded-proto"]);
const subnet = (hex: string, network: string, bits: number) => {const shift = BigInt(hex.length * 4 - bits);
  return BigInt(`0x${hex}`) >> shift === BigInt(`0x${network}`) >> shift;};
const addressKey = (value: NetworkAddressV1) => `${value.family}:${value.bytesHex}`;
const guarded = <Arguments extends unknown[], Result>(operation: (...args: Arguments) => Result) =>
  (...args: Arguments): Result | undefined => {try {return operation(...args);} catch {return undefined;}};
const deniedV4: readonly [string, number][] = [["00000000", 8], ["0a000000", 8], ["64400000", 10], ["7f000000", 8],
  ["a9fe0000", 16], ["ac100000", 12], ["c0000000", 24], ["c0000200", 24], ["c01fc400", 24], ["c034c100", 24],
  ["c0586300", 24], ["c0a80000", 16], ["c0af3000", 24], ["c6120000", 15], ["c6336400", 24], ["cb007100", 24],
  ["e0000000", 4], ["f0000000", 4]];
// Versioned, deliberately local fail-closed table for IPv6 special-purpose assignments relevant to V1.
const deniedV6SpecialPurposeV1: readonly [string, number][] = [["00000000000000000000000000000000", 96],
  ["00000000000000000000ffff00000000", 96], ["0064ff9b000000000000000000000000", 96],
  ["0064ff9b000100000000000000000000", 48], ["01000000000000000000000000000000", 64],
  ["20010000000000000000000000000000", 23],
  ["20010003000000000000000000000000", 32], ["20010010000000000000000000000000", 28],
  ["20010020000000000000000000000000", 28], ["20010db8000000000000000000000000", 32],
  ["20020000000000000000000000000000", 16], ["2620004f800000000000000000000000", 48],
  ["3fff0000000000000000000000000000", 20], ["5f000000000000000000000000000000", 16],
  ["fc000000000000000000000000000000", 7], ["fec00000000000000000000000000000", 10],
  ["fe800000000000000000000000000000", 10], ["ff000000000000000000000000000000", 8]];

type Exact = EgressSecurityPrimitives["exactObject"];
type Methods = <Name extends string>(value: unknown, names: readonly Name[]) =>
  Readonly<Record<Name, (...args: never[]) => unknown>> | undefined;
interface ValidationTools {readonly primitives: EgressSecurityPrimitives; readonly hash: (value: Uint8Array) => string;
  readonly exact: Exact; readonly dense: (value: unknown, maximum: number) => readonly unknown[] | undefined;
  readonly methods: Methods}

const createValidationTools = (primitives: EgressSecurityPrimitives) => {
  const hash = (value: Uint8Array) => primitives.sha256(value); const exact = primitives.exactObject;
  const dense = (value: unknown, maximum: number): readonly unknown[] | undefined => {
    if (!primitives.array(value)) {return;}
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value) ||
        (length.value as number) < 0 || (length.value as number) > maximum) {return;}
    if (Reflect.ownKeys(value).length !== (length.value as number) + 1) {return;}
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const output: unknown[] = [];
    for (let index = 0; index < (length.value as number); index += 1) {
      const descriptor = descriptors[String(index)]; if (descriptor === undefined || !("value" in descriptor)) {return;}
      output.push(descriptor.value);
    }
    return Object.freeze(output);
  };
  const methods: Methods = <Name extends string>(value: unknown, names: readonly Name[]) => {
    const owner = exact(value, names);
    if (owner === undefined || names.some(name => !primitives.callable(owner[name]))) {return;}
    return Object.freeze(Object.fromEntries(names.map(name => [name, (...args: unknown[]) =>
      Reflect.apply(owner[name] as (...values: unknown[]) => unknown, value, args)]))) as unknown as
      Readonly<Record<Name, (...args: never[]) => unknown>>;
  };
  return {primitives, hash, exact, dense, methods} satisfies ValidationTools;
};

const captureComposition = (tools: ValidationTools, identity: unknown, dependencies: unknown) => {
  const {exact, methods} = tools;
  const host = exact(identity, ["attemptId", "environmentId", "gatewayId", "hostInstanceId", "hostBootId", "transportMode"]);
  const deps = exact(dependencies, ["routeAuthority", "dispatchAuthority", "policyAuthority", "signer", "transportGateway"]);
  const routeAuthority = methods(deps?.routeAuthority, ["resolveExact", "revalidateExact"]);
  const dispatchAuthority = methods(deps?.dispatchAuthority, ["observeDispatchConsumption"]);
  const policyAuthority = methods(deps?.policyAuthority, ["resolve", "revalidateExact", "consumeFirstWrite"]);
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

const validRequestFields = (candidate: Readonly<Record<string, unknown>>, scope: Readonly<Record<string, unknown>>,
  budgets: Readonly<Record<string, unknown>>) =>
  [scope.tenantId, scope.projectId, candidate.providerId, candidate.providerAccountRef, candidate.providerRouteRef,
    candidate.credentialBindingRef, candidate.credentialGeneration, candidate.credentialRevision,
    candidate.resolutionAuthorityId, candidate.resolutionGeneration, candidate.operationId, candidate.requestId,
    candidate.requestNonce].every(identifier) && isDigest(scope.scopeDigest) && isDigest(candidate.credentialBindingDigest) &&
  (candidate.method === "GET" || candidate.method === "POST") && normalizedPath(candidate.path) &&
  [budgets.requestBytes, budgets.responseBytes, budgets.deadlineMs].every(count) && budgets.responseBytes !== 0 && budgets.deadlineMs !== 0;

const createRequestValidation = (tools: ValidationTools) => {
  const {exact, dense, primitives, hash} = tools;
  const snapshotDispatch = (value: unknown): ObserveDispatchConsumptionInput | undefined => {
    const names = ["purpose", "operationId", "scope", "grantRequestId", "requestDigest", "providerId", "authorityGeneration",
      "providerBindingDigest", "claimBindingDigest", "acceptedAuthorityDigest", "expectedAuthorityHeadDigest",
      "expectedAuthorityRevision", "expectedConstraintsDigest", "expectedContainmentPolicyDigest"] as const;
    const dispatch = exact(value, names); const scope = exact(dispatch?.scope, ["tenantId", "projectId", "scopeDigest"]);
    if (dispatch === undefined || scope === undefined || dispatch.purpose !== "contained-turn.provider-dispatch/v1" ||
        ![dispatch.operationId, scope.tenantId, scope.projectId, dispatch.grantRequestId, dispatch.providerId,
          dispatch.authorityGeneration, dispatch.expectedAuthorityRevision].every(identifier) ||
        ![scope.scopeDigest, dispatch.requestDigest, dispatch.providerBindingDigest, dispatch.claimBindingDigest,
          dispatch.acceptedAuthorityDigest, dispatch.expectedAuthorityHeadDigest, dispatch.expectedConstraintsDigest,
          dispatch.expectedContainmentPolicyDigest].every(isDigest)) {return;}
    return Object.freeze({...dispatch, scope: Object.freeze({...scope})}) as ObserveDispatchConsumptionInput;
  };
  const snapshotHeaders = (value: unknown) => {
    const candidates = dense(value, 64); if (candidates === undefined) {return;}
    const result: Readonly<{name: string; value: string}>[] = [];
    for (let index = 0; index < candidates.length; index += 1) {const header = exact(candidates[index], ["name", "value"]);
      if (header === undefined || typeof header.name !== "string" || typeof header.value !== "string" ||
          header.name !== header.name.toLowerCase() || !/^[a-z0-9-]{1,64}$/u.test(header.name) ||
          dangerousHeaders.has(header.name) || header.value.length > 8_192 || /[\r\n\0]/u.test(header.value)) {return;}
      result.push(Object.freeze({name: header.name, value: header.value}));}
    return Object.freeze(result);
  };
  const canonicalHeaders = (headers: readonly Readonly<{name: string; value: string}>[]) =>
    frame("contained-turn-egress-headers/v1", headers.flatMap(header => [header.name, header.value]));
  const canonicalDispatch = (value: ObserveDispatchConsumptionInput) => frame("contained-turn-egress-dispatch/v1", [
    value.purpose, value.operationId, value.scope.tenantId, value.scope.projectId, value.scope.scopeDigest,
    value.grantRequestId, value.requestDigest, value.providerId, value.authorityGeneration, value.providerBindingDigest,
    value.claimBindingDigest, value.acceptedAuthorityDigest, value.expectedAuthorityHeadDigest,
    value.expectedAuthorityRevision, value.expectedConstraintsDigest, value.expectedContainmentPolicyDigest]);
  const exactWire = (method: "GET" | "POST", path: string, host: string,
    headers: readonly Readonly<{name: string; value: string}>[], body: Uint8Array) => concat([
      utf8.encode(`${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Length: ${body.byteLength}\r\n`),
      ...headers.map(header => utf8.encode(`${header.name}: ${header.value}\r\n`)), utf8.encode("\r\n"), body]);
  const snapshotRequest = (value: unknown, host?: string): BufferedRequest | undefined => {
    const candidate = exact(value, ["scope", "providerId", "providerAccountRef", "providerRouteRef", "credentialBindingRef",
      "credentialBindingDigest", "credentialGeneration", "credentialRevision", "resolutionAuthorityId", "resolutionGeneration",
      "operationId", "dispatch", "requestId", "requestNonce", "method", "path", "headers", "body", "budgets"]);
    const scope = exact(candidate?.scope, ["tenantId", "projectId", "scopeDigest"]);
    const budgets = exact(candidate?.budgets, ["requestBytes", "responseBytes", "deadlineMs"]);
    const dispatch = snapshotDispatch(candidate?.dispatch); const headers = snapshotHeaders(candidate?.headers);
    if (headers === undefined) {return;}
    const body = primitives.copyBytes(candidate?.body, 1_048_576);
    if (candidate === undefined || scope === undefined || budgets === undefined || dispatch === undefined || body === undefined) {return;}
    const matches = [[candidate.operationId, dispatch.operationId], [candidate.providerId, dispatch.providerId],
      [scope.tenantId, dispatch.scope.tenantId], [scope.projectId, dispatch.scope.projectId],
      [scope.scopeDigest, dispatch.scope.scopeDigest]].every(([left, right]) => left === right);
    if (!matches) {return;}
    const valid = validRequestFields(candidate, scope, budgets);
    if (!valid) {return;}
    const safe = Object.freeze({...candidate, scope: Object.freeze({...scope}), dispatch, headers, body,
      budgets: Object.freeze({...budgets})}) as unknown as ContainedTurnEgressRequest;
    const pathDigest = hash(frame("contained-turn-egress-path/v1", [safe.path]));
    const headerBytes = canonicalHeaders(headers); const bodyBytes = frame("contained-turn-egress-body/v1", [body]);
    const requestCanonical = frame("contained-turn-egress-request/v1", [safe.scope.tenantId, safe.scope.projectId,
      safe.scope.scopeDigest, safe.providerId, safe.providerAccountRef, safe.providerRouteRef, safe.credentialBindingRef,
      safe.credentialBindingDigest, safe.credentialGeneration, safe.credentialRevision, safe.resolutionAuthorityId,
      safe.resolutionGeneration, safe.operationId, canonicalDispatch(dispatch), safe.requestId, safe.requestNonce, safe.method,
      pathDigest, headerBytes, bodyBytes, safe.budgets.requestBytes, safe.budgets.responseBytes, safe.budgets.deadlineMs]);
    const wire = exactWire(safe.method, safe.path, host ?? "", headers, body);
    return Object.freeze({request: safe, buffered: Object.freeze({method: safe.method, headers, body: body.slice()}),
      pathDigest, headerDigest: hash(headerBytes), bodyDigest: hash(bodyBytes), requestDigest: hash(requestCanonical),
      applicationBytesDigest: hash(wire), applicationBytes: wire.byteLength, applicationBuffer: wire.slice()});
  };
  return {snapshotRequest};
};

const validHostname = (route: Readonly<Record<string, unknown>>) =>
  route.scheme === "https" && route.port === 443 && typeof route.host === "string" && route.host.length <= 253 &&
  route.host === route.tlsServerName && route.host === route.host.toLowerCase() && /^[a-z0-9.-]+$/u.test(route.host) &&
  !route.host.endsWith(".") && !/^\d+(?:\.\d+){3}$/u.test(route.host) &&
  route.host.split(".").every(label => label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"));

const createAuthorityValidation = (tools: ValidationTools) => {
  const {exact, dense, hash} = tools;
  const snapshotRoute = (value: unknown): RouteAuthority | undefined => {
    const route = exact(value, ["contractVersion", "tenantId", "projectId", "scopeDigest", "providerId", "providerAccountRef",
      "providerRouteRef", "credentialBindingRef", "credentialBindingDigest", "credentialGeneration", "credentialRevision",
      "accessRef", "accessRevision", "routeRevision", "authorityDigest", "scheme", "host", "port", "tlsServerName", "pathConstraint",
      "allowedTlsSpkiDigests", "tlsPinSetDigest", "tlsPinSetGeneration", "tlsPinSetRevision", "resolutionAuthorityId",
      "resolutionGeneration"]);
    const pins = dense(route?.allowedTlsSpkiDigests, 16);
    if (route === undefined || pins === undefined) {return;}
    if (!Object.isFrozen(value) || !Object.isFrozen(route.allowedTlsSpkiDigests) ||
        route.contractVersion !== "provider-route-authority/v1" ||
        ![route.tenantId, route.projectId, route.providerId, route.providerAccountRef, route.providerRouteRef,
          route.credentialBindingRef, route.credentialGeneration, route.credentialRevision, route.accessRef, route.accessRevision, route.routeRevision,
          route.tlsPinSetGeneration, route.tlsPinSetRevision, route.resolutionAuthorityId, route.resolutionGeneration].every(identifier) ||
        ![route.scopeDigest, route.credentialBindingDigest, route.authorityDigest, route.tlsPinSetDigest].every(isDigest) ||
        pins.length === 0 || pins.some(digest => !isDigest(digest)) ||
        new Set(pins).size !== pins.length || pins.some((digest, index) => index > 0 && (digest as string) <= (pins[index - 1] as string)) ||
        route.tlsPinSetDigest !== hash(frame("contained-turn-egress-tls-pin-set/v1", pins as string[])) ||
        !validHostname(route) || !normalizedPath(route.pathConstraint)) {return;}
    return Object.freeze({...route, allowedTlsSpkiDigests: pins}) as RouteAuthority;
  };
  const snapshotPolicy = (value: unknown): PolicyAuthority | undefined => {
    const policy = exact(value, ["contractVersion", "policyId", "policyRevision", "policyGeneration", "keyId",
      "keyGeneration", "signerRevision", "timeAuthorityId", "timeGeneration", "observedAt", "expiresAt",
      "maxRequestBytes", "maxResponseBytes", "maxDeadlineMs"]);
    return policy !== undefined && Object.isFrozen(value) && policy.contractVersion === "contained-turn-egress-policy/v1" &&
      [policy.policyId, policy.policyRevision, policy.policyGeneration, policy.keyId, policy.keyGeneration,
        policy.signerRevision, policy.timeAuthorityId, policy.timeGeneration].every(identifier) &&
      [policy.observedAt, policy.expiresAt, policy.maxRequestBytes, policy.maxResponseBytes, policy.maxDeadlineMs].every(count) &&
      (policy.expiresAt as number) > (policy.observedAt as number) && (policy.maxRequestBytes as number) > 0 &&
      (policy.maxResponseBytes as number) > 0 && (policy.maxDeadlineMs as number) > 0 ? Object.freeze({...policy}) as PolicyAuthority : undefined;
  };
  // Domain-separated preimage of the exact resolved Provider Access route, including owner revisions.
  // Only the digest crosses into dispatch evidence; concrete path/credential material is never emitted.
  const routeBindingDigest = (route: RouteAuthority) => hash(frame("contained-turn-egress-provider-binding/v1", [
    route.contractVersion, route.tenantId, route.projectId, route.scopeDigest, route.providerId,
    route.providerAccountRef, route.accessRef, route.accessRevision, route.providerRouteRef, route.routeRevision,
    route.credentialBindingRef, route.credentialBindingDigest, route.credentialGeneration, route.credentialRevision,
    route.authorityDigest, route.scheme, route.host, route.port, route.tlsServerName,
    hash(frame("contained-turn-egress-path/v1", [route.pathConstraint])), route.tlsPinSetDigest,
    route.tlsPinSetGeneration, route.tlsPinSetRevision, route.resolutionAuthorityId, route.resolutionGeneration,
  ]));
  return {snapshotRoute, snapshotPolicy, routeBindingDigest};
};

const validObservationFacts = (observation: Readonly<Record<string, unknown>>) =>
  observation.peerPort === 443 && identifier(observation.tlsServerName) && isDigest(observation.tlsSpkiDigest) &&
  identifier(observation.resolutionAuthorityId) && identifier(observation.resolutionGeneration) &&
  isDigest(observation.answerSetDigest) && isDigest(observation.applicationBytesDigest) && count(observation.applicationBytes) &&
  observation.alpn === "http/1.1" && observation.phase === "immediately_before_first_application_byte";

const createTransportValidation = (tools: ValidationTools) => {
  const {exact, dense, hash, methods} = tools;
  const snapshotAddress = (value: unknown): NetworkAddressV1 | undefined => {
    const address = exact(value, ["family", "bytesHex"]);
    if (address === undefined || (address.family !== "ipv4" && address.family !== "ipv6") ||
        typeof address.bytesHex !== "string" || !/^[0-9a-f]+$/u.test(address.bytesHex) ||
        address.bytesHex.length !== (address.family === "ipv4" ? 8 : 32) ||
        (address.family === "ipv6" && !subnet(address.bytesHex, "20000000000000000000000000000000", 3)) ||
        (address.family === "ipv4" ? deniedV4 : deniedV6SpecialPurposeV1)
          .some(([network, bits]) => subnet(address.bytesHex as string, network, bits))) {return;}
    return Object.freeze({family: address.family, bytesHex: address.bytesHex}) as NetworkAddressV1;
  };
  const answerDigest = (addresses: readonly NetworkAddressV1[]) => hash(frame("contained-turn-egress-answer-set/v1",
    addresses.map(addressKey)));
  const snapshotObservation = (value: unknown): TransportObservation | undefined => {
    const observation = exact(value, ["canonicalAddresses", "peerAddress", "peerPort", "tlsServerName", "tlsSpkiDigest", "alpn",
      "phase", "resolutionAuthorityId", "resolutionGeneration", "answerSetDigest", "applicationBytesDigest", "applicationBytes"]);
    const candidates = dense(observation?.canonicalAddresses, 16);
    if (observation === undefined || candidates === undefined || candidates.length === 0 || !validObservationFacts(observation)) {return;}
    const addresses: (NetworkAddressV1 | undefined)[] = [];
    for (let index = 0; index < candidates.length; index += 1) {addresses.push(snapshotAddress(candidates[index]));}
    const peer = snapshotAddress(observation.peerAddress);
    if (peer === undefined || addresses.some(address => address === undefined)) {return;}
    const safe = addresses as NetworkAddressV1[]; const keys = safe.map(addressKey);
    if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && key <= keys[index - 1]!) ||
        !keys.includes(addressKey(peer)) || observation.answerSetDigest !== answerDigest(safe)) {return;}
    return Object.freeze({...observation, canonicalAddresses: Object.freeze(safe), peerAddress: peer}) as TransportObservation;
  };
  const committedReceipt = (value: unknown, expected: ObserveDispatchConsumptionInput): DispatchConsumptionReceipt | undefined => {
    const names = ["contractVersion", "purpose", "operationId", "scope", "grantRequestId", "requestDigest", "providerId",
      "authorityGeneration", "providerBindingDigest", "claimBindingDigest", "acceptedAuthorityDigest",
      "authorityHeadDigestAtConsumption", "authorityRevision", "constraintsDigest", "containmentPolicyDigest",
      "consumptionDigest", "claimBeforeControlTime", "consumedAtControlTime", "ownerEvidenceRef"] as const;
    const outcome = exact(value, ["status", "receipt", "lifecycleState"]); const receipt = exact(outcome?.receipt, names);
    const scope = exact(receipt?.scope, ["tenantId", "projectId", "scopeDigest"]);
    if (!outcome || !receipt || !scope || !Object.isFrozen(value) || !Object.isFrozen(outcome.receipt) ||
        !Object.isFrozen(receipt.scope)) {return;}
    const pairs = [[outcome.status, "consumed"], [outcome.lifecycleState, "claim_committed"],
      [receipt.contractVersion, "contained-turn-dispatch-consumption/v1"], [receipt.purpose, expected.purpose],
      [receipt.operationId, expected.operationId], [scope.tenantId, expected.scope.tenantId], [scope.projectId, expected.scope.projectId],
      [scope.scopeDigest, expected.scope.scopeDigest], [receipt.grantRequestId, expected.grantRequestId],
      [receipt.requestDigest, expected.requestDigest], [receipt.providerId, expected.providerId],
      [receipt.authorityGeneration, expected.authorityGeneration], [receipt.providerBindingDigest, expected.providerBindingDigest],
      [receipt.claimBindingDigest, expected.claimBindingDigest], [receipt.acceptedAuthorityDigest, expected.acceptedAuthorityDigest],
      [receipt.authorityHeadDigestAtConsumption, expected.expectedAuthorityHeadDigest],
      [receipt.authorityRevision, expected.expectedAuthorityRevision], [receipt.constraintsDigest, expected.expectedConstraintsDigest],
      [receipt.containmentPolicyDigest, expected.expectedContainmentPolicyDigest]];
    if (!pairs.every(([left, right]) => left === right) || ![scope.scopeDigest, receipt.requestDigest, receipt.providerBindingDigest,
      receipt.claimBindingDigest, receipt.acceptedAuthorityDigest, receipt.authorityHeadDigestAtConsumption,
      receipt.constraintsDigest, receipt.containmentPolicyDigest, receipt.consumptionDigest].every(isDigest) ||
      !count(receipt.claimBeforeControlTime) || !count(receipt.consumedAtControlTime) ||
      (receipt.claimBeforeControlTime as number) <= (receipt.consumedAtControlTime as number) || !identifier(receipt.ownerEvidenceRef)) {return;}
    return Object.freeze({...receipt, scope: Object.freeze({...scope})}) as DispatchConsumptionReceipt;
  };
  const canonicalReceipt = (value: DispatchConsumptionReceipt) => frame("contained-turn-egress-dispatch-receipt/v1", [
    value.contractVersion, value.purpose, value.operationId, value.scope.tenantId, value.scope.projectId, value.scope.scopeDigest,
    value.grantRequestId, value.requestDigest, value.providerId, value.authorityGeneration, value.providerBindingDigest,
    value.claimBindingDigest, value.acceptedAuthorityDigest, value.authorityHeadDigestAtConsumption, value.authorityRevision,
    value.constraintsDigest, value.containmentPolicyDigest, value.consumptionDigest, value.claimBeforeControlTime,
    value.consumedAtControlTime, value.ownerEvidenceRef]);
  const canonicalAddress = (value: NetworkAddressV1) => frame("contained-turn-egress-address/v1", [value.family, value.bytesHex]);
  const canonicalAuthorization = (value: EgressAuthorizationBodyV1) => frame("contained-turn-egress-authorization/v1", [
    value.contractVersion, value.tenantId, value.projectId, value.scopeDigest, value.providerId, value.providerAccountRef,
    value.providerRouteRef, value.credentialBindingRef, value.credentialBindingDigest, value.credentialGeneration,
    value.credentialRevision, value.accessRef, value.accessRevision, value.routeRevision, value.routeAuthorityDigest, value.operationId, value.attemptId,
    canonicalReceipt(value.dispatchReceipt), value.requestId, value.requestNonce, value.environmentId, value.gatewayId,
    value.hostInstanceId, value.hostBootId, value.transportMode, value.policyId, value.policyRevision, value.policyGeneration,
    value.keyId, value.keyGeneration, value.signerRevision, value.timeAuthorityId, value.timeGeneration, value.issuedAt,
    value.expiresAt, value.target.scheme, value.target.host, value.target.port, value.target.tlsServerName, value.target.pathDigest,
    flatten(value.allowedTlsSpkiDigests.map(digest => frame("spki/v1", [digest]))), value.tlsPinSetDigest,
    value.tlsPinSetGeneration, value.tlsPinSetRevision, value.resolutionAuthorityId, value.resolutionGeneration,
    value.answerSetDigest, flatten(value.addresses.map(canonicalAddress)), canonicalAddress(value.peerAddress), value.peerPort,
    value.tlsSpkiDigest, value.alpn, value.method, value.headerDigest, value.bodyDigest, value.requestDigest,
    value.applicationBytesDigest, value.applicationBytes, value.budgets.requestBytes, value.budgets.responseBytes,
    value.budgets.deadlineMs, value.policyMaxima.requestBytes, value.policyMaxima.responseBytes, value.policyMaxima.deadlineMs]);
  const captureTransport = (value: unknown) => {
    const session = exact(value, ["transport", "firstWrite"]); const transport = methods(session?.transport, ["execute", "close"]);
    const writer = methods(session?.firstWrite, ["writeExact"]); if (transport === undefined || writer === undefined) {return;}
    return Object.freeze({transport: transport as unknown as EgressTransportV1,
      writeExact: writer.writeExact as (input: unknown) => unknown});
  };
  const snapshotTransportResult = (value: unknown): TransportResult | undefined => {
    const completed = exact(value, ["status", "responseBytes", "responseDigest", "boundaryReceipt"]);
    if (completed !== undefined && Object.isFrozen(value) && completed.status === "completed" && count(completed.responseBytes) && isDigest(completed.responseDigest)) {
      return Object.freeze({...completed}) as TransportResult;}
    const notSent = exact(value, ["status"]); if (notSent !== undefined && Object.isFrozen(value) && notSent.status === "not_sent") {return Object.freeze({...notSent}) as TransportResult;}
    const uncertain = exact(value, ["status"]); return uncertain !== undefined && Object.isFrozen(value) && uncertain.status === "write_indeterminate" ?
      Object.freeze({...uncertain}) as TransportResult : undefined;
  };
  return {snapshotObservation, committedReceipt, canonicalAuthorization, captureTransport, snapshotTransportResult, answerDigest};
};

export const createEgressValidation = (primitives: EgressSecurityPrimitives) => {
  const tools = createValidationTools(primitives); const request = createRequestValidation(tools);
  const authority = createAuthorityValidation(tools); const transport = createTransportValidation(tools);
  return {hash: tools.hash, exact: tools.exact,
    captureComposition: (identity: unknown, dependencies: unknown) => captureComposition(tools, identity, dependencies),
    snapshotRequest: guarded(request.snapshotRequest), snapshotRoute: guarded(authority.snapshotRoute),
    routeBindingDigest: authority.routeBindingDigest, snapshotPolicy: guarded(authority.snapshotPolicy), snapshotObservation: guarded(transport.snapshotObservation),
    committedReceipt: guarded(transport.committedReceipt), canonicalAuthorization: transport.canonicalAuthorization,
    captureTransport: guarded(transport.captureTransport), snapshotTransportResult: guarded(transport.snapshotTransportResult),
    answerDigest: transport.answerDigest};
};
