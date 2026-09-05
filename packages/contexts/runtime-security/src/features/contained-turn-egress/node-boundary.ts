import { types } from "node:util";

// Intrinsics stay in this dormant Node boundary; none perform network operations.
export const monotonicNow = performance.now.bind(performance);
export const dataProperty = (value: unknown, name: string): unknown => {
  if (value === null || typeof value !== "object" || types.isProxy(value)) {return;}
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};
export const captureClose = (session: unknown): (() => PromiseLike<void>) | undefined => {
  const transport = dataProperty(session, "transport"); const close = dataProperty(transport, "close");
  if (typeof close !== "function" || types.isProxy(close)) {return;}
  return () => Reflect.apply(close, transport, []) as PromiseLike<void>;
};
