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
import { createHttpEgressFinalAuthorization } from "./http-final-authorization-binding.js";
import { createOutboundHttpRequest, selectForwardedRequestHeaders } from "./http-outbound-request.js";
import { boundedHttpOpaque, snapshotHttpEgressOperation, snapshotHttpGenerationObservation,
  snapshotHttpRouteObservation, snapshotHttpTransportBinding } from "./http-ingress-validation.js";
import { createHttpDispatchBoundary } from "./http-dispatch-boundary.js";
import { zeroHttpBytes, zeroLateHttpBytes } from "./http-byte-intrinsics.js";
import { observeHttpDispatch } from "./http-dispatch-observation.js";
import { observeHttpResponse } from "./http-response-observation.js";
import { httpAuthorizationMatches, httpFinalAuthorizationMatches,
  snapshotHttpAuthorizationDecision, snapshotHttpClosureDecision,
  snapshotHttpFinalAuthorizationDecision,
} from "./http-receipt-validation.js";
import { normalizeHttpEgressResolution } from "./public-address-policy.js";
import type { NormalizedHttpEgressResolution } from "./public-address-policy.js";
import {
  canonicalRequestDigestParts,
  readStrictHttpRequest,
  StrictHttpRequestError,
} from "./strict-http-request.js";
import type { StrictHttpRequest } from "./strict-http-request.js";
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

const initialState = (): ReceiptState => ({
  outcome: "rejected",
  anomalyCode: "inbound_malformed",
  requestDigest: "",
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
  value: unknown,
): boolean => {
  const observation = snapshotHttpGenerationObservation(value);
  return observation?.status === "current"
  && observation.policyGeneration === route.policyGeneration
  && observation.keyGeneration === route.keyGeneration
  && observation.routeGeneration === route.routeGeneration
  && observation.credentialGeneration === route.credentialGeneration
  && observation.materializationReceiptDigest === route.materializationReceiptDigest;
};

const evidenceDigest = (ports: HttpEgressBrokerPorts, parts: readonly Uint8Array[]): string => {
  const digest = ports.evidence.digest(parts);
  if (!boundedHttpOpaque(digest)) {throw new TypeError("invalid HTTP evidence digest");}
  return digest;
};

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
      const closure = snapshotHttpClosureDecision(
        await ports.clock.within(operation.limits.closureDeadline, () => attempt.close()),
      );
      state.upstreamClosure = closure?.state ?? "unknown";
      state.upstreamClosureReceiptDigest = closure?.receiptDigest ?? "";
    } catch {
      state.upstreamClosure = "unknown";
    }
  }
  try {
    const closure = snapshotHttpClosureDecision(
      await ports.clock.within(
        operation.limits.closureDeadline,
        () => operation.connection.close(state.outcome === "completed" ? "complete" : "abort"),
      ),
    );
    state.inboundClosure = closure?.state ?? "unknown";
    state.inboundClosureReceiptDigest = closure?.receiptDigest ?? "";
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
  const observation = snapshotHttpRouteObservation(await ports.clock.within(
    operation.limits.deadline,
    () => ports.routeAuthority.observe(operation.operationId, operation.attemptId),
    operation.signal,
  ));
  if (observation?.status !== "available") {
    state.outcome = "denied";
    state.anomalyCode = "provider_access_denied";
    return await halt(ports, operation, state, resources);
  }
  const route = observation.route;
  state.requestDigest = evidenceDigest(ports, canonicalRequestDigestParts(
    operation.expectedRequest.requestId, request, selectForwardedRequestHeaders(request, route),
  ));
  applyRoute(state, route);
  const provisionalInput = provisionalAuthorizationInput(operation, state, route);
  let provisional: HttpEgressAuthorizationDecision | undefined;
  try {
    provisional = snapshotHttpAuthorizationDecision(
      await ports.clock.within(
        operation.limits.deadline,
        () => ports.provisionalAuthorization.authorize(provisionalInput),
        operation.signal,
      ),
    );
  } catch {
    state.outcome = operation.signal?.aborted ? "cancelled" : "denied";
    state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "provisional_timeout";
    return await halt(ports, operation, state, resources);
  }
  if (provisional === undefined || !httpAuthorizationMatches(provisional, route, ports.clock.now())) {
    if (provisional !== undefined) {state.provisionalAuthorizationReceiptDigest = provisional.receiptDigest;}
    state.outcome = "denied";
    state.anomalyCode = "provisional_denied";
    return await halt(ports, operation, state, resources);
  }
  state.provisionalAuthorizationReceiptDigest = provisional.receiptDigest;
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
      return halt(ports, operation, state, resources);
    }
    return Object.freeze({ halted: false, value: Object.freeze({ route, resolution: normalized }) });
  } catch {
    state.outcome = operation.signal?.aborted ? "cancelled" : "denied";
    state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "resolution_denied";
    return halt(ports, operation, state, resources);
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
  let authorization: Uint8Array | undefined;
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
    zeroLateHttpBytes(pendingAuthorization);
    state.outcome = operation.signal?.aborted ? "cancelled" : "denied";
    state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "credential_render_failed";
    return await halt(ports, operation, state, resources);
  }
  let outboundRequest: Uint8Array | undefined;
  try {
    outboundRequest = createOutboundHttpRequest(request, route, authorization);
    const authorizedBinding = snapshotHttpTransportBinding(session.binding);
    if (authorizedBinding === undefined) {throw new TypeError("invalid transport binding");}
    const finalInput = createHttpEgressFinalAuthorization({
      operation, requestDigest: state.requestDigest, route,
      resolvedAddresses: resolution.addresses, selectedAddress: resolution.selectedAddress,
      binding: authorizedBinding, digest: parts => evidenceDigest(ports, parts),
    });
    let finalDecision: HttpEgressFinalAuthorizationDecision | undefined;
    finalDecision = snapshotHttpFinalAuthorizationDecision(
      await ports.clock.within(
        operation.limits.deadline,
        () => ports.finalAuthorization.authorize(finalInput),
        operation.signal,
      ),
    );
    if (finalDecision === undefined
      || !httpFinalAuthorizationMatches(finalDecision, finalInput.bindingDigest, route, ports.clock.now())) {
      if (finalDecision !== undefined) {state.finalAuthorizationReceiptDigest = finalDecision.receiptDigest;}
      state.outcome = "denied";
      state.anomalyCode = "final_denied";
      return halt(ports, operation, state, resources);
    }
    state.finalAuthorizationReceiptDigest = finalDecision.receiptDigest;
    const decision = finalDecision;
    const transferred = outboundRequest;
    outboundRequest = undefined;
    return Object.freeze({ halted: false, value: Object.freeze({
      bytes: transferred,
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
        const currentBinding = snapshotHttpTransportBinding(session.binding);
        if (currentBinding === undefined || !bindingMatches(route, resolution.selectedAddress, currentBinding)
          || !transportBindingUnchanged(authorizedBinding, currentBinding)) {
          state.anomalyCode = "transport_binding_drift";
          return false;
        }
        const currentInput = createHttpEgressFinalAuthorization({
          operation, requestDigest: state.requestDigest, route,
          resolvedAddresses: resolution.addresses, selectedAddress: resolution.selectedAddress,
          binding: currentBinding, digest: parts => evidenceDigest(ports, parts),
        });
        const allowed = Number.isSafeInteger(now) && now < operation.limits.deadline
          && httpFinalAuthorizationMatches(decision, currentInput.bindingDigest, route, now);
        if (!allowed) {state.anomalyCode = "final_denied";}
        return allowed;
      },
    }) });
  } catch {
    state.outcome = operation.signal?.aborted ? "cancelled" : "denied";
    state.anomalyCode = operation.signal?.aborted ? "inbound_cancelled" : "final_timeout";
    return halt(ports, operation, state, resources);
  } finally {
    zeroHttpBytes(authorization);
    zeroHttpBytes(outboundRequest);
  }
};

const openAuthorizedSession = async (
  context: ExecutionStageContext,
  request: StrictHttpRequest,
  input: Readonly<{ route: HttpEgressRoute; resolution: NormalizedHttpEgressResolution }>,
): Promise<StageResult<AuthorizedHttpRequest>> => {
  const { ports, operation, state, resources } = context;
  const beforeOpen = ports.clock.now();
  if (operation.signal?.aborted || !Number.isSafeInteger(beforeOpen) || beforeOpen >= operation.limits.deadline) {
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
  const binding = snapshotHttpTransportBinding(session.binding);
  if (binding === undefined) {
    state.outcome = "denied";
    state.anomalyCode = "transport_binding_drift";
    return await halt(ports, operation, state, resources);
  }
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
    const operation = snapshotHttpEgressOperation(input);
    const state = initialState();
    const resources: ExecutionResources = {};
    let request: StrictHttpRequest | undefined;
    try {
      state.requestDigest = evidenceDigest(ports, [
        encoder.encode("agent-runtime.host-http-request-unavailable/v1\n"),
        encoder.encode(operation.expectedRequest.requestId),
      ]);
      request = await readStrictHttpRequest(
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
    } finally {
      zeroHttpBytes(request?.body);
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
