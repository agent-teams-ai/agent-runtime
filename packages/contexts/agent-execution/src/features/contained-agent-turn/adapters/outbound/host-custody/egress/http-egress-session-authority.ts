import { types as utilTypes } from "node:util";
import type { HostHttpMaterializationAuthorizationRequest, HostHttpMaterializationReceipt,
  HostHttpRequestProjection, HttpEgressBrokerPorts, HttpEgressRoute,
  HostHttpUnsignedMaterializationAuthorizationRequest } from "./http-egress-ports.js";
import type { PreparedHttpRequestCustodyV1 } from "./prepared-http-request-v1.js";
import type { StrictHttpRequest } from "./strict-http-request.js";
import { zeroHttpBytes } from "./http-byte-intrinsics.js";
import { isHttpCredentialCollision, nativeHttpRequestProfile, type NativeHttpRequestProfile } from "./native-http-request-profile.js";
import { selectHttpPresentationFields } from "./native-http-request-headers.js";

const encoder = new TextEncoder();
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PRESENTATION = new Set(["accept", "content-type"]);
const ROUTE_FIELDS = ["routeReceiptDigest", "originHost", "originPort", "upstreamMethod", "upstreamPath",
  "forwardedRequestHeaderNames", "credentialFieldNames"] as const;

const bounded = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0
  && value.length <= maximum && value.isWellFormed() && encoder.encode(value).byteLength <= maximum
  && !/\p{Cc}|\p{Cs}/u.test(value);
const exactArray = (value: unknown, maximumItems: number): readonly string[] | undefined => {
  if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumItems
    || Reflect.ownKeys(descriptors).length !== length + 1) {return undefined;}
  const output: string[] = [];
  for (let index = 0; index < length; index += 1) {const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !bounded(descriptor.value, 128)) {return undefined;}
    output.push(descriptor.value);}
  return Object.freeze(output);
};

const snapshotRouteDescriptors = (value: unknown): PropertyDescriptorMap | undefined => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {return undefined;}
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
  const fields: readonly string[] = Object.hasOwn(descriptors, "requestProfile") ? [...ROUTE_FIELDS, "requestProfile"] : ROUTE_FIELDS;
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))
    || fields.some(name => descriptors[name] === undefined || !("value" in descriptors[name]!))
    || ROUTE_FIELDS.some(name => descriptors[name] === undefined || !("value" in descriptors[name]!))) {return undefined;}
  return descriptors;
};

const validRoutePath = (value: unknown): value is string => bounded(value, 16_384)
  && value.startsWith("/") && !value.startsWith("//") && !/[^\x21-\x7e]|#/.test(value);

const validRouteOriginHost = (value: unknown): value is string => bounded(value, 512) && /^[A-Za-z0-9.-]+$/.test(value);

const validRouteHeaderNames = (forwarded: readonly string[], credentials: readonly string[],
  allowed: readonly string[]): boolean =>
  new Set(forwarded).size === forwarded.length
  && !forwarded.some(name => name !== name.toLowerCase() || !TOKEN.test(name) || !allowed.includes(name))
  && credentials.length !== 0 && new Set(credentials).size === credentials.length
  && !credentials.some(name => name !== name.toLowerCase() || !TOKEN.test(name) || isHttpCredentialCollision(name));

const sameNames = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((name, index) => name === expected[index]);

const validProfileInput = (value: unknown, descriptors: PropertyDescriptorMap,
  profile: NativeHttpRequestProfile | undefined): boolean => !Object.hasOwn(descriptors, "requestProfile")
  || profile !== undefined && Object.isFrozen(value) && Object.isFrozen(descriptors.forwardedRequestHeaderNames?.value)
    && Object.isFrozen(descriptors.credentialFieldNames?.value);

const profileMatchesRoute = (profile: NativeHttpRequestProfile | undefined, route: HttpEgressRoute): boolean =>
  profile === undefined || route.originHost === profile.originHost && route.originPort === profile.originPort
    && route.upstreamMethod === profile.upstreamMethod && route.upstreamPath === profile.upstreamPath
    && sameNames(route.forwardedRequestHeaderNames, profile.forwardedRequestHeaderNames)
    && sameNames(route.credentialFieldNames, profile.credentialFieldNames);

export const snapshotHostHttpRoute = (value: unknown): HttpEgressRoute | undefined => {
  const descriptors = snapshotRouteDescriptors(value);
  if (descriptors === undefined) {return undefined;}
  const read = (name: typeof ROUTE_FIELDS[number]): unknown => descriptors[name]?.value;
  const forwarded = exactArray(read("forwardedRequestHeaderNames"), 32);
  const credentials = exactArray(read("credentialFieldNames"), 16);
  // Rejected arrays must never reach reflection such as Object.isFrozen: it can execute proxy traps.
  if (forwarded === undefined || credentials === undefined) {return undefined;}
  const originHost = read("originHost"); const originPort = read("originPort"); const method = read("upstreamMethod");
  const path = read("upstreamPath"); const receipt = read("routeReceiptDigest");
  const profile = nativeHttpRequestProfile(descriptors.requestProfile?.value);
  if (!validProfileInput(value, descriptors, profile)) {return undefined;}
  if (!bounded(receipt, 512) || !validRouteOriginHost(originHost)
    || !Number.isSafeInteger(originPort) || (originPort as number) < 1 || (originPort as number) > 65_535
    || !bounded(method, 128) || !TOKEN.test(method) || method === "CONNECT"
    || !validRoutePath(path)
    || !validRouteHeaderNames(forwarded, credentials, profile?.forwardedRequestHeaderNames ?? [...PRESENTATION])) {return undefined;}
  const route = Object.freeze({routeReceiptDigest: receipt, originHost, originPort: originPort as number,
    ...(profile === undefined ? {} : {requestProfile: profile.id}),
    upstreamMethod: method as HttpEgressRoute["upstreamMethod"], upstreamPath: path,
    forwardedRequestHeaderNames: forwarded as HttpEgressRoute["forwardedRequestHeaderNames"],
    credentialFieldNames: credentials});
  return profileMatchesRoute(profile, route) ? route : undefined;
};

const receiptFields: readonly (keyof HostHttpMaterializationReceipt)[] = ["schemaVersion", "purpose", "accessRef",
  "authorizationRequestId", "availability", "bindingRevision", "credentialBindingDigest", "credentialBindingRef",
  "credentialGeneration", "decision", "rejectionReason", "projectId", "provider", "providerAccountRef",
  "providerRouteRef", "requestDigest", "revocation", "scopeDigest", "tenantId"];
const validReceipt = (value: unknown): value is HostHttpMaterializationReceipt => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {return false;}
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== receiptFields.length || keys.some(key => typeof key !== "string"
    || !receiptFields.includes(key as keyof HostHttpMaterializationReceipt))) {return false;}
  for (const name of receiptFields) {const descriptor = descriptors[name];
    if (descriptor === undefined || !("value" in descriptor)) {return false;}
    const item = descriptor.value;
    if (typeof item === "string" && (item.length === 0 || item.length > 512 || !item.isWellFormed()
      || /\p{Cc}|\p{Cs}/u.test(item)) || typeof item === "number" && !Number.isSafeInteger(item)
      || item !== null && typeof item !== "string" && typeof item !== "number") {return false;}}
  return true;
};
const sameReceipt = (left: HostHttpMaterializationReceipt, right: HostHttpMaterializationReceipt): boolean =>
  validReceipt(left) && validReceipt(right) && receiptFields.every(name => left[name] === right[name]);

const receiptProviderMatchesSnapshot = (receipt: HostHttpMaterializationReceipt, ports: HttpEgressBrokerPorts): boolean =>
  routeMatchesProvider(ports) && receipt.provider === ports.providerAccessSnapshot.provider;

export const receiptMatchesSnapshot = (receipt: HostHttpMaterializationReceipt, ports: HttpEgressBrokerPorts,
  authorizationRequestId: string, requestDigest: string): boolean => validReceipt(receipt) && receipt.schemaVersion === 1
  && receiptProviderMatchesSnapshot(receipt, ports)
  && receipt.purpose === "contained-turn.credential-materialization-authorization/v1" && receipt.decision === "authorized"
  && receipt.rejectionReason === null && receipt.authorizationRequestId === authorizationRequestId
  && receipt.requestDigest === requestDigest && receipt.accessRef === ports.providerAccessSnapshot.accessRef
  && receipt.providerAccountRef === ports.providerAccessSnapshot.providerAccountRef
  && receipt.providerRouteRef === ports.providerAccessSnapshot.providerRouteRef
  && receipt.credentialBindingRef === ports.providerAccessSnapshot.credentialBindingRef
  && receipt.credentialBindingDigest === ports.providerAccessSnapshot.ownerAuthorityDigest
  && receipt.bindingRevision === ports.providerAccessSnapshot.revision
  && receipt.credentialGeneration === ports.providerAccessSnapshot.credentialGeneration
  && receipt.scopeDigest === ports.providerAccessSnapshot.scopeDigest
  && receipt.tenantId === ports.providerAccessSnapshot.tenantId && receipt.projectId === ports.providerAccessSnapshot.projectId
  && receipt.availability === "available" && receipt.revocation === "active";

export const observeMaterializationReceipt = async (ports: HttpEgressBrokerPorts,
  receipt: HostHttpMaterializationReceipt): Promise<boolean> => {
  const observed = await ports.providerAccess.observe(Object.freeze({authorizationRequestId: receipt.authorizationRequestId,
    projectId: receipt.projectId, provider: receipt.provider, requestDigest: receipt.requestDigest,
    scopeDigest: receipt.scopeDigest, tenantId: receipt.tenantId}));
  return observed.kind === "observed" && sameReceipt(observed.receipt, receipt);
};

export const presentationFields = (request: StrictHttpRequest, route: HttpEgressRoute) => {
  const snapshot = snapshotHostHttpRoute(route);
  if (snapshot === undefined) {throw new TypeError("invalid HTTP route");}
  return selectHttpPresentationFields(request, snapshot.forwardedRequestHeaderNames,
    nativeHttpRequestProfile(snapshot.requestProfile));
};

export const projectPreparedRequest = (ports: HttpEgressBrokerPorts, prepared: PreparedHttpRequestCustodyV1,
  receipt: HostHttpMaterializationReceipt): HostHttpRequestProjection => {
  const target = prepared.wireBytes.slice(prepared.targetSpan.offset, prepared.targetSpan.offset + prepared.targetSpan.length);
  const body = prepared.wireBytes.slice(prepared.bodySpan.offset, prepared.bodySpan.offset + prepared.bodySpan.length);
  const credentials: Array<Readonly<{name: string; credentialBindingDigest: string; valueDigest: string;
    byteLength: number}>> = [];
  try {for (const span of prepared.credentialValueSpans) {const value = prepared.wireBytes.slice(span.offset, span.offset + span.length);
    try {credentials.push(Object.freeze({name: span.name, credentialBindingDigest: receipt.credentialBindingDigest,
      valueDigest: ports.evidence.digest([value]), byteLength: span.length}));} finally {zeroHttpBytes(value);}}
    return Object.freeze({method: ports.route.upstreamMethod, scheme: "https",
      authority: Object.freeze({hostname: ports.route.originHost, port: ports.route.originPort}),
      requestTarget: Object.freeze({digest: ports.evidence.digest([target]), byteLength: target.byteLength}),
      headers: Object.freeze({canonicalDigest: ports.evidence.digest([prepared.headerProjectionBytes]),
        fieldCount: prepared.headerLineSpans.length, credentialFields: Object.freeze(credentials)}),
      body: Object.freeze({digest: ports.evidence.digest([body]), byteLength: body.byteLength}),
      framing: Object.freeze({protocol: "http/1.1", requestTarget: "origin-form", authoritySource: "host",
        contentLength: body.byteLength, transferEncoding: "absent", connectionSpecificHeaders: "absent"})});
  } finally {zeroHttpBytes(target); zeroHttpBytes(body);}
};

const routeMatchesProvider = (ports: HttpEgressBrokerPorts): boolean => {
  const route = snapshotHostHttpRoute(ports.route);
  return route !== undefined && (route.requestProfile === undefined
    || nativeHttpRequestProfile(route.requestProfile)?.provider === ports.providerAccessSnapshot.provider);
};

export const materializationAuthorizationRequest = (ports: HttpEgressBrokerPorts,
  id: string): HostHttpUnsignedMaterializationAuthorizationRequest => {
  if (!routeMatchesProvider(ports)) {throw new TypeError("HTTP route provider mismatch");}
  return Object.freeze({
    accessRef: ports.providerAccessSnapshot.accessRef,
    authorizationRequestId: id, availability: ports.providerAccessSnapshot.availability,
    bindingRevision: ports.providerAccessSnapshot.revision,
    credentialBindingDigest: ports.providerAccessSnapshot.ownerAuthorityDigest,
    credentialBindingRef: ports.providerAccessSnapshot.credentialBindingRef,
    credentialGeneration: ports.providerAccessSnapshot.credentialGeneration,
    projectId: ports.providerAccessSnapshot.projectId, provider: ports.providerAccessSnapshot.provider,
    providerAccountRef: ports.providerAccessSnapshot.providerAccountRef,
    providerRouteRef: ports.providerAccessSnapshot.providerRouteRef,
    purpose: "contained-turn.credential-materialization-authorization/v1" as const,
    revocation: ports.providerAccessSnapshot.revocation, schemaVersion: 1 as const,
    scopeDigest: ports.providerAccessSnapshot.scopeDigest, tenantId: ports.providerAccessSnapshot.tenantId});
};

export const bindMaterializationRequestDigest = (
  request: HostHttpUnsignedMaterializationAuthorizationRequest,
  requestDigest: unknown,
): HostHttpMaterializationAuthorizationRequest | undefined => bounded(requestDigest, 512)
  ? Object.freeze({...request, requestDigest})
  : undefined;
