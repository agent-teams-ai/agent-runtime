import { createResolveContainedTurnProviderAccess } from "../application/resolve-contained-turn-provider-access.js";
import { createRevalidateContainedTurnProviderAccess } from "../application/revalidate-contained-turn-provider-access.js";
import type { ProviderAccessBindingRepository } from "../application/ports/outbound/provider-access-binding-repository.js";
import type {
  ContainedTurnProviderAccessFeatureApi,
  RevalidateContainedTurnProviderAccessInput,
  ResolveContainedTurnProviderAccessInput,
} from "../contracts/contained-turn-provider-access.js";
import {
  revalidateCommandFromContract,
  revalidateResultToContract,
  resolveCommandFromContract,
  resolveResultToContract,
} from "../contracts/contained-turn-provider-access-mapper.js";

interface ContainedTurnProviderAccessDependencies {
  readonly bindingRepository: ProviderAccessBindingRepository;
}

export const createContainedTurnProviderAccessFeature = (
  dependencies: ContainedTurnProviderAccessDependencies,
): ContainedTurnProviderAccessFeatureApi => {
  const repository = dependencies.bindingRepository;
  const resolve = createResolveContainedTurnProviderAccess(repository);
  const revalidate = createRevalidateContainedTurnProviderAccess(repository);
  return Object.freeze({
    resolve: Object.freeze({
      async execute(input: ResolveContainedTurnProviderAccessInput) {
        return resolveResultToContract(await resolve.execute(resolveCommandFromContract(input)));
      },
    }),
    revalidate: Object.freeze({
      async execute(input: RevalidateContainedTurnProviderAccessInput) {
        return revalidateResultToContract(await revalidate.execute(revalidateCommandFromContract(input)));
      },
    }),
  });
};
