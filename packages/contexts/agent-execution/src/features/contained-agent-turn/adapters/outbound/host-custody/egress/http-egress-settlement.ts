import type {HttpEgressAnomalyCode, HttpEgressClosureState, HttpEgressOperation, HttpEgressOutcome,
  HttpEgressReceipt} from "./http-egress-contracts.js";
import type {HostHttpAdmissionLease} from "./host-http-admission-guard.js";
import type {HostHttpGrant, HttpEgressBrokerPorts, HttpEgressTransportAttempt, HttpEgressTransportSession,
  HttpEgressTransportBinding} from "./http-egress-ports.js";
import type {PreparedHttpRequestV1} from "./prepared-http-request-v1.js";
import {createHttpDispatchBoundary} from "./http-dispatch-boundary.js";
import {observeHttpDispatch} from "./http-dispatch-observation.js";
import {observeHttpResponse} from "./http-response-observation.js";
import {snapshotHttpClosureDecision} from "./http-receipt-validation.js";
import {dispatchGrantIsCurrent} from "./http-egress-runtime-security-v2.js";

export type HttpEgressMutableState = {
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

export const initialHttpEgressState = (): HttpEgressMutableState => ({outcome: "rejected", anomalyCode: "inbound_malformed",
  requestDigest: "", provisionalAuthorizationReceiptDigest: "", finalAuthorizationReceiptDigest: "",
  routeReceiptDigest: "", materializationReceiptDigest: "", selectedPeer: "", tlsProtocol: "", sniDigest: "",
  certificateDigest: "", pinDigest: "", alpn: "", policyGeneration: "", keyGeneration: "", routeGeneration: "",
  credentialGeneration: "", inboundRequestBytes: 0, upstreamRequestBytes: 0, upstreamResponseBytes: 0,
  outboundResponseBytes: 0, outboundResponseWriteUncertain: false, firstByteState: "not_sent",
  inboundClosure: "not_opened", upstreamClosure: "not_opened", inboundClosureReceiptDigest: "",
  upstreamClosureReceiptDigest: "", attemptCount: 0});

const immutableReceipt = (operation: HttpEgressOperation, state: HttpEgressMutableState): HttpEgressReceipt => Object.freeze({
  schema: "agent-runtime.host-http-egress-receipt/v1", operationId: operation.operationId,
  attemptId: operation.attemptId, requestId: operation.expectedRequest.requestId, ...state});

const applyHttpClosureDisposition = (state: HttpEgressMutableState, hasAttempt: boolean): void => {
  hasAttempt ||= state.attemptCount === 1;
  if (state.inboundClosure !== "closed" || (hasAttempt && state.upstreamClosure !== "closed")) {
    state.anomalyCode = "closure_unproved";
    if (hasAttempt || state.firstByteState !== "not_sent") {state.outcome = "reconcile_required";}}
};

// Initiation is custody work, not an acknowledgement-budget decision. Observe
// rejections immediately, including when the deadline prevents awaiting the result.
const initiateHttpClosure = (close: () => Promise<unknown>) => {
  try {const pending = close(); void pending.catch(() => {}); return pending;}
  catch {return Promise.resolve();}
};

export const closeAndRecordHttpEgress = async (ports: HttpEgressBrokerPorts, operation: HttpEgressOperation,
  state: HttpEgressMutableState, attempt?: HttpEgressTransportAttempt): Promise<Readonly<{
    receipt: HttpEgressReceipt; fullyAcknowledged: boolean}>> => {
  const upstream = attempt === undefined ? undefined : initiateHttpClosure(() => attempt.close());
  const inbound = initiateHttpClosure(() => operation.connection.close(state.outcome === "completed" ? "complete" : "abort"));
  const acknowledge = async (pending: ReturnType<typeof initiateHttpClosure>) => {
    try {return snapshotHttpClosureDecision(await ports.clock.within(operation.limits.closureDeadline, () => pending));}
    catch {return;}
  };
  const [upstreamValue, inboundValue] = await Promise.all([
    upstream === undefined ? undefined : acknowledge(upstream), acknowledge(inbound),
  ]);
  if (upstream !== undefined) {state.upstreamClosure = upstreamValue?.state ?? "unknown";
    state.upstreamClosureReceiptDigest = upstreamValue?.receiptDigest ?? "";}
  state.inboundClosure = inboundValue?.state ?? "unknown";
  state.inboundClosureReceiptDigest = inboundValue?.receiptDigest ?? "";
  applyHttpClosureDisposition(state, attempt !== undefined);
  let receipt = immutableReceipt(operation, state); let recorded = false;
  try {const result = await ports.clock.within(operation.limits.closureDeadline, () => ports.evidence.record(receipt));
    recorded = result === "recorded";
    if (!recorded) {state.anomalyCode = result === "conflict" ? "conflicting_replay" : "evidence_ack_lost";}
  } catch {state.anomalyCode = "evidence_ack_lost";}
  if (!recorded && state.firstByteState !== "not_sent") {state.outcome = "reconcile_required";}
  receipt = immutableReceipt(operation, state);
  return Object.freeze({receipt, fullyAcknowledged: recorded && state.outcome === "completed"
    && state.inboundClosure === "closed" && state.upstreamClosure === "closed"});
};

const retryAnomaly = (status: number): HttpEgressAnomalyCode | undefined => status === 401 || status === 403
  ? "upstream_auth_rejected" : status === 429 ? "upstream_rate_limited" : status >= 500
    ? "upstream_server_error" : status >= 300 && status <= 399 ? "redirect_rejected" : undefined;

export const settleHttpEgressDispatch = async (input: Readonly<{ports: HttpEgressBrokerPorts;
  operation: HttpEgressOperation; state: HttpEgressMutableState; attempt: HttpEgressTransportAttempt;
  session: HttpEgressTransportSession; tls: HttpEgressTransportBinding; grant: HostHttpGrant;
  prepared: PreparedHttpRequestV1; lease: HostHttpAdmissionLease}>): Promise<Readonly<{
    receipt: HttpEgressReceipt; fullyAcknowledged: boolean}>> => {
  const {ports, operation, state, attempt, session, tls, grant, prepared, lease} = input;
  let boundaryAnomaly: HttpEgressAnomalyCode = "upstream_write_failed";
  const boundary = createHttpDispatchBoundary(prepared.wireBytes, () => {
    if (ports.journal.consume(grant.payload.consumption.journalKey,
      grant.payload.consumption.requestFingerprint) !== "consumed") {boundaryAnomaly = "final_denied"; return false;}
    if (operation.signal?.aborted) {boundaryAnomaly = "inbound_cancelled"; return false;}
    if (ports.guard.snapshot().state !== "active" || !dispatchGrantIsCurrent(ports, grant)) {
      boundaryAnomaly = "provider_generation_drift"; return false;}
    if (session.binding !== tls) {boundaryAnomaly = "transport_binding_drift"; return false;}
    state.firstByteState = "uncertain"; return true;
  });
  const dispatched = await ports.clock.within(operation.limits.deadline,
    () => session.dispatch(boundary.consume, operation.signal), operation.signal).finally(boundary.seal);
  state.firstByteState = boundary.wasConsumed() ? "uncertain" : "not_sent";
  if (!boundary.wasConsumed() && dispatched.status === "response") {state.firstByteState = "uncertain";
    state.outcome = "reconcile_required"; state.anomalyCode = "upstream_ack_lost";
    return closeAndRecordHttpEgress(ports, operation, state, attempt);}
  const observed = observeHttpDispatch(dispatched, prepared.wireBytes.byteLength);
  if (observed.kind === "failed") {Object.assign(state, observed.evidence);
    if (!boundary.wasConsumed()) {state.anomalyCode = boundaryAnomaly;}
    return closeAndRecordHttpEgress(ports, operation, state, attempt);}
  state.firstByteState = "sent"; state.upstreamRequestBytes = observed.upstreamRequestBytes;
  let rejectedStatus: HttpEgressAnomalyCode | undefined;
  Object.assign(state, await observeHttpResponse(observed.response, {...operation, limits: {...operation.limits,
    maxOutputBytes: Math.min(operation.limits.maxOutputBytes, grant.payload.limits.responseBytes)}}, ports.clock, status => {
    rejectedStatus = retryAnomaly(status); if (rejectedStatus !== undefined) {ports.guard.invalidate(lease); return false;}
    return true;}));
  if (rejectedStatus !== undefined) {state.anomalyCode = rejectedStatus; state.outcome = "denied";}
  return closeAndRecordHttpEgress(ports, operation, state, attempt);
};
