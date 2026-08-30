import type {
  ProviderAccessBindingObservation,
  ProviderAccessBindingRepository,
} from "../../application/ports/outbound/provider-access-binding-repository.js";
import {
  snapshotProviderAccessBinding,
  snapshotProviderAccessProvider,
  snapshotProviderAccessScope,
  type ProviderAccessProviderValue,
  type ProviderAccessScopeValue,
} from "../../domain/provider-access-binding.js";
import {
  canonicalProviderAccessBinding,
  canonicalProviderAccessScope,
  exactProviderAccessDataRecord,
  isRuntimeProxy,
} from "../../boundary/exact-provider-access-data.js";

interface StaticAvailableProviderAccessAuthority {
  readonly accessRef: string;
  readonly availability?: "available" | "unavailable";
  readonly credentialBindingDigest: string;
  readonly credentialBindingRef: string;
  readonly credentialGeneration: number;
  readonly kind: "binding";
  readonly projectId: string;
  readonly provider: ProviderAccessProviderValue;
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly revision: number;
  readonly revocation?: "active" | "revoked";
  readonly tenantId: string;
}

interface StaticIndeterminateProviderAccessAuthority {
  readonly kind: "indeterminate";
  readonly provider: ProviderAccessProviderValue;
  readonly scope: ProviderAccessScopeValue;
}

type StaticProviderAccessAuthority =
  | StaticAvailableProviderAccessAuthority
  | StaticIndeterminateProviderAccessAuthority;

export const createStaticProviderAccessBindingRepository = (
  authorities: readonly StaticProviderAccessAuthority[],
): ProviderAccessBindingRepository => {
  if (!Array.isArray(authorities) || isRuntimeProxy(authorities)) {
    throw new TypeError("authorities must be a stable array");
  }
  const authorityDescriptors = Object.getOwnPropertyDescriptors(authorities) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const length = authorityDescriptors.length;
  if (length === undefined || !("value" in length) || typeof length.value !== "number") {
    throw new TypeError("authorities must be a stable array");
  }
  const snapshots = Array.from({ length: length.value }, (_, index) => {
    const descriptor = authorityDescriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("authorities cannot contain holes or accessors");
    }
    const authority = descriptor.value;
    if (authority === null || typeof authority !== "object" || isRuntimeProxy(authority)) {
      throw new TypeError("authority must be a plain data record");
    }
    const data = exactProviderAccessDataRecord("authority", authority, Object.keys(authority));
    const kind = data.kind;
    const required = kind === "binding"
      ? ["accessRef", "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "kind", "projectId",
        "provider", "providerAccountRef", "providerRouteRef", "revision", "tenantId"]
      : ["kind", "provider", "scope"];
    const optional = kind === "binding" ? ["availability", "revocation"] : [];
    if (Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))
      || required.some(key => !(key in data))) {
      throw new TypeError("authority has an invalid shape");
    }
    return data;
  });
  const observations = new Map<
    ProviderAccessProviderValue,
    Map<string, Map<string, ProviderAccessBindingObservation>>
  >();
  for (const authority of snapshots) {
    const kind = authority.kind;
    if (kind !== "binding" && kind !== "indeterminate") {
      throw new TypeError("authority kind is invalid");
    }
    const provider = snapshotProviderAccessProvider(authority.provider);
    const scope = kind === "binding"
      ? canonicalProviderAccessScope({ projectId: authority.projectId, tenantId: authority.tenantId })
      : canonicalProviderAccessScope(authority.scope);
    const providerObservations = observations.get(provider) ?? new Map();
    const tenantObservations = providerObservations.get(scope.tenantId) ?? new Map();
    if (tenantObservations.has(scope.projectId)) {
      throw new Error("duplicate exact-scope Provider Access authority");
    }
    observations.set(provider, providerObservations);
    providerObservations.set(scope.tenantId, tenantObservations);
    if (kind === "indeterminate") {
      tenantObservations.set(scope.projectId, Object.freeze({ kind: "indeterminate" }));
      continue;
    }
    const record = canonicalProviderAccessBinding({
      availability: authority.availability ?? "available",
      accessRef: authority.accessRef,
      credentialBindingDigest: authority.credentialBindingDigest,
      credentialBindingRef: authority.credentialBindingRef,
      credentialGeneration: authority.credentialGeneration,
      projectId: authority.projectId,
      provider,
      providerAccountRef: authority.providerAccountRef,
      providerRouteRef: authority.providerRouteRef,
      revision: authority.revision,
      revocation: authority.revocation ?? "active",
      tenantId: authority.tenantId,
    });
    tenantObservations.set(scope.projectId, Object.freeze({ kind: "found", record }));
  }

  return Object.freeze({
    async observeExact(input: {
      readonly provider: ProviderAccessProviderValue;
      readonly scope: ProviderAccessScopeValue;
    }): Promise<ProviderAccessBindingObservation> {
      const scope = snapshotProviderAccessScope(input.scope);
      const observation = observations
        .get(input.provider)
        ?.get(scope.tenantId)
        ?.get(scope.projectId);
      if (observation === undefined) {
        return Object.freeze({ kind: "not_found" });
      }
      if (observation.kind !== "found") {
        return Object.freeze({ kind: observation.kind });
      }
      // A repository read is always a fresh canonical snapshot, never stored or caller-owned data.
      return Object.freeze({ kind: "found", record: snapshotProviderAccessBinding(observation.record) });
    },
  });
};
