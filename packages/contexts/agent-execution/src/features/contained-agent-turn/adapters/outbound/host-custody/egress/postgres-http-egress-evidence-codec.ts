import {isIP} from "node:net";
import {types} from "node:util";
import {HTTP_EGRESS_ANOMALY_CODES, type HttpEgressReceipt} from "./http-egress-contracts.js";
import {boundedHttpOpaque} from "./http-ingress-validation.js";

export type PostgresHttpEgressEvidenceScope = Readonly<{tenantId: string; projectId: string; deploymentId: string}>;
type Rule<T = unknown> = (value: unknown) => value is T;
type Rules<T extends object> = Record<string, Rule> & {[K in keyof T]: Rule<T[K]>};
const opaque = boundedHttpOpaque;
const optionalOpaque = (value: unknown): value is string => value === "" || opaque(value);
const choice = <const T extends readonly unknown[]>(...values: T): Rule<T[number]> =>
  (value): value is T[number] => values.includes(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const closure = choice("not_opened", "closed", "unknown");
// Digests from other authorities are bounded opaque references (including sha256:
// references). Locally computed byte digests remain lowercase SHA256 hex.
const rules: Rules<HttpEgressReceipt> = {
  schema: choice("agent-runtime.host-http-egress-receipt/v1"),
  operationId: opaque, attemptId: opaque, requestId: opaque,
  requestDigest: optionalOpaque, outcome: choice("completed", "rejected", "denied", "cancelled", "reconcile_required"),
  anomalyCode: choice(...HTTP_EGRESS_ANOMALY_CODES),
  provisionalAuthorizationReceiptDigest: optionalOpaque, finalAuthorizationReceiptDigest: optionalOpaque,
  routeReceiptDigest: optionalOpaque, materializationReceiptDigest: optionalOpaque,
  selectedPeer: (value): value is string => value === "" || (typeof value === "string" && value.length <= 45 && isIP(value) !== 0),
  tlsProtocol: choice("", "TLSv1.2", "TLSv1.3"), sniDigest: optionalOpaque,
  certificateDigest: optionalOpaque, pinDigest: optionalOpaque, alpn: choice("", "http/1.1"),
  policyGeneration: optionalOpaque, keyGeneration: optionalOpaque, routeGeneration: optionalOpaque,
  credentialGeneration: optionalOpaque, inboundRequestBytes: count, upstreamRequestBytes: count,
  upstreamResponseBytes: count, outboundResponseBytes: count, outboundResponseWriteUncertain: choice(true, false),
  firstByteState: choice("not_sent", "sent", "uncertain"), inboundClosure: closure, upstreamClosure: closure,
  inboundClosureReceiptDigest: optionalOpaque, upstreamClosureReceiptDigest: optionalOpaque, attemptCount: choice(0, 1),
};

const matchesRules = <T extends object>(value: Record<string, unknown>, validators: Rules<T>): value is Record<string, unknown> & T =>
  Object.entries(validators).every(([name, validate]) => validate(value[name]));

const snapshot = <T extends object>(input: unknown, validators: Rules<T>): Readonly<T> => {
  if (typeof input !== "object" || input === null || types.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) {throw new TypeError("invalid HTTP evidence object");}
  const names = Object.keys(validators).toSorted();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !Object.hasOwn(validators, key))) {
    throw new TypeError("invalid HTTP evidence fields");
  }
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("invalid HTTP evidence value");
    }
    result[name] = descriptor.value;
  }
  if (!matchesRules(result, validators)) {throw new TypeError("invalid HTTP evidence value");}
  return Object.freeze(result);
};
export const snapshotHttpEvidenceScope = (input: unknown): PostgresHttpEgressEvidenceScope =>
  snapshot<PostgresHttpEgressEvidenceScope>(input, {tenantId: opaque, projectId: opaque, deploymentId: opaque});
export const canonicalHttpEvidenceReceipt = (input: unknown): Readonly<{receipt: HttpEgressReceipt; canonical: string}> => {
  const receipt = snapshot<HttpEgressReceipt>(input, rules);
  const canonical = JSON.stringify(receipt);
  if (Buffer.byteLength(canonical, "utf8") > 32_768) {throw new TypeError("HTTP evidence receipt too large");}
  return {receipt, canonical};
};

export type PostgresHttpEgressReceiptIdentity = Readonly<{operationId: string; attemptId: string; requestId: string}>;
export const snapshotHttpEvidenceIdentity = (input: unknown): PostgresHttpEgressReceiptIdentity =>
  snapshot<PostgresHttpEgressReceiptIdentity>(input, {operationId: opaque, attemptId: opaque, requestId: opaque});
