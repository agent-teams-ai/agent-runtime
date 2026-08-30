import { isRuntimeProxy } from "./exact-provider-access-data.js";
import type { DispatchConsumptionJournalEntry } from "../application/ports/outbound/dispatch-consumption-repository.js";
import {
  snapshotDispatchConsumeOutcome, snapshotDispatchDigest, snapshotDispatchExpectation, snapshotDispatchId,
  snapshotDispatchScope,
} from "../domain/dispatch-consumption.js";

const detachedArray = (
  name: string, value: object, seen: Set<object>, depth: number,
  reflection: { readonly descriptors: Record<PropertyKey, PropertyDescriptor>; readonly prototype: unknown },
): readonly unknown[] => {
  const { descriptors, prototype } = reflection;
  const lengthDescriptor = descriptors.length;
  if (prototype !== Array.prototype || lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 128
    || Reflect.ownKeys(descriptors).length !== lengthDescriptor.value + 1) {
    throw new TypeError(`${name} must contain a bounded dense array`);
  }
  const detached: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${name} cannot contain sparse arrays or accessors`);
    }
    detached.push(detachedData(name, descriptor.value, seen, depth + 1));
  }
  seen.delete(value);
  return Object.freeze(detached);
};

const detachedData = (name: string, value: unknown, seen: Set<object>, depth: number): unknown => {
  if (isRuntimeProxy(value)) { throw new TypeError(`${name} cannot contain a proxy`); }
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    if (typeof value === "string" && value.length > 512) { throw new TypeError(`${name} contains oversized data`); }
    return value;
  }
  if (typeof value === "function" || depth > 8 || seen.size > 128 || seen.has(value)) {
    throw new TypeError(`${name} has an invalid aggregate`);
  }
  seen.add(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
  if (Array.isArray(value)) {return detachedArray(name, value, seen, depth, { descriptors, prototype });}
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(descriptors).length > 128) {
    throw new TypeError(`${name} must contain bounded plain data`);
  }
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${name} cannot contain accessors or symbol fields`);
    }
    entries.push([key, detachedData(name, descriptor.value, seen, depth + 1)]);
  }
  seen.delete(value);
  return Object.freeze(Object.fromEntries(entries));
};

/** Runtime boundary projection. Proxy classification precedes every reflective operation. */
export const detachedDispatchData = (name: string, value: unknown): unknown =>
  detachedData(name, value, new Set(), 0);

export const exactDispatchDataRecord = (
  name: string,
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> => {
  const detached = detachedDispatchData(name, value);
  if (detached === null || typeof detached !== "object" || Array.isArray(detached)) {
    throw new TypeError(`${name} must be a data record`);
  }
  const actual = Object.keys(detached);
  if (actual.toSorted().join("\0") !== [...keys].toSorted().join("\0")) {
    throw new TypeError(`${name} has an invalid shape`);
  }
  return detached as Readonly<Record<string, unknown>>;
};

/** Exact canonical projection for persistence data before it reaches application code or repository state. */
export const canonicalDispatchJournalEntry = (value: unknown): DispatchConsumptionJournalEntry => {
  const data = exactDispatchDataRecord("journal entry", value, [
    "binding", "claimBindingDigest", "grantRequestId", "journalDigest", "operationId", "outcome", "provider", "purpose",
    "requestDigest", "scope",
  ]);
  if (data.provider !== "claude" && data.provider !== "codex") { throw new TypeError("journal provider is invalid"); }
  if (data.purpose !== "contained-turn.provider-dispatch/v1") { throw new TypeError("journal purpose is invalid"); }
  return Object.freeze({
    binding: snapshotDispatchExpectation(data.binding as never),
    claimBindingDigest: snapshotDispatchDigest("claimBindingDigest", data.claimBindingDigest),
    grantRequestId: snapshotDispatchId("grantRequestId", data.grantRequestId),
    journalDigest: snapshotDispatchDigest("journalDigest", data.journalDigest),
    operationId: snapshotDispatchId("operationId", data.operationId),
    outcome: snapshotDispatchConsumeOutcome(data.outcome),
    provider: data.provider,
    purpose: data.purpose,
    requestDigest: snapshotDispatchDigest("requestDigest", data.requestDigest),
    scope: snapshotDispatchScope(data.scope as never),
  });
};
