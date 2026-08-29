export type ProviderAccessProviderValue = "claude" | "codex";

export interface ProviderAccessScopeValue {
  readonly projectId: string;
  readonly tenantId: string;
}

export interface ProviderAccessBindingRecord extends ProviderAccessScopeValue {
  readonly accessRef: string;
  readonly availability: "available" | "unavailable";
  readonly credentialBindingDigest: string;
  readonly credentialBindingRef: string;
  readonly credentialGeneration: number;
  readonly provider: ProviderAccessProviderValue;
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly revision: number;
  readonly revocation: "active" | "revoked";
}

const isRecord = (value: unknown): value is object => value !== null && typeof value === "object";

const hasWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) { return false; }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) { return false; }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const bounded = (name: string, value: unknown): string => {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a primitive string`);
  }
  if (value.length === 0 || value.length > 4_096 || value.includes("\u0000")) {
    throw new TypeError(`${name} must contain 1..4096 safe characters`);
  }
  if (!hasWellFormedUnicode(value)) {
    throw new TypeError(`${name} must contain well-formed Unicode`);
  }
  return value;
};

const positiveInteger = (name: string, value: unknown): number => {
  if (typeof value !== "number") {
    throw new TypeError(`${name} must be a primitive number`);
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
};

export const snapshotProviderAccessProvider = (provider: unknown): ProviderAccessProviderValue => {
  if (provider !== "claude" && provider !== "codex") {
    throw new TypeError("provider is not supported");
  }
  return provider;
};

export const snapshotProviderAccessScope = (scope: ProviderAccessScopeValue): ProviderAccessScopeValue => {
  if (!isRecord(scope)) { throw new TypeError("scope must be a record"); }
  return Object.freeze({
    projectId: bounded("projectId", scope.projectId),
    tenantId: bounded("tenantId", scope.tenantId),
  });
};

export const snapshotProviderAccessBinding = (
  record: ProviderAccessBindingRecord,
): ProviderAccessBindingRecord => {
  if (!isRecord(record)) { throw new TypeError("binding must be a record"); }
  const availability = record.availability;
  if (availability !== "available" && availability !== "unavailable") {
    throw new TypeError("availability is invalid");
  }
  const revocation = record.revocation;
  if (revocation !== "active" && revocation !== "revoked") {
    throw new TypeError("revocation is invalid");
  }
  const provider = snapshotProviderAccessProvider(record.provider);
  return Object.freeze({
    accessRef: bounded("accessRef", record.accessRef),
    availability,
    credentialBindingDigest: bounded("credentialBindingDigest", record.credentialBindingDigest),
    credentialBindingRef: bounded("credentialBindingRef", record.credentialBindingRef),
    credentialGeneration: positiveInteger("credentialGeneration", record.credentialGeneration),
    projectId: bounded("projectId", record.projectId),
    provider,
    providerAccountRef: bounded("providerAccountRef", record.providerAccountRef),
    providerRouteRef: bounded("providerRouteRef", record.providerRouteRef),
    revision: positiveInteger("revision", record.revision),
    revocation,
    tenantId: bounded("tenantId", record.tenantId),
  });
};
