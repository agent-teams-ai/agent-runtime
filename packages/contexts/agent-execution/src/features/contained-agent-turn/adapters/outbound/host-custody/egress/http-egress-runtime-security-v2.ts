import type {
  HostHttpGrant, HostHttpMaterializationReceipt, HostHttpProvisionalDecision, HostHttpRequestProjection,
  HostHttpSigningKey, HostHttpTlsObservation, HostHttpVerifierV2, HttpEgressBrokerPorts,
} from "./http-egress-ports.js";

const sameKey = (left: HostHttpSigningKey, right: HostHttpSigningKey): boolean =>
  left.algorithm === "ed25519" && left.signatureEncoding === "hex-lower"
  && left.keyRef === right.keyRef && left.publicKeyDigest === right.publicKeyDigest
  && left.keyGeneration === right.keyGeneration && left.signerRevision === right.signerRevision
  && left.hostReservationId === right.hostReservationId;

const sameProjection = (left: HostHttpRequestProjection, right: HostHttpRequestProjection): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const providerAccessMatches = (
  value: HostHttpProvisionalDecision["providerAccess"],
  receipt: HostHttpMaterializationReceipt,
): boolean => value.accessRef === receipt.accessRef && value.providerRef === receipt.provider
  && value.accountRef === receipt.providerAccountRef && value.routeRef === receipt.providerRouteRef
  && value.credentialBindingDigest === receipt.credentialBindingDigest
  && value.routeGeneration === String(receipt.bindingRevision)
  && value.credentialGeneration === String(receipt.credentialGeneration);

export const verifiedProvisional = (input: Readonly<{
  decision: HostHttpProvisionalDecision; verifier: HostHttpVerifierV2; expectedKey: HostHttpSigningKey;
  ports: HttpEgressBrokerPorts; authorizationRequestId: string; request: HostHttpRequestProjection;
  receipt: HostHttpMaterializationReceipt;
}>): boolean => {
  const {decision, ports} = input;
  return decision.contractVersion === "provider-process-egress-provisional-decision/v2"
    && input.verifier.verifyProvisionalDecision(decision)
    && sameKey(input.verifier.signingKey, input.expectedKey) && sameKey(decision.signingKey, input.expectedKey)
    && sameKey(decision.signature, input.expectedKey)
    && decision.authorizationRequestId === input.authorizationRequestId
    && decision.scope.operationId === ports.identity.operationId
    && decision.scope.tenantId === ports.providerAccessSnapshot.tenantId
    && decision.scope.projectId === ports.providerAccessSnapshot.projectId
    && decision.scope.scopeDigest === ports.providerAccessSnapshot.scopeDigest
    && decision.signingKey.hostReservationId === ports.identity.custodyId
    && sameProjection(decision.request, input.request)
    && providerAccessMatches(decision.providerAccess, input.receipt)
    && !decision.policy.revoked;
};

export const verifiedGrant = (input: Readonly<{
  grant: HostHttpGrant; provisional: HostHttpProvisionalDecision; verifier: HostHttpVerifierV2;
  expectedKey: HostHttpSigningKey; ports: HttpEgressBrokerPorts; request: HostHttpRequestProjection;
  receipt: HostHttpMaterializationReceipt; tls: HostHttpTlsObservation; boundaryUseId: string;
  connectionAttemptId: string; streamId: string;
}>): boolean => {
  const {grant, ports} = input;
  const payload = grant.payload;
  return payload.contractVersion === "provider-process-first-application-byte-grant/v2"
    && grant.evidence.contractVersion === "provider-process-egress-grant-evidence/v2"
    && input.verifier.verifyGrant(grant) && sameKey(input.verifier.signingKey, input.expectedKey)
    && sameKey(grant.signature, input.expectedKey) && sameKey(grant.evidence.signingKey, input.expectedKey)
    && payload.scope.operationId === ports.identity.operationId
    && payload.scope.tenantId === ports.providerAccessSnapshot.tenantId
    && payload.scope.projectId === ports.providerAccessSnapshot.projectId
    && payload.scope.scopeDigest === ports.providerAccessSnapshot.scopeDigest
    && payload.provisionalDecisionDigest === input.provisional.decisionDigest
    && payload.authorizationRequestId === input.provisional.authorizationRequestId
    && payload.boundaryUseId === input.boundaryUseId && payload.connectionAttemptId === input.connectionAttemptId
    && payload.streamId === input.streamId && payload.redirectHop === 0
    && payload.automaticRetryAuthorized === false && payload.poolingAuthorized === false
    && payload.consumption.owner === "host-custody"
    && payload.consumption.journalKey.namespace === "provider-process-egress/v2"
    && payload.consumption.journalKey.tenantId === ports.providerAccessSnapshot.tenantId
    && payload.consumption.journalKey.projectId === ports.providerAccessSnapshot.projectId
    && payload.consumption.journalKey.operationId === ports.identity.operationId
    && payload.consumption.journalKey.boundaryUseId === input.boundaryUseId
    && payload.selectedPeer.address === input.tls.peerAddress && payload.selectedPeer.port === input.tls.peerPort
    && payload.tls.sniHostname === input.tls.requestedSni && payload.tls.certificateValidated === true
    && payload.tls.dnsIdentity === input.tls.dnsIdentity
    && payload.tls.certificateDigest === input.tls.certificateDigest
    && payload.tls.tlsPolicyDigest === input.tls.tlsPolicyDigest && payload.tls.alpn === input.tls.alpn
    && sameProjection(payload.request, input.request) && providerAccessMatches(payload.providerAccess, input.receipt);
};

export const dispatchGrantIsCurrent = (ports: HttpEgressBrokerPorts, grant: HostHttpGrant): boolean => {
  const cut = ports.localAuthorityCut.read();
  const now = ports.clock.now();
  return cut.status === "current" && cut.authorityId === grant.payload.time.authorityId
    && cut.epoch === grant.payload.time.epoch && cut.controlTime === now
    && Number.isSafeInteger(now) && now < grant.payload.time.expiresAtControlTime;
};
