import type { HttpEgressLimits } from "./http-egress-contracts.js";

/** Invalid trusted configuration is rejected before accepting connection custody. */
export class HttpEgressLimitsError extends Error {
  public constructor() {
    super("invalid Host HTTP egress limits");
    this.name = "HttpEgressLimitsError";
  }
}

export const snapshotHttpEgressLimits = (input: HttpEgressLimits): HttpEgressLimits => {
  const limits = Object.freeze({ ...input });
  const positive = [limits.maxInboundHeaderBytes, limits.maxUpstreamHeaderBytes,
    limits.maxBufferedBytes, limits.maxUpstreamWireBytes];
  const nonnegative = [limits.maxInboundBodyBytes, limits.maxOutputBytes];
  if (positive.some(value => !Number.isSafeInteger(value) || value <= 0)
    || nonnegative.some(value => !Number.isSafeInteger(value) || value < 0)
    || !Number.isSafeInteger(limits.maxInboundHeaderBytes + limits.maxInboundBodyBytes)
    || !Number.isFinite(limits.deadline) || limits.deadline < 0
    || !Number.isFinite(limits.closureDeadline) || limits.closureDeadline < limits.deadline) {
    throw new HttpEgressLimitsError();
  }
  return limits;
};
