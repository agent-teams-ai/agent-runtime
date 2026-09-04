import type { HttpEgressAnomalyCode, HttpEgressClosureState, HttpEgressOperation,
  HttpEgressOutcome, HttpEgressReceipt } from "./http-egress-contracts.js";
import type { HostHttpGrant, HostHttpMaterializationReceipt, HostHttpRequestProjection,
  HttpEgressBrokerPorts, HttpEgressTransportAttempt, HttpEgressTransportSession } from "./http-egress-ports.js";
import { createPreparedHttpRequestV1, type PreparedHttpRequestV1 } from "./prepared-http-request-v1.js";
import { createHttpDispatchBoundary } from "./http-dispatch-boundary.js";
import { zeroHttpBytes, zeroLateHttpBytes } from "./http-byte-intrinsics.js";
import { observeHttpDispatch } from "./http-dispatch-observation.js";
import { observeHttpResponse } from "./http-response-observation.js";
import { snapshotHttpClosureDecision } from "./http-receipt-validation.js";
import { snapshotHttpEgressOperation } from "./http-ingress-validation.js";
import { normalizeHttpEgressResolution } from "./public-address-policy.js";
import { readStrictHttpRequest, StrictHttpRequestError, type StrictHttpRequest } from "./strict-http-request.js";
import { dispatchGrantIsCurrent, verifiedGrant, verifiedProvisional } from "./http-egress-runtime-security-v2.js";

const encoder = new TextEncoder();
type State = {
  outcome: HttpEgressOutcome; anomalyCode: HttpEgressAnomalyCode; requestDigest: string;
  provisionalAuthorizationReceiptDigest: string; finalAuthorizationReceiptDigest: string;
  routeReceiptDigest: string; materializationReceiptDigest: string; selectedPeer: string; tlsProtocol: string;
  sniDigest: string; certificateDigest: string; pinDigest: string; alpn: string; policyGeneration: string;
  keyGeneration: string; routeGeneration: string; credentialGeneration: string; inboundRequestBytes: number;
  upstreamRequestBytes: number; upstreamResponseBytes: number; outboundResponseBytes: number;
  outboundResponseWriteUncertain: boolean; firstByteState: "not_sent" | "sent" | "uncertain";
  inboundClosure: HttpEgressClosureState; upstreamClosure: HttpEgressClosureState;
  inboundClosureReceiptDigest: string; upstreamClosureReceiptDigest: string; attemptCount: 0 | 1;
};
const initial = (ports: HttpEgressBrokerPorts): State => ({outcome: "rejected", anomalyCode: "inbound_malformed",
  requestDigest: "", provisionalAuthorizationReceiptDigest: "", finalAuthorizationReceiptDigest: "",
  routeReceiptDigest: ports.route.routeReceiptDigest, materializationReceiptDigest: "", selectedPeer: "", tlsProtocol: "",
  sniDigest: "", certificateDigest: "", pinDigest: "", alpn: "", policyGeneration: "", keyGeneration: "",
  routeGeneration: "", credentialGeneration: "", inboundRequestBytes: 0, upstreamRequestBytes: 0,
  upstreamResponseBytes: 0, outboundResponseBytes: 0, outboundResponseWriteUncertain: false, firstByteState: "not_sent",
  inboundClosure: "not_opened", upstreamClosure: "not_opened", inboundClosureReceiptDigest: "",
  upstreamClosureReceiptDigest: "", attemptCount: 0});

const digest = (ports: HttpEgressBrokerPorts, parts: readonly Uint8Array[]): string => ports.evidence.digest(parts);
const immutableReceipt = (operation: HttpEgressOperation, state: State): HttpEgressReceipt => Object.freeze({
  schema: "agent-runtime.host-http-egress-receipt/v1", operationId: operation.operationId,
  attemptId: operation.attemptId, requestId: operation.expectedRequest.requestId, ...state,
});

const requestError = (error: StrictHttpRequestError): HttpEgressAnomalyCode => ({cancelled: "inbound_cancelled",
  deadline: "inbound_deadline", headers_oversized: "inbound_headers_oversized", body_oversized: "inbound_body_oversized",
  malformed: "inbound_malformed", smuggling: "inbound_smuggling", route_mismatch: "inbound_route_mismatch"})[error.kind] as HttpEgressAnomalyCode;

const closeAndRecord = async (ports: HttpEgressBrokerPorts, operation: HttpEgressOperation, state: State,
  attempt: HttpEgressTransportAttempt | undefined): Promise<Readonly<{receipt: HttpEgressReceipt; fullyAcknowledged: boolean}>> => {
  if (attempt !== undefined) {
    try { const value = snapshotHttpClosureDecision(await ports.clock.within(operation.limits.closureDeadline,
      () => attempt.close())); state.upstreamClosure = value?.state ?? "unknown";
      state.upstreamClosureReceiptDigest = value?.receiptDigest ?? ""; } catch {state.upstreamClosure = "unknown";}
  }
  try { const value = snapshotHttpClosureDecision(await ports.clock.within(operation.limits.closureDeadline,
    () => operation.connection.close(state.outcome === "completed" ? "complete" : "abort")));
  state.inboundClosure = value?.state ?? "unknown"; state.inboundClosureReceiptDigest = value?.receiptDigest ?? "";
  } catch {state.inboundClosure = "unknown";}
  if (state.inboundClosure !== "closed" || (attempt !== undefined && state.upstreamClosure !== "closed")) {
    state.anomalyCode = "closure_unproved";
    if (attempt !== undefined || state.firstByteState !== "not_sent") {state.outcome = "reconcile_required";}
  }
  let receipt = immutableReceipt(operation, state);
  let recorded = false;
  try { const result = await ports.clock.within(operation.limits.closureDeadline, () => ports.evidence.record(receipt));
    recorded = result === "recorded";
    if (!recorded) {state.anomalyCode = result === "conflict" ? "conflicting_replay" : "evidence_ack_lost";}
  } catch {state.anomalyCode = "evidence_ack_lost";}
  if (!recorded && state.firstByteState !== "not_sent") {state.outcome = "reconcile_required";}
  receipt = immutableReceipt(operation, state);
  return Object.freeze({receipt, fullyAcknowledged: recorded && state.outcome === "completed"
    && state.inboundClosure === "closed" && state.upstreamClosure === "closed"});
};

const sameReceipt = (left: HostHttpMaterializationReceipt, right: HostHttpMaterializationReceipt): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const receiptMatchesSnapshot = (receipt: HostHttpMaterializationReceipt, ports: HttpEgressBrokerPorts,
  authorizationRequestId: string, requestDigest: string): boolean => receipt.schemaVersion === 1
  && receipt.purpose === "contained-turn.credential-materialization-authorization/v1" && receipt.decision === "authorized"
  && receipt.rejectionReason === null && receipt.authorizationRequestId === authorizationRequestId
  && receipt.requestDigest === requestDigest && receipt.accessRef === ports.providerAccessSnapshot.accessRef
  && receipt.provider === ports.providerAccessSnapshot.provider
  && receipt.providerAccountRef === ports.providerAccessSnapshot.providerAccountRef
  && receipt.providerRouteRef === ports.providerAccessSnapshot.providerRouteRef
  && receipt.credentialBindingRef === ports.providerAccessSnapshot.credentialBindingRef
  && receipt.credentialBindingDigest === ports.providerAccessSnapshot.ownerAuthorityDigest
  && receipt.bindingRevision === ports.providerAccessSnapshot.revision
  && receipt.credentialGeneration === ports.providerAccessSnapshot.credentialGeneration
  && receipt.scopeDigest === ports.providerAccessSnapshot.scopeDigest
  && receipt.tenantId === ports.providerAccessSnapshot.tenantId && receipt.projectId === ports.providerAccessSnapshot.projectId
  && receipt.availability === "available" && receipt.revocation === "active";

const observationInput = (receipt: HostHttpMaterializationReceipt) => Object.freeze({
  authorizationRequestId: receipt.authorizationRequestId, projectId: receipt.projectId, provider: receipt.provider,
  requestDigest: receipt.requestDigest, scopeDigest: receipt.scopeDigest, tenantId: receipt.tenantId,
});
const observeReceipt = async (ports: HttpEgressBrokerPorts, receipt: HostHttpMaterializationReceipt): Promise<boolean> => {
  const observed = await ports.providerAccess.observe(observationInput(receipt));
  return observed.kind === "observed" && sameReceipt(observed.receipt, receipt);
};

const presentationFields = (request: StrictHttpRequest, ports: HttpEgressBrokerPorts) => {
  const allowed = new Set(ports.route.forwardedRequestHeaderNames);
  const fields = request.headers.filter(field => allowed.has(field.name as "accept" | "content-type"));
  if (new Set(fields.map(field => field.name)).size !== fields.length) {throw new TypeError("duplicate presentation field");}
  return fields.toSorted((a, b) => a.name.localeCompare(b.name)).map(field => Object.freeze({
    name: field.name, valueBytes: encoder.encode(field.value),
  }));
};

const projection = (ports: HttpEgressBrokerPorts, prepared: PreparedHttpRequestV1,
  receipt: HostHttpMaterializationReceipt): HostHttpRequestProjection => {
  const target = prepared.snapshotSpan(prepared.targetSpan); const body = prepared.snapshotSpan(prepared.bodySpan);
  if (target === undefined || body === undefined) {throw new TypeError("prepared request disposed");}
  const credentials: Array<Readonly<{name: string; credentialBindingDigest: string; valueDigest: string; byteLength: number}>> = [];
  try {
    for (const span of prepared.credentialValueSpans) {
      const value = prepared.snapshotSpan(span); if (value === undefined) {throw new TypeError("credential span invalid");}
      try {credentials.push(Object.freeze({name: span.name, credentialBindingDigest: receipt.credentialBindingDigest,
        valueDigest: digest(ports, [value]), byteLength: span.length}));} finally {zeroHttpBytes(value);}
    }
    return Object.freeze({method: ports.route.upstreamMethod, scheme: "https",
      authority: Object.freeze({hostname: ports.route.originHost, port: ports.route.originPort}),
      requestTarget: Object.freeze({digest: digest(ports, [target]), byteLength: target.byteLength}),
      headers: Object.freeze({canonicalDigest: digest(ports, [prepared.headerProjectionBytes]),
        fieldCount: prepared.headerLineSpans.length, credentialFields: Object.freeze(credentials)}),
      body: Object.freeze({digest: digest(ports, [body]), byteLength: body.byteLength}),
      framing: Object.freeze({protocol: "http/1.1", requestTarget: "origin-form", authoritySource: "host",
        contentLength: body.byteLength, transferEncoding: "absent", connectionSpecificHeaders: "absent"})});
  } finally {zeroHttpBytes(target); zeroHttpBytes(body);}
};

const authorizationRequest = (ports: HttpEgressBrokerPorts, id: string, requestDigest: string) => Object.freeze({
  accessRef: ports.providerAccessSnapshot.accessRef, authorizationRequestId: id,
  availability: ports.providerAccessSnapshot.availability, bindingRevision: ports.providerAccessSnapshot.revision,
  credentialBindingDigest: ports.providerAccessSnapshot.ownerAuthorityDigest,
  credentialBindingRef: ports.providerAccessSnapshot.credentialBindingRef,
  credentialGeneration: ports.providerAccessSnapshot.credentialGeneration,
  projectId: ports.providerAccessSnapshot.projectId, provider: ports.providerAccessSnapshot.provider,
  providerAccountRef: ports.providerAccessSnapshot.providerAccountRef,
  providerRouteRef: ports.providerAccessSnapshot.providerRouteRef,
  purpose: "contained-turn.credential-materialization-authorization/v1" as const, requestDigest,
  revocation: ports.providerAccessSnapshot.revocation, schemaVersion: 1 as const,
  scopeDigest: ports.providerAccessSnapshot.scopeDigest, tenantId: ports.providerAccessSnapshot.tenantId,
});

const retryAnomaly = (status: number): HttpEgressAnomalyCode | undefined => status === 401 || status === 403
  ? "upstream_auth_rejected" : status === 429 ? "upstream_rate_limited" : status >= 500
    ? "upstream_server_error" : status >= 300 && status <= 399 ? "redirect_rejected" : undefined;

export const createStrictHttpEgressBroker = (ports: HttpEgressBrokerPorts): Readonly<{
  execute(operation: HttpEgressOperation): Promise<HttpEgressReceipt>;
}> => Object.freeze({execute: async (input): Promise<HttpEgressReceipt> => {
  const operation = snapshotHttpEgressOperation(input);
  const state = initial(ports); let request: StrictHttpRequest | undefined; let attempt: HttpEgressTransportAttempt | undefined;
  let prepared: PreparedHttpRequestV1 | undefined; const lease = ports.guard.acquire();
  // Parsing is allowed before admission acquisition, but this implementation acquires first so no hostile
  // inbound stream can hold unreserved session work. No fresh boundary ID or owner call precedes this point.
  if (lease === undefined) {return (await closeAndRecord(ports, operation, state, undefined)).receipt;}
  let successful = false;
  try {
    if (operation.operationId !== ports.identity.operationId || operation.attemptId !== ports.identity.attemptId) {
      throw new TypeError("HTTP session identity mismatch");
    }
    request = await readStrictHttpRequest(operation.connection.request, operation.expectedRequest, operation.limits,
      ports.clock, operation.signal); state.inboundRequestBytes = request.wireBytes;
    const ids = ports.ids.fresh();
    state.requestDigest = digest(ports, [encoder.encode("agent-runtime.host-http-materialization-request/v1\n"),
      encoder.encode(operation.expectedRequest.requestId), encoder.encode(ports.route.routeReceiptDigest), request.body]);
    const pa = await ports.providerAccess.authorize(authorizationRequest(ports, ids.materializationAuthorizationId,
      state.requestDigest));
    if (pa.kind !== "authorized" || !receiptMatchesSnapshot(pa.receipt, ports,
      ids.materializationAuthorizationId, state.requestDigest)) {state.outcome = "denied"; state.anomalyCode = "provider_access_denied";
      return (await closeAndRecord(ports, operation, state, attempt)).receipt;}
    const paReceipt = pa.receipt; state.materializationReceiptDigest = digest(ports, [encoder.encode(JSON.stringify(paReceipt))]);
    state.routeGeneration = String(paReceipt.bindingRevision); state.credentialGeneration = String(paReceipt.credentialGeneration);
    let pendingFields: Promise<readonly Readonly<{name: string; valueBytes: Uint8Array}>[]> | undefined;
    const fields = await ports.clock.within(operation.limits.deadline, () => {
      pendingFields = ports.materializer.render(paReceipt); return pendingFields;
    }, operation.signal).catch(error => {zeroLateHttpBytes(pendingFields?.then(values => {
      for (const value of values) {zeroHttpBytes(value.valueBytes);} return new Uint8Array();
    })); throw error;});
    try {
      const names = fields.map(field => field.name);
      if (JSON.stringify(names) !== JSON.stringify(ports.route.credentialFieldNames)) {throw new TypeError("credential fields mismatch");}
      const host = ports.route.originPort === 443 ? ports.route.originHost : `${ports.route.originHost}:${ports.route.originPort}`;
      prepared = createPreparedHttpRequestV1({methodBytes: encoder.encode(ports.route.upstreamMethod),
        targetBytes: encoder.encode(ports.route.upstreamPath), hostBytes: encoder.encode(host),
        presentationFields: presentationFields(request, ports), credentialFields: fields, bodyBytes: request.body});
    } finally {for (const field of fields) {zeroHttpBytes(field.valueBytes);}}
    if (!await observeReceipt(ports, paReceipt)) {state.outcome = "denied"; state.anomalyCode = "provider_generation_drift";
      return (await closeAndRecord(ports, operation, state, attempt)).receipt;}
    const requestProjection = projection(ports, prepared, paReceipt);
    const provisionalOutcome = await ports.runtimeSecurity.requestProvisional({contractVersion:
      "provider-process-egress-provisional/v2", authorizationRequestId: ids.runtimeAuthorizationId, request: requestProjection});
    const expectedKey = ports.verifier.signingKey;
    if (provisionalOutcome.status !== "authorized" || !verifiedProvisional({decision: provisionalOutcome.decision,
      verifier: ports.verifier, expectedKey, ports, authorizationRequestId: ids.runtimeAuthorizationId,
      request: requestProjection, receipt: paReceipt})) {state.outcome = "denied"; state.anomalyCode = "provisional_denied";
      return (await closeAndRecord(ports, operation, state, attempt)).receipt;}
    const provisional = provisionalOutcome.decision; state.provisionalAuthorizationReceiptDigest = provisional.decisionDigest;
    state.policyGeneration = provisional.policy.policyGeneration; state.keyGeneration = provisional.signingKey.keyGeneration;
    const rawResolution = await ports.resolver.resolve(ports.route.originHost);
    const normalized = normalizeHttpEgressResolution(rawResolution.addresses.map(value => value.address), rawResolution.selectedAddress);
    if (normalized === undefined || rawResolution.resolutionCount !== 1) {state.outcome = "denied"; state.anomalyCode = "resolution_denied";
      return (await closeAndRecord(ports, operation, state, attempt)).receipt;}
    state.attemptCount = 1; state.upstreamClosure = "unknown";
    attempt = ports.transport.beginOpen({originHost: ports.route.originHost, originPort: ports.route.originPort,
      selectedAddress: normalized.selectedAddress, sni: ports.route.originHost, alpn: "http/1.1"});
    const session: HttpEgressTransportSession = await ports.clock.within(operation.limits.deadline,
      () => (attempt as HttpEgressTransportAttempt).ready(), operation.signal);
    const tls = session.binding; state.selectedPeer = tls.peerAddress; state.tlsProtocol = tls.tlsProtocol;
    state.certificateDigest = tls.certificateDigest; state.pinDigest = tls.spkiDigest ?? ""; state.alpn = tls.alpn;
    state.sniDigest = digest(ports, [encoder.encode(tls.observedSni)]);
    if (tls.peerAddress !== normalized.selectedAddress || tls.peerPort !== ports.route.originPort
      || tls.requestedSni !== ports.route.originHost || tls.observedSni !== ports.route.originHost
      || tls.chainValidated !== true || tls.dnsIdentity !== ports.route.originHost) {
      state.outcome = "denied"; state.anomalyCode = "transport_binding_drift";
      return (await closeAndRecord(ports, operation, state, attempt)).receipt;
    }
    if (!await observeReceipt(ports, paReceipt)) {state.outcome = "denied"; state.anomalyCode = "provider_generation_drift";
      return (await closeAndRecord(ports, operation, state, attempt)).receipt;}
    const resolver = Object.freeze({resolverIdentity: rawResolution.resolverIdentity,
      resolverEpoch: rawResolution.resolverEpoch, resolutionCount: 1 as const, addresses: rawResolution.addresses});
    const finalOutcome = await ports.runtimeSecurity.authorizeFirstApplicationByte({contractVersion:
      "provider-process-egress-final/v2", provisional, boundaryUseId: ids.boundaryUseId,
      connectionAttemptId: ids.connectionAttemptId, streamId: ids.streamId, transport: "tcp-tls", resolver,
      pinnedDestination: Object.freeze({address: normalized.selectedAddress, port: ports.route.originPort}),
      observedPeer: Object.freeze({address: tls.peerAddress, port: tls.peerPort}), tls: Object.freeze({
        sniHostname: tls.requestedSni, certificateValidated: tls.chainValidated, dnsIdentity: tls.dnsIdentity,
        certificateDigest: tls.certificateDigest, tlsPolicyDigest: tls.tlsPolicyDigest, alpn: tls.alpn}),
      request: requestProjection, redirectHop: 0});
    if (finalOutcome.status !== "authorized" || !verifiedGrant({grant: finalOutcome.grant, provisional,
      verifier: ports.verifier, expectedKey, ports, request: requestProjection, receipt: paReceipt, tls,
      boundaryUseId: ids.boundaryUseId, connectionAttemptId: ids.connectionAttemptId, streamId: ids.streamId})) {
      state.outcome = "denied"; state.anomalyCode = "final_denied";
      return (await closeAndRecord(ports, operation, state, attempt)).receipt;
    }
    const grant: HostHttpGrant = finalOutcome.grant; state.finalAuthorizationReceiptDigest = grant.finalAuthorizationDigest;
    const boundary = createHttpDispatchBoundary(prepared.wireBytes, () => {
      // The signed journal key is always consumed first. Every remaining check is synchronous.
      if (ports.journal.consume(grant.payload.consumption.journalKey,
        grant.payload.consumption.requestFingerprint) !== "consumed") {return false;}
      return !operation.signal?.aborted && ports.guard.snapshot().state === "active"
        && dispatchGrantIsCurrent(ports, grant) && session.binding === tls;
    });
    const dispatched = await ports.clock.within(operation.limits.deadline,
      () => session.dispatch(boundary.consume, operation.signal), operation.signal).finally(boundary.seal);
    state.firstByteState = boundary.wasConsumed() ? "uncertain" : "not_sent";
    const observed = observeHttpDispatch(dispatched, prepared.wireBytes.byteLength);
    if (observed.kind === "failed") {Object.assign(state, observed.evidence);
      return (await closeAndRecord(ports, operation, state, attempt)).receipt;}
    state.firstByteState = "sent"; state.upstreamRequestBytes = observed.upstreamRequestBytes;
    let rejectedStatus: HttpEgressAnomalyCode | undefined;
    Object.assign(state, await observeHttpResponse(observed.response, operation, ports.clock, status => {
      rejectedStatus = retryAnomaly(status); if (rejectedStatus !== undefined) {ports.guard.invalidate(lease); return false;}
      return true;
    }));
    if (rejectedStatus !== undefined) {state.anomalyCode = rejectedStatus; state.outcome = "denied";}
    const settled = await closeAndRecord(ports, operation, state, attempt);
    successful = settled.fullyAcknowledged;
    return settled.receipt;
  } catch (error) {
    if (error instanceof StrictHttpRequestError) {state.inboundRequestBytes = error.observedBytes;
      state.outcome = error.kind === "cancelled" ? "cancelled" : "rejected"; state.anomalyCode = requestError(error);}
    else {state.outcome = state.firstByteState === "not_sent" ? "denied" : "reconcile_required";
      if (state.anomalyCode === "inbound_malformed") {state.anomalyCode = "provider_access_denied";}}
    return (await closeAndRecord(ports, operation, state, attempt)).receipt;
  } finally {
    prepared?.dispose(); zeroHttpBytes(request?.body);
    ports.guard.finish(lease, successful ? Object.freeze({response: "observed_policy_accepted", delivery: "delivered",
      upstreamClosure: "closed", inboundClosure: "closed", evidenceAcknowledgement: "acknowledged"}) : undefined);
  }
}});
