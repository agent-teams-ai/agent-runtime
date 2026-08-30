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
  | { readonly kind: "indeterminate" } | { readonly kind: "not_found" }
  | { readonly kind: "prevented"; readonly prevention: DispatchPrevention };
export interface DispatchSettlementReceipt {
  readonly consumptionDigest: string; readonly disposition: DispatchDisposition; readonly settledAtControlTime: number;
  readonly settlementDigest: string; readonly settlementRequestId: string;
}
export type DispatchSettlementOutcome =
  | { readonly kind: "conflict"; readonly reason: "settlement_request_conflict" }
  | { readonly kind: "indeterminate" } | { readonly kind: "not_found" }
  | { readonly kind: "settled"; readonly receipt: DispatchSettlementReceipt };

const primitive = (name: string, value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\u0000")) {
    throw new TypeError(`${name} must be a bounded primitive string`);
  }
  return value;
};
const positive = (name: string, value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
};
export const snapshotDispatchScope = (value: DispatchScopeValue): DispatchScopeValue => Object.freeze({
  projectId: primitive("projectId", value.projectId), scopeDigest: primitive("scopeDigest", value.scopeDigest),
  tenantId: primitive("tenantId", value.tenantId),
});
export const snapshotDispatchBindingHead = (value: DispatchBindingHead): DispatchBindingHead => {
  if (value.provider !== "claude" && value.provider !== "codex") throw new TypeError("provider is invalid");
  if (value.availability !== "available" && value.availability !== "unavailable") throw new TypeError("availability is invalid");
  if (value.revocation !== "active" && value.revocation !== "revoked") throw new TypeError("revocation is invalid");
  if (value.claimBeforeControlTime > value.expiresAtControlTime) throw new TypeError("claim deadline cannot exceed expiry");
  return Object.freeze({
    acceptedAuthorityDigest: primitive("acceptedAuthorityDigest", value.acceptedAuthorityDigest),
    accessRef: primitive("accessRef", value.accessRef), authorityHeadDigest: primitive("authorityHeadDigest", value.authorityHeadDigest),
    availability: value.availability, bindingDigest: primitive("bindingDigest", value.bindingDigest),
    bindingRevision: positive("bindingRevision", value.bindingRevision),
    claimBeforeControlTime: positive("claimBeforeControlTime", value.claimBeforeControlTime),
    credentialBindingDigest: primitive("credentialBindingDigest", value.credentialBindingDigest),
    credentialBindingRef: primitive("credentialBindingRef", value.credentialBindingRef),
    credentialGeneration: positive("credentialGeneration", value.credentialGeneration),
    opaqueOwnerEvidenceRef: primitive("opaqueOwnerEvidenceRef", value.opaqueOwnerEvidenceRef), provider: value.provider,
    providerAccountRef: primitive("providerAccountRef", value.providerAccountRef),
    providerRouteRef: primitive("providerRouteRef", value.providerRouteRef), revocation: value.revocation,
    expiresAtControlTime: positive("expiresAtControlTime", value.expiresAtControlTime),
    ...snapshotDispatchScope(value),
  });
};
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("canonical value is invalid");
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).toSorted().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};
export const requestDigestPayload = (command: Omit<DispatchConsumeCommand, "requestDigest">): string => canonicalJson(command);
export const claimBindingDigestPayload = (command: DispatchConsumeCommand): string => canonicalJson({
  acceptedAuthorityDigest: command.binding.acceptedAuthorityDigest, authorityHeadDigest: command.binding.authorityHeadDigest,
  bindingDigest: command.binding.bindingDigest, bindingRevision: command.binding.bindingRevision,
  grantRequestId: command.grantRequestId, operationId: command.operationId, provider: command.provider,
  purpose: command.purpose, scopeDigest: command.scope.scopeDigest,
});
