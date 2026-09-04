import {types as utilTypes} from "node:util";
import type {
  HostHttpGrant, HostHttpMaterializationReceipt, HostHttpProvisionalDecision, HostHttpRequestProjection,
  HostHttpSigningKey, HostHttpTlsObservation, HostHttpVerifierV2, HttpEgressBrokerPorts,
} from "./http-egress-ports.js";
import {validHostHttpGrant, validHostHttpProvisionalDecision} from "./http-egress-signed-proof-validation.js";

const readCut = (ports: HttpEgressBrokerPorts) => {
  const value = ports.localAuthorityCut.read();
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {return null;}
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 4 || keys.some(key => typeof key !== "string"
    || !["status", "authorityId", "epoch", "controlTime"].includes(key))) {return null;}
  if (["status", "authorityId", "epoch", "controlTime"].some(key => descriptors[key] === undefined
    || !("value" in descriptors[key]!))) {return null;}
  const status = descriptors.status?.value; const authorityId = descriptors.authorityId?.value;
  const epoch = descriptors.epoch?.value; const controlTime = descriptors.controlTime?.value;
  if ((status !== "current" && status !== "revoked" && status !== "unknown")
    || typeof authorityId !== "string" || typeof epoch !== "string" || !Number.isSafeInteger(controlTime)) {return null;}
  return Object.freeze({status, authorityId, epoch, controlTime});
};

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

// oxlint-disable-next-line complexity -- exact signed proof binding is intentionally one closed conjunction
export const verifiedProvisional = (input: Readonly<{
  decision: HostHttpProvisionalDecision; verifier: HostHttpVerifierV2; expectedKey: HostHttpSigningKey;
  ports: HttpEgressBrokerPorts; authorizationRequestId: string; request: HostHttpRequestProjection;
  receipt: HostHttpMaterializationReceipt;
}>): boolean => {
  const {decision, ports} = input;
  const cut = readCut(ports); const now = ports.clock.now();
  return validHostHttpProvisionalDecision(decision)
    && decision.contractVersion === "provider-process-egress-provisional-decision/v2"
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
    && decision.policy.authorizedRequestDigest === decision.requestDigest
    && decision.policy.origin.scheme === "https" && decision.policy.origin.hostname === ports.route.originHost
    && decision.policy.origin.port === ports.route.originPort && decision.policy.dnsIdentity === ports.route.originHost
    && cut !== null && cut.status === "current" && cut.authorityId === decision.time.authorityId && cut.epoch === decision.time.epoch
    && cut.controlTime === now && Number.isSafeInteger(now) && now >= decision.time.controlTime
    && now < decision.time.expiresAtControlTime
    && !decision.policy.revoked;
};

// oxlint-disable-next-line complexity -- exact signed proof binding is intentionally one closed conjunction
export const verifiedGrant = (input: Readonly<{
  grant: HostHttpGrant; provisional: HostHttpProvisionalDecision; verifier: HostHttpVerifierV2;
  expectedKey: HostHttpSigningKey; ports: HttpEgressBrokerPorts; request: HostHttpRequestProjection;
  receipt: HostHttpMaterializationReceipt; tls: HostHttpTlsObservation; boundaryUseId: string;
  connectionAttemptId: string; streamId: string; resolver: Readonly<{resolverIdentity: string; resolverEpoch: string;
    resolutionCount: 1; addresses: readonly Readonly<{family: "ipv4" | "ipv6"; address: string;
      classification: "public"}>[]}>; selectedAddress: string;
}>): boolean => {
  const {grant, ports} = input;
  if (!validHostHttpGrant(grant)) {return false;}
  const payload = grant.payload;
  const now = ports.clock.now();
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
    && payload.authorityRef === input.provisional.authorityRef
    && payload.requestDigest === input.provisional.requestDigest
    && payload.boundaryUseId === input.boundaryUseId && payload.connectionAttemptId === input.connectionAttemptId
    && payload.streamId === input.streamId && payload.redirectHop === 0
    && payload.automaticRetryAuthorized === false && payload.poolingAuthorized === false
    && payload.consumption.owner === "host-custody"
    && payload.consumption.journalKey.namespace === "provider-process-egress/v2"
    && payload.consumption.journalKey.tenantId === ports.providerAccessSnapshot.tenantId
    && payload.consumption.journalKey.projectId === ports.providerAccessSnapshot.projectId
    && payload.consumption.journalKey.operationId === ports.identity.operationId
    && payload.consumption.journalKey.boundaryUseId === input.boundaryUseId
    && payload.resolver.resolverIdentity === input.resolver.resolverIdentity
    && payload.resolver.resolverEpoch === input.resolver.resolverEpoch
    && payload.resolver.resolutionCount === input.resolver.resolutionCount
    && JSON.stringify(payload.resolver.normalizedAddresses) === JSON.stringify(input.resolver.addresses)
    && payload.selectedPeer.address === input.selectedAddress
    && payload.selectedPeer.address === input.tls.peerAddress && payload.selectedPeer.port === input.tls.peerPort
    && payload.tls.sniHostname === input.tls.requestedSni && payload.tls.certificateValidated === true
    && payload.tls.dnsIdentity === input.tls.dnsIdentity
    && payload.tls.certificateDigest === input.tls.certificateDigest
    && payload.tls.tlsPolicyDigest === input.tls.tlsPolicyDigest && payload.tls.alpn === input.tls.alpn
    && Number.isSafeInteger(now) && now >= payload.time.authorizedAtControlTime
    && now < payload.time.expiresAtControlTime
    && grant.evidence.boundaryUseRef === input.boundaryUseId
    && grant.evidence.decisionDigest === input.provisional.decisionDigest
    && grant.evidence.finalAuthorizationDigest === grant.finalAuthorizationDigest
    && JSON.stringify(payload.policy) === JSON.stringify(input.provisional.policy)
    && JSON.stringify(payload.limits) === JSON.stringify(input.provisional.policy.limits)
    && sameProjection(payload.request, input.request) && providerAccessMatches(payload.providerAccess, input.receipt);
};

export const dispatchGrantIsCurrent = (ports: HttpEgressBrokerPorts, grant: HostHttpGrant): boolean => {
  const cut = readCut(ports);
  const now = ports.clock.now();
  return cut !== null && cut.status === "current" && cut.authorityId === grant.payload.time.authorityId
    && cut.epoch === grant.payload.time.epoch && cut.controlTime === now
    && Number.isSafeInteger(now) && now < grant.payload.time.expiresAtControlTime;
};
