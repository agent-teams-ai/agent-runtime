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
  HttpEgressFinalAuthorizationDecision,
  HttpEgressRoute,
  HttpEgressTransportAttempt,
  HttpEgressTransportBinding,
  HttpEgressTransportSession,
} from "./http-egress-ports.js";
import {
  createHttpEgressFinalAuthorization,
  snapshotHttpEgressTransportBinding,
} from "./http-final-authorization-binding.js";
import { assertHttpEgressRoute, createOutboundHttpRequest, selectForwardedRequestHeaders } from "./http-outbound-request.js";
import { snapshotHttpEgressLimits } from "./http-egress-limits.js";
import { createHttpDispatchBoundary } from "./http-dispatch-boundary.js";
import { observeHttpDispatch } from "./http-dispatch-observation.js";
import { observeHttpResponse } from "./http-response-observation.js";
import { normalizeHttpEgressResolution } from "./public-address-policy.js";
import type { NormalizedHttpEgressResolution } from "./public-address-policy.js";
import {
  canonicalRequestDigestParts,
  readStrictHttpRequest,
  StrictHttpRequestError,
} from "./strict-http-request.js";
import type { StrictHttpRequest } from "./strict-http-request.js";

const encoder = new TextEncoder();
const zeroLateBytes = (pending: Promise<Uint8Array> | undefined): void =>
  void pending?.then(value => value.fill(0), () => {});

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
  && Number.isFinite(now) && Number.isFinite(decision.validUntil)
  && now < decision.validUntil
  && decision.policyGeneration === route.policyGeneration
  && decision.keyGeneration === route.keyGeneration
  && decision.routeGeneration === route.routeGeneration
  && decision.credentialGeneration === route.credentialGeneration
  && decision.materializationReceiptDigest === route.materializationReceiptDigest;

const finalAuthorizationMatches = (
  decision: HttpEgressFinalAuthorizationDecision,
  bindingDigest: string,
  route: HttpEgressRoute,
  now: number,
): boolean => authorizationMatches(decision, route, now)
  && decision.bindingDigest === bindingDigest;

const bindingMatches = (
  route: HttpEgressRoute,
  selectedAddress: string,
  binding: HttpEgressTransportBinding,
): boolean => binding.peerAddress === selectedAddress
  && Number.isSafeInteger(binding.peerPort)
  && binding.peerPort === route.originPort
  && binding.sni === route.sni
  && binding.sniDigest === route.sniDigest
  && binding.certificateDigest === route.certificateDigest
  && binding.pinDigest === route.pinDigest
  && binding.alpn === "http/1.1"
  && route.alpn === "http/1.1"
  && (binding.tlsProtocol === "TLSv1.2" || binding.tlsProtocol === "TLSv1.3");

const transportBindingUnchanged = (
  authorized: HttpEgressTransportBinding,
  current: HttpEgressTransportBinding,
): boolean => authorized.peerAddress === current.peerAddress
  && authorized.peerPort === current.peerPort
  && authorized.tlsProtocol === current.tlsProtocol
  && authorized.sni === current.sni
  && authorized.sniDigest === current.sniDigest
  && authorized.certificateDigest === current.certificateDigest
  && authorized.pinDigest === current.pinDigest
  && authorized.alpn === current.alpn;

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
  attempt: HttpEgressTransportAttempt | undefined,
): Promise<void> => {
  if (attempt !== undefined) {
    try {
      const closure = await ports.clock.within(operation.limits.closureDeadline, () => attempt.close());
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
  if (state.inboundClosure !== "closed" || (attempt !== undefined && state.upstreamClosure !== "closed")) {
    state.anomalyCode = "closure_unproved";
    if (attempt !== undefined && state.upstreamClosure !== "closed") {state.outcome = "reconcile_required";}
    else if (state.upstreamRequestBytes > 0 || state.firstByteState !== "not_sent") {state.outcome = "reconcile_required";}
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

type ExecutionResources = { attempt?: HttpEgressTransportAttempt; session?: HttpEgressTransportSession };
type ExecutionStageContext = Readonly<{
  ports: HttpEgressBrokerPorts;
  operation: HttpEgressOperation;
  state: ReceiptState;
  resources: ExecutionResources;
}>;
type Halted = Readonly<{ halted: true; receipt: HttpEgressReceipt }>;
type Continuing<T> = Readonly<{ halted: false; value: T }>;
type StageResult<T> = Halted | Continuing<T>;
type AuthorizedHttpRequest = Readonly<{ bytes: Uint8Array; validateFirstByte(): boolean }>;

const halt = async (
  ports: HttpEgressBrokerPorts,
  operation: HttpEgressOperation,
  state: ReceiptState,
  resources: ExecutionResources,
): Promise<Halted> => Object.freeze({
  halted: true,
  receipt: await settleAfterClose(ports, operation, state, resources.attempt),
});

const authorizeResolution = async (
  context: ExecutionStageContext,
  request: StrictHttpRequest,
): Promise<StageResult<Readonly<{ route: HttpEgressRoute; resolution: NormalizedHttpEgressResolution }>>> => {
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
    const normalized = normalizeHttpEgressResolution(resolution.addresses, resolution.selectedAddress);
    if (normalized === undefined) {
      state.outcome = "denied";
      state.anomalyCode = "resolution_denied";
      return await halt(ports, operation, state, resources);
    }
    return Object.freeze({ halted: false, value: Object.freeze({ route, resolution: normalized }) });
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
  resolution: NormalizedHttpEgressResolution,
): Promise<StageResult<AuthorizedHttpRequest>> => {
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
  let pendingAuthorization: Promise<Uint8Array> | undefined;
  try {
    authorization = await ports.clock.within(
      operation.limits.deadline,
      () => {
        pendingAuthorization = ports.credentialCustody.renderAuthorization({
          operationId: operation.operationId, attemptId: operation.attemptId,
          materializationReceiptDigest: route.materializationReceiptDigest,
        });
        return pendingAuthorization;
      },
      operation.signal,
    );
  } catch {
    zeroLateBytes(pendingAuthorization);
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
  const authorizedBinding = snapshotHttpEgressTransportBinding(session.binding);
  const finalInput = createHttpEgressFinalAuthorization({
    operation, requestDigest: state.requestDigest, route,
    resolvedAddresses: resolution.addresses, selectedAddress: resolution.selectedAddress,
    binding: authorizedBinding, digest: parts => ports.evidence.digest(parts),
  });
  let finalDecision: HttpEgressFinalAuthorizationDecision;
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
  if (!finalAuthorizationMatches(finalDecision, finalInput.bindingDigest, route, ports.clock.now())) {
    outboundRequest.fill(0);
    state.outcome = "denied";
    state.anomalyCode = "final_denied";
    return await halt(ports, operation, state, resources);
  }
  const decision = Object.freeze({ ...finalDecision });
  return Object.freeze({ halted: false, value: Object.freeze({
    bytes: outboundRequest,
    validateFirstByte: () => {
      state.anomalyCode = "final_denied";
      if (operation.signal?.aborted) {
        state.anomalyCode = "inbound_cancelled";
        return false;
      }
      if (!generationsMatch(route, ports.routeAuthority.revalidateAtFirstByte(route.materializationReceiptDigest))) {
        state.anomalyCode = "provider_generation_drift";
        return false;
      }
      const now = ports.clock.now();
      const currentBinding = snapshotHttpEgressTransportBinding(session.binding);
      if (!bindingMatches(route, resolution.selectedAddress, currentBinding)
        || !transportBindingUnchanged(authorizedBinding, currentBinding)) {
        state.anomalyCode = "transport_binding_drift";
        return false;
      }
      const currentInput = createHttpEgressFinalAuthorization({
        operation, requestDigest: state.requestDigest, route,
        resolvedAddresses: resolution.addresses, selectedAddress: resolution.selectedAddress,
        binding: currentBinding, digest: parts => ports.evidence.digest(parts),
      });
      const allowed = now < operation.limits.deadline
        && finalAuthorizationMatches(decision, currentInput.bindingDigest, route, now);
      if (!allowed) {state.anomalyCode = "final_denied";}
      return allowed;
    },
  }) });
};

const openAuthorizedSession = async (
  context: ExecutionStageContext,
  request: StrictHttpRequest,
  input: Readonly<{ route: HttpEgressRoute; resolution: NormalizedHttpEgressResolution }>,
): Promise<StageResult<AuthorizedHttpRequest>> => {
  const { ports, operation, state, resources } = context;
  const beforeOpen = ports.clock.now();
  if (operation.signal?.aborted || !Number.isFinite(beforeOpen) || beforeOpen >= operation.limits.deadline) {
    state.outcome = operation.signal?.aborted ? "cancelled" : "denied";
    state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "transport_open_failed";
    return await halt(ports, operation, state, resources);
  }
  state.attemptCount = 1;
  try {
    resources.attempt = ports.transport.beginOpen({
      originHost: input.route.originHost,
      originPort: input.route.originPort,
      selectedAddress: input.resolution.selectedAddress,
      sni: input.route.sni,
      alpn: input.route.alpn,
    });
    state.upstreamClosure = "unknown";
    resources.session = await ports.clock.within(
      operation.limits.deadline,
      () => (resources.attempt as HttpEgressTransportAttempt).ready(),
      operation.signal,
    );
  } catch {
    state.outcome = operation.signal?.aborted ? "cancelled" : "denied";
    state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "transport_open_failed";
    return await halt(ports, operation, state, resources);
  }
  if (operation.signal?.aborted) {
    state.outcome = "cancelled";
    state.anomalyCode = "inbound_cancelled";
    return await halt(ports, operation, state, resources);
  }
  const session = resources.session;
  const binding = snapshotHttpEgressTransportBinding(session.binding);
  state.selectedPeer = binding.peerAddress;
  state.tlsProtocol = binding.tlsProtocol;
  if (!bindingMatches(input.route, input.resolution.selectedAddress, binding)) {
    state.outcome = "denied";
    state.anomalyCode = "transport_binding_drift";
    return await halt(ports, operation, state, resources);
  }
  return await renderAuthorizedRequest(context, request, input.route, input.resolution);
};

const dispatchOnce = async (
  ports: HttpEgressBrokerPorts,
  operation: HttpEgressOperation,
  state: ReceiptState,
  resources: ExecutionResources,
  prepared: AuthorizedHttpRequest,
): Promise<HttpEgressReceipt> => {
  const session = resources.session as HttpEgressTransportSession;
  const outboundRequest = prepared.bytes;
  const boundary = createHttpDispatchBoundary(outboundRequest, prepared.validateFirstByte);
  let dispatch;
  try {
    dispatch = await ports.clock.within(
      operation.limits.deadline,
      () => session.dispatch(boundary.consume, operation.signal),
      operation.signal,
    );
  } catch {
    boundary.seal();
    state.firstByteState = boundary.wasConsumed() ? "uncertain" : "not_sent";
    state.outcome = boundary.wasConsumed() ? "reconcile_required" : (operation.signal?.aborted ? "cancelled" : "denied");
    state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "upstream_write_failed";
    return (await halt(ports, operation, state, resources)).receipt;
  } finally {
    boundary.seal();
  }
  state.firstByteState = boundary.wasConsumed() ? "uncertain" : "not_sent";
  if (!boundary.wasConsumed()) {
    const provedNoWrite = dispatch.status === "failed" && dispatch.acceptedRequestBytes === 0;
    state.outcome = provedNoWrite ? (operation.signal?.aborted ? "cancelled" : "denied") : "reconcile_required";
    state.firstByteState = provedNoWrite ? "not_sent" : "uncertain";
    if (!boundary.wasRequested() || !provedNoWrite) {state.anomalyCode = "upstream_write_failed";}
    return (await halt(ports, operation, state, resources)).receipt;
  }
  const observed = observeHttpDispatch(dispatch, outboundRequest.byteLength);
  if (observed.kind === "failed") {
    Object.assign(state, observed.evidence);
    return (await halt(ports, operation, state, resources)).receipt;
  }
  state.upstreamRequestBytes = observed.upstreamRequestBytes;
  state.firstByteState = "sent";
  Object.assign(state, await observeHttpResponse(observed.response, operation, ports.clock));
  return (await halt(ports, operation, state, resources)).receipt;
};

export const createStrictHttpEgressBroker = (ports: HttpEgressBrokerPorts): Readonly<{
  execute(operation: HttpEgressOperation): Promise<HttpEgressReceipt>;
}> => Object.freeze({
  execute: async (input: HttpEgressOperation): Promise<HttpEgressReceipt> => {
    // Invalid configuration never transfers connection custody to this broker.
    const operation = Object.freeze({
      ...input,
      expectedRequest: Object.freeze({ ...input.expectedRequest }),
      limits: snapshotHttpEgressLimits(input.limits),
    });
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
        state.inboundRequestBytes = error.observedBytes;
        state.outcome = error.kind === "cancelled" ? "cancelled" : "rejected";
        state.anomalyCode = requestErrorCode(error);
      } else {
        state.outcome = state.firstByteState === "not_sent"
          ? (operation.signal?.aborted ? "cancelled" : "denied") : "reconcile_required";
        state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "provider_access_denied";
      }
      return await settleAfterClose(ports, operation, state, resources.attempt);
    }
  },
});

const settleAfterClose = async (
  ports: HttpEgressBrokerPorts,
  operation: HttpEgressOperation,
  state: ReceiptState,
  attempt: HttpEgressTransportAttempt | undefined,
): Promise<HttpEgressReceipt> => {
  await closeFlows(ports, operation, state, attempt);
  return await settleEvidence(ports, operation, state);
};
