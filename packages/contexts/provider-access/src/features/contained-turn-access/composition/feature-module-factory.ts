import { createResolveContainedTurnProviderAccess } from "../application/resolve-contained-turn-provider-access.js";
import type { ProviderAccessBindingRepository } from "../application/ports/outbound/provider-access-binding-repository.js";
import type { ContainedTurnProviderAccessFeatureApi } from "../contracts/contained-turn-provider-access.js";

export interface ContainedTurnProviderAccessDependencies {
  readonly bindingRepository: ProviderAccessBindingRepository;
}

export const createContainedTurnProviderAccessFeature = (
  dependencies: ContainedTurnProviderAccessDependencies,
): ContainedTurnProviderAccessFeatureApi => {
  const snapshot = Object.freeze({ ...dependencies });
  return Object.freeze({ resolve: createResolveContainedTurnProviderAccess(snapshot.bindingRepository) });
};
