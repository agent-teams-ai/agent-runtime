import type {
  ContainedTurnDispatchConsumptionV1, ConsumeForDispatchInput, ConsumeForDispatchOutcome,
  ObserveDispatchConsumptionInput, SettleDispatchConsumptionInput, SettleDispatchConsumptionOutcome,
} from "../contracts/dispatch-consumption-v1.js";
import { createDispatchConsumptionUseCases } from "../application/dispatch-consumption-v1.js";
import type { DispatchConsumptionDigest } from "../application/ports/outbound/dispatch-consumption-digest.js";
import type { DispatchConsumptionRepository } from "../application/ports/outbound/dispatch-consumption-repository.js";
import {
  consumeCommandFromContract, observeInputFromContract, settlementInputFromContract,
} from "../contracts/dispatch-consumption-input.js";
import { isDispatchProxy } from "../domain/dispatch-consumption.js";

export interface DispatchConsumptionV1Dependencies {
  readonly digest: DispatchConsumptionDigest;
  readonly repository: DispatchConsumptionRepository;
}

const methodsFrom = (name: string, value: unknown, keys: readonly string[]): Record<string, (...args: never[]) => unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isDispatchProxy(value)) {
    throw new TypeError(`${name} must be a plain dependency record`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {throw new TypeError(`${name} must be a plain dependency record`);}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string") || Object.keys(descriptors).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {
    throw new TypeError(`${name} has an invalid dependency shape`);
  }
  return Object.fromEntries(keys.map(key => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") {
      throw new TypeError(`${name}.${key} must be a stable method`);
    }
    return [key, descriptor.value.bind(value) as (...args: never[]) => unknown];
  }));
};

const snapshotDependencies = (value: DispatchConsumptionV1Dependencies): DispatchConsumptionV1Dependencies => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isDispatchProxy(value)) {
    throw new TypeError("dependencies must be a plain data record");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {throw new TypeError("dependencies must be a plain data record");}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string") || Object.keys(descriptors).toSorted().join("\0") !== "digest\0repository") {
    throw new TypeError("dependencies have an invalid shape");
  }
  if (!("value" in descriptors.digest) || !("value" in descriptors.repository)) {throw new TypeError("dependencies cannot contain accessors");}
  const digest = methodsFrom("digest", descriptors.digest.value, ["digest"]);
  const repository = methodsFrom("repository", descriptors.repository.value, ["observeGrantRequest", "transact"]);
  return Object.freeze({
    digest: Object.freeze({ digest: digest.digest }) as DispatchConsumptionDigest,
    repository: Object.freeze(repository) as unknown as DispatchConsumptionRepository,
  });
};

export const createContainedTurnDispatchConsumptionV1 = (
  dependencies: DispatchConsumptionV1Dependencies,
): ContainedTurnDispatchConsumptionV1 => {
  const useCases = createDispatchConsumptionUseCases(snapshotDependencies(dependencies));
  return Object.freeze({
    async consumeForDispatch(input: ConsumeForDispatchInput): Promise<ConsumeForDispatchOutcome> {
      let command;
      try { command = consumeCommandFromContract(input); }
      catch { return Object.freeze({ kind: "invalid" as const, reason: "invalid_request" as const }); }
      try { return await useCases.consume(command); }
      catch { return Object.freeze({ kind: "indeterminate" }); }
    },
    async observeDispatchConsumption(input: ObserveDispatchConsumptionInput) {
      let snapshot;
      try { snapshot = observeInputFromContract(input); }
      catch { return Object.freeze({ kind: "invalid" as const, reason: "invalid_request" as const }); }
      try { return await useCases.observe(snapshot); }
      catch { return Object.freeze({ kind: "indeterminate" as const }); }
    },
    async settleDispatchConsumption(input: SettleDispatchConsumptionInput): Promise<SettleDispatchConsumptionOutcome> {
      let snapshot;
      try { snapshot = settlementInputFromContract(input); }
      catch { return Object.freeze({ kind: "invalid" as const, reason: "invalid_request" as const }); }
      try { return await useCases.settle(snapshot); }
      catch { return Object.freeze({ kind: "indeterminate" }); }
    },
  });
};
