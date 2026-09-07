import { isNodeDispatchProxy } from "./node-dispatch-proxy.js";

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
