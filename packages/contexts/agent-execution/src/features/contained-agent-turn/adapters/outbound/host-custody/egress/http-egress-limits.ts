import { types as utilTypes } from "node:util";
import type { HttpEgressLimits } from "./http-egress-contracts.js";

/** Invalid trusted configuration is rejected before accepting connection custody. */
export class HttpEgressLimitsError extends Error {
  public constructor() {
    super("invalid Host HTTP egress limits");
    this.name = "HttpEgressLimitsError";
  }
}

const FIELDS = ["maxInboundHeaderBytes", "maxInboundBodyBytes", "maxUpstreamHeaderBytes",
  "maxOutputBytes", "maxBufferedBytes", "maxUpstreamWireBytes", "deadline", "closureDeadline"] as const;

export const snapshotHttpEgressLimits = (input: unknown): HttpEgressLimits => {
  if (typeof input !== "object" || input === null || utilTypes.isProxy(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new HttpEgressLimitsError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== FIELDS.length
    || Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !FIELDS.some(field => field === key))
    || FIELDS.some(name => descriptors[name] === undefined || !("value" in descriptors[name]))) {
    throw new HttpEgressLimitsError();
  }
  const read = (name: typeof FIELDS[number]): number => {
    const value: unknown = descriptors[name]?.value;
    if (typeof value !== "number") {throw new HttpEgressLimitsError();}
    return value;
  };
  const limits: HttpEgressLimits = Object.freeze({
    maxInboundHeaderBytes: read("maxInboundHeaderBytes"),
    maxInboundBodyBytes: read("maxInboundBodyBytes"),
    maxUpstreamHeaderBytes: read("maxUpstreamHeaderBytes"),
    maxOutputBytes: read("maxOutputBytes"),
    maxBufferedBytes: read("maxBufferedBytes"),
    maxUpstreamWireBytes: read("maxUpstreamWireBytes"),
    deadline: read("deadline"),
    closureDeadline: read("closureDeadline"),
  });
  const positive = [limits.maxInboundHeaderBytes, limits.maxUpstreamHeaderBytes,
    limits.maxBufferedBytes, limits.maxUpstreamWireBytes];
  const nonnegative = [limits.maxInboundBodyBytes, limits.maxOutputBytes];
  if (positive.some(value => !Number.isSafeInteger(value) || value <= 0)
    || nonnegative.some(value => !Number.isSafeInteger(value) || value < 0)
    || !Number.isSafeInteger(limits.maxInboundHeaderBytes + limits.maxInboundBodyBytes)
    || !Number.isSafeInteger(limits.deadline) || limits.deadline < 0
    || !Number.isSafeInteger(limits.closureDeadline) || limits.closureDeadline < limits.deadline) {
    throw new HttpEgressLimitsError();
  }
  return limits;
};
