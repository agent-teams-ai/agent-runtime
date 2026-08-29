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

const bounded = (name: string, value: string): string => {
  if (value.length === 0 || value.length > 4_096 || value.includes("\u0000")) {
    throw new TypeError(`${name} must contain 1..4096 safe characters`);
  }
  return value;
};

const positiveInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
};

export const snapshotProviderAccessScope = (scope: ProviderAccessScopeValue): ProviderAccessScopeValue =>
  Object.freeze({
    projectId: bounded("projectId", scope.projectId),
    tenantId: bounded("tenantId", scope.tenantId),
  });

export const snapshotProviderAccessBinding = (
  record: ProviderAccessBindingRecord,
): ProviderAccessBindingRecord => {
  if (record.availability !== "available" && record.availability !== "unavailable") {
    throw new TypeError("availability is invalid");
  }
  if (record.revocation !== "active" && record.revocation !== "revoked") {
    throw new TypeError("revocation is invalid");
  }
  if (record.provider !== "claude" && record.provider !== "codex") {
    throw new TypeError("provider is not supported");
  }
  return Object.freeze({
    accessRef: bounded("accessRef", record.accessRef),
    availability: record.availability,
    credentialBindingDigest: bounded("credentialBindingDigest", record.credentialBindingDigest),
    credentialBindingRef: bounded("credentialBindingRef", record.credentialBindingRef),
    credentialGeneration: positiveInteger("credentialGeneration", record.credentialGeneration),
    projectId: bounded("projectId", record.projectId),
    provider: record.provider,
    providerAccountRef: bounded("providerAccountRef", record.providerAccountRef),
    providerRouteRef: bounded("providerRouteRef", record.providerRouteRef),
    revision: positiveInteger("revision", record.revision),
    revocation: record.revocation,
    tenantId: bounded("tenantId", record.tenantId),
  });
};

export interface ProviderAccessOwnerFacts {
  readonly accessRef: string;
  readonly credentialBindingRef: string;
  readonly credentialGeneration: number;
  readonly projectId: string;
  readonly provider: ProviderAccessProviderValue;
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly revision: number;
  readonly tenantId: string;
}

/** Stable, length-delimited canonical bytes; all fields are non-secret owner facts. */
export const canonicalProviderAccessOwnerFacts = (facts: ProviderAccessOwnerFacts): string => {
  const values: readonly (readonly [string, string])[] = [
    ["accessRef", bounded("accessRef", facts.accessRef)],
    ["credentialBindingRef", bounded("credentialBindingRef", facts.credentialBindingRef)],
    ["credentialGeneration", String(positiveInteger("credentialGeneration", facts.credentialGeneration))],
    ["projectId", bounded("projectId", facts.projectId)],
    ["provider", facts.provider],
    ["providerAccountRef", bounded("providerAccountRef", facts.providerAccountRef)],
    ["providerRouteRef", bounded("providerRouteRef", facts.providerRouteRef)],
    ["revision", String(positiveInteger("revision", facts.revision))],
    ["tenantId", bounded("tenantId", facts.tenantId)],
  ];
  if (facts.provider !== "claude" && facts.provider !== "codex") {
    throw new TypeError("provider is not supported");
  }
  return `provider-access-owner-facts-v1\n${values.map(([name, value]) => `${name}:${value.length}:${value}`).join("\n")}`;
};
