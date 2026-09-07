import { isDeepStrictEqual, types } from "node:util";

/** Snapshot data without executing proxy traps, accessors or inherited properties. */
export const custodyDataRecord = <Value extends object>(value: Value): Value => {
  if (value === null || typeof value !== "object" || types.isProxy(value)) {
    throw new TypeError("Host Custody requires an inert data record");
  }
  const result = Object.create(null) as Value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) {throw new TypeError("Host Custody accessors are unavailable");}
    Object.defineProperty(result, key, descriptor);
  }
  return Object.freeze(result);
};

/** Compare retained Host reservation and execution binding data without coercion. */
export const sameHostCustodyBinding = (left: unknown, right: unknown): boolean => isDeepStrictEqual(left, right);

/** Inspect callback identity without reading callable properties or proxy traps. */
export const isHostCustodyDataCallback = (value: unknown): value is (...args: never[]) => unknown =>
  typeof value === "function" && !types.isProxy(value);
