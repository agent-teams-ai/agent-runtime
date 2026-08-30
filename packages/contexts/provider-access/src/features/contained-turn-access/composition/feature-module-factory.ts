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
import {
  canonicalProviderAccessObservation,
  isNativePromise,
  isRuntimeProxy,
} from "../boundary/exact-provider-access-data.js";

interface ContainedTurnProviderAccessDependencies {
  readonly bindingRepository: ProviderAccessBindingRepository;
}

const indeterminateObservation = () => Object.freeze({ kind: "indeterminate" as const });

const exactOwnDataDescriptors = (
  name: string,
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, PropertyDescriptor>> => {
  if (value === null || typeof value !== "object" || isRuntimeProxy(value)) {
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
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${name} cannot contain accessors`);
    }
  }
  return descriptors as Readonly<Record<string, PropertyDescriptor>>;
};

const snapshotRepository = (
  dependencies: ContainedTurnProviderAccessDependencies,
): ProviderAccessBindingRepository => {
  const dependencyDescriptors = exactOwnDataDescriptors("dependencies", dependencies, ["bindingRepository"]);
  const repository = dependencyDescriptors.bindingRepository?.value;
  const repositoryDescriptors = exactOwnDataDescriptors("bindingRepository", repository, ["observeExact"]);
  const observeExact = repositoryDescriptors.observeExact?.value;
  if (typeof observeExact !== "function" || isRuntimeProxy(observeExact)) {
    throw new TypeError("bindingRepository.observeExact must be a stable method");
  }
  const detachedObserveExact = observeExact as (input: unknown) => unknown;
  return Object.freeze({
    async observeExact(input: Parameters<ProviderAccessBindingRepository["observeExact"]>[0]) {
      try {
        const output = detachedObserveExact(input);
        if (isRuntimeProxy(output)) { return indeterminateObservation(); }
        if (isNativePromise(output)) {
          return canonicalProviderAccessObservation(await output);
        }
        return canonicalProviderAccessObservation(output);
      } catch {
        return indeterminateObservation();
      }
    },
  });
};

export const createContainedTurnProviderAccessFeature = (
  dependencies: ContainedTurnProviderAccessDependencies,
): ContainedTurnProviderAccessFeatureApi => {
  const repository = snapshotRepository(dependencies);
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
