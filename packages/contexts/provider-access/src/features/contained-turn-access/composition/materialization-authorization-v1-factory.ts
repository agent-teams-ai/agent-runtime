import type { CredentialMaterializationAuthorizationV1 } from "../contracts/materialization-authorization-v1.js";
import { createCredentialMaterializationAuthorizationV1 } from "../application/materialization-authorization-v1.js";
import type { MaterializationAuthorizationDigest } from "../application/ports/outbound/materialization-authorization-digest.js";
import type {
  MaterializationAuthorizationBinding, MaterializationAuthorizationRepository, MaterializationAuthorizationTransaction,
} from "../application/ports/outbound/materialization-authorization-repository.js";
import { createCredentialMaterializationAuthorizationAdapter } from "../adapters/inbound/materialization-authorization-mapper.js";
import { detachedDispatchData } from "../adapters/dispatch-consumption-data.js";
import { isNativePromise, isRuntimeProxy } from "../adapters/provider-access-data.js";
import { snapshotAuthorizationRecord, type AuthorizationRecord } from "../domain/materialization-authorization.js";

export interface MaterializationAuthorizationV1Dependencies {
  readonly digest: MaterializationAuthorizationDigest;
  readonly repository: MaterializationAuthorizationRepository;
}

type Callable = (...args: never[]) => unknown;
const intrinsicBind = Function.prototype.bind;
const intrinsicFunctionToString = Function.prototype.toString;
const nativeCallableSource = /\{\s*\[native code\]\s*\}\s*$/u;

const isCapturableMethod = (value: unknown): value is Callable => {
  if (typeof value !== "function" || isRuntimeProxy(value)) {return false;}
  let source: string;
  try {source = Reflect.apply(intrinsicFunctionToString, value, []);}
  catch {return false;}
  return !nativeCallableSource.test(source) && !source.trimStart().startsWith("class");
};
const capture = (name: string, value: Callable): Callable => {
  let bound: unknown;
  try {bound = Reflect.apply(intrinsicBind, value, [Object.freeze({})]);}
  catch {throw new TypeError(`${name} must be a stable method`);}
  if (typeof bound !== "function" || isRuntimeProxy(bound)) {throw new TypeError(`${name} must produce a stable method`);}
  try {Object.freeze(bound);} catch {throw new TypeError(`${name} must produce a stable method`);}
  if (!Object.isFrozen(bound)) {throw new TypeError(`${name} must produce a frozen method`);}
  return bound as Callable;
};
const methodsFrom = (name: string, value: unknown, keys: readonly string[]): Readonly<Record<string, Callable>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isRuntimeProxy(value)) {
    throw new TypeError(`${name} must be a plain dependency record`);
  }
  let prototype: unknown;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {prototype = Object.getPrototypeOf(value) as unknown; descriptors = Object.getOwnPropertyDescriptors(value);}
  catch {throw new TypeError(`${name} must be a stable dependency record`);}
  if (prototype !== Object.prototype && prototype !== null) {throw new TypeError(`${name} must be a plain dependency record`);}
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string") ||
      Object.keys(descriptors).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {
    throw new TypeError(`${name} has an invalid dependency shape`);
  }
  return Object.freeze(Object.fromEntries(keys.map(key => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !isCapturableMethod(descriptor.value)) {
      throw new TypeError(`${name}.${key} must be a stable method`);
    }
    return [key, capture(`${name}.${key}`, descriptor.value)];
  })));
};
const nativeResult = async (name: string, value: unknown): Promise<unknown> => {
  if (isRuntimeProxy(value) || !isNativePromise(value)) {throw new TypeError(`${name} must return a native promise`);}
  const result = await value;
  if (isRuntimeProxy(result)) {throw new TypeError(`${name} returned a proxy`);}
  return result;
};

const bindingSnapshot = (value: unknown): MaterializationAuthorizationBinding => {
  const data = detachedDispatchData("authorization binding", value) as MaterializationAuthorizationBinding;
  const record = snapshotAuthorizationRecord({
    ...data, authorizationRequestId: "boundary:validation", decision: "authorized", purpose:
      "contained-turn.credential-materialization-authorization/v1", rejectionReason: null, requestDigest: "pending",
    schemaVersion: 1,
  });
  const {
    authorizationRequestId: _authorizationRequestId, decision: _decision, purpose: _purpose,
    rejectionReason: _rejectionReason, requestDigest: _requestDigest, schemaVersion: _schemaVersion, ...binding
  } = record;
  return Object.freeze(binding);
};
const transactionFacade = (value: unknown, isOpen: () => boolean): MaterializationAuthorizationTransaction => {
  const methods = methodsFrom("transaction", value, ["findAuthorizationRequest", "findBinding", "saveAuthorization"]);
  const invoke = async (key: string, ...args: unknown[]) => {
    if (!isOpen()) {throw new TypeError("repository transaction is closed");}
    const result = await nativeResult(`transaction.${key}`, methods[key]?.(...args as never[]));
    if (!isOpen()) {throw new TypeError("repository transaction is closed");}
    return result;
  };
  return Object.freeze({
    async findAuthorizationRequest() {
      const found = await invoke("findAuthorizationRequest");
      return found === undefined ? undefined : snapshotAuthorizationRecord(detachedDispatchData("authorization record", found));
    },
    async findBinding() {
      const found = await invoke("findBinding");
      return found === undefined ? undefined : bindingSnapshot(found);
    },
    async saveAuthorization(record: AuthorizationRecord) {
      if (await invoke("saveAuthorization", snapshotAuthorizationRecord(detachedDispatchData("authorization write", record))) !== undefined) {
        throw new TypeError("transaction.saveAuthorization acknowledgement is invalid");
      }
    },
  });
};

const snapshotDependencies = (value: MaterializationAuthorizationV1Dependencies): MaterializationAuthorizationV1Dependencies => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isRuntimeProxy(value)) {
    throw new TypeError("dependencies must be a plain data record");
  }
  let prototype: unknown;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {prototype = Object.getPrototypeOf(value) as unknown; descriptors = Object.getOwnPropertyDescriptors(value);}
  catch {throw new TypeError("dependencies must be stable data");}
  if (prototype !== Object.prototype && prototype !== null) {throw new TypeError("dependencies must be a plain data record");}
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string") || Object.keys(descriptors).toSorted().join("\0") !== "digest\0repository") {
    throw new TypeError("dependencies have an invalid shape");
  }
  if (descriptors.digest === undefined || descriptors.repository === undefined ||
      !("value" in descriptors.digest) || !("value" in descriptors.repository)) {
    throw new TypeError("dependencies cannot contain accessors");
  }
  const digestMethods = methodsFrom("digest", descriptors.digest.value, ["digest"]);
  const repositoryMethods = methodsFrom("repository", descriptors.repository.value, ["observeAuthorizationRequest", "transact"]);
  const digest: MaterializationAuthorizationDigest = Object.freeze({
    async digest(payload: string) {return await nativeResult("digest.digest", digestMethods.digest?.(payload as never)) as string;},
  });
  const repository: MaterializationAuthorizationRepository = Object.freeze({
    async observeAuthorizationRequest(authorizationRequestId: string) {
      const found = await nativeResult("repository.observeAuthorizationRequest", repositoryMethods.observeAuthorizationRequest?.(authorizationRequestId as never));
      return found === undefined ? undefined : snapshotAuthorizationRecord(detachedDispatchData("authorization observation", found));
    },
    async transact<T>(selector: Parameters<MaterializationAuthorizationRepository["transact"]>[0], work: (transaction: MaterializationAuthorizationTransaction) => Promise<T>) {
      const detachedSelector = detachedDispatchData("authorization transaction selector", selector);
      let callbackUsed = false;
      let callbackOpen = true;
      let callbackRejectedReplay = false;
      let callbackCompleted = false;
      let callbackResult: T | undefined;
      const acknowledgement = Object.freeze({});
      const callback = async (rawTransaction: unknown): Promise<typeof acknowledgement> => {
        if (callbackUsed || !callbackOpen) {
          callbackRejectedReplay = true;
          throw new TypeError("repository transaction callback is closed");
        }
        callbackUsed = true;
        callbackResult = await work(transactionFacade(rawTransaction, () => callbackOpen));
        callbackCompleted = true;
        return acknowledgement;
      };
      let returned: unknown;
      try {
        returned = await nativeResult("repository.transact", repositoryMethods.transact?.(detachedSelector as never, callback as never));
      } finally {
        callbackOpen = false;
      }
      if (callbackRejectedReplay || !callbackCompleted || returned !== acknowledgement) {throw new TypeError("repository substituted the transaction result");}
      return callbackResult as T;
    },
  });
  return Object.freeze({digest, repository});
};

export const createContainedTurnCredentialMaterializationAuthorizationV1 = (
  dependencies: MaterializationAuthorizationV1Dependencies,
): CredentialMaterializationAuthorizationV1 =>
  createCredentialMaterializationAuthorizationAdapter(createCredentialMaterializationAuthorizationV1(snapshotDependencies(dependencies)));
