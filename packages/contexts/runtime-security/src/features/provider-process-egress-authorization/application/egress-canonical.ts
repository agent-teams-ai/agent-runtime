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

export const provisionalPreimage = (decision: {
  readonly contractVersion: string;
  readonly authorizationRequestId: string;
  readonly scope: unknown;
  readonly providerRoute: unknown;
  readonly generations: unknown;
  readonly origin: unknown;
  readonly resolverAuthority: unknown;
  readonly certificate: unknown;
  readonly redirectHop: number;
  readonly budgets: unknown;
  readonly expiresAtControlTime: number;
  readonly requestIntentDigest: string;
}) => ({
  contractVersion: decision.contractVersion,
  authorizationRequestId: decision.authorizationRequestId,
  scope: decision.scope,
  providerRoute: decision.providerRoute,
  generations: decision.generations,
  origin: decision.origin,
  resolverAuthority: decision.resolverAuthority,
  certificate: decision.certificate,
  redirectHop: decision.redirectHop,
  budgets: decision.budgets,
  expiresAtControlTime: decision.expiresAtControlTime,
  requestIntentDigest: decision.requestIntentDigest,
});

export const finalAuthorizationPreimage = (authorization: {
  readonly authorizationRequestId: string;
  readonly boundaryUseId: string;
  readonly connectionAttemptId: string;
  readonly streamId: string;
  readonly decisionDigest: string;
  readonly requestIntentDigest: string;
  readonly scope: unknown;
  readonly providerRoute: unknown;
  readonly generations: unknown;
  readonly resolver: unknown;
  readonly selectedPeer: unknown;
  readonly sniHostname: string;
  readonly certificate: unknown;
  readonly alpn: string;
  readonly budgets: unknown;
  readonly observedAtControlTime: number;
}) => ({
  contractVersion: "provider-process-final-authorization-preimage/v1",
  authorizationRequestId: authorization.authorizationRequestId,
  boundaryUseId: authorization.boundaryUseId,
  connectionAttemptId: authorization.connectionAttemptId,
  streamId: authorization.streamId,
  decisionDigest: authorization.decisionDigest,
  requestIntentDigest: authorization.requestIntentDigest,
  scope: authorization.scope,
  providerRoute: authorization.providerRoute,
  generations: authorization.generations,
  resolver: authorization.resolver,
  selectedPeer: authorization.selectedPeer,
  sniHostname: authorization.sniHostname,
  certificate: authorization.certificate,
  alpn: authorization.alpn,
  budgets: authorization.budgets,
  observedAtControlTime: authorization.observedAtControlTime,
});
