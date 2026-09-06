import { types } from "node:util";

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
