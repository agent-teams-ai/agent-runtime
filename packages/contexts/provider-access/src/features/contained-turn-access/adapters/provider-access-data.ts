import {
  snapshotProviderAccessBinding,
  snapshotProviderAccessProvider,
  snapshotProviderAccessScope,
  type ProviderAccessBindingRecord,
  type ProviderAccessScopeValue,
} from "../domain/provider-access-binding.js";
import type { ProviderAccessBindingObservation } from "../application/ports/outbound/provider-access-binding-repository.js";

interface RuntimeTypes {
  readonly isPromise: (value: unknown) => boolean;
  readonly isProxy: (value: unknown) => boolean;
}

// Runtime-specific, non-trapping classification stays at this outer boundary.
const runtimeTypes = (process.getBuiltinModule("node:util") as { readonly types: RuntimeTypes }).types;

const preflight = (name: string, value: unknown, seen: Set<object>, depth: number): void => {
  if (value === null || typeof value !== "object") { return; }
  if (runtimeTypes.isProxy(value)) { throw new TypeError(`${name} cannot contain a proxy`); }
  if (Array.isArray(value) || depth > 4 || seen.size > 32 || seen.has(value)) {
    throw new TypeError(`${name} contains an invalid aggregate`);
  }
  seen.add(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(descriptors).length > 32) {
    throw new TypeError(`${name} must contain plain bounded data`);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${name} cannot contain accessors or symbol fields`);
    }
    preflight(name, descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
};

/** Node boundary validation. Proxy detection happens before any reflective operation. */
export const exactProviderAccessDataRecord = (
  name: string,
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || runtimeTypes.isProxy(value) || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain data record`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
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
    preflight(name, descriptor.value, new Set(), 0);
  }
  return Object.freeze(Object.fromEntries(keys.map(key => [key, descriptors[key]?.value])));
};

export const isRuntimeProxy = (value: unknown): boolean =>
  value !== null && (typeof value === "object" || typeof value === "function") && runtimeTypes.isProxy(value);

export const isNativePromise = (value: unknown): value is Promise<unknown> => runtimeTypes.isPromise(value);

const BINDING_KEYS = [
  "accessRef", "availability", "credentialBindingDigest", "credentialBindingRef", "credentialGeneration",
  "projectId", "provider", "providerAccountRef", "providerRouteRef", "revision", "revocation", "tenantId",
] as const;

const stringField = (name: string, value: unknown): string => {
  if (typeof value !== "string") {throw new TypeError(`${name} must be a primitive string`);}
  return value;
};
const numberField = (name: string, value: unknown): number => {
  if (typeof value !== "number") {throw new TypeError(`${name} must be a primitive number`);}
  return value;
};

export const canonicalProviderAccessScope = (value: unknown): ProviderAccessScopeValue => {
  const data = exactProviderAccessDataRecord("scope", value, ["projectId", "tenantId"]);
  return snapshotProviderAccessScope({
    projectId: stringField("projectId", data.projectId),
    tenantId: stringField("tenantId", data.tenantId),
  });
};

export const canonicalProviderAccessBinding = (value: unknown): ProviderAccessBindingRecord => {
  const data = exactProviderAccessDataRecord("binding", value, BINDING_KEYS);
  const availability = data.availability;
  if (availability !== "available" && availability !== "unavailable") {throw new TypeError("availability is invalid");}
  const revocation = data.revocation;
  if (revocation !== "active" && revocation !== "revoked") {throw new TypeError("revocation is invalid");}
  return snapshotProviderAccessBinding({
    accessRef: stringField("accessRef", data.accessRef), availability,
    credentialBindingDigest: stringField("credentialBindingDigest", data.credentialBindingDigest),
    credentialBindingRef: stringField("credentialBindingRef", data.credentialBindingRef),
    credentialGeneration: numberField("credentialGeneration", data.credentialGeneration),
    projectId: stringField("projectId", data.projectId),
    provider: snapshotProviderAccessProvider(data.provider),
    providerAccountRef: stringField("providerAccountRef", data.providerAccountRef),
    providerRouteRef: stringField("providerRouteRef", data.providerRouteRef),
    revision: numberField("revision", data.revision), revocation,
    tenantId: stringField("tenantId", data.tenantId),
  });
};

export const canonicalProviderAccessObservation = (value: unknown): ProviderAccessBindingObservation => {
  const kindRecord = exactProviderAccessDataRecord(
    "binding observation",
    value,
    (() => {
      if (value === null || typeof value !== "object" || isRuntimeProxy(value)) { return ["kind"]; }
      const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
      return descriptor !== undefined && "value" in descriptor && descriptor.value === "found"
        ? ["kind", "record"] : ["kind"];
    })(),
  );
  if (kindRecord.kind === "not_found" || kindRecord.kind === "indeterminate") {
    return Object.freeze({ kind: kindRecord.kind });
  }
  if (kindRecord.kind !== "found") { throw new TypeError("binding observation kind is invalid"); }
  return Object.freeze({ kind: "found", record: canonicalProviderAccessBinding(kindRecord.record) });
};

/** Capture native methods for explicit-receiver calls without binding a producer object. */
export const intrinsicMethod = <T extends object, K extends keyof T>(owner: T, key: K): T[K] => {
  const value: unknown = Reflect.get(owner, key);
  if (typeof value !== "function") {throw new TypeError("Native method is unavailable");}
  return value as T[K];
};

/** Intrinsic accessors operate only on the receiver supplied to Reflect.apply. */
export const intrinsicGetter = (owner: object, key: PropertyKey): ((this: unknown) => unknown) | undefined => {
  const descriptor: { readonly get?: (this: unknown) => unknown } | undefined = Object.getOwnPropertyDescriptor(owner, key);
  return descriptor?.get;
};
