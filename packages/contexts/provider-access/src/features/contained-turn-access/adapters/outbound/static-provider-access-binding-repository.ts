import { createHash } from "node:crypto";

import type {
  ProviderAccessBindingObservation,
  ProviderAccessBindingRepository,
} from "../../application/ports/outbound/provider-access-binding-repository.js";
import {
  canonicalProviderAccessOwnerFacts,
  providerAccessBindingKey,
  snapshotProviderAccessBinding,
  snapshotProviderAccessScope,
  type ProviderAccessOwnerFacts,
  type ProviderAccessProviderValue,
  type ProviderAccessScopeValue,
} from "../../domain/provider-access-binding.js";

interface StaticAvailableProviderAccessAuthority {
  readonly accessRef: string;
  readonly availability?: "available" | "unavailable";
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

export const digestProviderAccessOwnerFacts = (facts: ProviderAccessOwnerFacts): string =>
  `sha256:${createHash("sha256").update(canonicalProviderAccessOwnerFacts(facts), "utf8").digest("hex")}`;

export const createStaticProviderAccessBindingRepository = (
  authorities: readonly StaticProviderAccessAuthority[],
): ProviderAccessBindingRepository => {
  const observations = new Map<string, ProviderAccessBindingObservation>();
  for (const authority of authorities) {
    const provider = authority.provider;
    const scope = authority.kind === "binding"
      ? { projectId: authority.projectId, tenantId: authority.tenantId }
      : snapshotProviderAccessScope(authority.scope);
    const key = providerAccessBindingKey(scope, provider);
    if (observations.has(key)) {
      throw new Error("duplicate exact-scope Provider Access authority");
    }
    if (authority.kind === "indeterminate") {
      observations.set(key, Object.freeze({ kind: "indeterminate" }));
      continue;
    }
    const record = snapshotProviderAccessBinding({
      ...authority,
      availability: authority.availability ?? "available",
      credentialBindingDigest: digestProviderAccessOwnerFacts(authority),
      revocation: authority.revocation ?? "active",
    });
    observations.set(key, Object.freeze({ kind: "found", record }));
  }

  return Object.freeze({
    async observeExact(input: {
      readonly provider: ProviderAccessProviderValue;
      readonly scope: ProviderAccessScopeValue;
    }): Promise<ProviderAccessBindingObservation> {
      const observation = observations.get(providerAccessBindingKey(input.scope, input.provider));
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
