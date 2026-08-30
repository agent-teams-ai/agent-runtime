export type DispatchProvider = "claude" | "codex";
export type DispatchDisposition = "abandoned_without_claim" | "claim_committed";
export interface DispatchScopeValue { readonly projectId: string; readonly scopeDigest: string; readonly tenantId: string }
export interface DispatchBindingHead extends DispatchScopeValue {
  readonly acceptedAuthorityDigest: string; readonly accessRef: string; readonly authorityHeadDigest: string;
  readonly availability: "available" | "unavailable"; readonly bindingDigest: string; readonly bindingRevision: number;
  readonly claimBeforeControlTime: number; readonly credentialBindingDigest: string; readonly credentialBindingRef: string;
  readonly credentialGeneration: number; readonly opaqueOwnerEvidenceRef: string; readonly provider: DispatchProvider;
  readonly providerAccountRef: string; readonly providerRouteRef: string; readonly revocation: "active" | "revoked";
  readonly expiresAtControlTime: number;
}
export interface DispatchExpectationValue {
  readonly acceptedAuthorityDigest: string; readonly accessRef: string; readonly authorityHeadDigest: string;
  readonly bindingDigest: string; readonly bindingRevision: number; readonly credentialBindingDigest: string;
  readonly credentialBindingRef: string; readonly credentialGeneration: number;
  readonly providerAccountRef: string; readonly providerRouteRef: string;
}
export interface DispatchConsumeCommand {
  readonly binding: DispatchExpectationValue; readonly claimBindingDigest: string; readonly grantRequestId: string;
  readonly operationId: string; readonly provider: DispatchProvider; readonly purpose: "contained-turn.provider-dispatch/v1";
  readonly requestDigest: string; readonly scope: DispatchScopeValue;
}
export interface DispatchConsumedReceipt {
  readonly acceptedAuthorityDigest: string; readonly accessRef: string; readonly authorityHeadDigestAtConsumption: string;
  readonly bindingDigest: string; readonly bindingRevision: number; readonly claimBeforeControlTime: number;
  readonly claimBindingDigest: string; readonly consumedAtControlTime: number; readonly consumptionDigest: string;
  readonly credentialBindingDigest: string; readonly credentialBindingRef: string; readonly credentialGeneration: number;
  readonly grantRequestId: string; readonly opaqueOwnerEvidenceRef: string; readonly operationId: string;
  readonly provider: DispatchProvider; readonly providerAccountRef: string; readonly providerRouteRef: string;
  readonly purpose: "contained-turn.provider-dispatch/v1"; readonly requestDigest: string; readonly scope: DispatchScopeValue;
}
export interface DispatchSettlementCommand {
  readonly consumptionDigest: string; readonly disposition: DispatchDisposition;
  readonly expectedBinding: DispatchExpectationValue; readonly operationId: string; readonly provider: DispatchProvider;
  readonly scope: DispatchScopeValue; readonly settlementRequestId: string;
}
export type DispatchPreventedReason =
  | "accepted_authority_changed" | "access_changed" | "account_changed" | "already_consumed" | "authority_head_changed"
  | "binding_changed" | "claim_binding_mismatch" | "credential_changed" | "credential_rotated"
  | "expired" | "invalid_request" | "provider_mismatch" | "request_digest_mismatch"
  | "revision_changed" | "revoked" | "route_changed" | "scope_mismatch" | "unavailable";
export interface DispatchPrevention {
  readonly grantRequestId: string; readonly observedAtControlTime: number; readonly opaqueOwnerEvidenceRef: string;
  readonly reason: DispatchPreventedReason; readonly requestDigest: string; readonly scope: DispatchScopeValue;
}
export type DispatchConsumeOutcome =
  | { readonly kind: "conflict"; readonly reason: "grant_request_digest_conflict" }
  | { readonly kind: "consumed"; readonly receipt: DispatchConsumedReceipt }
  | { readonly kind: "invalid"; readonly reason: "invalid_request" }
  | { readonly kind: "indeterminate" } | { readonly kind: "not_found" }
  | { readonly kind: "prevented"; readonly prevention: DispatchPrevention };
export interface DispatchSettlementReceipt {
  readonly consumptionDigest: string; readonly disposition: DispatchDisposition; readonly expectedBinding: DispatchExpectationValue;
  readonly operationId: string; readonly provider: DispatchProvider; readonly scope: DispatchScopeValue;
  readonly settledAtControlTime: number; readonly settlementDigest: string; readonly settlementRequestId: string;
}
export type DispatchSettlementOutcome =
  | { readonly kind: "conflict"; readonly reason: "settlement_request_conflict" }
  | { readonly kind: "invalid"; readonly reason: "invalid_request" }
  | { readonly kind: "indeterminate" } | { readonly kind: "not_found" }
  | { readonly kind: "settled"; readonly receipt: DispatchSettlementReceipt };

const TOKEN = /^[\p{L}\p{N}._:@+-]+$/u;
const DIGEST = /^[\p{L}\p{N}._:+-]+$/u;
const primitive = (name: string, value: unknown, digest = false): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || !(digest ? DIGEST : TOKEN).test(value)) {
    throw new TypeError(`${name} must be a bounded primitive token`);
  }
  return value;
};
const positive = (name: string, value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {throw new TypeError(`${name} must be a positive safe integer`);}
  return value;
};
const preflightData = (name: string, value: unknown, seen: Set<object>, depth: number): void => {
  if (typeof value === "string" && value.length > 512) {throw new TypeError(`${name} contains oversized data`);}
  if (value === null || typeof value !== "object") {return;}
  if (depth > 8 || seen.size > 128) {throw new TypeError(`${name} has an invalid aggregate`);}
  if (seen.has(value)) {throw new TypeError(`${name} cannot be cyclic`);}
  seen.add(value);
  let prototype: unknown;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {throw new TypeError(`${name} must be stable data`);}
  if (Reflect.ownKeys(descriptors).length > 128) {throw new TypeError(`${name} contains too many fields`);}
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) {throw new TypeError(`${name} must be a data record`);}
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {throw new TypeError(`${name} cannot contain symbol fields`);}
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {throw new TypeError(`${name} cannot contain accessors`);}
    preflightData(name, descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
};
export const exactDispatchDataRecord = (name: string, value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {throw new TypeError(`${name} must be a data record`);}
  let prototype: unknown;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {throw new TypeError(`${name} must be stable data`);}
  if (prototype !== Object.prototype && prototype !== null) {throw new TypeError(`${name} must be a data record`);}
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string") ||
    Object.keys(descriptors).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {throw new TypeError(`${name} has an invalid shape`);}
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) {throw new TypeError(`${name} cannot contain accessors`);}
  }
  preflightData(name, value, new Set(), 0);
  try {structuredClone(value);} catch {throw new TypeError(`${name} must be cloneable data`);}
  return Object.fromEntries(keys.map(key => [key, descriptors[key]?.value]));
};
const record = exactDispatchDataRecord;
export const snapshotDispatchScope = (value: DispatchScopeValue): DispatchScopeValue => {
  const data = record("scope", value, ["projectId", "scopeDigest", "tenantId"]);
  return Object.freeze({
    projectId: primitive("projectId", data.projectId), scopeDigest: primitive("scopeDigest", data.scopeDigest, true),
    tenantId: primitive("tenantId", data.tenantId),
  });
};
export const snapshotDispatchBindingHead = (value: DispatchBindingHead): DispatchBindingHead => {
  const data = record("binding head", value, [
    "acceptedAuthorityDigest", "accessRef", "authorityHeadDigest", "availability", "bindingDigest", "bindingRevision",
    "claimBeforeControlTime", "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "expiresAtControlTime",
    "opaqueOwnerEvidenceRef", "projectId", "provider", "providerAccountRef", "providerRouteRef", "revocation", "scopeDigest", "tenantId",
  ]);
  if (data.provider !== "claude" && data.provider !== "codex") {throw new TypeError("provider is invalid");}
  if (data.availability !== "available" && data.availability !== "unavailable") {throw new TypeError("availability is invalid");}
  if (data.revocation !== "active" && data.revocation !== "revoked") {throw new TypeError("revocation is invalid");}
  const claimBeforeControlTime = positive("claimBeforeControlTime", data.claimBeforeControlTime);
  const expiresAtControlTime = positive("expiresAtControlTime", data.expiresAtControlTime);
  if (claimBeforeControlTime > expiresAtControlTime) {throw new TypeError("claim deadline cannot exceed expiry");}
  return Object.freeze({
    acceptedAuthorityDigest: primitive("acceptedAuthorityDigest", data.acceptedAuthorityDigest, true),
    accessRef: primitive("accessRef", data.accessRef), authorityHeadDigest: primitive("authorityHeadDigest", data.authorityHeadDigest, true),
    availability: data.availability, bindingDigest: primitive("bindingDigest", data.bindingDigest, true),
    bindingRevision: positive("bindingRevision", data.bindingRevision), claimBeforeControlTime,
    credentialBindingDigest: primitive("credentialBindingDigest", data.credentialBindingDigest, true),
    credentialBindingRef: primitive("credentialBindingRef", data.credentialBindingRef),
    credentialGeneration: positive("credentialGeneration", data.credentialGeneration),
    opaqueOwnerEvidenceRef: primitive("opaqueOwnerEvidenceRef", data.opaqueOwnerEvidenceRef), provider: data.provider,
    providerAccountRef: primitive("providerAccountRef", data.providerAccountRef),
    providerRouteRef: primitive("providerRouteRef", data.providerRouteRef), revocation: data.revocation, expiresAtControlTime,
    ...snapshotDispatchScope({ projectId: data.projectId, scopeDigest: data.scopeDigest, tenantId: data.tenantId } as DispatchScopeValue),
  });
};
export const snapshotDispatchExpectation = (value: DispatchExpectationValue): DispatchExpectationValue => {
  const data = record("binding expectation", value, [
    "acceptedAuthorityDigest", "accessRef", "authorityHeadDigest", "bindingDigest", "bindingRevision",
    "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "providerAccountRef", "providerRouteRef",
  ]);
  return Object.freeze({
    acceptedAuthorityDigest: primitive("acceptedAuthorityDigest", data.acceptedAuthorityDigest, true),
    accessRef: primitive("accessRef", data.accessRef), authorityHeadDigest: primitive("authorityHeadDigest", data.authorityHeadDigest, true),
    bindingDigest: primitive("bindingDigest", data.bindingDigest, true), bindingRevision: positive("bindingRevision", data.bindingRevision),
    credentialBindingDigest: primitive("credentialBindingDigest", data.credentialBindingDigest, true),
    credentialBindingRef: primitive("credentialBindingRef", data.credentialBindingRef),
    credentialGeneration: positive("credentialGeneration", data.credentialGeneration),
    providerAccountRef: primitive("providerAccountRef", data.providerAccountRef), providerRouteRef: primitive("providerRouteRef", data.providerRouteRef),
  });
};
export const snapshotDispatchDigest = (name: string, value: unknown): string => primitive(name, value, true);
export const snapshotDispatchId = (name: string, value: unknown): string => primitive(name, value);
export const snapshotDispatchControlTime = (value: unknown): number => positive("controlTime", value);
const provider = (value: unknown): DispatchProvider => {
  if (value !== "claude" && value !== "codex") {throw new TypeError("provider is invalid");}
  return value;
};
const disposition = (value: unknown): DispatchDisposition => {
  if (value !== "abandoned_without_claim" && value !== "claim_committed") {throw new TypeError("disposition is invalid");}
  return value;
};
export const snapshotDispatchConsumedReceipt = (value: unknown): DispatchConsumedReceipt => {
  const data = record("consumption receipt", value, [
    "acceptedAuthorityDigest", "accessRef", "authorityHeadDigestAtConsumption", "bindingDigest", "bindingRevision",
    "claimBeforeControlTime", "claimBindingDigest", "consumedAtControlTime", "consumptionDigest", "credentialBindingDigest",
    "credentialBindingRef", "credentialGeneration", "grantRequestId", "opaqueOwnerEvidenceRef", "operationId", "provider",
    "providerAccountRef", "providerRouteRef", "purpose", "requestDigest", "scope",
  ]);
  if (data.purpose !== "contained-turn.provider-dispatch/v1") {throw new TypeError("purpose is invalid");}
  return Object.freeze({
    acceptedAuthorityDigest: primitive("acceptedAuthorityDigest", data.acceptedAuthorityDigest, true), accessRef: primitive("accessRef", data.accessRef),
    authorityHeadDigestAtConsumption: primitive("authorityHeadDigestAtConsumption", data.authorityHeadDigestAtConsumption, true),
    bindingDigest: primitive("bindingDigest", data.bindingDigest, true), bindingRevision: positive("bindingRevision", data.bindingRevision),
    claimBeforeControlTime: positive("claimBeforeControlTime", data.claimBeforeControlTime), claimBindingDigest: primitive("claimBindingDigest", data.claimBindingDigest, true),
    consumedAtControlTime: positive("consumedAtControlTime", data.consumedAtControlTime),
    credentialBindingDigest: primitive("credentialBindingDigest", data.credentialBindingDigest, true), credentialBindingRef: primitive("credentialBindingRef", data.credentialBindingRef),
    credentialGeneration: positive("credentialGeneration", data.credentialGeneration), grantRequestId: primitive("grantRequestId", data.grantRequestId),
    opaqueOwnerEvidenceRef: primitive("opaqueOwnerEvidenceRef", data.opaqueOwnerEvidenceRef), operationId: primitive("operationId", data.operationId),
    provider: provider(data.provider), providerAccountRef: primitive("providerAccountRef", data.providerAccountRef), providerRouteRef: primitive("providerRouteRef", data.providerRouteRef),
    purpose: data.purpose, requestDigest: primitive("requestDigest", data.requestDigest, true), scope: snapshotDispatchScope(data.scope as DispatchScopeValue),
    consumptionDigest: primitive("consumptionDigest", data.consumptionDigest, true),
  });
};
const snapshotDispatchPrevention = (value: unknown): DispatchPrevention => {
  const data = record("prevention", value, ["grantRequestId", "observedAtControlTime", "opaqueOwnerEvidenceRef", "reason", "requestDigest", "scope"]);
  const reasons: readonly DispatchPreventedReason[] = [
    "accepted_authority_changed", "access_changed", "account_changed", "already_consumed", "authority_head_changed", "binding_changed",
    "claim_binding_mismatch", "credential_changed", "credential_rotated", "expired", "invalid_request", "provider_mismatch",
    "request_digest_mismatch", "revision_changed", "revoked", "route_changed", "scope_mismatch", "unavailable",
  ];
  if (!reasons.includes(data.reason as DispatchPreventedReason)) {throw new TypeError("prevention reason is invalid");}
  return Object.freeze({
    grantRequestId: primitive("grantRequestId", data.grantRequestId), observedAtControlTime: positive("observedAtControlTime", data.observedAtControlTime),
    opaqueOwnerEvidenceRef: primitive("opaqueOwnerEvidenceRef", data.opaqueOwnerEvidenceRef), reason: data.reason as DispatchPreventedReason,
    requestDigest: primitive("requestDigest", data.requestDigest, true), scope: snapshotDispatchScope(data.scope as DispatchScopeValue),
  });
};
const dispatchKind = (name: string, value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {throw new TypeError(`${name} must be a data record`);}
  preflightData(name, value, new Set(), 0);
  try {structuredClone(value);} catch {throw new TypeError(`${name} must be cloneable data`);}
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (descriptor === undefined || !("value" in descriptor)) {throw new TypeError(`${name} kind is invalid`);}
  return descriptor.value;
};
export const snapshotDispatchConsumeOutcome = (value: unknown): DispatchConsumeOutcome => {
  const kind = dispatchKind("consume outcome", value);
  if (kind === "consumed") {
    const data = record("consume outcome", value, ["kind", "receipt"]); return Object.freeze({ kind: "consumed", receipt: snapshotDispatchConsumedReceipt(data.receipt) });
  }
  if (kind === "prevented") {
    const data = record("consume outcome", value, ["kind", "prevention"]); return Object.freeze({ kind: "prevented", prevention: snapshotDispatchPrevention(data.prevention) });
  }
  if (kind === "conflict") {
    const data = record("consume outcome", value, ["kind", "reason"]);
    if (data.reason !== "grant_request_digest_conflict") {throw new TypeError("conflict reason is invalid");}
    return Object.freeze({ kind: "conflict", reason: data.reason });
  }
  if (kind === "invalid") {
    const data = record("consume outcome", value, ["kind", "reason"]);
    if (data.reason !== "invalid_request") {throw new TypeError("invalid reason is invalid");}
    return Object.freeze({ kind: "invalid", reason: data.reason });
  }
  if (kind === "indeterminate" || kind === "not_found") {
    record("consume outcome", value, ["kind"]); return Object.freeze({ kind });
  }
  throw new TypeError("consume outcome kind is invalid");
};
export const snapshotDispatchSettlementReceipt = (value: unknown): DispatchSettlementReceipt => {
  const data = record("settlement receipt", value, [
    "consumptionDigest", "disposition", "expectedBinding", "operationId", "provider", "scope", "settledAtControlTime",
    "settlementDigest", "settlementRequestId",
  ]);
  return Object.freeze({
    consumptionDigest: primitive("consumptionDigest", data.consumptionDigest, true), disposition: disposition(data.disposition),
    expectedBinding: snapshotDispatchExpectation(data.expectedBinding as DispatchExpectationValue), operationId: primitive("operationId", data.operationId),
    provider: provider(data.provider), scope: snapshotDispatchScope(data.scope as DispatchScopeValue),
    settlementRequestId: primitive("settlementRequestId", data.settlementRequestId), settledAtControlTime: positive("settledAtControlTime", data.settledAtControlTime),
    settlementDigest: primitive("settlementDigest", data.settlementDigest, true),
  });
};
export const snapshotDispatchSettlementOutcome = (value: unknown): DispatchSettlementOutcome => {
  const kind = dispatchKind("settlement outcome", value);
  if (kind === "settled") {
    const data = record("settlement outcome", value, ["kind", "receipt"]); return Object.freeze({ kind: "settled", receipt: snapshotDispatchSettlementReceipt(data.receipt) });
  }
  if (kind === "conflict") {
    const data = record("settlement outcome", value, ["kind", "reason"]);
    if (data.reason !== "settlement_request_conflict") {throw new TypeError("conflict reason is invalid");}
    return Object.freeze({ kind: "conflict", reason: data.reason });
  }
  if (kind === "invalid") {
    const data = record("settlement outcome", value, ["kind", "reason"]);
    if (data.reason !== "invalid_request") {throw new TypeError("invalid reason is invalid");}
    return Object.freeze({ kind: "invalid", reason: data.reason });
  }
  if (kind === "indeterminate" || kind === "not_found") {
    record("settlement outcome", value, ["kind"]); return Object.freeze({ kind });
  }
  throw new TypeError("settlement outcome kind is invalid");
};
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {return JSON.stringify(value);}
  if (Array.isArray(value)) {return `[${value.map(canonicalJson).join(",")}]`;}
  if (typeof value !== "object") {throw new TypeError("canonical value is invalid");}
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object).toSorted().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
};
export const requestDigestPayload = (command: Omit<DispatchConsumeCommand, "requestDigest">): string => canonicalJson(command);
export const journalDigestPayload = (entry: { readonly journalDigest?: string } & Readonly<Record<string, unknown>>): string => {
  const { journalDigest: _digest, ...unsigned } = entry; return canonicalJson(unsigned);
};
export const claimBindingDigestPayload = (command: DispatchConsumeCommand): string => canonicalJson({
  acceptedAuthorityDigest: command.binding.acceptedAuthorityDigest, accessRef: command.binding.accessRef,
  authorityHeadDigest: command.binding.authorityHeadDigest, bindingDigest: command.binding.bindingDigest,
  bindingRevision: command.binding.bindingRevision, credentialBindingDigest: command.binding.credentialBindingDigest,
  credentialBindingRef: command.binding.credentialBindingRef, credentialGeneration: command.binding.credentialGeneration,
  grantRequestId: command.grantRequestId, operationId: command.operationId, provider: command.provider,
  providerAccountRef: command.binding.providerAccountRef, providerRouteRef: command.binding.providerRouteRef,
  purpose: command.purpose, scope: command.scope,
});
export const consumptionDigestPayload = (receipt: DispatchConsumedReceipt): string => {
  const { consumptionDigest: _digest, ...unsigned } = receipt; return canonicalJson(unsigned);
};
export const settlementDigestPayload = (receipt: DispatchSettlementReceipt): string => {
  const { settlementDigest: _digest, ...unsigned } = receipt; return canonicalJson(unsigned);
};
