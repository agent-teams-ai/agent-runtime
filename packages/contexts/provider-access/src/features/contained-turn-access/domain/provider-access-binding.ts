import type {
  ContainedTurnProviderAccessBinding,
  ProviderAccessProvider,
} from "../contracts/contained-turn-provider-access.js";

export interface ProviderAccessBindingRecord extends ContainedTurnProviderAccessBinding {
  readonly status: "active" | "revoked";
}

const bounded = (name: string, value: string): string => {
  if (value.length === 0 || value.length > 4_096 || value.includes("\u0000")) {
    throw new TypeError(`${name} must contain 1..4096 safe characters`);
  }
  return value;
};

export const providerAccessBindingKey = (
  tenantId: string,
  projectId: string,
  provider: ProviderAccessProvider,
): string => `${bounded("tenantId", tenantId)}\u0001${bounded("projectId", projectId)}\u0001${provider}`;

export const snapshotProviderAccessBinding = (record: ProviderAccessBindingRecord): ProviderAccessBindingRecord => {
  if (!Number.isSafeInteger(record.credentialGeneration) || record.credentialGeneration < 1) {
    throw new TypeError("credentialGeneration must be a positive safe integer");
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new TypeError("revision must be a positive safe integer");
  }
  return Object.freeze({
    accessRef: bounded("accessRef", record.accessRef),
    adapterRevision: bounded("adapterRevision", record.adapterRevision),
    binaryRevision: bounded("binaryRevision", record.binaryRevision),
    capabilityManifestRevision: bounded("capabilityManifestRevision", record.capabilityManifestRevision),
    credentialBindingDigest: bounded("credentialBindingDigest", record.credentialBindingDigest),
    credentialBindingRef: bounded("credentialBindingRef", record.credentialBindingRef),
    credentialGeneration: record.credentialGeneration,
    projectId: bounded("projectId", record.projectId),
    provider: record.provider,
    providerAccountRef: bounded("providerAccountRef", record.providerAccountRef),
    providerRouteRef: bounded("providerRouteRef", record.providerRouteRef),
    revision: record.revision,
    status: record.status,
    tenantId: bounded("tenantId", record.tenantId),
  });
};

export const providerAccessView = (record: ProviderAccessBindingRecord): ContainedTurnProviderAccessBinding =>
  Object.freeze({
    accessRef: record.accessRef,
    adapterRevision: record.adapterRevision,
    binaryRevision: record.binaryRevision,
    capabilityManifestRevision: record.capabilityManifestRevision,
    credentialBindingDigest: record.credentialBindingDigest,
    credentialBindingRef: record.credentialBindingRef,
    credentialGeneration: record.credentialGeneration,
    projectId: record.projectId,
    provider: record.provider,
    providerAccountRef: record.providerAccountRef,
    providerRouteRef: record.providerRouteRef,
    revision: record.revision,
    tenantId: record.tenantId,
  });
