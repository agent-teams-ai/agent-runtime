import {types as utilTypes} from "node:util";
import type {HostHttpGrant, HostHttpProvisionalDecision} from "./http-egress-ports.js";

const fields = (...values: string[]) => Object.freeze(values);
const SHAPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  provisional: fields("contractVersion", "authorizationRequestId", "authorityRef", "scope", "policy", "providerAccess",
    "request", "requestDigest", "time", "signingKey", "decisionDigest", "signature"),
  grant: fields("payload", "finalAuthorizationDigest", "signature", "evidence"),
  payload: fields("contractVersion", "authorizationRequestId", "authorityRef", "scope", "policy", "providerAccess",
    "resolver", "selectedPeer", "tls", "limits", "request", "requestDigest", "time", "boundaryUseId",
    "connectionAttemptId", "streamId", "redirectHop", "provisionalDecisionDigest", "automaticRetryAuthorized",
    "poolingAuthorized", "consumption"),
  scope: fields("tenantId", "projectId", "operationId", "scopeDigest"),
  policy: fields("policyRef", "policyRevision", "policyGeneration", "authorizedRequestDigest", "origin", "dnsIdentity",
    "tlsPolicyDigest", "limits", "decisionTtlMilliseconds", "revoked"),
  origin: fields("scheme", "hostname", "port"), limits: fields("requestBytes", "responseBytes", "totalMilliseconds"),
  providerAccess: fields("accessRef", "providerRef", "accountRef", "routeRef", "routeAuthorityDigest",
    "credentialBindingDigest", "routeGeneration", "credentialGeneration"),
  request: fields("method", "scheme", "authority", "requestTarget", "headers", "body", "framing"),
  authority: fields("hostname", "port"), span: fields("digest", "byteLength"),
  headers: fields("canonicalDigest", "fieldCount", "credentialFields"),
  credential: fields("name", "credentialBindingDigest", "valueDigest", "byteLength"),
  framing: fields("protocol", "requestTarget", "authoritySource", "contentLength", "transferEncoding",
    "connectionSpecificHeaders"), provisionalTime: fields("authorityId", "epoch", "controlTime", "expiresAtControlTime"),
  grantTime: fields("authorityId", "epoch", "authorizedAtControlTime", "expiresAtControlTime"),
  key: fields("algorithm", "signatureEncoding", "keyRef", "publicKeyDigest", "keyGeneration", "signerRevision",
    "hostReservationId"), signature: fields("algorithm", "signatureEncoding", "keyRef", "publicKeyDigest",
    "keyGeneration", "signerRevision", "hostReservationId", "value"),
  resolver: fields("resolverIdentity", "resolverEpoch", "resolutionCount", "normalizedAddresses", "addressSetDigest"),
  address: fields("family", "address", "classification"), peer: fields("address", "port"),
  tls: fields("sniHostname", "certificateValidated", "dnsIdentity", "certificateDigest", "tlsPolicyDigest", "alpn"),
  consumption: fields("owner", "journalKey", "requestFingerprint"),
  journalKey: fields("namespace", "tenantId", "projectId", "operationId", "boundaryUseId"),
  evidence: fields("contractVersion", "authorizationRef", "boundaryUseRef", "decisionDigest",
    "finalAuthorizationDigest", "signingKey"),
});

const childShape = (parent: string, name: string): string | undefined => (Object.freeze({
  provisional_scope: "scope", provisional_policy: "policy", provisional_providerAccess: "providerAccess",
  provisional_request: "request", provisional_time: "provisionalTime", provisional_signingKey: "key",
  provisional_signature: "signature", grant_payload: "payload", grant_signature: "signature", grant_evidence: "evidence",
  payload_scope: "scope", payload_policy: "policy", payload_providerAccess: "providerAccess", payload_resolver: "resolver",
  payload_selectedPeer: "peer", payload_tls: "tls", payload_limits: "limits", payload_request: "request",
  payload_time: "grantTime", payload_consumption: "consumption", policy_origin: "origin", policy_limits: "limits",
  request_authority: "authority", request_requestTarget: "span", request_headers: "headers", request_body: "span",
  request_framing: "framing", consumption_journalKey: "journalKey", evidence_signingKey: "key",
}) as Readonly<Record<string, string>>)[`${parent}_${name}`];

const validScalar = (value: unknown): boolean => value === null || typeof value === "boolean"
  || typeof value === "number" && Number.isSafeInteger(value)
  || typeof value === "string" && value.length > 0 && value.length <= 512 && value.isWellFormed()
    && !/\p{Cc}|\p{Cs}/u.test(value);

const validArray = (value: unknown, itemShape: string): boolean => {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {return false;}
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors["length"];
  const length = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!Number.isSafeInteger(length) || (length as number) < 0
    || (length as number) > 128 || Reflect.ownKeys(descriptors).length !== (length as number) + 1) {return false;}
  for (let index = 0; index < (length as number); index += 1) {const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !validObject(descriptor.value, itemShape)) {return false;}}
  return true;
};

const validObject = (value: unknown, shape: string): boolean => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {return false;}
  const expected = SHAPES[shape]; if (expected === undefined) {return false;}
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length || keys.some(key => typeof key !== "string" || !expected.includes(key))) {return false;}
  for (const name of expected) {const descriptor = descriptors[name]; if (descriptor === undefined || !("value" in descriptor)) {return false;}
    if (shape === "headers" && name === "credentialFields") {if (!validArray(descriptor.value, "credential")) {return false;} continue;}
    if (shape === "resolver" && name === "normalizedAddresses") {if (!validArray(descriptor.value, "address")) {return false;} continue;}
    const child = childShape(shape, name);
    if (child === undefined ? !validScalar(descriptor.value) : !validObject(descriptor.value, child)) {return false;}}
  return true;
};

export const validHostHttpProvisionalDecision = (value: unknown): value is HostHttpProvisionalDecision =>
  validObject(value, "provisional");
export const validHostHttpGrant = (value: unknown): value is HostHttpGrant => validObject(value, "grant");
