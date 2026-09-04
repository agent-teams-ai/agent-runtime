import { types as utilTypes } from "node:util";
import type { HttpEgressExpectedRequest, HttpEgressOperation } from "./http-egress-contracts.js";
import type {
  HttpEgressGenerationObservation,
  HttpEgressRoute,
  HttpEgressRouteObservation,
  HttpEgressTransportBinding,
} from "./http-egress-ports.js";
import { snapshotHttpEgressLimits } from "./http-egress-limits.js";

const encoder = new TextEncoder();
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORWARDABLE_HEADERS = new Set(["accept", "content-type"]);

export class HttpEgressIngressError extends TypeError {
  public constructor() {
    super("invalid HTTP egress ingress value");
    this.name = "HttpEgressIngressError";
  }
}

type DataRecord = Readonly<Record<PropertyKey, unknown>>;

const exactDataRecord = (value: unknown, names: readonly string[]): DataRecord | undefined => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {return undefined;}
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {return undefined;}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !names.includes(key))) {
    return undefined;
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const descriptor = descriptors[name];
    if (descriptor === undefined || !("value" in descriptor)) {return undefined;}
    result[name] = descriptor.value;
  }
  return result;
};

const bounded = (value: unknown, maximum: number): value is string => typeof value === "string"
  && value.length > 0 && value.length <= maximum && value.isWellFormed()
  && encoder.encode(value).byteLength <= maximum;

export const boundedHttpOpaque = (value: unknown): value is string => bounded(value, 512);

const exactStringArray = (value: unknown, maximumItems: number, maximumBytes: number): readonly string[] | undefined => {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0
    || length > maximumItems || Reflect.ownKeys(descriptors).length !== length + 1) {
    return undefined;
  }
  const output: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !bounded(descriptor.value, maximumBytes)) {
      return undefined;
    }
    output.push(descriptor.value);
  }
  return Object.freeze(output);
};

const EXPECTED_FIELDS = ["requestId", "method", "path", "host"] as const;
const snapshotExpected = (value: unknown): HttpEgressExpectedRequest | undefined => {
  const record = exactDataRecord(value, EXPECTED_FIELDS);
  if (record === undefined || !boundedHttpOpaque(record.requestId)
    || !bounded(record.method, 128) || !TOKEN.test(record.method)
    || !bounded(record.path, 16_384) || !record.path.startsWith("/")
    || !bounded(record.host, 512)) {
    return undefined;
  }
  return Object.freeze({
    requestId: record.requestId, method: record.method, path: record.path, host: record.host,
  });
};

const CONNECTION_FIELDS = ["request", "write", "close"] as const;
const snapshotConnection = (value: unknown): HttpEgressOperation["connection"] | undefined => {
  const record = exactDataRecord(value, CONNECTION_FIELDS);
  if (record === undefined || (typeof record.request !== "object" && typeof record.request !== "function")
    || record.request === null || typeof record.write !== "function" || typeof record.close !== "function") {
    return undefined;
  }
  return Object.freeze({
    request: record.request as AsyncIterable<Uint8Array>,
    write: record.write as HttpEgressOperation["connection"]["write"],
    close: record.close as HttpEgressOperation["connection"]["close"],
  });
};

export const snapshotHttpEgressOperation = (value: unknown): HttpEgressOperation => {
  const base = exactDataRecord(value, ["operationId", "attemptId", "expectedRequest", "connection", "limits"])
    ?? exactDataRecord(value, ["operationId", "attemptId", "expectedRequest", "connection", "limits", "signal"]);
  const expectedRequest = base === undefined ? undefined : snapshotExpected(base.expectedRequest);
  const connection = base === undefined ? undefined : snapshotConnection(base.connection);
  if (base === undefined || !boundedHttpOpaque(base.operationId) || !boundedHttpOpaque(base.attemptId)
    || expectedRequest === undefined || connection === undefined
    || (base.signal !== undefined && !(base.signal instanceof AbortSignal))) {
    throw new HttpEgressIngressError();
  }
  const limits = snapshotHttpEgressLimits(base.limits);
  return Object.freeze({
    operationId: base.operationId, attemptId: base.attemptId, expectedRequest, connection, limits,
    ...(base.signal === undefined ? {} : { signal: base.signal }),
  });
};

const ROUTE_FIELDS = [
  "routeReceiptDigest", "materializationReceiptDigest", "originHost", "originPort", "upstreamMethod",
  "upstreamPath", "sni", "sniDigest", "certificateDigest", "pinDigest", "alpn", "policyGeneration",
  "keyGeneration", "routeGeneration", "credentialGeneration", "forwardedRequestHeaderNames",
] as const;

type RouteIdentity = {
  readonly routeReceiptDigest: string;
  readonly materializationReceiptDigest: string;
  readonly policyGeneration: string;
  readonly keyGeneration: string;
  readonly routeGeneration: string;
  readonly credentialGeneration: string;
};

const hasRouteIdentity = (record: DataRecord): record is DataRecord & RouteIdentity =>
  boundedHttpOpaque(record.routeReceiptDigest)
  && boundedHttpOpaque(record.materializationReceiptDigest)
  && boundedHttpOpaque(record.policyGeneration)
  && boundedHttpOpaque(record.keyGeneration)
  && boundedHttpOpaque(record.routeGeneration)
  && boundedHttpOpaque(record.credentialGeneration);

type RouteTarget = {
  readonly originHost: string;
  readonly originPort: number;
  readonly sni: string;
  readonly sniDigest: string;
  readonly certificateDigest: string;
  readonly pinDigest: string;
  readonly alpn: "http/1.1";
};

const hasRouteTarget = (record: DataRecord): record is DataRecord & RouteTarget =>
  bounded(record.originHost, 512) && /^[A-Za-z0-9.-]+$/.test(record.originHost)
  && Number.isSafeInteger(record.originPort) && typeof record.originPort === "number"
  && record.originPort >= 1 && record.originPort <= 65_535
  && bounded(record.sni, 512) && /^[A-Za-z0-9.-]+$/.test(record.sni)
  && boundedHttpOpaque(record.sniDigest) && boundedHttpOpaque(record.certificateDigest)
  && boundedHttpOpaque(record.pinDigest) && record.alpn === "http/1.1";

type RouteRequest = {
  readonly upstreamMethod: string;
  readonly upstreamPath: string;
};

const hasRouteRequest = (record: DataRecord): record is DataRecord & RouteRequest =>
  bounded(record.upstreamMethod, 128) && TOKEN.test(record.upstreamMethod)
  && record.upstreamMethod !== "CONNECT" && bounded(record.upstreamPath, 16_384)
  && record.upstreamPath.startsWith("/") && !record.upstreamPath.startsWith("//")
  && !/[^\x21-\x7e]|[?#]/.test(record.upstreamPath);

const hasForwardableHeaders = (headers: readonly string[]): boolean =>
  new Set(headers).size === headers.length
  && headers.every(name => name === name.toLowerCase() && TOKEN.test(name) && FORWARDABLE_HEADERS.has(name));

const snapshotRoute = (value: unknown): HttpEgressRoute | undefined => {
  const record = exactDataRecord(value, ROUTE_FIELDS);
  const headers = record === undefined ? undefined
    : exactStringArray(record.forwardedRequestHeaderNames, 32, 128);
  if (record === undefined || headers === undefined || !hasRouteIdentity(record)
    || !hasRouteTarget(record) || !hasRouteRequest(record) || !hasForwardableHeaders(headers)) {
    return undefined;
  }
  return Object.freeze({
    routeReceiptDigest: record.routeReceiptDigest, materializationReceiptDigest: record.materializationReceiptDigest,
    originHost: record.originHost, originPort: record.originPort, upstreamMethod: record.upstreamMethod,
    upstreamPath: record.upstreamPath, sni: record.sni, sniDigest: record.sniDigest,
    certificateDigest: record.certificateDigest, pinDigest: record.pinDigest, alpn: "http/1.1",
    policyGeneration: record.policyGeneration, keyGeneration: record.keyGeneration,
    routeGeneration: record.routeGeneration, credentialGeneration: record.credentialGeneration,
    forwardedRequestHeaderNames: headers,
  });
};

export const snapshotHttpRouteObservation = (value: unknown): HttpEgressRouteObservation | undefined => {
  const denied = exactDataRecord(value, ["status"]);
  if (denied?.status === "denied") {return Object.freeze({ status: "denied" });}
  const available = exactDataRecord(value, ["status", "route"]);
  const route = available?.status === "available" ? snapshotRoute(available.route) : undefined;
  return route === undefined ? undefined : Object.freeze({ status: "available", route });
};

const GENERATION_FIELDS = ["status", "policyGeneration", "keyGeneration", "routeGeneration",
  "credentialGeneration", "materializationReceiptDigest"] as const;
export const snapshotHttpGenerationObservation = (value: unknown): HttpEgressGenerationObservation | undefined => {
  const record = exactDataRecord(value, GENERATION_FIELDS);
  if (record === undefined || (record.status !== "current" && record.status !== "revoked")
    || !boundedHttpOpaque(record.policyGeneration) || !boundedHttpOpaque(record.keyGeneration)
    || !boundedHttpOpaque(record.routeGeneration) || !boundedHttpOpaque(record.credentialGeneration)
    || !boundedHttpOpaque(record.materializationReceiptDigest)) {return undefined;}
  return Object.freeze({ status: record.status, policyGeneration: record.policyGeneration,
    keyGeneration: record.keyGeneration, routeGeneration: record.routeGeneration,
    credentialGeneration: record.credentialGeneration, materializationReceiptDigest: record.materializationReceiptDigest });
};

const BINDING_FIELDS = ["peerAddress", "peerPort", "tlsProtocol", "sni", "sniDigest",
  "certificateDigest", "pinDigest", "alpn"] as const;
export const snapshotHttpTransportBinding = (value: unknown): HttpEgressTransportBinding | undefined => {
  const record = exactDataRecord(value, BINDING_FIELDS);
  if (record === undefined || !bounded(record.peerAddress, 64) || !Number.isSafeInteger(record.peerPort)
    || (record.peerPort as number) < 1 || (record.peerPort as number) > 65_535
    || (record.tlsProtocol !== "TLSv1.2" && record.tlsProtocol !== "TLSv1.3")
    || !bounded(record.sni, 512) || !boundedHttpOpaque(record.sniDigest)
    || !boundedHttpOpaque(record.certificateDigest) || !boundedHttpOpaque(record.pinDigest)
    || record.alpn !== "http/1.1") {return undefined;}
  return Object.freeze({ peerAddress: record.peerAddress, peerPort: record.peerPort as number,
    tlsProtocol: record.tlsProtocol, sni: record.sni, sniDigest: record.sniDigest,
    certificateDigest: record.certificateDigest, pinDigest: record.pinDigest, alpn: "http/1.1" });
};
