import { types as utilTypes } from "node:util";
import type { HttpEgressAnomalyCode, HttpEgressOperation, HttpEgressReceipt } from "./http-egress-contracts.js";
import type { HostHttpGrant, HttpEgressBrokerPorts, HttpEgressTransportAttempt,
  HttpEgressTransportSession, HttpEgressTransportBinding } from "./http-egress-ports.js";
import { createPreparedHttpRequestV1, type PreparedHttpRequestV1, type PreparedHttpRequestCustodyV1 } from "./prepared-http-request-v1.js";
import { intrinsicUint8ArrayLength, zeroHttpBytes } from "./http-byte-intrinsics.js";
import { snapshotHttpEgressOperation } from "./http-ingress-validation.js";
import { normalizeHttpResolverEvidence } from "./http-egress-resolver-evidence.js";
import { normalizePublicAddress } from "./public-address-policy.js";
import { readStrictHttpRequest, StrictHttpRequestError, type StrictHttpRequest } from "./strict-http-request.js";
import { verifiedGrant, verifiedProvisional } from "./http-egress-runtime-security-v2.js";
import { bindMaterializationRequestDigest, materializationAuthorizationRequest, observeMaterializationReceipt, presentationFields,
  projectPreparedRequest, receiptMatchesSnapshot, snapshotHostHttpRoute } from "./http-egress-session-authority.js";
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
  // Validate data descriptors before reading names; never execute materializer accessors.
  if (!Array.isArray(fields) || utilTypes.isProxy(fields)) {throw new TypeError("credential fields mismatch");}
  const descriptors = Object.getOwnPropertyDescriptors(fields);
  const length = Object.getOwnPropertyDescriptor(fields, "length")?.value;
  if (length !== ports.route.credentialFieldNames.length || Reflect.ownKeys(descriptors).length !== length + 1) {
    throw new TypeError("credential fields mismatch");
  }
  for (let index = 0; index < length; index += 1) {
    const field = descriptors[String(index)]?.value;
    if (typeof field !== "object" || field === null || utilTypes.isProxy(field)) {throw new TypeError("credential fields mismatch");}
    const name = Object.getOwnPropertyDescriptor(field, "name");
    const value = Object.getOwnPropertyDescriptor(field, "valueBytes");
    if (name === undefined || !("value" in name) || name.value !== ports.route.credentialFieldNames[index]
      || value === undefined || !("value" in value)) {throw new TypeError("credential fields mismatch");}
  }
  const host = ports.route.originPort === 443 ? ports.route.originHost : `${ports.route.originHost}:${ports.route.originPort}`;
  return createPreparedHttpRequestV1({methodBytes: encoder.encode(ports.route.upstreamMethod),
    targetBytes: encoder.encode(ports.route.upstreamPath), hostBytes: encoder.encode(host),
    credentialHeaderNameAllowlist: ports.route.credentialFieldNames,
    presentationFields: forwardedFields, credentialFields: fields, bodyBytes: request.body});
};

const consumePreparedRequest = (prepared: PreparedHttpRequestV1): PreparedHttpRequestCustodyV1 => {
  const custody = prepared.consume();
  if (custody === undefined) {throw new TypeError("prepared request already consumed");}
  return custody;
};

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const viewGetters = [DataView.prototype, typedArrayPrototype].map(prototype => ({
  buffer: Object.getOwnPropertyDescriptor(prototype, "buffer")!.get!,
  byteOffset: Object.getOwnPropertyDescriptor(prototype, "byteOffset")!.get!,
  byteLength: Object.getOwnPropertyDescriptor(prototype, "byteLength")!.get!,
}));
const typedArrayValues = Uint8Array.prototype.values;

// Read internal view slots, never instance properties; clear only the visible byte range.
const zeroMaterializedView = (value: object): boolean => {
  try {
    if (intrinsicUint8ArrayLength(value) !== undefined) {zeroHttpBytes(value); return true;}
    if (!ArrayBuffer.isView(value)) {return true;}
    const dataView = utilTypes.isDataView(value);
    // Typed-array getters alone report zero for detached or out-of-bounds views.
    if (!dataView) {Reflect.apply(typedArrayValues, value, []);}
    const getters = viewGetters[dataView ? 0 : 1]!;
    const buffer = Reflect.apply(getters.buffer, value, []);
    const offset = Reflect.apply(getters.byteOffset, value, []);
    const length = Reflect.apply(getters.byteLength, value, []);
    zeroHttpBytes(new Uint8Array(buffer, offset, length));
    return true;
  } catch {return false;}
};

// Walk own data properties, including malformed entries and non-index properties. Holes,
// accessors and proxies must never interrupt cleanup of independently reachable buffers.
const zeroMaterializedFields = (fields: unknown): boolean => {
  const pending: unknown[] = [fields]; const seen = new Set<object>(); let certain = true;
  while (pending.length !== 0) {
    const value = pending.pop();
    if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) {continue;}
    seen.add(value);
    if (utilTypes.isProxy(value)) {certain = false; continue;}
    if (!zeroMaterializedView(value)) {certain = false;}
    try {
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined && "value" in descriptor) {pending.push(descriptor.value);}
        else {certain = false;}
      }
    } catch {certain = false;}
  }
  return certain;
};

const zeroLateMaterializedFields = (pendingFields: Promise<MaterializedFields> | undefined): void => {
  void pendingFields?.then(values => zeroMaterializedFields(values), () => false);
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

const recordAuthorityFailure = (operation: HttpEgressOperation, state: HttpEgressMutableState,
  anomaly: HttpEgressAnomalyCode): void => {
  state.outcome = operation.signal?.aborted ? "cancelled" : "denied";
  state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : anomaly;
};

const observeTransportBinding = (ports: HttpEgressBrokerPorts, state: HttpEgressMutableState,
  tls: HttpEgressTransportBinding, selectedAddress: string): boolean => {
  state.selectedPeer = tls.peerAddress; state.tlsProtocol = tls.tlsProtocol;
  state.certificateDigest = tls.certificateDigest; state.pinDigest = tls.spkiDigest ?? ""; state.alpn = tls.alpn;
  state.sniDigest = digest(ports, [encoder.encode(tls.observedSni)]);
  if (normalizePublicAddress(tls.peerAddress) !== selectedAddress || tls.peerPort !== ports.route.originPort
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

export const createStrictHttpEgressBroker = (dependencies: HttpEgressBrokerPorts): Readonly<{
  execute(operation: HttpEgressOperation): Promise<HttpEgressReceipt>;
}> => Object.freeze({execute: async (input): Promise<HttpEgressReceipt> => {
  const operation = snapshotHttpEgressOperation(input);
  const state = initialHttpEgressState(); let request: StrictHttpRequest | undefined; let attempt: HttpEgressTransportAttempt | undefined;
  let prepared: PreparedHttpRequestV1 | undefined;
  let custody: PreparedHttpRequestCustodyV1 | undefined;
  const lease = dependencies.guard.acquire();
  let cleanupCertain = true; let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) {return;} cleaned = true;
    // dispose can fail before clearing its second owned allocation. Clear each independently.
    for (const action of [() => {if (custody === undefined) {prepared?.dispose();} else {custody.dispose();}},
      () => zeroHttpBytes(request?.body)]) {
      try {action();} catch {cleanupCertain = false;}
    }
    if (!cleanupCertain) {state.outcome = "reconcile_required"; state.anomalyCode = "closure_unproved";}
  };
  const ports: HttpEgressBrokerPorts = {...dependencies, evidence: {digest: parts => dependencies.evidence.digest(parts), record: receipt => {
    cleanup();
    return dependencies.evidence.record(Object.freeze({...receipt, outcome: state.outcome, anomalyCode: state.anomalyCode}));
  }}};
  const within = <T>(action: () => Promise<T>): Promise<T> =>
    ports.clock.within(operation.limits.deadline, action, operation.signal);
  // Parsing is allowed before admission acquisition, but this implementation acquires first so no hostile
  // inbound stream can hold unreserved session work. No fresh boundary ID or owner call precedes this point.
  if (lease === undefined) {return (await closeAndRecordHttpEgress(ports, operation, state)).receipt;}
  let successful = false;
  const run = async (): Promise<HttpEgressReceipt> => {try {
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
    const unsignedMaterializationRequest = materializationAuthorizationRequest(
      ports, ids.materializationAuthorizationId,
    );
    let materializationRequest;
    try {
      materializationRequest = bindMaterializationRequestDigest(
        unsignedMaterializationRequest,
        await within(() => ports.providerAccess.createRequestDigest(unsignedMaterializationRequest)),
      );
    } catch {
      materializationRequest = undefined;
    }
    if (materializationRequest === undefined) {recordAuthorityFailure(operation, state, "provider_access_denied");
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    const pa = await within(() => ports.providerAccess.authorize(materializationRequest));
    if (pa.kind !== "authorized" || !receiptMatchesSnapshot(pa.receipt, ports,
      ids.materializationAuthorizationId, materializationRequest.requestDigest)) {state.outcome = "denied";
      state.anomalyCode = "provider_access_denied";
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    const paReceipt = pa.receipt; state.materializationReceiptDigest = digest(ports, [encoder.encode(JSON.stringify(paReceipt))]);
    state.routeGeneration = String(paReceipt.bindingRevision); state.credentialGeneration = String(paReceipt.credentialGeneration);
    let pendingFields: Promise<readonly Readonly<{name: string; valueBytes: Uint8Array}>[]> | undefined;
    let fields: readonly Readonly<{name: string; valueBytes: Uint8Array}>[];
    try {fields = await ports.clock.within(operation.limits.deadline, () => {
      pendingFields = ports.materializer.render(paReceipt); return pendingFields;
    }, operation.signal);} catch {zeroLateMaterializedFields(pendingFields); recordAuthorityFailure(operation, state, "credential_render_failed");
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    try {prepared = prepareMaterializedRequest(ports, request, forwardedFields, fields);}
    finally {cleanupCertain = zeroMaterializedFields(fields);}
    if (!cleanupCertain) {throw new TypeError("credential cleanup unproved");}
    if (!await within(() => observeMaterializationReceipt(ports, paReceipt))) {state.outcome = "denied"; state.anomalyCode = "provider_generation_drift";
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    custody = consumePreparedRequest(prepared);
    const requestProjection = projectPreparedRequest(ports, custody, paReceipt);
    let provisionalOutcome: Awaited<ReturnType<typeof ports.runtimeSecurity.requestProvisional>>;
    try {provisionalOutcome = await within(() => ports.runtimeSecurity.requestProvisional({contractVersion:
      "provider-process-egress-provisional/v2", authorizationRequestId: ids.runtimeAuthorizationId, request: requestProjection}));
    } catch {recordAuthorityFailure(operation, state, "provisional_timeout");
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    const expectedKey = ports.verifier.signingKey;
    if (provisionalOutcome.status !== "authorized" || !verifiedProvisional({decision: provisionalOutcome.decision,
      verifier: ports.verifier, expectedKey, ports, authorizationRequestId: ids.runtimeAuthorizationId,
      request: requestProjection, receipt: paReceipt})) {state.outcome = "denied"; state.anomalyCode = "provisional_denied";
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    const provisional = provisionalOutcome.decision; state.provisionalAuthorizationReceiptDigest = provisional.decisionDigest;
    state.policyGeneration = provisional.policy.policyGeneration; state.keyGeneration = provisional.signingKey.keyGeneration;
    let rawResolution: Awaited<ReturnType<typeof ports.resolver.resolve>>;
    try {rawResolution = await within(() => ports.resolver.resolve(ports.route.originHost));} catch {recordAuthorityFailure(operation, state, "resolution_denied"); return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    const normalized = normalizeHttpResolverEvidence(rawResolution);
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
    } catch {recordAuthorityFailure(operation, state, "transport_open_failed");
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    const tls = session.binding;
    if (!observeTransportBinding(ports, state, tls, normalized.selectedAddress)) {
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    if (!await within(() => observeMaterializationReceipt(ports, paReceipt))) {state.outcome = "denied"; state.anomalyCode = "provider_generation_drift";
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    const resolver = Object.freeze({resolverIdentity: normalized.resolverIdentity,
      resolverEpoch: normalized.resolverEpoch, resolutionCount: 1 as const, addresses: normalized.addresses});
    let finalOutcome: Awaited<ReturnType<typeof ports.runtimeSecurity.authorizeFirstApplicationByte>>;
    try {finalOutcome = await within(() => ports.runtimeSecurity.authorizeFirstApplicationByte({contractVersion:
      "provider-process-egress-final/v2", provisional, boundaryUseId: ids.boundaryUseId,
      connectionAttemptId: ids.connectionAttemptId, streamId: ids.streamId, transport: "tcp-tls", resolver,
      pinnedDestination: Object.freeze({address: normalized.selectedAddress, port: ports.route.originPort}),
      observedPeer: Object.freeze({address: tls.peerAddress, port: tls.peerPort}), tls: Object.freeze({
        sniHostname: tls.requestedSni, certificateValidated: tls.chainValidated, dnsIdentity: tls.dnsIdentity,
        certificateDigest: tls.certificateDigest, tlsPolicyDigest: tls.tlsPolicyDigest, alpn: tls.alpn}),
      request: requestProjection, redirectHop: 0}));} catch {recordAuthorityFailure(operation, state, "final_timeout");
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;}
    if (finalOutcome.status !== "authorized" || !verifiedGrant({grant: finalOutcome.grant, provisional,
      verifier: ports.verifier, expectedKey, ports, request: requestProjection, receipt: paReceipt, tls,
      boundaryUseId: ids.boundaryUseId, connectionAttemptId: ids.connectionAttemptId, streamId: ids.streamId,
      resolver, selectedAddress: normalized.selectedAddress})) {
      state.outcome = "denied"; state.anomalyCode = "final_denied";
      return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;
    }
    const grant: HostHttpGrant = finalOutcome.grant; state.finalAuthorizationReceiptDigest = grant.finalAuthorizationDigest;
    const settled = await settleHttpEgressDispatch({ports, operation, state, attempt, session, tls, grant, prepared: custody, lease});
    successful = settled.fullyAcknowledged;
    return settled.receipt;
  } catch (error) {
    recordExecutionError(operation, state, error);
    return (await closeAndRecordHttpEgress(ports, operation, state, attempt)).receipt;
  }};
  let receipt: HttpEgressReceipt;
  try {receipt = await run();}
  finally {
    try {cleanup();} finally {
      ports.guard.finish(lease, successful && cleanupCertain ? Object.freeze({response: "observed_policy_accepted",
        delivery: "delivered", upstreamClosure: "closed", inboundClosure: "closed", evidenceAcknowledgement: "acknowledged"}) : undefined);
    }
  }
  return cleanupCertain ? receipt : Object.freeze({...receipt, outcome: state.outcome, anomalyCode: state.anomalyCode});
}});
