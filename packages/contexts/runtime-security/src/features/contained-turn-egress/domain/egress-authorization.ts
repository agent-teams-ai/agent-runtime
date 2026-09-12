import type { DispatchConsumptionReceipt } from
  "../../contained-turn-dispatch-authority/contracts/contained-turn-dispatch-authority-v1.js";
import type { NetworkAddressV1 } from "./network-address.js";

export interface EgressAuthorizationEnvelopeV1 {
  readonly keyId: string; readonly keyGeneration: string; readonly signerRevision: string;
  readonly digest: string; readonly signature: string;
}
export interface EgressAuthorizationBodyV1 {
  readonly contractVersion: "contained-turn-egress-authorization-body/v1";
  readonly tenantId: string; readonly projectId: string; readonly scopeDigest: string;
  readonly providerId: string; readonly providerAccountRef: string; readonly providerRouteRef: string;
  readonly credentialBindingRef: string; readonly credentialBindingDigest: string;
  readonly credentialGeneration: string; readonly credentialRevision: string;
  readonly accessRef: string; readonly accessRevision: string;
  readonly routeRevision: string; readonly routeAuthorityDigest: string; readonly operationId: string;
  readonly attemptId: string; readonly dispatchReceipt: DispatchConsumptionReceipt;
  readonly requestId: string; readonly requestNonce: string; readonly environmentId: string;
  readonly gatewayId: string; readonly hostInstanceId: string; readonly hostBootId: string;
  readonly transportMode: "one_shot_https"; readonly policyId: string; readonly policyRevision: string;
  readonly policyGeneration: string; readonly keyId: string; readonly keyGeneration: string;
  readonly signerRevision: string; readonly timeAuthorityId: string; readonly timeGeneration: string;
  readonly issuedAt: number; readonly expiresAt: number; readonly target: Readonly<{scheme: "https";
    host: string; port: 443; tlsServerName: string; pathDigest: string}>;
  readonly allowedTlsSpkiDigests: readonly string[]; readonly tlsPinSetDigest: string;
  readonly tlsPinSetGeneration: string; readonly tlsPinSetRevision: string;
  readonly resolutionAuthorityId: string; readonly resolutionGeneration: string; readonly answerSetDigest: string;
  readonly addresses: readonly NetworkAddressV1[]; readonly peerAddress: NetworkAddressV1;
  readonly peerPort: 443; readonly tlsSpkiDigest: string; readonly alpn: "http/1.1";
  readonly method: "GET" | "POST"; readonly headerDigest: string; readonly bodyDigest: string;
  readonly requestDigest: string; readonly applicationBytesDigest: string; readonly applicationBytes: number;
  readonly budgets: Readonly<{requestBytes: number; responseBytes: number; deadlineMs: number}>;
  readonly policyMaxima: Readonly<{requestBytes: number; responseBytes: number; deadlineMs: number}>;
}
export interface BufferedEgressRequestV1 {
  readonly method: "GET" | "POST"; readonly headers: readonly Readonly<{name: string; value: string}>[];
  readonly body: Uint8Array;
}
export interface EgressTransportObservationV1 {
  readonly canonicalAddresses: readonly NetworkAddressV1[]; readonly peerAddress: NetworkAddressV1;
  readonly peerPort: 443; readonly tlsServerName: string; readonly tlsSpkiDigest: string; readonly alpn: "http/1.1";
  readonly phase: "immediately_before_first_application_byte"; readonly resolutionAuthorityId: string;
  readonly resolutionGeneration: string; readonly answerSetDigest: string;
  readonly applicationBytesDigest: string; readonly applicationBytes: number;
}
