import { types } from "node:util";

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
  readonly consumptionDigest: string; readonly disposition: DispatchDisposition; readonly settledAtControlTime: number;
  readonly settlementDigest: string; readonly settlementRequestId: string;
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
const record = (name: string, value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {throw new TypeError(`${name} must be a data record`);}
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {throw new TypeError(`${name} must be a data record`);}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string") || Object.keys(descriptors).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {
    throw new TypeError(`${name} has an invalid shape`);
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) {throw new TypeError(`${name} cannot contain accessors`);}
  }
  return Object.fromEntries(keys.map(key => [key, descriptors[key]?.value]));
};
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
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {return JSON.stringify(value);}
  if (Array.isArray(value)) {return `[${value.map(canonicalJson).join(",")}]`;}
  if (typeof value !== "object") {throw new TypeError("canonical value is invalid");}
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object).toSorted().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
};
export const requestDigestPayload = (command: Omit<DispatchConsumeCommand, "requestDigest">): string => canonicalJson(command);
export const claimBindingDigestPayload = (command: DispatchConsumeCommand): string => canonicalJson({
  acceptedAuthorityDigest: command.binding.acceptedAuthorityDigest, authorityHeadDigest: command.binding.authorityHeadDigest,
  bindingDigest: command.binding.bindingDigest, bindingRevision: command.binding.bindingRevision,
  grantRequestId: command.grantRequestId, operationId: command.operationId, provider: command.provider,
  purpose: command.purpose, scopeDigest: command.scope.scopeDigest,
});
