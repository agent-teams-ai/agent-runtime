import type { ContainedTurnDispatchConsumptionV1 } from "../contracts/dispatch-consumption-v1.js";
import { createDispatchConsumptionUseCases } from "../application/dispatch-consumption-v1.js";
import type { DispatchConsumptionDigest } from "../application/ports/outbound/dispatch-consumption-digest.js";
import type {
  DispatchConsumptionJournalEntry, DispatchConsumptionRepository, DispatchConsumptionTransaction,
} from "../application/ports/outbound/dispatch-consumption-repository.js";
import { createDispatchConsumptionAdapter } from "../adapters/inbound/dispatch-consumption-mapper.js";
import {
  canonicalDispatchJournalEntry, detachedDispatchData,
} from "../adapters/dispatch-consumption-data.js";
import { isNativePromise, isRuntimeProxy } from "../adapters/provider-access-data.js";
import {
  snapshotDispatchBindingHead, snapshotDispatchConsumedReceipt, snapshotDispatchSettlementOutcome,
  type DispatchConsumedReceipt, type DispatchSettlementOutcome,
} from "../domain/dispatch-consumption.js";
export interface DispatchConsumptionV1Dependencies {
  readonly digest: DispatchConsumptionDigest;
  readonly repository: DispatchConsumptionRepository;
}

type Callable = (...args: never[]) => unknown;
const intrinsicBind = Function.prototype.bind;
const intrinsicFunctionToString = Function.prototype.toString;
const nativeCallableSource = /\{\s*\[native code\]\s*\}\s*$/u;

const isCapturableMethod = (value: unknown): value is Callable => {
  if (typeof value !== "function" || isRuntimeProxy(value)) { return false; }
  let source: string;
  try { source = Reflect.apply(intrinsicFunctionToString, value, []); }
  catch { return false; }
  return !nativeCallableSource.test(source) && !source.trimStart().startsWith("class");
};

const capturedMethod = (name: string, value: Callable, receiver: object): Callable => {
  let bound: unknown;
  try { bound = Reflect.apply(intrinsicBind, value, [receiver]); }
  catch { throw new TypeError(`${name} must be a stable method`); }
  if (typeof bound !== "function" || isRuntimeProxy(bound)) {throw new TypeError(`${name} must produce a stable method`);}
  try { Object.freeze(bound); }
  catch { throw new TypeError(`${name} must produce a stable method`); }
  if (!Object.isFrozen(bound)) {throw new TypeError(`${name} must produce a frozen method`);}
  return bound as Callable;
};

const methodsFrom = (name: string, value: unknown, keys: readonly string[]): Readonly<Record<string, Callable>> => {
  if (value === null || typeof value !== "object" || isRuntimeProxy(value) || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain dependency record`);
  }
  let prototype: unknown;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw new TypeError(`${name} must be a stable dependency record`); }
  if (prototype !== Object.prototype && prototype !== null) {throw new TypeError(`${name} must be a plain dependency record`);}
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string") || Object.keys(descriptors).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {
    throw new TypeError(`${name} has an invalid dependency shape`);
  }
  const receiver = Object.freeze({});
  return Object.freeze(Object.fromEntries(keys.map(key => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !isCapturableMethod(descriptor.value)) {
      throw new TypeError(`${name}.${key} must be a stable method`);
    }
    return [key, capturedMethod(`${name}.${key}`, descriptor.value, receiver)];
  })));
};

const nativeResult = async (name: string, value: unknown): Promise<unknown> => {
  if (isRuntimeProxy(value) || !isNativePromise(value)) { throw new TypeError(`${name} must return a native promise`); }
  const result = await value;
  if (isRuntimeProxy(result)) { throw new TypeError(`${name} returned a proxy`); }
  return result;
};

const transactionFacade = (value: unknown): DispatchConsumptionTransaction => {
  const methods = methodsFrom("transaction", value, [
    "controlTime", "findBindingHead", "findConsumption", "findGrantRequest", "findSettlement",
    "findSettlementByConsumption", "isBindingConsumed", "markBindingConsumed", "saveGrantRequest", "saveSettlement",
  ]);
  const invoke = (key: string, ...args: unknown[]) => nativeResult(`transaction.${key}`, methods[key]?.(...args as never[]));
  const optionalProjection = async <T>(key: string, project: (found: unknown) => T): Promise<T | undefined> => {
    const found = await invoke(key);
    return found === undefined ? undefined : project(detachedDispatchData(`transaction.${key} result`, found));
  };
  const acknowledgement = async (key: string, writeValue: unknown): Promise<void> => {
    if (await invoke(key, writeValue) !== undefined) { throw new TypeError(`transaction.${key} acknowledgement is invalid`); }
  };
  return Object.freeze({
    async controlTime() { return await invoke("controlTime") as number; },
    async findBindingHead() { return optionalProjection("findBindingHead", snapshotDispatchBindingHead); },
    async findConsumption() { return optionalProjection("findConsumption", snapshotDispatchConsumedReceipt); },
    async findGrantRequest() { return optionalProjection("findGrantRequest", canonicalDispatchJournalEntry); },
    async findSettlement() { return optionalProjection("findSettlement", snapshotDispatchSettlementOutcome); },
    async findSettlementByConsumption() { return optionalProjection("findSettlementByConsumption", snapshotDispatchSettlementOutcome); },
    async isBindingConsumed() { return await invoke("isBindingConsumed") as boolean; },
    markBindingConsumed(receipt: DispatchConsumedReceipt) {
      return acknowledgement("markBindingConsumed", snapshotDispatchConsumedReceipt(detachedDispatchData("consumption write", receipt)));
    },
    saveGrantRequest(entry: DispatchConsumptionJournalEntry) {
      return acknowledgement("saveGrantRequest", canonicalDispatchJournalEntry(entry));
    },
    saveSettlement(outcome: DispatchSettlementOutcome) {
      return acknowledgement("saveSettlement", snapshotDispatchSettlementOutcome(detachedDispatchData("settlement write", outcome)));
    },
  });
};

const snapshotDependencies = (value: DispatchConsumptionV1Dependencies): DispatchConsumptionV1Dependencies => {
  if (value === null || typeof value !== "object" || isRuntimeProxy(value) || Array.isArray(value)) {
    throw new TypeError("dependencies must be a plain data record");
  }
  let prototype: unknown;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw new TypeError("dependencies must be stable data"); }
  if (prototype !== Object.prototype && prototype !== null) {throw new TypeError("dependencies must be a plain data record");}
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string") || Object.keys(descriptors).toSorted().join("\0") !== "digest\0repository") {
    throw new TypeError("dependencies have an invalid shape");
  }
  if (descriptors.digest === undefined || descriptors.repository === undefined
    || !("value" in descriptors.digest) || !("value" in descriptors.repository)) {
    throw new TypeError("dependencies cannot contain accessors");
  }
  const digestMethods = methodsFrom("digest", descriptors.digest.value, ["digest"]);
  const repositoryMethods = methodsFrom("repository", descriptors.repository.value, ["observeGrantRequest", "transact"]);
  const digest: DispatchConsumptionDigest = Object.freeze({
    async digest(payload: string) { return await nativeResult("digest.digest", digestMethods.digest?.(payload as never)) as string; },
  });
  const repository: DispatchConsumptionRepository = Object.freeze({
    async observeGrantRequest(input: Parameters<DispatchConsumptionRepository["observeGrantRequest"]>[0]) {
      const detachedInput = detachedDispatchData("repository observation selector", input);
      const found = await nativeResult("repository.observeGrantRequest", repositoryMethods.observeGrantRequest?.(detachedInput as never));
      return found === undefined ? undefined : canonicalDispatchJournalEntry(found);
    },
    async transact<T>(selector: Parameters<DispatchConsumptionRepository["transact"]>[0], work: (transaction: DispatchConsumptionTransaction) => Promise<T>) {
      type CallbackState = "open" | "active" | "succeeded" | "failed" | "closed";
      let callbackState: CallbackState = "open";
      let callbackCompleted = false;
      let callbackRejectedReplay = false;
      let callbackResult: T | undefined;
      const transactionAcknowledgement = Object.freeze({});
      const detachedSelector = detachedDispatchData("repository transaction selector", selector);
      const callback = (transaction: unknown): Promise<typeof transactionAcknowledgement> => {
        if (callbackState !== "open") {
          callbackRejectedReplay = true;
          throw new TypeError("repository transaction callback is closed");
        }
        callbackState = "active";
        let facade: DispatchConsumptionTransaction;
        try { facade = transactionFacade(transaction); }
        catch (error) { callbackState = "failed"; throw error; }
        return (async () => {
          try {
            callbackResult = await work(facade);
            callbackCompleted = true;
            callbackState = "succeeded";
            return transactionAcknowledgement;
          } catch (error) {
            callbackState = "failed";
            throw error;
          }
        })();
      };
      let returned: unknown;
      try {
        const raw = repositoryMethods.transact?.(detachedSelector as never, callback as never);
        returned = await nativeResult("repository.transact", raw);
      } finally {
        callbackState = "closed";
      }
      if (callbackRejectedReplay || !callbackCompleted || returned !== transactionAcknowledgement) {
        throw new TypeError("repository substituted the transaction result");
      }
      return callbackResult as T;
    },
  });
  return Object.freeze({
    digest,
    repository,
  });
};

export const createContainedTurnDispatchConsumptionV1 = (
  dependencies: DispatchConsumptionV1Dependencies,
): ContainedTurnDispatchConsumptionV1 => {
  const useCases = createDispatchConsumptionUseCases(snapshotDependencies(dependencies));
  return createDispatchConsumptionAdapter(useCases);
};
