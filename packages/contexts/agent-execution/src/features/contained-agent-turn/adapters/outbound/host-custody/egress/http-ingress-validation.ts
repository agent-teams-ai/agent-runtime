import { types as utilTypes } from "node:util";
import type { HttpEgressLimits, HttpEgressOperation } from "./http-egress-contracts.js";
import { snapshotHttpEgressLimits } from "./http-egress-limits.js";

export const boundedHttpOpaque = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 512 && !/\p{Cc}|\p{Cs}/u.test(value);
const exact = (value: unknown, names: readonly string[]): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {return undefined;}
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !names.includes(key))) {return undefined;}
  const result: Record<string, unknown> = {};
  for (const name of names) {const descriptor = descriptors[name];
    if (descriptor === undefined || !("value" in descriptor)) {return undefined;} result[name] = descriptor.value;}
  return result;
};
export const snapshotHttpEgressOperation = (value: unknown): HttpEgressOperation => {
  const base = exact(value, ["operationId", "attemptId", "expectedRequest", "connection", "limits"])
    ?? exact(value, ["operationId", "attemptId", "expectedRequest", "connection", "limits", "signal"]);
  if (base === undefined || !boundedHttpOpaque(base.operationId) || !boundedHttpOpaque(base.attemptId)) {
    throw new TypeError("invalid HTTP egress operation");
  }
  const expected = exact(base.expectedRequest, ["requestId", "method", "path", "host"]);
  const connectionRecord = exact(base.connection, ["request", "write", "close"]);
  const connection = connectionRecord as Partial<HttpEgressOperation["connection"]> | undefined;
  if (expected === undefined || !boundedHttpOpaque(expected.requestId) || !boundedHttpOpaque(expected.method)
    || !boundedHttpOpaque(expected.path) || !boundedHttpOpaque(expected.host)
    || connection === undefined || typeof connection.write !== "function" || typeof connection.close !== "function"
    || connection.request === undefined || typeof connection.request[Symbol.asyncIterator] !== "function"
    || (base.signal !== undefined && !(base.signal instanceof AbortSignal))) {
    throw new TypeError("invalid HTTP egress operation");
  }
  const fixedLimits: HttpEgressLimits = snapshotHttpEgressLimits(base.limits);
  return Object.freeze({operationId: base.operationId, attemptId: base.attemptId,
    expectedRequest: Object.freeze(expected) as HttpEgressOperation["expectedRequest"],
    connection: Object.freeze({request: connection.request, write: connection.write.bind(connection),
      close: connection.close.bind(connection)}), limits: fixedLimits,
    ...(base.signal === undefined ? {} : {signal: base.signal as AbortSignal})});
};
