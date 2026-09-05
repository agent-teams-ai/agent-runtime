import type { ContainedTurnEgressRequest, EgressAuthorizationBodyV1,
  ProviderRouteAuthoritySnapshotV1, TrustedEgressHostIdentityV1 } from "./composition.js";
import type { BufferedRequest, PolicyAuthority, TransportObservation } from "./validation.js";
import type { DispatchConsumptionReceipt } from
  "../contained-turn-dispatch-authority/contracts/contained-turn-dispatch-authority-v1.js";
const freeze = Object.freeze;
export const authorizationBody = (input: Readonly<{route: ProviderRouteAuthoritySnapshotV1; request: ContainedTurnEgressRequest;
  receipt: DispatchConsumptionReceipt; identity: TrustedEgressHostIdentityV1; policy: PolicyAuthority; issuedAt: number;
  capturedRequest: BufferedRequest; observation: TransportObservation}>): EgressAuthorizationBodyV1 => {
  const {route, request, receipt, identity, policy, issuedAt, capturedRequest, observation} = input;
  return freeze({contractVersion: "contained-turn-egress-authorization-body/v1",
    tenantId: route.tenantId, projectId: route.projectId, scopeDigest: route.scopeDigest,
    providerId: route.providerId, providerAccountRef: route.providerAccountRef, providerRouteRef: route.providerRouteRef,
    credentialBindingRef: route.credentialBindingRef, credentialBindingDigest: route.credentialBindingDigest,
    credentialGeneration: route.credentialGeneration, credentialRevision: route.credentialRevision,
    accessRef: route.accessRef, accessRevision: route.accessRevision,
    routeRevision: route.routeRevision, routeAuthorityDigest: route.authorityDigest, operationId: receipt.operationId,
    attemptId: identity.attemptId, dispatchReceipt: receipt, requestId: request.requestId, requestNonce: request.requestNonce,
    environmentId: identity.environmentId, gatewayId: identity.gatewayId, hostInstanceId: identity.hostInstanceId,
    hostBootId: identity.hostBootId, transportMode: identity.transportMode, policyId: policy.policyId,
    policyRevision: policy.policyRevision, policyGeneration: policy.policyGeneration, keyId: policy.keyId,
    keyGeneration: policy.keyGeneration, signerRevision: policy.signerRevision, timeAuthorityId: policy.timeAuthorityId,
    timeGeneration: policy.timeGeneration, issuedAt, expiresAt: policy.expiresAt,
    target: freeze({scheme: route.scheme, host: route.host, port: route.port, tlsServerName: route.tlsServerName,
      pathDigest: capturedRequest.pathDigest}), allowedTlsSpkiDigests: route.allowedTlsSpkiDigests,
    tlsPinSetDigest: route.tlsPinSetDigest, tlsPinSetGeneration: route.tlsPinSetGeneration,
    tlsPinSetRevision: route.tlsPinSetRevision, resolutionAuthorityId: route.resolutionAuthorityId,
    resolutionGeneration: route.resolutionGeneration, answerSetDigest: observation.answerSetDigest,
    addresses: observation.canonicalAddresses, peerAddress: observation.peerAddress, peerPort: observation.peerPort,
    tlsSpkiDigest: observation.tlsSpkiDigest, alpn: observation.alpn, method: request.method,
    headerDigest: capturedRequest.headerDigest, bodyDigest: capturedRequest.bodyDigest,
    requestDigest: capturedRequest.requestDigest, applicationBytesDigest: capturedRequest.applicationBytesDigest,
    applicationBytes: capturedRequest.applicationBytes, budgets: request.budgets,
    policyMaxima: freeze({requestBytes: policy.maxRequestBytes, responseBytes: policy.maxResponseBytes,
      deadlineMs: policy.maxDeadlineMs})});
};
