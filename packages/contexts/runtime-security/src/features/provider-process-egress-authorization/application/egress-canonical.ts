import type {
  FirstApplicationByteGrantPayloadV1,
  ProvisionalEgressAuthorizationV1,
} from "../contracts/provider-process-egress-authorization-v1.js";
import type { EgressCanonicalDigest } from "./ports/outbound/egress-cryptography.js";

export const canonicalEgressValue = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {throw new TypeError("non-canonical number");}
    return String(value);
  }
  if (Array.isArray(value)) {return `[${value.map(canonicalEgressValue).join(",")}]`;}
  if (typeof value !== "object") {throw new TypeError("non-canonical value");}
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).toSorted().map(key =>
    `${JSON.stringify(key)}:${canonicalEgressValue(record[key])}`).join(",")}}`;
};

export const digestCanonical = (digest: EgressCanonicalDigest, value: unknown): string =>
  digest.digest(canonicalEgressValue(value));

export const provisionalPreimage = (
  decision: Omit<ProvisionalEgressAuthorizationV1, "decisionDigest" | "signature">,
) => decision;

export const finalAuthorizationPreimage = (payload: FirstApplicationByteGrantPayloadV1) => payload;
