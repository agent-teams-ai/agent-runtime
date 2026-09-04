import type { HttpEgressAnomalyCode, HttpEgressOperation, HttpEgressReceipt } from "./http-egress-contracts.js";
import type { HostHttpGrant, HttpEgressBrokerPorts, HttpEgressTransportAttempt,
  HttpEgressTransportSession, HttpEgressTransportBinding } from "./http-egress-ports.js";
import { createPreparedHttpRequestV1, type PreparedHttpRequestV1 } from "./prepared-http-request-v1.js";
import { zeroHttpBytes, zeroLateHttpBytes } from "./http-byte-intrinsics.js";
import { snapshotHttpEgressOperation } from "./http-ingress-validation.js";
import { normalizeHttpEgressResolution } from "./public-address-policy.js";
import { readStrictHttpRequest, StrictHttpRequestError, type StrictHttpRequest } from "./strict-http-request.js";
import { verifiedGrant, verifiedProvisional } from "./http-egress-runtime-security-v2.js";
import { materializationAuthorizationRequest, observeMaterializationReceipt, presentationFields,
  projectPreparedRequest, receiptMatchesSnapshot, snapshotHostHttpRoute } from "./http-egress-session-authority.js";
import type {HostHttpAdmissionLease} from "./host-http-admission-guard.js";
import {closeAndRecordHttpEgress, initialHttpEgressState, settleHttpEgressDispatch, type HttpEgressMutableState} from "./http-egress-settlement.js";

const encoder = new TextEncoder();
const digest = (ports: HttpEgressBrokerPorts, parts: readonly Uint8Array[]): string => ports.evidence.digest(parts);

const requestError = (error: StrictHttpRequestError): HttpEgressAnomalyCode => ({cancelled: "inbound_cancelled",
  deadline: "inbound_deadline", headers_oversized: "inbound_headers_oversized", body_oversized: "inbound_body_oversized",
  malformed: "inbound_malformed", smuggling: "inbound_smuggling", route_mismatch: "inbound_route_mismatch"})[error.kind] as HttpEgressAnomalyCode;

// Keep asynchronous authority and settlement ordering explicit in execute.
const assertSessionIdentity = (ports: HttpEgressBrokerPorts, operation: HttpEgressOperation): void => {
  if (operation.operationId !== ports.identity.operationId || operation.attemptId !== ports.identity.attemptId) {
    throw new TypeError("HTTP session identity mismatch");
  }
};

type MaterializedFields = Awaited<ReturnType<HttpEgressBrokerPorts["materializer"]["render"]>>;

const prepareMaterializedRequest = (ports: HttpEgressBrokerPorts, request: StrictHttpRequest,
  forwardedFields: ReturnType<typeof presentationFields>, fields: MaterializedFields): PreparedHttpRequestV1 => {
  const names = fields.map(field => field.name);
  if (JSON.stringify(names) !== JSON.stringify(ports.route.credentialFieldNames)) {throw new TypeError("credential fields mismatch");}
  const host = ports.route.originPort === 443 ? ports.route.originHost : `${ports.route.originHost}:${ports.route.originPort}`;
  return createPreparedHttpRequestV1({methodBytes: encoder.encode(ports.route.upstreamMethod),
    targetBytes: encoder.encode(ports.route.upstreamPath), hostBytes: encoder.encode(host),
    presentationFields: forwardedFields, credentialFields: fields, bodyBytes: request.body});
};

const zeroMaterializedFields = (fields: MaterializedFields): void => {
  for (const field of fields) {zeroHttpBytes(field.valueBytes);}
};

const zeroLateMaterializedFields = (pendingFields: Promise<MaterializedFields> | undefined): void => {
  zeroLateHttpBytes(pendingFields?.then(values => {
    zeroMaterializedFields(values); return new Uint8Array();
  }));
};

const normalizeSingleResolution = (rawResolution: Awaited<ReturnType<HttpEgressBrokerPorts["resolver"]["resolve"]>>) => {
  const normalized = normalizeHttpEgressResolution(rawResolution.addresses.map(value => value.address), rawResolution.selectedAddress);
  if (normalized === undefined || rawResolution.resolutionCount !== 1) {return;}
  return normalized;
};

const transportOpenAllowed = (ports: HttpEgressBrokerPorts, operation: HttpEgressOperation,
  state: HttpEgressMutableState): boolean => {
  const beforeOpen = ports.clock.now();
  if (operation.signal?.aborted) {state.outcome = "cancelled"; state.anomalyCode = "inbound_cancelled";
    return false;}
  if (!Number.isSafeInteger(beforeOpen) || beforeOpen >= operation.limits.deadline) {state.outcome = "denied";
    state.anomalyCode = "transport_open_failed"; return false;}
  return true;
};

const recordTransportOpenFailure = (operation: HttpEgressOperation, state: HttpEgressMutableState): void => {
  state.outcome = operation.signal?.aborted ? "cancelled" : "denied";
  state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "transport_open_failed";
};

const observeTransportBinding = (ports: HttpEgressBrokerPorts, state: HttpEgressMutableState,
  tls: HttpEgressTransportBinding, selectedAddress: string): boolean => {
  state.selectedPeer = tls.peerAddress; state.tlsProtocol = tls.tlsProtocol;
  state.certificateDigest = tls.certificateDigest; state.pinDigest = tls.spkiDigest ?? ""; state.alpn = tls.alpn;
  state.sniDigest = digest(ports, [encoder.encode(tls.observedSni)]);
  if (tls.peerAddress !== selectedAddress || tls.peerPort !== ports.route.originPort
    || tls.requestedSni !== ports.route.originHost || tls.observedSni !== ports.route.originHost
    || tls.chainValidated !== true || tls.dnsIdentity !== ports.route.originHost || tls.alpn !== "http/1.1"
    || (tls.tlsProtocol !== "TLSv1.2" && tls.tlsProtocol !== "TLSv1.3")) {
    state.outcome = "denied"; state.anomalyCode = "transport_binding_drift";
    return false;
  }
  return true;
};

const recordExecutionError = (operation: HttpEgressOperation, state: HttpEgressMutableState, error: unknown): void => {
  if (operation.signal?.aborted) {state.outcome = state.firstByteState === "not_sent" ? "cancelled" : "reconcile_required";
    state.anomalyCode = "inbound_cancelled";}
  else if (error instanceof StrictHttpRequestError) {state.inboundRequestBytes = error.observedBytes;
    state.outcome = error.kind === "cancelled" ? "cancelled" : "rejected"; state.anomalyCode = requestError(error);}
  else {state.outcome = state.firstByteState === "not_sent" ? "denied" : "reconcile_required";
    if (state.anomalyCode === "inbound_malformed") {state.anomalyCode = "provider_access_denied";}}
};

const finishExecution = (ports: HttpEgressBrokerPorts, lease: HostHttpAdmissionLease, successful: boolean,
  prepared: PreparedHttpRequestV1 | undefined, request: StrictHttpRequest | undefined): void => {
  prepared?.dispose(); zeroHttpBytes(request?.body);
  ports.guard.finish(lease, successful ? Object.freeze({response: "observed_policy_accepted", delivery: "delivered",
    upstreamClosure: "closed", inboundClosure: "closed", evidenceAcknowledgement: "acknowledged"}) : undefined);
};

export const createStrictHttpEgressBroker = (ports: HttpEgressBrokerPorts): Readonly<{
  execute(operation: HttpEgressOperation): Promise<HttpEgressReceipt>;
}> => Object.freeze({execute: async (input): Promise<HttpEgressReceipt> => {
  const operation = snapshotHttpEgressOperation(input);
  const state = initialHttpEgressState(); let request: StrictHttpRequest | undefined; let attempt: HttpEgressTransportAttempt | undefined;
  let prepared: PreparedHttpRequestV1 | undefined; const lease = ports.guard.acquire();
  // Parsing is allowed before admission acquisition, but this implementation acquires first so no hostile
  // inbound stream can hold unreserved session work. No fresh boundary ID or owner call precedes this point.
  if (lease === undefined) {return (await closeAndRecordHttpEgress(ports, operation, state)).receipt;}
  let successful = false;
  try {
    assertSessionIdentity(ports, operation);
    const route = snapshotHostHttpRoute(ports.route);
    if (route === undefined) {state.outcome = "denied";
      state.anomalyCode = "provider_access_denied"; return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    state.routeReceiptDigest = route.routeReceiptDigest;
    request = await readStrictHttpRequest(operation.connection.request, operation.expectedRequest, operation.limits,
      ports.clock, operation.signal); state.inboundRequestBytes = request.wireBytes;
    const forwardedFields = presentationFields(request, ports.route);
    const ids = ports.ids.fresh();
    state.requestDigest = digest(ports, [encoder.encode("agent-runtime.host-http-materialization-request/v1\n"),
      encoder.encode(operation.expectedRequest.requestId), encoder.encode(ports.route.routeReceiptDigest), request.body]);
    const pa = await ports.providerAccess.authorize(materializationAuthorizationRequest(ports, ids.materializationAuthorizationId,
      state.requestDigest));
    if (pa.kind !== "authorized" || !receiptMatchesSnapshot(pa.receipt, ports,
      ids.materializationAuthorizationId, state.requestDigest)) {state.outcome = "denied"; state.anomalyCode = "provider_access_denied";
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    const paReceipt = pa.receipt; state.materializationReceiptDigest = digest(ports, [encoder.encode(JSON.stringify(paReceipt))]);
    state.routeGeneration = String(paReceipt.bindingRevision); state.credentialGeneration = String(paReceipt.credentialGeneration);
    let pendingFields: Promise<readonly Readonly<{name: string; valueBytes: Uint8Array}>[]> | undefined;
    let fields: readonly Readonly<{name: string; valueBytes: Uint8Array}>[];
    try {fields = await ports.clock.within(operation.limits.deadline, () => {
      pendingFields = ports.materializer.render(paReceipt); return pendingFields;
    }, operation.signal);} catch {zeroLateMaterializedFields(pendingFields); state.outcome = "denied"; state.anomalyCode = "credential_render_failed";
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    try {prepared = prepareMaterializedRequest(ports, request, forwardedFields, fields);}
    finally {zeroMaterializedFields(fields);}
    if (!await observeMaterializationReceipt(ports, paReceipt)) {state.outcome = "denied"; state.anomalyCode = "provider_generation_drift";
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    const requestProjection = projectPreparedRequest(ports, prepared, paReceipt);
    let provisionalOutcome: Awaited<ReturnType<typeof ports.runtimeSecurity.requestProvisional>>;
    try {provisionalOutcome = await ports.runtimeSecurity.requestProvisional({contractVersion:
      "provider-process-egress-provisional/v2", authorizationRequestId: ids.runtimeAuthorizationId, request: requestProjection});
    } catch {state.outcome = "denied"; state.anomalyCode = "provisional_timeout";
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    const expectedKey = ports.verifier.signingKey;
    if (provisionalOutcome.status !== "authorized" || !verifiedProvisional({decision: provisionalOutcome.decision,
      verifier: ports.verifier, expectedKey, ports, authorizationRequestId: ids.runtimeAuthorizationId,
      request: requestProjection, receipt: paReceipt})) {state.outcome = "denied"; state.anomalyCode = "provisional_denied";
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    const provisional = provisionalOutcome.decision; state.provisionalAuthorizationReceiptDigest = provisional.decisionDigest;
    state.policyGeneration = provisional.policy.policyGeneration; state.keyGeneration = provisional.signingKey.keyGeneration;
    let rawResolution: Awaited<ReturnType<typeof ports.resolver.resolve>>;
    try {rawResolution = await ports.resolver.resolve(ports.route.originHost);} catch {state.outcome = "denied";
      state.anomalyCode = "resolution_denied"; return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    const normalized = normalizeSingleResolution(rawResolution);
    if (normalized === undefined) {state.outcome = "denied"; state.anomalyCode = "resolution_denied";
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    if (!transportOpenAllowed(ports, operation, state)) {
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    state.attemptCount = 1; state.upstreamClosure = "unknown";
    let session: HttpEgressTransportSession;
    try {attempt = ports.transport.beginOpen({originHost: ports.route.originHost, originPort: ports.route.originPort,
      selectedAddress: normalized.selectedAddress, sni: ports.route.originHost, alpn: "http/1.1"});
      session = await ports.clock.within(operation.limits.deadline,
        () => (attempt as HttpEgressTransportAttempt).ready(), operation.signal);
    } catch {recordTransportOpenFailure(operation, state);
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    const tls = session.binding;
    if (!observeTransportBinding(ports, state, tls, normalized.selectedAddress)) {
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    if (!await observeMaterializationReceipt(ports, paReceipt)) {state.outcome = "denied"; state.anomalyCode = "provider_generation_drift";
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    const resolver = Object.freeze({resolverIdentity: rawResolution.resolverIdentity,
      resolverEpoch: rawResolution.resolverEpoch, resolutionCount: 1 as const, addresses: rawResolution.addresses});
    let finalOutcome: Awaited<ReturnType<typeof ports.runtimeSecurity.authorizeFirstApplicationByte>>;
    try {finalOutcome = await ports.runtimeSecurity.authorizeFirstApplicationByte({contractVersion:
      "provider-process-egress-final/v2", provisional, boundaryUseId: ids.boundaryUseId,
      connectionAttemptId: ids.connectionAttemptId, streamId: ids.streamId, transport: "tcp-tls", resolver,
      pinnedDestination: Object.freeze({address: normalized.selectedAddress, port: ports.route.originPort}),
      observedPeer: Object.freeze({address: tls.peerAddress, port: tls.peerPort}), tls: Object.freeze({
        sniHostname: tls.requestedSni, certificateValidated: tls.chainValidated, dnsIdentity: tls.dnsIdentity,
        certificateDigest: tls.certificateDigest, tlsPolicyDigest: tls.tlsPolicyDigest, alpn: tls.alpn}),
      request: requestProjection, redirectHop: 0});} catch {state.outcome = "denied"; state.anomalyCode = "final_timeout";
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    if (finalOutcome.status !== "authorized" || !verifiedGrant({grant: finalOutcome.grant, provisional,
      verifier: ports.verifier, expectedKey, ports, request: requestProjection, receipt: paReceipt, tls,
      boundaryUseId: ids.boundaryUseId, connectionAttemptId: ids.connectionAttemptId, streamId: ids.streamId,
      resolver, selectedAddress: normalized.selectedAddress})) {
      state.outcome = "denied"; state.anomalyCode = "final_denied";
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;
    }
    const grant: HostHttpGrant = finalOutcome.grant; state.finalAuthorizationReceiptDigest = grant.finalAuthorizationDigest;
    const settled = await settleHttpEgressDispatch({ports, operation, state, attempt, session, tls, grant, prepared, lease});
    successful = settled.fullyAcknowledged;
    return settled.receipt;
  } catch (error) {
    recordExecutionError(operation, state, error);
    return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;
  } finally {
    finishExecution(ports, lease, successful, prepared, request);
  }
}});
