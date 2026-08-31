import { createResolveContainedTurnProviderAccess } from "../application/resolve-contained-turn-provider-access.js";
import { createRevalidateContainedTurnProviderAccess } from "../application/revalidate-contained-turn-provider-access.js";
import type { ProviderAccessBindingRepository } from "../application/ports/outbound/provider-access-binding-repository.js";
import type { ContainedTurnProviderAccessFeatureApi } from "../contracts/contained-turn-provider-access.js";
import { createContainedTurnProviderAccessAdapter } from "../adapters/inbound/contained-turn-provider-access-mapper.js";
import {
  canonicalProviderAccessObservation,
  isNativePromise,
  isRuntimeProxy,
} from "../adapters/provider-access-data.js";

interface ContainedTurnProviderAccessDependencies {
  readonly bindingRepository: ProviderAccessBindingRepository;
}

const indeterminateObservation = () => Object.freeze({ kind: "indeterminate" as const });

type Callable = (...args: never[]) => unknown;
const intrinsicFunctionToString = Function.prototype.toString;
const nativeCallableSource = /\{\s*\[native code\]\s*\}\s*$/u;

const isCapturableMethod = (value: unknown): value is Callable => {
  if (typeof value !== "function" || isRuntimeProxy(value)) { return false; }
  let source: string;
  try { source = Reflect.apply(intrinsicFunctionToString, value, []); }
  catch { return false; }
  return !nativeCallableSource.test(source) && !source.trimStart().startsWith("class");
};

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
  if (!isCapturableMethod(observeExact)) {
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
  return createContainedTurnProviderAccessAdapter({ resolve, revalidate });
};
