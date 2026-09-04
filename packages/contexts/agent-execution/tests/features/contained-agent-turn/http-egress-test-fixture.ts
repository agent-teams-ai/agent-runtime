import { createHash } from "node:crypto";
import { createHostHttpAdmissionGuard } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-admission-guard.js";
import type {
  HostHttpGrant, HostHttpMaterializationReceipt, HostHttpProvisionalDecision,
  HttpEgressBrokerPorts, HttpEgressDispatch, HttpEgressRoute, HttpEgressTransportBinding,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import type { HttpEgressConnection, HttpEgressLimits, HttpEgressOperation, HttpEgressReceipt,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-contracts.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const SECRET_MARKER = "synthetic-secret-never-observe";
export const bytes = (value: string): Uint8Array => encoder.encode(value);
export async function* chunks(values: readonly (string | Uint8Array)[]): AsyncIterable<Uint8Array> {
  for (const value of values) {yield typeof value === "string" ? bytes(value) : value;}
}

const defaultRequest = "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
const defaultResponse = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\ndata:\r\n2\r\n\n\n\r\n0\r\n\r\n";
const defaultLimits: HttpEgressLimits = Object.freeze({maxInboundHeaderBytes: 2_048, maxInboundBodyBytes: 1_024,
  maxUpstreamHeaderBytes: 2_048, maxOutputBytes: 4_096, maxBufferedBytes: 128, maxUpstreamWireBytes: 8_192,
  deadline: 1_000, closureDeadline: 1_100});

/** Compatibility facts retained while each restored suite migrates to the signed V2 names. */
export const defaultRoute = Object.freeze({routeReceiptDigest: "route-receipt-digest", originHost: "provider.example",
  originPort: 443, upstreamMethod: "POST" as const, upstreamPath: "/fixed-provider-route",
  forwardedRequestHeaderNames: Object.freeze(["accept", "content-type"] as const),
  credentialFieldNames: Object.freeze(["authorization"]), materializationReceiptDigest: "materialization-receipt-digest",
  sni: "provider.example", sniDigest: "sni-digest", certificateDigest: "sha256:certificate-digest",
  pinDigest: "sha256:pin-digest", alpn: "http/1.1", policyGeneration: "policy-generation-7",
  keyGeneration: "key-generation-3", routeGeneration: "11", credentialGeneration: "5"});

type LegacyDecision = Readonly<{decision: "allow" | "deny"; receiptDigest: unknown; validUntil: number;
  policyGeneration: string; keyGeneration: string; routeGeneration: string; credentialGeneration: string;
  materializationReceiptDigest: string}>;
type LegacyGeneration = Readonly<{status: "current" | "revoked"; policyGeneration: string; keyGeneration: string;
  routeGeneration: string; credentialGeneration: string; materializationReceiptDigest: string}>;
type LegacyBinding = Partial<HttpEgressTransportBinding & Readonly<{sni: string; sniDigest: string; pinDigest: string}>>;

const decision = (route: typeof defaultRoute, receiptDigest: string): LegacyDecision => Object.freeze({decision: "allow",
  receiptDigest, validUntil: 900, policyGeneration: route.policyGeneration, keyGeneration: route.keyGeneration,
  routeGeneration: route.routeGeneration, credentialGeneration: route.credentialGeneration,
  materializationReceiptDigest: route.materializationReceiptDigest});

export type FixtureOptions = Readonly<{request?: readonly (string | Uint8Array)[]; response?: readonly (string | Uint8Array)[];
  responseSource?: AsyncIterable<Uint8Array>; route?: typeof defaultRoute | HttpEgressRoute; binding?: LegacyBinding;
  bindingAtFirstByte?: LegacyBinding; provisional?: LegacyDecision | "timeout"; final?: LegacyDecision | "timeout" | ((input: any) => any);
  paReceiptChange?: Readonly<Record<string, unknown>>;
  firstObserveDenied?: boolean; secondObserveDenied?: boolean;
  mutateProvisional?: (value: HostHttpProvisionalDecision) => HostHttpProvisionalDecision;
  mutateGrant?: (value: HostHttpGrant) => HostHttpGrant; provisionalVerifier?: boolean; grantVerifier?: boolean;
  generation?: LegacyGeneration; generationAtFirstByte?: LegacyGeneration; addresses?: readonly string[];
  selectedAddress?: string; dispatch?: HttpEgressDispatch | "throw"; openThrows?: boolean; openReady?: Promise<void>;
  renderThrows?: boolean; connectionWriteThrows?: boolean; inboundClosure?: "closed" | "unknown";
  upstreamClosure?: "closed" | "unknown"; upstreamCloseThrows?: boolean; upstreamCloseNever?: boolean;
  evidence?: "recorded" | "conflict" | "unknown" | "throw"; abortOnDispatch?: AbortController;
  signal?: AbortSignal; deadlineNow?: number}>;

export type EgressFixture = Readonly<{ports: HttpEgressBrokerPorts; operation: HttpEgressOperation; observations: {
  readonly order: string[]; readonly outboundWrites: Uint8Array[]; readonly dispatchedRequests: Uint8Array[];
  readonly receipts: HttpEgressReceipt[]; readonly materializationInputs: any[]; readonly provisionalInputs: any[];
  readonly finalAuthorizationInputs: any[]; dispatches: number;
  opens: number; renders: number; closes: number}}>; 

const digest = (parts: readonly Uint8Array[]): string => {const hash = createHash("sha256");
  for (const part of parts) {hash.update(part);} return hash.digest("hex");};
const key = Object.freeze({algorithm: "ed25519" as const, signatureEncoding: "hex-lower" as const,
  keyRef: "key-1", publicKeyDigest: "public-key-digest", keyGeneration: defaultRoute.keyGeneration,
  signerRevision: "signer-revision-1", hostReservationId: "custody-egress-1"});
const signature = Object.freeze({...key, value: "a".repeat(128)});
const snapshot = Object.freeze({tenantId: "tenant-1", projectId: "project-1", scopeDigest: "scope-digest",
  accessRef: "access-1", provider: "codex" as const, providerAccountRef: "account-1", providerRouteRef: "route-1",
  credentialBindingRef: "binding-1", ownerAuthorityDigest: "pa-owner-binding-digest", revision: 11,
  credentialGeneration: 5, availability: "available" as const, revocation: "active" as const});

const narrowRoute = (value: typeof defaultRoute | HttpEgressRoute): HttpEgressRoute => Object.freeze({
  routeReceiptDigest: value.routeReceiptDigest, originHost: value.originHost, originPort: value.originPort,
  upstreamMethod: value.upstreamMethod, upstreamPath: value.upstreamPath,
  forwardedRequestHeaderNames: value.forwardedRequestHeaderNames,
  credentialFieldNames: "credentialFieldNames" in value ? value.credentialFieldNames : Object.freeze(["authorization"]),
});
const tlsBinding = (route: HttpEgressRoute, change: LegacyBinding = {}): HttpEgressTransportBinding => Object.freeze({
  peerAddress: change.peerAddress ?? "93.184.216.34", peerPort: change.peerPort ?? route.originPort,
  tlsProtocol: change.tlsProtocol ?? "TLSv1.3", requestedSni: change.requestedSni ?? change.sni ?? route.originHost,
  observedSni: change.observedSni ?? change.sni ?? route.originHost, chainValidated: change.chainValidated ?? true,
  dnsIdentity: change.dnsIdentity ?? route.originHost,
  certificateDigest: (change.certificateDigest ?? "sha256:certificate-digest") as `sha256:${string}`,
  tlsPolicyDigest: change.tlsPolicyDigest ?? "tls-policy-digest",
  spkiDigest: (change.spkiDigest ?? change.pinDigest ?? "sha256:pin-digest") as `sha256:${string}`,
  alpn: change.alpn ?? "http/1.1",
});

export const createEgressFixture = (options: FixtureOptions = {}): EgressFixture => {
  const legacyRoute = options.route ?? defaultRoute; const route = narrowRoute(legacyRoute);
  const observations: EgressFixture["observations"] = {order: [], outboundWrites: [], dispatchedRequests: [], receipts: [],
    materializationInputs: [], provisionalInputs: [], finalAuthorizationInputs: [], dispatches: 0, opens: 0,
    renders: 0, closes: 0};
  let credentialUsed = false; let ids = 0; let firstByte = false; let observationCount = 0;
  let materializationReceipt: HostHttpMaterializationReceipt | undefined;
  const baseBinding = tlsBinding(route, options.binding); const changedBinding = tlsBinding(route, {...options.binding,
    ...options.bindingAtFirstByte});
  const provisionalOption = options.provisional ?? decision(defaultRoute, "provisional-receipt-digest");
  const finalOption = options.final ?? decision(defaultRoute, "final-receipt-digest");
  const providerAccess = Object.freeze({accessRef: snapshot.accessRef, providerRef: snapshot.provider,
    accountRef: snapshot.providerAccountRef, routeRef: snapshot.providerRouteRef,
    routeAuthorityDigest: "runtime-security-route-authority", credentialBindingDigest: snapshot.ownerAuthorityDigest,
    routeGeneration: String(snapshot.revision), credentialGeneration: String(snapshot.credentialGeneration)});
  const policy = (requestDigest: string) => Object.freeze({policyRef: "policy-1", policyRevision: "revision-1",
    policyGeneration: defaultRoute.policyGeneration, authorizedRequestDigest: requestDigest,
    origin: Object.freeze({scheme: "https" as const, hostname: route.originHost, port: route.originPort}),
    dnsIdentity: route.originHost, tlsPolicyDigest: "tls-policy-digest", limits: Object.freeze({requestBytes: 1_000_000,
      responseBytes: 1_000_000, totalMilliseconds: 900}), decisionTtlMilliseconds: 100, revoked: false});
  let provisionalDecision: HostHttpProvisionalDecision | undefined;
  const portsWithoutGuard: Omit<HttpEgressBrokerPorts, "guard"> = {
    identity: Object.freeze({operationId: "operation-egress-1", attemptId: "attempt-egress-1",
      custodyId: "custody-egress-1", hostBootId: "boot-1", liveProcessSessionIdentity: {}}),
    ids: Object.freeze({fresh: () => {ids += 1; return Object.freeze({materializationAuthorizationId: `pa-${ids}`,
      runtimeAuthorizationId: `rs-${ids}`, boundaryUseId: `boundary-${ids}`, connectionAttemptId: `connection-${ids}`,
      streamId: `stream-${ids}`});}}), providerAccessSnapshot: snapshot, route,
    providerAccess: Object.freeze({authorize: async input => {observations.order.push("authorize-materialization");
      observations.materializationInputs.push(input);
      materializationReceipt = Object.freeze({...input, decision: "authorized" as const, rejectionReason: null,
        ...options.paReceiptChange}) as HostHttpMaterializationReceipt;
      return Object.freeze({kind: "authorized" as const, receipt: materializationReceipt});}, observe: async input => {
      observations.order.push("observe-materialization");
      observationCount += 1;
      if ((observationCount === 1 && options.firstObserveDenied)
        || (observationCount === 2 && options.secondObserveDenied)) {
        return Object.freeze({kind: "indeterminate" as const});
      }
      if (materializationReceipt === undefined || input.authorizationRequestId !== materializationReceipt.authorizationRequestId) {
        return Object.freeze({kind: "indeterminate" as const});
      }
      return Object.freeze({kind: "observed" as const, receipt: materializationReceipt});}}),
    materializer: Object.freeze({render: async () => {observations.order.push("render-credential"); observations.renders += 1;
      if (options.renderThrows || credentialUsed) {throw new Error("synthetic credential failure");} credentialUsed = true;
      return Object.freeze([Object.freeze({name: "authorization", valueBytes: bytes(`Bearer ${SECRET_MARKER}`)})]);}}),
    runtimeSecurity: Object.freeze({requestProvisional: async input => {observations.order.push("provisional");
      observations.provisionalInputs.push(input);
      if (provisionalOption === "timeout") {throw new Error("synthetic timeout");}
      if (provisionalOption.decision === "deny") {return Object.freeze({status: "denied" as const});}
      const signedRequestDigest = digest([bytes(JSON.stringify(input.request))]);
      provisionalDecision = Object.freeze({contractVersion: "provider-process-egress-provisional-decision/v2",
        authorizationRequestId: input.authorizationRequestId, authorityRef: "authority-1",
        scope: Object.freeze({tenantId: snapshot.tenantId, projectId: snapshot.projectId,
          operationId: "operation-egress-1", scopeDigest: snapshot.scopeDigest}), policy: policy(signedRequestDigest),
        providerAccess, request: input.request, requestDigest: signedRequestDigest,
        time: Object.freeze({authorityId: "clock-authority", epoch: "epoch-1", controlTime: 0,
          expiresAtControlTime: provisionalOption.validUntil}), signingKey: key,
        decisionDigest: String(provisionalOption.receiptDigest), signature});
      provisionalDecision = options.mutateProvisional?.(provisionalDecision) ?? provisionalDecision;
      return Object.freeze({status: "authorized" as const, decision: provisionalDecision});},
      authorizeFirstApplicationByte: async input => {observations.order.push("final");
        observations.finalAuthorizationInputs.push(input); if (finalOption === "timeout") {throw new Error("synthetic timeout");}
        if (typeof finalOption === "function") {const legacy = finalOption(input); if (legacy?.decision === "deny") {
          return Object.freeze({status: "denied" as const});}}
        else if (finalOption.decision === "deny") {return Object.freeze({status: "denied" as const});}
        let grant: HostHttpGrant = Object.freeze({payload: Object.freeze({contractVersion:
          "provider-process-first-application-byte-grant/v2", authorizationRequestId: input.provisional.authorizationRequestId,
          authorityRef: input.provisional.authorityRef, scope: input.provisional.scope, policy: input.provisional.policy,
          providerAccess, resolver: Object.freeze({resolverIdentity: input.resolver.resolverIdentity,
            resolverEpoch: input.resolver.resolverEpoch, resolutionCount: input.resolver.resolutionCount,
            normalizedAddresses: input.resolver.addresses, addressSetDigest: "address-set-digest"}),
          selectedPeer: input.observedPeer, tls: input.tls,
          limits: input.provisional.policy.limits, request: input.request, requestDigest: input.provisional.requestDigest,
          time: Object.freeze({authorityId: "clock-authority", epoch: "epoch-1", authorizedAtControlTime: 0,
            expiresAtControlTime: typeof finalOption === "function" ? 900 : finalOption.validUntil}),
          boundaryUseId: input.boundaryUseId, connectionAttemptId: input.connectionAttemptId, streamId: input.streamId,
          redirectHop: 0, provisionalDecisionDigest: input.provisional.decisionDigest, automaticRetryAuthorized: false,
          poolingAuthorized: false, consumption: Object.freeze({owner: "host-custody", journalKey: Object.freeze({namespace:
            "provider-process-egress/v2", tenantId: snapshot.tenantId, projectId: snapshot.projectId,
            operationId: "operation-egress-1", boundaryUseId: input.boundaryUseId}), requestFingerprint: "fingerprint"})}),
          finalAuthorizationDigest: "final-receipt-digest", signature, evidence: Object.freeze({contractVersion:
            "provider-process-egress-grant-evidence/v2", authorizationRef: "authorization-1", boundaryUseRef: input.boundaryUseId,
            decisionDigest: input.provisional.decisionDigest, finalAuthorizationDigest: "final-receipt-digest", signingKey: key})});
        grant = options.mutateGrant?.(grant) ?? grant;
        return Object.freeze({status: "authorized" as const, grant});}}),
    verifier: Object.freeze({signingKey: key, verifyProvisionalDecision: () => (options.provisionalVerifier ?? true)
      && typeof provisionalOption.receiptDigest === "string"
      && provisionalOption.policyGeneration === defaultRoute.policyGeneration
      && provisionalOption.keyGeneration === defaultRoute.keyGeneration
      && provisionalOption.routeGeneration === defaultRoute.routeGeneration
      && provisionalOption.credentialGeneration === defaultRoute.credentialGeneration
      && provisionalOption.materializationReceiptDigest === defaultRoute.materializationReceiptDigest,
      verifyGrant: () => (options.grantVerifier ?? true) && provisionalDecision !== undefined}),
    localAuthorityCut: Object.freeze({read: () => {const generation = firstByte ? options.generationAtFirstByte : options.generation;
      const current = generation === undefined || generation.status === "current"
        && generation.policyGeneration === defaultRoute.policyGeneration && generation.keyGeneration === defaultRoute.keyGeneration
        && generation.routeGeneration === defaultRoute.routeGeneration && generation.credentialGeneration === defaultRoute.credentialGeneration
        && generation.materializationReceiptDigest === defaultRoute.materializationReceiptDigest;
      return Object.freeze({status: current ? "current" as const : "revoked" as const,
        authorityId: "clock-authority", epoch: "epoch-1", controlTime: options.deadlineNow ?? 0});}}),
    journal: Object.freeze({consume: () => "consumed" as const}), resolver: Object.freeze({resolve: async () => {
      observations.order.push("resolve"); const selectedAddress = options.selectedAddress ?? "93.184.216.34";
      const values = options.addresses ?? [selectedAddress]; return Object.freeze({resolverIdentity: "resolver-1",
        resolverEpoch: "resolver-epoch-1", resolutionCount: 1 as const, addresses: Object.freeze(values.map(address =>
          Object.freeze({family: address.includes(":") ? "ipv6" as const : "ipv4" as const, address,
            classification: "public" as const}))), selectedAddress});}}),
    transport: Object.freeze({beginOpen: () => {observations.order.push("open"); observations.opens += 1; let closed = false;
      let closeResult: Promise<Readonly<{state: "closed" | "unknown"; receiptDigest: string}>> | undefined;
      const session = Object.freeze({get binding() {return firstByte && options.bindingAtFirstByte !== undefined
        ? changedBinding : baseBinding;}, dispatch: async (consume: () => Uint8Array | undefined) => {
        observations.order.push("dispatch"); if (closed) {return Object.freeze({status: "failed" as const,
          acceptedRequestBytes: 0, acknowledgement: "acknowledged" as const});} firstByte = true; const wire = consume();
        if (wire === undefined) {return Object.freeze({status: "failed" as const, acceptedRequestBytes: 0,
          acknowledgement: "acknowledged" as const});} observations.dispatches += 1;
        observations.dispatchedRequests.push(wire.slice()); options.abortOnDispatch?.abort();
        if (options.dispatch === "throw") {throw new Error("synthetic dispatch crash");}
        if (options.dispatch !== undefined) {return options.dispatch;}
        return Object.freeze({status: "response" as const, acceptedRequestBytes: wire.byteLength,
          acknowledgement: "acknowledged" as const, response: options.responseSource ?? chunks(options.response ?? [defaultResponse])});}});
      return Object.freeze({ready: async () => {await options.openReady; if (options.openThrows) {
        throw new Error("synthetic open failure");} if (closed) {throw new Error("synthetic attempt closed before ready");}
        return session;}, close: () => {if (closeResult !== undefined) {return closeResult;} closeResult = (async () => {
        closed = true; observations.order.push("upstream-close"); observations.closes += 1;
        if (options.upstreamCloseThrows) {throw new Error("synthetic close failure");}
        if (options.upstreamCloseNever) {return await new Promise<never>(() => {});} return Object.freeze({state:
          options.upstreamClosure ?? "closed", receiptDigest: "upstream-closure-digest"});})(); return closeResult;}});}}),
    clock: Object.freeze({now: () => options.deadlineNow ?? 0, within: async <T>(_deadline: number,
      operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {signal?.throwIfAborted(); return await operation();}}),
    evidence: Object.freeze({digest, record: async receipt => {observations.order.push("record-evidence");
      observations.receipts.push(receipt); if (options.evidence === "throw") {throw new Error("synthetic lost ack");}
      return options.evidence ?? "recorded";}}),
  };
  const guard = createHostHttpAdmissionGuard({operationId: portsWithoutGuard.identity.operationId,
    attemptId: portsWithoutGuard.identity.attemptId, custodyId: portsWithoutGuard.identity.custodyId,
    hostGeneration: portsWithoutGuard.identity.hostBootId,
    liveProcessSessionIdentity: portsWithoutGuard.identity.liveProcessSessionIdentity});
  const ports = Object.freeze({...portsWithoutGuard, guard});
  const connection: HttpEgressConnection = Object.freeze({request: chunks(options.request ?? [defaultRequest]),
    write: async value => {observations.order.push("write-output"); if (options.connectionWriteThrows) {
      throw new Error("synthetic backpressure failure");} observations.outboundWrites.push(value.slice());},
    close: async () => {observations.order.push("inbound-close"); return Object.freeze({state:
      options.inboundClosure ?? "closed", receiptDigest: "inbound-closure-digest"});}});
  const operation: HttpEgressOperation = Object.freeze({operationId: "operation-egress-1", attemptId: "attempt-egress-1",
    expectedRequest: Object.freeze({requestId: "request-egress-1", method: "POST", path: "/invoke", host: "broker.invalid"}),
    connection, limits: defaultLimits, ...(options.signal === undefined ? {} : {signal: options.signal})});
  return Object.freeze({ports, operation, observations});
};

export const outputText = (fixture: EgressFixture): string => decoder.decode(fixture.observations.outboundWrites.reduce(
  (all, part) => {const joined = new Uint8Array(all.byteLength + part.byteLength); joined.set(all); joined.set(part, all.byteLength);
    return joined;}, new Uint8Array()));
export const denyDecision = (route: typeof defaultRoute, receiptDigest: string): LegacyDecision => Object.freeze({
  ...decision(route, receiptDigest), decision: "deny"});
