import type { EgressDispatchObservation } from "./dispatch-consumption.js";

export interface ContainedTurnEgressRequest {
  readonly scope: Readonly<{tenantId: string; projectId: string; scopeDigest: string}>;
  readonly providerId: string; readonly providerAccountRef: string; readonly providerRouteRef: string;
  readonly credentialBindingRef: string; readonly credentialBindingDigest: string;
  readonly credentialGeneration: string; readonly credentialRevision: string;
  readonly resolutionAuthorityId: string; readonly resolutionGeneration: string;
  readonly operationId: string; readonly dispatch: EgressDispatchObservation;
  readonly requestId: string; readonly requestNonce: string; readonly method: "GET" | "POST";
  /** Ephemeral transport target only. It is represented by pathDigest in authorization evidence. */
  readonly path: string; readonly headers: readonly Readonly<{name: string; value: string}>[];
  readonly body: Uint8Array;
  readonly budgets: Readonly<{requestBytes: number; responseBytes: number; deadlineMs: number}>;
}
export type ContainedTurnEgressResult =
  | Readonly<{status: "completed"; responseDigest: string; responseBytes: number;
      applicationBytesDigest: string; applicationBytesWritten: number}>
  | Readonly<{status: "denied"; reason: "invalid_request" | "route_unavailable" | "route_mismatch" |
      "dispatch_not_committed" | "authority_unavailable" | "authority_drift" | "address_denied" |
      "tls_peer_mismatch" | "expired" | "budget_exceeded" | "authorization_invalid" |
      "transport_denied"; deniedApplicationBytes: 0}>
  | Readonly<{status: "indeterminate"; reason: "first_write_indeterminate" | "response_invalid" | "close_failed"}>;
