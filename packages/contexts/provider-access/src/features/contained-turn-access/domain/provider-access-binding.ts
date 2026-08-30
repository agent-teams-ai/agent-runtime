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

const preflightProviderAccessData = (name: string, value: unknown, seen: Set<object>, depth: number): void => {
  if (value === null || typeof value !== "object") { return; }
  if (Array.isArray(value) || depth > 4 || seen.size > 32 || seen.has(value)) {
    throw new TypeError(`${name} contains an invalid aggregate`);
  }
  seen.add(value);
  let prototype: unknown;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw new TypeError(`${name} must be stable data`); }
  if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(descriptors).length > 32) {
    throw new TypeError(`${name} must contain plain bounded data`);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${name} cannot contain accessors or symbol fields`);
    }
    preflightProviderAccessData(name, descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
};

export const exactProviderAccessDataRecord = (
  name: string,
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain data record`);
  }
  let prototype: unknown;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError(`${name} must be stable data`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data record`);
  }
  if (
    Reflect.ownKeys(descriptors).some(key => typeof key !== "string")
    || Object.keys(descriptors).toSorted().join("\0") !== [...keys].toSorted().join("\0")
  ) {
    throw new TypeError(`${name} has an invalid shape`);
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) { throw new TypeError(`${name} cannot contain accessors`); }
  }
  preflightProviderAccessData(name, value, new Set(), 0);
  try { structuredClone(value); } catch { throw new TypeError(`${name} must be cloneable plain data`); }
  return Object.fromEntries(keys.map(key => [key, descriptors[key]?.value]));
};

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
  const data = exactProviderAccessDataRecord("scope", scope, ["projectId", "tenantId"]);
  return Object.freeze({
    projectId: bounded("projectId", data.projectId),
    tenantId: bounded("tenantId", data.tenantId),
  });
};

export const snapshotProviderAccessBinding = (
  record: ProviderAccessBindingRecord,
): ProviderAccessBindingRecord => {
  const data = exactProviderAccessDataRecord("binding", record, [
    "accessRef", "availability", "credentialBindingDigest", "credentialBindingRef", "credentialGeneration",
    "projectId", "provider", "providerAccountRef", "providerRouteRef", "revision", "revocation", "tenantId",
  ]);
  const availability = data.availability;
  if (availability !== "available" && availability !== "unavailable") {
    throw new TypeError("availability is invalid");
  }
  const revocation = data.revocation;
  if (revocation !== "active" && revocation !== "revoked") {
    throw new TypeError("revocation is invalid");
  }
  const provider = snapshotProviderAccessProvider(data.provider);
  return Object.freeze({
    accessRef: bounded("accessRef", data.accessRef),
    availability,
    credentialBindingDigest: bounded("credentialBindingDigest", data.credentialBindingDigest),
    credentialBindingRef: bounded("credentialBindingRef", data.credentialBindingRef),
    credentialGeneration: positiveInteger("credentialGeneration", data.credentialGeneration),
    projectId: bounded("projectId", data.projectId),
    provider,
    providerAccountRef: bounded("providerAccountRef", data.providerAccountRef),
    providerRouteRef: bounded("providerRouteRef", data.providerRouteRef),
    revision: positiveInteger("revision", data.revision),
    revocation,
    tenantId: bounded("tenantId", data.tenantId),
  });
};
