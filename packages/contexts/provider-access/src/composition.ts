import { createStaticProviderAccessBindingRepository } from "./features/contained-turn-access/adapters/outbound/static-provider-access-binding-repository.js";
import { createContainedTurnProviderAccessFeature } from "./features/contained-turn-access/composition/feature-module-factory.js";
import type {
  ContainedTurnProviderAccessFeatureApi,
  ProviderAccessProvider,
  ProviderAccessScope,
} from "./index.js";

/** Non-secret authority seed for deterministic same-application composition and tests. */
export interface StaticAvailableProviderAccessAuthority {
  readonly accessRef: string;
  readonly availability?: "available" | "unavailable";
  /** Authority-issued opaque digest over non-secret owner facts. */
  readonly credentialBindingDigest: string;
  readonly credentialBindingRef: string;
  readonly credentialGeneration: number;
  readonly kind: "binding";
  readonly projectId: string;
  readonly provider: ProviderAccessProvider;
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly revision: number;
  readonly revocation?: "active" | "revoked";
  readonly tenantId: string;
}

/** Fail-closed static observation for one exact qualified lookup. */
export interface StaticIndeterminateProviderAccessAuthority {
  readonly kind: "indeterminate";
  readonly provider: ProviderAccessProvider;
  readonly scope: ProviderAccessScope;
}

export type StaticProviderAccessAuthority =
  | StaticAvailableProviderAccessAuthority
  | StaticIndeterminateProviderAccessAuthority;

/** Narrow deterministic composition entrypoint; persistence ports, records, and adapters remain private. */
export const createStaticContainedTurnProviderAccessFeature = (
  authorities: readonly StaticProviderAccessAuthority[],
): ContainedTurnProviderAccessFeatureApi => createContainedTurnProviderAccessFeature({
  bindingRepository: createStaticProviderAccessBindingRepository(authorities),
});
