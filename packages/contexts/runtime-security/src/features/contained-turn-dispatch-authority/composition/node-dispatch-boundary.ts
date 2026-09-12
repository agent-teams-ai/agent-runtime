import { types as nodeUtilTypes } from "node:util";
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

import { detachDispatchBoundaryValue } from "../adapters/dispatch-boundary-value.js";
export { detachDispatchBoundaryValue } from "../adapters/dispatch-boundary-value.js";

export const exactOwnerMethods = <Name extends string>(
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

const nativePromisePrototype = Promise.prototype;
const nativePromiseThen = Promise.prototype.then;
const nativePromiseConstructor = Promise;

// Only ordinary local-realm native promises are supported. Subclasses and
// cross-realm promises require adoption hooks and are deliberately rejected.
// Inspect descriptors only, before await can read constructor or then. Keep this
// synchronous: an async return would introduce another then-assimilation step.
export const ownerPromise = <T>(value: T | Promise<T>): Promise<T> => {
  if (isNodeDispatchProxy(value) || !nodeUtilTypes.isPromise(value) ||
      Object.getPrototypeOf(value) !== nativePromisePrototype ||
      Object.getOwnPropertyDescriptor(value, "then") !== undefined ||
      Object.getOwnPropertyDescriptor(value, "constructor") !== undefined ||
      Object.getPrototypeOf(nativePromisePrototype) !== Object.prototype ||
      Object.getPrototypeOf(Object.prototype) !== null) {return invalidBoundary();}
  const then = Object.getOwnPropertyDescriptor(nativePromisePrototype, "then");
  const constructor = Object.getOwnPropertyDescriptor(nativePromisePrototype, "constructor");
  if (then === undefined || !("value" in then) || then.value !== nativePromiseThen ||
      constructor === undefined || !("value" in constructor) ||
      constructor.value !== nativePromiseConstructor) {return invalidBoundary();}
  return value as Promise<T>;
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
