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
        try {
          return resolveResultToContract(await resolve.execute(resolveCommandFromContract(input)));
        } catch {
          return Object.freeze({ evidence: Object.freeze({
            authorityDigest: JSON.stringify({ purpose: "acceptance", reason: "indeterminate", version: 1 }),
            bindingAuthorityDigest: "authority-observation:indeterminate",
            proofRef: "observation:indeterminate:purpose:acceptance",
            purpose: "acceptance" as const,
          }), kind: "unavailable" as const, reason: "indeterminate" as const });
        }
      },
    }),
    revalidate: Object.freeze({
      async execute(input: RevalidateContainedTurnProviderAccessInput) {
        try {
          return revalidateResultToContract(await revalidate.execute(revalidateCommandFromContract(input)));
        } catch {
          return Object.freeze({ evidence: Object.freeze({
            authorityDigest: JSON.stringify({ purpose: "dispatch", reason: "indeterminate", version: 1 }),
            bindingAuthorityDigest: "authority-observation:indeterminate",
            proofRef: "observation:indeterminate:purpose:dispatch",
            purpose: "dispatch" as const,
          }), kind: "rejected" as const, reason: "indeterminate" as const });
        }
      },
    }),
  });
};
