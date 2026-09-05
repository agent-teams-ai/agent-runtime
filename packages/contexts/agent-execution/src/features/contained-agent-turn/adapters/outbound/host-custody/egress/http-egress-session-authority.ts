import { types as utilTypes } from "node:util";
import type { HostHttpMaterializationAuthorizationRequest, HostHttpMaterializationReceipt,
  HostHttpRequestProjection, HttpEgressBrokerPorts, HttpEgressRoute,
  HostHttpUnsignedMaterializationAuthorizationRequest } from "./http-egress-ports.js";
import type { PreparedHttpRequestCustodyV1 } from "./prepared-http-request-v1.js";
import type { StrictHttpRequest } from "./strict-http-request.js";
import { zeroHttpBytes } from "./http-byte-intrinsics.js";

const encoder = new TextEncoder();
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PRESENTATION = new Set(["accept", "content-type"]);
const ROUTE_FIELDS = ["routeReceiptDigest", "originHost", "originPort", "upstreamMethod", "upstreamPath",
  "forwardedRequestHeaderNames", "credentialFieldNames"] as const;

const bounded = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0
  && value.length <= maximum && value.isWellFormed() && encoder.encode(value).byteLength <= maximum
  && !/\p{Cc}|\p{Cs}/u.test(value);
const exactArray = (value: unknown, maximumItems: number): readonly string[] | undefined => {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
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
  if (keys.length !== ROUTE_FIELDS.length || keys.some(key => typeof key !== "string" || !ROUTE_FIELDS.includes(key as never))
    || ROUTE_FIELDS.some(name => descriptors[name] === undefined || !("value" in descriptors[name]!))) {return undefined;}
  return descriptors;
};

const validRoutePath = (value: unknown): value is string => bounded(value, 16_384)
  && value.startsWith("/") && !value.startsWith("//") && !/[^\x21-\x7e]|[?#]/.test(value);

const validRouteHeaderNames = (forwarded: readonly string[], credentials: readonly string[]): boolean =>
  new Set(forwarded).size === forwarded.length
  && !forwarded.some(name => name !== name.toLowerCase() || !TOKEN.test(name) || !PRESENTATION.has(name))
  && credentials.length !== 0 && new Set(credentials).size === credentials.length
  && !credentials.some(name => name !== name.toLowerCase() || !TOKEN.test(name) || PRESENTATION.has(name)
    || name === "host" || name === "content-length" || name === "connection");

export const snapshotHostHttpRoute = (value: unknown): HttpEgressRoute | undefined => {
  const descriptors = snapshotRouteDescriptors(value);
  if (descriptors === undefined) {return undefined;}
  const read = (name: typeof ROUTE_FIELDS[number]): unknown => descriptors[name]?.value;
  const forwarded = exactArray(read("forwardedRequestHeaderNames"), 32);
  const credentials = exactArray(read("credentialFieldNames"), 16);
  const originHost = read("originHost"); const originPort = read("originPort"); const method = read("upstreamMethod");
  const path = read("upstreamPath"); const receipt = read("routeReceiptDigest");
  if (!bounded(receipt, 512) || !bounded(originHost, 512) || !/^[A-Za-z0-9.-]+$/.test(originHost)
    || !Number.isSafeInteger(originPort) || (originPort as number) < 1 || (originPort as number) > 65_535
    || !bounded(method, 128) || !TOKEN.test(method) || method === "CONNECT"
    || !validRoutePath(path) || forwarded === undefined || credentials === undefined
    || !validRouteHeaderNames(forwarded, credentials)) {return undefined;}
  return Object.freeze({routeReceiptDigest: receipt, originHost, originPort: originPort as number,
    upstreamMethod: method as HttpEgressRoute["upstreamMethod"], upstreamPath: path,
    forwardedRequestHeaderNames: forwarded as HttpEgressRoute["forwardedRequestHeaderNames"],
    credentialFieldNames: credentials});
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

export const receiptMatchesSnapshot = (receipt: HostHttpMaterializationReceipt, ports: HttpEgressBrokerPorts,
  authorizationRequestId: string, requestDigest: string): boolean => validReceipt(receipt) && receipt.schemaVersion === 1
  && receipt.purpose === "contained-turn.credential-materialization-authorization/v1" && receipt.decision === "authorized"
  && receipt.rejectionReason === null && receipt.authorizationRequestId === authorizationRequestId
  && receipt.requestDigest === requestDigest && receipt.accessRef === ports.providerAccessSnapshot.accessRef
  && receipt.provider === ports.providerAccessSnapshot.provider
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
  const allowed = new Set(route.forwardedRequestHeaderNames);
  const fields = request.headers.filter(field => allowed.has(field.name as "accept" | "content-type"));
  if (new Set(fields.map(field => field.name)).size !== fields.length) {throw new TypeError("duplicate presentation field");}
  return fields.toSorted((a, b) => a.name.localeCompare(b.name)).map(field => Object.freeze({
    name: field.name, valueBytes: encoder.encode(field.value)}));
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

export const materializationAuthorizationRequest = (ports: HttpEgressBrokerPorts,
  id: string): HostHttpUnsignedMaterializationAuthorizationRequest => Object.freeze({
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

export const bindMaterializationRequestDigest = (
  request: HostHttpUnsignedMaterializationAuthorizationRequest,
  requestDigest: unknown,
): HostHttpMaterializationAuthorizationRequest | undefined => bounded(requestDigest, 512)
  ? Object.freeze({...request, requestDigest})
  : undefined;
