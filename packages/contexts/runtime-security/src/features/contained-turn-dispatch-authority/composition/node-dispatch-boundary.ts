import { isNodeDispatchProxy } from "../adapters/node-dispatch-proxy.js";

import type { DispatchAuthorityOperations } from
  "../application/dispatch-authority-dependencies.js";
import type { DispatchControlClock } from
  "../application/ports/outbound/control-clock.js";
import type { DispatchConsumptionRepository } from
  "../application/ports/outbound/dispatch-consumption-repository.js";
import type { DispatchDigest } from
  "../application/ports/outbound/dispatch-digest.js";

const invalidBoundary = (): never => {
  throw new TypeError("invalid dispatch authority boundary value");
};

/** Node-owned proxy rejection and bounded detachment before application reflection. */
export const detachDispatchBoundaryValue = (
  value: unknown,
  depth = 0,
): unknown => {
  if (isNodeDispatchProxy(value)) {return invalidBoundary();}
  if (value === null || typeof value === "boolean") {return value;}
  if (typeof value === "string") {
    return value.length <= 4096 ? value : invalidBoundary();
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : invalidBoundary();
  }
  if (typeof value !== "object" || depth >= 8) {return invalidBoundary();}
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {return invalidBoundary();}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > 32 || keys.some(key => typeof key !== "string")) {return invalidBoundary();}
  const detached: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {return invalidBoundary();}
    detached[key] = detachDispatchBoundaryValue(descriptor.value, depth + 1);
  }
  return Object.freeze(detached);
};

const exactOwnerMethods = <Name extends string>(
  owner: unknown,
  names: readonly Name[],
): Readonly<Record<Name, (...args: never[]) => unknown>> => {
  if (isNodeDispatchProxy(owner) || typeof owner !== "object" || owner === null) {
    return invalidBoundary();
  }
  const prototype = Object.getPrototypeOf(owner);
  if (prototype !== Object.prototype && prototype !== null) {return invalidBoundary();}
  const descriptors = Object.getOwnPropertyDescriptors(owner);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== "string") ||
      names.some(name => !keys.includes(name))) {return invalidBoundary();}
  const methods = Object.create(null) as Record<Name, (...args: never[]) => unknown>;
  for (const name of names) {
    const descriptor = descriptors[name];
    if (descriptor === undefined || !("value" in descriptor) ||
        isNodeDispatchProxy(descriptor.value) || typeof descriptor.value !== "function") {
      return invalidBoundary();
    }
    methods[name] = descriptor.value as (...args: never[]) => unknown;
  }
  return Object.freeze(methods);
};

const ownerPromise = async (value: unknown): Promise<unknown> => {
  if (isNodeDispatchProxy(value) || !(value instanceof Promise)) {return invalidBoundary();}
  return value;
};

export const createNodeDispatchAuthorityOperations = (
  dependencies: {
    readonly repository: DispatchConsumptionRepository;
    readonly clock: DispatchControlClock;
    readonly digest: DispatchDigest;
  },
): DispatchAuthorityOperations => {
  if (isNodeDispatchProxy(dependencies) || typeof dependencies !== "object" ||
      dependencies === null) {
    return invalidBoundary();
  }
  const prototype = Object.getPrototypeOf(dependencies);
  if (prototype !== Object.prototype && prototype !== null) {return invalidBoundary();}
  const dependencyDescriptors = Object.getOwnPropertyDescriptors(dependencies);
  const dependencyKeys = Reflect.ownKeys(dependencyDescriptors);
  if (dependencyKeys.length !== 3 ||
      !["repository", "clock", "digest"].every(name => dependencyKeys.includes(name)) ||
      ["repository", "clock", "digest"].some(name =>
        !("value" in (dependencyDescriptors[name] ?? {})))) {return invalidBoundary();}
  const repositoryOwner = dependencyDescriptors.repository?.value as DispatchConsumptionRepository;
  const clockOwner = dependencyDescriptors.clock?.value as DispatchControlClock;
  const digestOwner = dependencyDescriptors.digest?.value as DispatchDigest;
  const repository = exactOwnerMethods(repositoryOwner,
    ["consumeAtomically", "observe", "settleAtomically"]);
  const clock = exactOwnerMethods(clockOwner, ["now"]);
  const digest = exactOwnerMethods(digestOwner, ["digestCanonical"]);
  return Object.freeze({
    consumeAtomically: (async (key, decide) => {
      const detachedKey = detachDispatchBoundaryValue(key) as typeof key;
      const pending = Reflect.apply(repository.consumeAtomically, repository, [detachedKey,
        (snapshot: unknown) => detachDispatchBoundaryValue(
          decide(detachDispatchBoundaryValue(snapshot) as never),
        )]);
      return detachDispatchBoundaryValue(await ownerPromise(pending)) as never;
    }) as DispatchConsumptionRepository["consumeAtomically"],
    observe: (async key => {
      const pending = Reflect.apply(repository.observe, repository,
        [detachDispatchBoundaryValue(key)]);
      const result = await ownerPromise(pending);
      return result === undefined ? undefined : detachDispatchBoundaryValue(result) as never;
    }) as DispatchConsumptionRepository["observe"],
    settleAtomically: (async (key, decide) => {
      const detachedKey = detachDispatchBoundaryValue(key) as typeof key;
      const pending = Reflect.apply(repository.settleAtomically, repository, [detachedKey,
        (snapshot: unknown) => detachDispatchBoundaryValue(
          decide(detachDispatchBoundaryValue(snapshot) as never),
        )]);
      return detachDispatchBoundaryValue(await ownerPromise(pending)) as never;
    }) as DispatchConsumptionRepository["settleAtomically"],
    now: (() => Reflect.apply(clock.now, clock, [])) as DispatchControlClock["now"],
    digestCanonical: ((value: string) => Reflect.apply(digest.digestCanonical, digest, [value])) as
      DispatchDigest["digestCanonical"],
  });
};
