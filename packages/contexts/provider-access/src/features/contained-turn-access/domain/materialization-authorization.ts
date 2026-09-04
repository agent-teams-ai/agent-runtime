import { canonicalJson } from "./dispatch-consumption.js";

export type AuthorizationProvider = "claude" | "codex";
export type AuthorizationRejectionReason =
  | "access_changed" | "access_not_available" | "account_changed" | "availability_changed"
  | "binding_revision_changed" | "credential_binding_changed" | "credential_generation_changed"
  | "revoked" | "route_changed";

export interface AuthorizationCommand {
  readonly accessRef: string;
  readonly authorizationRequestId: string;
  readonly availability: "available" | "unavailable";
  readonly bindingRevision: number;
  readonly credentialBindingDigest: string;
  readonly credentialBindingRef: string;
  readonly credentialGeneration: number;
  readonly projectId: string;
  readonly provider: AuthorizationProvider;
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly purpose: "contained-turn.credential-materialization-authorization/v1";
  readonly requestDigest: string;
  readonly revocation: "active" | "revoked";
  readonly schemaVersion: 1;
  readonly scopeDigest: string;
  readonly tenantId: string;
}

export interface AuthorizationRecord extends AuthorizationCommand {
  readonly decision: "authorized" | "rejected";
  readonly rejectionReason: AuthorizationRejectionReason | null;
}

export interface AuthorizationOwnerSelector {
  readonly authorizationRequestId: string;
  readonly projectId: string;
  readonly provider: AuthorizationProvider;
  readonly requestDigest: string;
  readonly scopeDigest: string;
  readonly tenantId: string;
}

const TOKEN = /^[\p{L}\p{N}._:@+-]+$/u;
const DIGEST = /^[\p{L}\p{N}._:+-]+$/u;
const token = (name: string, value: unknown, digest = false): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || !(digest ? DIGEST : TOKEN).test(value)) {
    throw new TypeError(`${name} must be a bounded primitive token`);
  }
  return value;
};
const positive = (name: string, value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
};

export const AUTHORIZATION_COMMAND_KEYS = [
  "accessRef", "authorizationRequestId", "availability", "bindingRevision", "credentialBindingDigest",
  "credentialBindingRef", "credentialGeneration", "projectId", "provider", "providerAccountRef", "providerRouteRef",
  "purpose", "requestDigest", "revocation", "schemaVersion", "scopeDigest", "tenantId",
] as const;

export class UnsupportedAuthorizationInputError extends TypeError {
  readonly reason: "unsupported_provider" | "unsupported_version";
  constructor(reason: "unsupported_provider" | "unsupported_version") {
    super(reason); this.reason = reason;
  }
}

const exactRecord = (name: string, value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {throw new TypeError(`${name} must be a data record`);}
  let prototype: unknown;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try { prototype = Object.getPrototypeOf(value) as unknown; descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { throw new TypeError(`${name} must be stable data`); }
  if (prototype !== Object.prototype && prototype !== null) {throw new TypeError(`${name} must be a plain data record`);}
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string") ||
      Object.keys(descriptors).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {
    throw new TypeError(`${name} has an invalid shape`);
  }
  const entries: [string, unknown][] = [];
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {throw new TypeError(`${name} cannot contain accessors`);}
    entries.push([key, descriptor.value]);
  }
  return Object.freeze(Object.fromEntries(entries));
};

export const snapshotAuthorizationCommand = (value: unknown): AuthorizationCommand => {
  const data = exactRecord("authorization command", value, AUTHORIZATION_COMMAND_KEYS);
  if (data.provider !== "claude" && data.provider !== "codex") {throw new UnsupportedAuthorizationInputError("unsupported_provider");}
  if (data.schemaVersion !== 1 || data.purpose !== "contained-turn.credential-materialization-authorization/v1") {
    throw new UnsupportedAuthorizationInputError("unsupported_version");
  }
  if (data.availability !== "available" && data.availability !== "unavailable") {throw new TypeError("availability is invalid");}
  if (data.revocation !== "active" && data.revocation !== "revoked") {throw new TypeError("revocation is invalid");}
  return Object.freeze({
    accessRef: token("accessRef", data.accessRef), authorizationRequestId: token("authorizationRequestId", data.authorizationRequestId),
    availability: data.availability, bindingRevision: positive("bindingRevision", data.bindingRevision),
    credentialBindingDigest: token("credentialBindingDigest", data.credentialBindingDigest, true),
    credentialBindingRef: token("credentialBindingRef", data.credentialBindingRef),
    credentialGeneration: positive("credentialGeneration", data.credentialGeneration), projectId: token("projectId", data.projectId),
    provider: data.provider, providerAccountRef: token("providerAccountRef", data.providerAccountRef),
    providerRouteRef: token("providerRouteRef", data.providerRouteRef), purpose: data.purpose,
    requestDigest: token("requestDigest", data.requestDigest, true), revocation: data.revocation, schemaVersion: data.schemaVersion,
    scopeDigest: token("scopeDigest", data.scopeDigest, true), tenantId: token("tenantId", data.tenantId),
  });
};

const REJECTION_REASONS: readonly AuthorizationRejectionReason[] = [
  "access_changed", "access_not_available", "account_changed", "availability_changed", "binding_revision_changed",
  "credential_binding_changed", "credential_generation_changed", "revoked", "route_changed",
];

export const snapshotAuthorizationRecord = (value: unknown): AuthorizationRecord => {
  const data = exactRecord("authorization record", value, [...AUTHORIZATION_COMMAND_KEYS, "decision", "rejectionReason"]);
  if (data.decision !== "authorized" && data.decision !== "rejected") {throw new TypeError("authorization decision is invalid");}
  if (data.decision === "authorized" ? data.rejectionReason !== null : !REJECTION_REASONS.includes(data.rejectionReason as AuthorizationRejectionReason)) {
    throw new TypeError("authorization rejection reason is invalid");
  }
  return Object.freeze({
    ...snapshotAuthorizationCommand(Object.fromEntries(AUTHORIZATION_COMMAND_KEYS.map(key => [key, data[key]]))),
    decision: data.decision, rejectionReason: data.rejectionReason as AuthorizationRejectionReason | null,
  });
};

export const snapshotAuthorizationOwnerSelector = (value: unknown): AuthorizationOwnerSelector => {
  const data = exactRecord("authorization owner selector", value, [
    "authorizationRequestId", "projectId", "provider", "requestDigest", "scopeDigest", "tenantId",
  ]);
  if (data.provider !== "claude" && data.provider !== "codex") {throw new UnsupportedAuthorizationInputError("unsupported_provider");}
  return Object.freeze({
    authorizationRequestId: token("authorizationRequestId", data.authorizationRequestId), projectId: token("projectId", data.projectId),
    provider: data.provider, requestDigest: token("requestDigest", data.requestDigest, true),
    scopeDigest: token("scopeDigest", data.scopeDigest, true), tenantId: token("tenantId", data.tenantId),
  });
};

export const authorizationRequestPayload = (command: Omit<AuthorizationCommand, "requestDigest">): string => canonicalJson({
  accessRef: command.accessRef, authorizationRequestId: command.authorizationRequestId, availability: command.availability,
  bindingRevision: command.bindingRevision, credentialBindingDigest: command.credentialBindingDigest,
  credentialBindingRef: command.credentialBindingRef, credentialGeneration: command.credentialGeneration,
  projectId: command.projectId, provider: command.provider, providerAccountRef: command.providerAccountRef,
  providerRouteRef: command.providerRouteRef, purpose: command.purpose, revocation: command.revocation,
  schemaVersion: command.schemaVersion, scopeDigest: command.scopeDigest, tenantId: command.tenantId,
});

export const sameAuthorizationOwner = (record: AuthorizationRecord, selector: AuthorizationOwnerSelector): boolean =>
  record.authorizationRequestId === selector.authorizationRequestId && record.tenantId === selector.tenantId &&
  record.projectId === selector.projectId && record.provider === selector.provider && record.scopeDigest === selector.scopeDigest;
