import type {
  HttpEgressAnomalyCode,
  HttpEgressClosureState,
  HttpEgressFirstByteState,
  HttpEgressOperation,
  HttpEgressOutcome,
  HttpEgressReceipt,
} from "./http-egress-contracts.js";
import type {
  HttpEgressAuthorizationDecision,
  HttpEgressBrokerPorts,
  HttpEgressRoute,
  HttpEgressTransportSession,
} from "./http-egress-ports.js";
import { assertHttpEgressRoute, createOutboundHttpRequest, selectForwardedRequestHeaders } from "./http-outbound-request.js";
import { snapshotHttpEgressLimits } from "./http-egress-limits.js";
import { resolutionIsSafe } from "./public-address-policy.js";
import {
  canonicalRequestDigestParts,
  readStrictHttpRequest,
  StrictHttpRequestError,
} from "./strict-http-request.js";
import type { StrictHttpRequest } from "./strict-http-request.js";
import {
  forwardStrictHttpResponse,
  StrictHttpResponseError,
} from "./strict-http-response.js";

const encoder = new TextEncoder();

type ReceiptState = {
  outcome: HttpEgressOutcome;
  anomalyCode: HttpEgressAnomalyCode;
  requestDigest: string;
  provisionalAuthorizationReceiptDigest: string;
  finalAuthorizationReceiptDigest: string;
  routeReceiptDigest: string;
  materializationReceiptDigest: string;
  selectedPeer: string;
  tlsProtocol: string;
  sniDigest: string;
  certificateDigest: string;
  pinDigest: string;
  alpn: string;
  policyGeneration: string;
  keyGeneration: string;
  routeGeneration: string;
  credentialGeneration: string;
  inboundRequestBytes: number;
  upstreamRequestBytes: number;
  upstreamResponseBytes: number;
  outboundResponseBytes: number;
  outboundResponseWriteUncertain: boolean;
  firstByteState: HttpEgressFirstByteState;
  inboundClosure: HttpEgressClosureState;
  upstreamClosure: HttpEgressClosureState;
  inboundClosureReceiptDigest: string;
  upstreamClosureReceiptDigest: string;
  attemptCount: 0 | 1;
};

const initialState = (
  ports: HttpEgressBrokerPorts,
  operation: HttpEgressOperation,
): ReceiptState => ({
  outcome: "rejected",
  anomalyCode: "inbound_malformed",
  requestDigest: ports.evidence.digest([
    encoder.encode("agent-runtime.host-http-request-unavailable/v1\n"),
    encoder.encode(operation.expectedRequest.requestId),
  ]),
  provisionalAuthorizationReceiptDigest: "",
  finalAuthorizationReceiptDigest: "",
  routeReceiptDigest: "",
  materializationReceiptDigest: "",
  selectedPeer: "",
  tlsProtocol: "",
  sniDigest: "",
  certificateDigest: "",
  pinDigest: "",
  alpn: "",
  policyGeneration: "",
  keyGeneration: "",
  routeGeneration: "",
  credentialGeneration: "",
  inboundRequestBytes: 0,
  upstreamRequestBytes: 0,
  upstreamResponseBytes: 0,
  outboundResponseBytes: 0,
  outboundResponseWriteUncertain: false,
  firstByteState: "not_sent",
  inboundClosure: "not_opened",
  upstreamClosure: "not_opened",
  inboundClosureReceiptDigest: "",
  upstreamClosureReceiptDigest: "",
  attemptCount: 0,
});

const authorizationMatches = (
  decision: HttpEgressAuthorizationDecision,
  route: HttpEgressRoute,
  now: number,
): boolean => decision.decision === "allow"
  && now < decision.validUntil
  && decision.policyGeneration === route.policyGeneration
  && decision.keyGeneration === route.keyGeneration
  && decision.routeGeneration === route.routeGeneration
  && decision.credentialGeneration === route.credentialGeneration
  && decision.materializationReceiptDigest === route.materializationReceiptDigest;

const finalAuthorizationMatches = (
  decision: HttpEgressAuthorizationDecision,
  route: HttpEgressRoute,
  session: HttpEgressTransportSession,
  now: number,
): boolean => authorizationMatches(decision, route, now)
  && decision.selectedPeer === session.binding.peerAddress
  && decision.sniDigest === session.binding.sniDigest
  && decision.certificateDigest === session.binding.certificateDigest
  && decision.pinDigest === session.binding.pinDigest
  && decision.alpn === session.binding.alpn;

const bindingMatches = (
  route: HttpEgressRoute,
  selectedAddress: string,
  session: HttpEgressTransportSession,
): boolean => session.binding.peerAddress === selectedAddress
  && session.binding.sni === route.sni
  && session.binding.sniDigest === route.sniDigest
  && session.binding.certificateDigest === route.certificateDigest
  && session.binding.pinDigest === route.pinDigest
  && session.binding.alpn === route.alpn
  && (session.binding.tlsProtocol === "TLSv1.2" || session.binding.tlsProtocol === "TLSv1.3");

const generationsMatch = (
  route: HttpEgressRoute,
  observation: Awaited<ReturnType<HttpEgressBrokerPorts["routeAuthority"]["revalidate"]>>,
): boolean => observation.status === "current"
  && observation.policyGeneration === route.policyGeneration
  && observation.keyGeneration === route.keyGeneration
  && observation.routeGeneration === route.routeGeneration
  && observation.credentialGeneration === route.credentialGeneration
  && observation.materializationReceiptDigest === route.materializationReceiptDigest;

const requestErrorCode = (error: StrictHttpRequestError): HttpEgressAnomalyCode => ({
  cancelled: "inbound_cancelled",
  deadline: "inbound_deadline",
  headers_oversized: "inbound_headers_oversized",
  body_oversized: "inbound_body_oversized",
  malformed: "inbound_malformed",
  smuggling: "inbound_smuggling",
  route_mismatch: "inbound_route_mismatch",
})[error.kind] as HttpEgressAnomalyCode;

const responseErrorCode = (error: StrictHttpResponseError): HttpEgressAnomalyCode => ({
  cancelled: "inbound_cancelled",
  stalled: "upstream_stalled",
  malformed: "upstream_malformed",
  truncated: "upstream_truncated",
  oversized: "output_oversized",
  backpressure: "output_backpressure_failed",
  redirect: "redirect_rejected",
})[error.kind] as HttpEgressAnomalyCode;

const applyRoute = (state: ReceiptState, route: HttpEgressRoute): void => {
  state.routeReceiptDigest = route.routeReceiptDigest;
  state.materializationReceiptDigest = route.materializationReceiptDigest;
  state.sniDigest = route.sniDigest;
  state.certificateDigest = route.certificateDigest;
  state.pinDigest = route.pinDigest;
  state.alpn = route.alpn;
  state.policyGeneration = route.policyGeneration;
  state.keyGeneration = route.keyGeneration;
  state.routeGeneration = route.routeGeneration;
  state.credentialGeneration = route.credentialGeneration;
};

const immutableReceipt = (
  operation: HttpEgressOperation,
  state: ReceiptState,
): HttpEgressReceipt => Object.freeze({
  schema: "agent-runtime.host-http-egress-receipt/v1",
  operationId: operation.operationId,
  attemptId: operation.attemptId,
  requestId: operation.expectedRequest.requestId,
  ...state,
});

const closeFlows = async (
  ports: HttpEgressBrokerPorts,
  operation: HttpEgressOperation,
  state: ReceiptState,
  session: HttpEgressTransportSession | undefined,
): Promise<void> => {
  if (session !== undefined) {
    try {
      const closure = await ports.clock.within(operation.limits.closureDeadline, () => session.close());
      state.upstreamClosure = closure.state;
      state.upstreamClosureReceiptDigest = closure.receiptDigest;
    } catch {
      state.upstreamClosure = "unknown";
    }
  }
  try {
    const closure = await ports.clock.within(
      operation.limits.closureDeadline,
      () => operation.connection.close(state.outcome === "completed" ? "complete" : "abort"),
    );
    state.inboundClosure = closure.state;
    state.inboundClosureReceiptDigest = closure.receiptDigest;
  } catch {
    state.inboundClosure = "unknown";
  }
  if (state.inboundClosure !== "closed" || (session !== undefined && state.upstreamClosure !== "closed")) {
    state.anomalyCode = "closure_unproved";
    if (state.upstreamRequestBytes > 0 || state.firstByteState !== "not_sent") {state.outcome = "reconcile_required";}
  }
};

const settleEvidence = async (
  ports: HttpEgressBrokerPorts,
  operation: HttpEgressOperation,
  state: ReceiptState,
): Promise<HttpEgressReceipt> => {
  let receipt = immutableReceipt(operation, state);
  try {
    const result = await ports.clock.within(
      operation.limits.closureDeadline,
      () => ports.evidence.record(receipt),
    );
    if (result === "recorded") {return receipt;}
    state.anomalyCode = result === "conflict" ? "conflicting_replay" : "evidence_ack_lost";
  } catch {
    state.anomalyCode = "evidence_ack_lost";
  }
  if (state.upstreamRequestBytes > 0 || state.firstByteState !== "not_sent") {state.outcome = "reconcile_required";}
  receipt = immutableReceipt(operation, state);
  return receipt;
};

type ExecutionResources = { session?: HttpEgressTransportSession };
type ExecutionStageContext = Readonly<{
  ports: HttpEgressBrokerPorts;
  operation: HttpEgressOperation;
  state: ReceiptState;
  resources: ExecutionResources;
}>;
type Halted = Readonly<{ halted: true; receipt: HttpEgressReceipt }>;
type Continuing<T> = Readonly<{ halted: false; value: T }>;
type StageResult<T> = Halted | Continuing<T>;

const halt = async (
  ports: HttpEgressBrokerPorts,
  operation: HttpEgressOperation,
  state: ReceiptState,
  resources: ExecutionResources,
): Promise<Halted> => Object.freeze({
  halted: true,
  receipt: await settleAfterClose(ports, operation, state, resources.session),
});

const authorizeResolution = async (
  context: ExecutionStageContext,
  request: StrictHttpRequest,
): Promise<StageResult<Readonly<{ route: HttpEgressRoute; selectedAddress: string }>>> => {
  const { ports, operation, state, resources } = context;
  const observation = await ports.clock.within(
    operation.limits.deadline,
    () => ports.routeAuthority.observe(operation.operationId, operation.attemptId),
    operation.signal,
  );
  if (observation.status !== "available") {
    state.outcome = "denied";
    state.anomalyCode = "provider_access_denied";
    return await halt(ports, operation, state, resources);
  }
  assertHttpEgressRoute(observation.route);
  const route = Object.freeze({ ...observation.route,
    forwardedRequestHeaderNames: Object.freeze([...observation.route.forwardedRequestHeaderNames]) });
  state.requestDigest = ports.evidence.digest(canonicalRequestDigestParts(
    operation.expectedRequest.requestId, request, selectForwardedRequestHeaders(request, route),
  ));
  applyRoute(state, route);
  const provisionalInput = provisionalAuthorizationInput(operation, state, route);
  let provisional: HttpEgressAuthorizationDecision;
  try {
    provisional = await ports.clock.within(
      operation.limits.deadline,
      () => ports.provisionalAuthorization.authorize(provisionalInput),
      operation.signal,
    );
  } catch {
    state.outcome = operation.signal?.aborted ? "cancelled" : "denied";
    state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "provisional_timeout";
    return await halt(ports, operation, state, resources);
  }
  state.provisionalAuthorizationReceiptDigest = provisional.receiptDigest;
  if (!authorizationMatches(provisional, route, ports.clock.now())) {
    state.outcome = "denied";
    state.anomalyCode = "provisional_denied";
    return await halt(ports, operation, state, resources);
  }
  try {
    const resolution = await ports.clock.within(
      operation.limits.deadline,
      () => ports.resolver.resolve(route.originHost),
      operation.signal,
    );
    if (!resolutionIsSafe(resolution.addresses, resolution.selectedAddress)) {
      state.outcome = "denied";
      state.anomalyCode = "resolution_denied";
      return await halt(ports, operation, state, resources);
    }
    return Object.freeze({ halted: false, value: Object.freeze({ route, selectedAddress: resolution.selectedAddress }) });
  } catch {
    state.outcome = operation.signal?.aborted ? "cancelled" : "denied";
    state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "resolution_denied";
    return await halt(ports, operation, state, resources);
  }
};

const provisionalAuthorizationInput = (
  operation: HttpEgressOperation,
  state: ReceiptState,
  route: HttpEgressRoute,
) => Object.freeze({
  operationId: operation.operationId,
  attemptId: operation.attemptId,
  requestDigest: state.requestDigest,
  routeReceiptDigest: route.routeReceiptDigest,
  materializationReceiptDigest: route.materializationReceiptDigest,
  originHost: route.originHost,
  originPort: route.originPort,
  policyGeneration: route.policyGeneration,
  keyGeneration: route.keyGeneration,
  routeGeneration: route.routeGeneration,
  credentialGeneration: route.credentialGeneration,
});

const renderAuthorizedRequest = async (
  context: ExecutionStageContext,
  request: StrictHttpRequest,
  route: HttpEgressRoute,
): Promise<StageResult<Uint8Array>> => {
  const { ports, operation, state, resources } = context;
  const session = resources.session as HttpEgressTransportSession;
  const current = await ports.clock.within(
    operation.limits.deadline,
    () => ports.routeAuthority.revalidate(route.materializationReceiptDigest),
    operation.signal,
  );
  if (!generationsMatch(route, current)) {
    state.outcome = "denied";
    state.anomalyCode = "provider_generation_drift";
    return await halt(ports, operation, state, resources);
  }
  let authorization: Uint8Array;
  try {
    authorization = await ports.clock.within(
      operation.limits.deadline,
      () => ports.credentialCustody.renderAuthorization({
        operationId: operation.operationId, attemptId: operation.attemptId,
        materializationReceiptDigest: route.materializationReceiptDigest,
      }),
      operation.signal,
    );
  } catch {
    state.outcome = operation.signal?.aborted ? "cancelled" : "denied";
    state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "credential_render_failed";
    return await halt(ports, operation, state, resources);
  }
  let outboundRequest: Uint8Array;
  try {
    outboundRequest = createOutboundHttpRequest(request, route, authorization);
  } catch {
    authorization.fill(0);
    state.outcome = "denied";
    state.anomalyCode = "credential_render_failed";
    return await halt(ports, operation, state, resources);
  }
  authorization.fill(0);
  const finalInput = Object.freeze({ ...provisionalAuthorizationInput(operation, state, route),
    selectedPeer: session.binding.peerAddress,
    sniDigest: session.binding.sniDigest,
    certificateDigest: session.binding.certificateDigest,
    pinDigest: session.binding.pinDigest,
    alpn: session.binding.alpn,
  });
  let finalDecision: HttpEgressAuthorizationDecision;
  try {
    finalDecision = await ports.clock.within(
      operation.limits.deadline,
      () => ports.finalAuthorization.authorize(finalInput),
      operation.signal,
    );
  } catch {
    outboundRequest.fill(0);
    state.outcome = operation.signal?.aborted ? "cancelled" : "denied";
    state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "final_timeout";
    return await halt(ports, operation, state, resources);
  }
  state.finalAuthorizationReceiptDigest = finalDecision.receiptDigest;
  if (!finalAuthorizationMatches(finalDecision, route, session, ports.clock.now())) {
    outboundRequest.fill(0);
    state.outcome = "denied";
    state.anomalyCode = "final_denied";
    return await halt(ports, operation, state, resources);
  }
  return Object.freeze({ halted: false, value: outboundRequest });
};

const openAuthorizedSession = async (
  context: ExecutionStageContext,
  request: StrictHttpRequest,
  input: Readonly<{ route: HttpEgressRoute; selectedAddress: string }>,
): Promise<StageResult<Uint8Array>> => {
  const { ports, operation, state, resources } = context;
  state.attemptCount = 1;
  try {
    resources.session = await ports.clock.within(operation.limits.deadline, () => ports.transport.open({
      originHost: input.route.originHost,
      originPort: input.route.originPort,
      selectedAddress: input.selectedAddress,
      sni: input.route.sni,
      alpn: input.route.alpn,
    }), operation.signal);
  } catch {
    state.outcome = operation.signal?.aborted ? "cancelled" : "denied";
    state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "transport_open_failed";
    return await halt(ports, operation, state, resources);
  }
  const session = resources.session;
  state.selectedPeer = session.binding.peerAddress;
  state.tlsProtocol = session.binding.tlsProtocol;
  if (!bindingMatches(input.route, input.selectedAddress, session)) {
    state.outcome = "denied";
    state.anomalyCode = "transport_binding_drift";
    return await halt(ports, operation, state, resources);
  }
  return await renderAuthorizedRequest(context, request, input.route);
};

const responseAnomaly = (status: number): HttpEgressAnomalyCode => {
  if (status === 401 || status === 403) {return "upstream_auth_rejected";}
  if (status === 429) {return "upstream_rate_limited";}
  if (status >= 500) {return "upstream_server_error";}
  return "none";
};

const dispatchOnce = async (
  ports: HttpEgressBrokerPorts,
  operation: HttpEgressOperation,
  state: ReceiptState,
  resources: ExecutionResources,
  outboundRequest: Uint8Array,
): Promise<HttpEgressReceipt> => {
  const session = resources.session as HttpEgressTransportSession;
  let dispatch;
  try {
    dispatch = await ports.clock.within(
      operation.limits.deadline,
      () => session.dispatch(outboundRequest, operation.signal),
      operation.signal,
    );
  } catch {
    outboundRequest.fill(0);
    state.firstByteState = "uncertain";
    state.outcome = "reconcile_required";
    state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "upstream_write_failed";
    return (await halt(ports, operation, state, resources)).receipt;
  }
  outboundRequest.fill(0);
  if (dispatch.acceptedRequestBytes === "unknown"
    || !Number.isSafeInteger(dispatch.acceptedRequestBytes)
    || dispatch.acceptedRequestBytes < 0 || dispatch.acceptedRequestBytes > outboundRequest.byteLength) {
    state.firstByteState = "uncertain";
    state.outcome = "reconcile_required";
    state.anomalyCode = "upstream_write_failed";
    return (await halt(ports, operation, state, resources)).receipt;
  }
  state.upstreamRequestBytes = dispatch.acceptedRequestBytes;
  state.firstByteState = dispatch.acceptedRequestBytes > 0 ? "sent" : "not_sent";
  if (dispatch.status === "response" && dispatch.acceptedRequestBytes !== outboundRequest.byteLength) {
    state.outcome = "reconcile_required";
    state.anomalyCode = "upstream_write_failed";
    if (dispatch.acceptedRequestBytes === 0) {state.firstByteState = "uncertain";}
    return (await halt(ports, operation, state, resources)).receipt;
  }
  if (dispatch.acknowledgement === "lost" || dispatch.status === "failed") {
    state.outcome = dispatch.acceptedRequestBytes > 0 ? "reconcile_required" : "denied";
    state.anomalyCode = dispatch.acknowledgement === "lost" ? "upstream_ack_lost" : "upstream_write_failed";
    return (await halt(ports, operation, state, resources)).receipt;
  }
  try {
    const response = await forwardStrictHttpResponse(
      dispatch.response,
      operation.connection,
      operation.limits,
      ports.clock,
      operation.signal,
    );
    state.upstreamResponseBytes = response.upstreamBytes;
    state.outboundResponseBytes = response.outboundBytes;
    state.outcome = "completed";
    state.anomalyCode = responseAnomaly(response.status);
  } catch (error) {
    if (!(error instanceof StrictHttpResponseError)) {throw error;}
    state.upstreamResponseBytes = error.upstreamBytes;
    state.outboundResponseBytes = error.outboundBytes;
    state.outboundResponseWriteUncertain = error.outboundWriteUncertain;
    state.outcome = error.kind === "redirect" ? "denied" : "reconcile_required";
    state.anomalyCode = responseErrorCode(error);
  }
  return (await halt(ports, operation, state, resources)).receipt;
};

export const createStrictHttpEgressBroker = (ports: HttpEgressBrokerPorts): Readonly<{
  execute(operation: HttpEgressOperation): Promise<HttpEgressReceipt>;
}> => Object.freeze({
  execute: async (input: HttpEgressOperation): Promise<HttpEgressReceipt> => {
    // Invalid configuration never transfers connection custody to this broker.
    const operation = Object.freeze({ ...input, limits: snapshotHttpEgressLimits(input.limits) });
    const state = initialState(ports, operation);
    const resources: ExecutionResources = {};
    try {
      const request = await readStrictHttpRequest(
        operation.connection.request,
        operation.expectedRequest,
        operation.limits,
        ports.clock,
        operation.signal,
      );
      state.inboundRequestBytes = request.wireBytes;
      const context = Object.freeze({ ports, operation, state, resources });
      const authority = await authorizeResolution(context, request);
      if (authority.halted) {return authority.receipt;}
      const prepared = await openAuthorizedSession(context, request, authority.value);
      if (prepared.halted) {return prepared.receipt;}
      return await dispatchOnce(ports, operation, state, resources, prepared.value);
    } catch (error) {
      if (error instanceof StrictHttpRequestError) {
        state.outcome = error.kind === "cancelled" ? "cancelled" : "rejected";
        state.anomalyCode = requestErrorCode(error);
      } else {
        state.outcome = state.firstByteState === "not_sent"
          ? (operation.signal?.aborted ? "cancelled" : "denied") : "reconcile_required";
        state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "provider_access_denied";
      }
      return await settleAfterClose(ports, operation, state, resources.session);
    }
  },
});

const settleAfterClose = async (
  ports: HttpEgressBrokerPorts,
  operation: HttpEgressOperation,
  state: ReceiptState,
  session: HttpEgressTransportSession | undefined,
): Promise<HttpEgressReceipt> => {
  await closeFlows(ports, operation, state, session);
  return await settleEvidence(ports, operation, state);
};
