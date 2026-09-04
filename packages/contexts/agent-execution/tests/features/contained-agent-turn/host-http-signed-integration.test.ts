import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, test} from "node:test";
import {createHostHttpEgressSession} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-egress-session.js";
import type {HttpEgressOperation} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-contracts.js";
import type {HostHttpGrant, HostHttpMaterializationReceipt, HostHttpProvisionalDecision,
  HttpEgressBrokerPorts} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";

const enc = new TextEncoder(); const SECRET = "fixture-secret-do-not-observe";
const bytes = (value: string) => enc.encode(value);
async function* chunks(value: string): AsyncIterable<Uint8Array> {yield bytes(value);}
const digest = (parts: readonly Uint8Array[]) => {const hash = createHash("sha256");
  for (const part of parts) {hash.update(part);} return hash.digest("hex");};
const key = Object.freeze({algorithm: "ed25519" as const, signatureEncoding: "hex-lower" as const,
  keyRef: "key-1", publicKeyDigest: "public-key-digest", keyGeneration: "key-generation-4",
  signerRevision: "signer-revision-2", hostReservationId: "custody-1"});
const signature = Object.freeze({...key, value: "a".repeat(128)});
const snapshot = Object.freeze({tenantId: "tenant-1", projectId: "project-1", scopeDigest: "scope-digest",
  accessRef: "access-1", provider: "codex" as const, providerAccountRef: "account-1", providerRouteRef: "route-1",
  credentialBindingRef: "binding-1", ownerAuthorityDigest: "pa-original-binding-digest", revision: 7,
  credentialGeneration: 11, availability: "available" as const, revocation: "active" as const});
const route = Object.freeze({routeReceiptDigest: "route-receipt", originHost: "provider.example", originPort: 443,
  upstreamMethod: "POST" as const, upstreamPath: "/fixed", forwardedRequestHeaderNames: Object.freeze(["content-type"] as const),
  credentialFieldNames: Object.freeze(["authorization"])});
const response = (status = 200) => `HTTP/1.1 ${status} Status\r\nContent-Length: 2\r\n\r\nok`;

type Options = Readonly<{status?: number; paAuthorizeKind?: "authorized" | "observed"; firstObserveDenied?: boolean;
  secondObserveDenied?: boolean; verifierProvisional?: boolean; verifierGrant?: boolean; substituteKey?: boolean;
  mutateProvisional?: (value: HostHttpProvisionalDecision) => HostHttpProvisionalDecision;
  mutateGrant?: (value: HostHttpGrant) => HostHttpGrant; journal?: "consumed" | "duplicate" | "mismatch" | "unknown";
  cut?: "current" | "revoked" | "unknown"; cutEpoch?: string; dispatch?: "success" | "lost" | "throw";
  truncated?: boolean; upstreamClosure?: "closed" | "unknown"; inboundClosure?: "closed" | "unknown";
  evidence?: "recorded" | "unknown"}>;

const receiptFor = (input: Record<string, unknown>): HostHttpMaterializationReceipt => Object.freeze({
  ...input, decision: "authorized", rejectionReason: null,
}) as HostHttpMaterializationReceipt;

const fixture = (options: Options = {}) => {
  const order: string[] = []; const writes: Uint8Array[] = []; const wires: Uint8Array[] = [];
  const paInputs: unknown[] = []; const provisionalInputs: unknown[] = []; const finalInputs: unknown[] = [];
  let ids = 0; let observes = 0; let opens = 0; let journalCalls = 0; let renders = 0; let cutReads = 0;
  const policy = (requestDigest: string) => Object.freeze({policyRef: "policy-1", policyRevision: "revision-3",
    policyGeneration: "policy-generation-9", authorizedRequestDigest: requestDigest,
    origin: Object.freeze({scheme: "https" as const, hostname: route.originHost, port: route.originPort}),
    dnsIdentity: route.originHost, tlsPolicyDigest: "tls-policy-digest", limits: Object.freeze({requestBytes: 1_000_000,
      responseBytes: 1_000_000, totalMilliseconds: 900}), decisionTtlMilliseconds: 100, revoked: false});
  const providerAccess = Object.freeze({accessRef: snapshot.accessRef, providerRef: snapshot.provider,
    accountRef: snapshot.providerAccountRef, routeRef: snapshot.providerRouteRef,
    routeAuthorityDigest: "runtime-security-owned-route-authority", credentialBindingDigest: snapshot.ownerAuthorityDigest,
    routeGeneration: String(snapshot.revision), credentialGeneration: String(snapshot.credentialGeneration)});
  const runtimeSecurity: HttpEgressBrokerPorts["runtimeSecurity"] = Object.freeze({
    requestProvisional: async input => {
      order.push("rs-provisional"); provisionalInputs.push(input);
      const signedRequestDigest = digest([bytes(JSON.stringify(input.request))]);
      let decision: HostHttpProvisionalDecision = Object.freeze({contractVersion: "provider-process-egress-provisional-decision/v2",
        authorizationRequestId: input.authorizationRequestId, authorityRef: "authority-1",
        scope: Object.freeze({tenantId: snapshot.tenantId, projectId: snapshot.projectId,
          operationId: "operation-1", scopeDigest: snapshot.scopeDigest}), policy: policy(signedRequestDigest),
        providerAccess, request: input.request, requestDigest: signedRequestDigest,
        time: Object.freeze({authorityId: "clock-authority", epoch: "epoch-1", controlTime: 10,
          expiresAtControlTime: 100}), signingKey: options.substituteKey ? Object.freeze({...key, keyRef: "other"}) : key,
        decisionDigest: "provisional-decision-digest", signature});
      decision = options.mutateProvisional?.(decision) ?? decision;
      return Object.freeze({status: "authorized" as const, decision});
    },
    authorizeFirstApplicationByte: async input => {
      order.push("rs-final"); finalInputs.push(input);
      let grant: HostHttpGrant = Object.freeze({payload: Object.freeze({
        contractVersion: "provider-process-first-application-byte-grant/v2", authorizationRequestId: input.provisional.authorizationRequestId,
        authorityRef: input.provisional.authorityRef, scope: input.provisional.scope, policy: input.provisional.policy,
        providerAccess, resolver: Object.freeze({resolverIdentity: input.resolver.resolverIdentity,
          resolverEpoch: input.resolver.resolverEpoch, resolutionCount: input.resolver.resolutionCount,
          normalizedAddresses: input.resolver.addresses, addressSetDigest: "address-set-digest"}),
        selectedPeer: input.observedPeer, tls: input.tls,
        limits: input.provisional.policy.limits, request: input.request, requestDigest: input.provisional.requestDigest,
        time: Object.freeze({authorityId: "clock-authority", epoch: "epoch-1", authorizedAtControlTime: 10,
          expiresAtControlTime: 100}), boundaryUseId: input.boundaryUseId, connectionAttemptId: input.connectionAttemptId,
        streamId: input.streamId, redirectHop: 0, provisionalDecisionDigest: input.provisional.decisionDigest,
        automaticRetryAuthorized: false, poolingAuthorized: false, consumption: Object.freeze({owner: "host-custody",
          journalKey: Object.freeze({namespace: "provider-process-egress/v2", tenantId: snapshot.tenantId,
            projectId: snapshot.projectId, operationId: "operation-1", boundaryUseId: input.boundaryUseId}),
          requestFingerprint: "request-fingerprint"})}), finalAuthorizationDigest: "final-authorization-digest", signature,
        evidence: Object.freeze({contractVersion: "provider-process-egress-grant-evidence/v2", authorizationRef: "auth-ref",
          boundaryUseRef: input.boundaryUseId, decisionDigest: input.provisional.decisionDigest,
          finalAuthorizationDigest: "final-authorization-digest", signingKey: key})});
      grant = options.mutateGrant?.(grant) ?? grant;
      return Object.freeze({status: "authorized" as const, grant});
    },
  });
  const deps: Omit<HttpEgressBrokerPorts, "guard"> = Object.freeze({identity: Object.freeze({operationId: "operation-1",
    attemptId: "attempt-1", custodyId: "custody-1", hostBootId: "boot-1", liveProcessSessionIdentity: {}}),
    ids: Object.freeze({fresh: () => {ids += 1; order.push("ids"); return Object.freeze({
      materializationAuthorizationId: `pa-${ids}`, runtimeAuthorizationId: `rs-${ids}`,
      boundaryUseId: `boundary-${ids}`, connectionAttemptId: `connection-${ids}`, streamId: `stream-${ids}`});}}),
    providerAccessSnapshot: snapshot, route, providerAccess: Object.freeze({
      authorize: async input => {order.push("pa-authorize"); paInputs.push(input);
        const receipt = receiptFor(input as unknown as Record<string, unknown>);
        return Object.freeze({kind: options.paAuthorizeKind ?? "authorized", receipt}) as never;},
      observe: async input => {observes += 1; order.push(`pa-observe-${observes}`);
        const original = paInputs.at(-1) as Record<string, unknown>; const receipt = receiptFor(original);
        if ((observes === 1 && options.firstObserveDenied) || (observes === 2 && options.secondObserveDenied)) {
          return Object.freeze({kind: "indeterminate" as const});
        }
        assert.equal(input.authorizationRequestId, receipt.authorizationRequestId);
        return Object.freeze({kind: "observed" as const, receipt});},
    }), materializer: Object.freeze({render: async receipt => {order.push("render"); renders += 1;
      assert.equal(receipt.credentialBindingDigest, snapshot.ownerAuthorityDigest);
      return Object.freeze([Object.freeze({name: "authorization", valueBytes: bytes(`Bearer ${SECRET}`)})]);}}),
    runtimeSecurity, verifier: Object.freeze({signingKey: key,
      verifyProvisionalDecision: () => options.verifierProvisional ?? true,
      verifyGrant: () => options.verifierGrant ?? true}),
    localAuthorityCut: Object.freeze({read: () => {cutReads += 1; return Object.freeze({
      status: cutReads === 1 ? "current" as const : options.cut ?? "current",
      authorityId: "clock-authority", epoch: cutReads === 1 ? "epoch-1" : options.cutEpoch ?? "epoch-1", controlTime: 10});}}),
    journal: Object.freeze({consume: () => {journalCalls += 1; order.push("journal"); return options.journal ?? "consumed";}}),
    resolver: Object.freeze({resolve: async () => {order.push("resolve"); return Object.freeze({resolverIdentity: "resolver-1",
      resolverEpoch: "resolver-epoch-1", resolutionCount: 1 as const,
      addresses: Object.freeze([Object.freeze({family: "ipv4" as const, address: "93.184.216.34",
        classification: "public" as const})]), selectedAddress: "93.184.216.34"});}}),
    transport: Object.freeze({beginOpen: () => {order.push("open"); opens += 1; let closed = false;
      const binding = Object.freeze({peerAddress: "93.184.216.34", peerPort: 443, tlsProtocol: "TLSv1.3" as const,
        requestedSni: route.originHost, observedSni: route.originHost, chainValidated: true as const,
        dnsIdentity: route.originHost, certificateDigest: "sha256:certificate" as const,
        tlsPolicyDigest: "tls-policy-digest", spkiDigest: "sha256:spki" as const, alpn: "http/1.1" as const});
      return Object.freeze({ready: async () => Object.freeze({binding, dispatch: async consume => {
        order.push("dispatch"); const wire = consume(); if (wire === undefined || closed) {return Object.freeze({status: "failed" as const,
          acceptedRequestBytes: 0, acknowledgement: "acknowledged" as const});}
        wires.push(wire.slice()); if (options.dispatch === "throw") {throw new Error("write failed");}
        if (options.dispatch === "lost") {return Object.freeze({status: "failed" as const, acceptedRequestBytes: "unknown" as const,
          acknowledgement: "lost" as const});}
        const body = options.truncated ? "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nok" : response(options.status);
        return Object.freeze({status: "response" as const, acceptedRequestBytes: wire.byteLength,
          acknowledgement: "acknowledged" as const, response: chunks(body)});}}), close: async () => {closed = true;
        order.push("upstream-close"); return Object.freeze({state: options.upstreamClosure ?? "closed",
          receiptDigest: "upstream-close-receipt"});}});}}),
    clock: Object.freeze({now: () => 10, within: async <T>(_deadline: number, operation: () => Promise<T>) => await operation()}),
    evidence: Object.freeze({digest, record: async receipt => {order.push("evidence");
      assert.doesNotMatch(JSON.stringify(receipt), new RegExp(SECRET)); return options.evidence ?? "recorded";}}),
  });
  const session = createHostHttpEgressSession(deps);
  const operation = (): HttpEgressOperation => Object.freeze({operationId: "operation-1", attemptId: "attempt-1",
    expectedRequest: Object.freeze({requestId: `request-${ids + 1}`, method: "POST", path: "/invoke", host: "broker.invalid"}),
    connection: Object.freeze({request: chunks("POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}"),
      write: async value => {order.push("write-response"); writes.push(value.slice());}, close: async () => {order.push("inbound-close");
        return Object.freeze({state: options.inboundClosure ?? "closed", receiptDigest: "inbound-close-receipt"});}}),
    limits: Object.freeze({maxInboundHeaderBytes: 2048, maxInboundBodyBytes: 1024, maxUpstreamHeaderBytes: 2048,
      maxOutputBytes: 4096, maxBufferedBytes: 256, maxUpstreamWireBytes: 8192, deadline: 1000, closureDeadline: 1100})});
  return {session, operation, order, writes, wires, provisionalInputs, finalInputs,
    counts: () => ({ids, observes, opens, journalCalls, renders})};
};

describe("Host HTTP PA and signed RS integration", () => {
  test("permits two sequential successes with fresh PA and RS proofs", async () => {
    const f = fixture(); const first = await f.session.execute(f.operation()); const second = await f.session.execute(f.operation());
    assert.equal(first.outcome, "completed"); assert.equal(second.outcome, "completed");
    assert.deepEqual(f.counts(), {ids: 2, observes: 4, opens: 2, journalCalls: 2, renders: 2});
    assert.equal((f.provisionalInputs[0] as any).request.headers.credentialFields[0].credentialBindingDigest,
      snapshot.ownerAuthorityDigest); assert.doesNotMatch(JSON.stringify(f.finalInputs), new RegExp(SECRET));
    assert.match(new TextDecoder().decode(f.wires[0]), new RegExp(SECRET));
  });

  test("observed PA replay cannot render and both observation vetoes fail closed", async () => {
    for (const options of [{paAuthorizeKind: "observed" as const}, {firstObserveDenied: true}, {secondObserveDenied: true}]) {
      const f = fixture(options); const receipt = await f.session.execute(f.operation());
      assert.equal(receipt.outcome, "denied"); assert.equal(f.counts().journalCalls, 0);
      if (options.paAuthorizeKind === "observed") {assert.equal(f.counts().renders, 0);}
      if (options.firstObserveDenied) {assert.equal(f.counts().opens, 0);}
      if (options.secondObserveDenied) {assert.equal(f.counts().opens, 1);}
    }
  });

  test("rejects signatures, V2 key substitution, projection and TLS/peer substitution", async () => {
    const cases: Options[] = [{verifierProvisional: false}, {verifierGrant: false}, {substituteKey: true},
      {mutateProvisional: value => Object.freeze({...value, request: Object.freeze({...value.request,
        body: Object.freeze({...value.request.body, digest: "altered"})})})},
      {mutateGrant: value => Object.freeze({...value, payload: Object.freeze({...value.payload,
        selectedPeer: Object.freeze({address: "93.184.216.35", port: 443})})})},
      {mutateGrant: value => Object.freeze({...value, payload: Object.freeze({...value.payload,
        tls: Object.freeze({...value.payload.tls, certificateDigest: "sha256:other"})})})}];
    for (const item of cases) {const f = fixture(item); const result = await f.session.execute(f.operation());
      assert.equal(result.firstByteState, "not_sent"); assert.equal(f.counts().journalCalls, 0);}
  });

  test("consumes signed journal key first and rejects duplicate, cut and epoch drift", async () => {
    for (const item of [{journal: "duplicate" as const}, {cut: "revoked" as const}, {cut: "unknown" as const},
      {cutEpoch: "epoch-other"}]) {const f = fixture(item); const result = await f.session.execute(f.operation());
      assert.equal(result.firstByteState, "not_sent"); assert.equal(f.counts().journalCalls, 1);
      assert.equal(f.order.indexOf("journal") < f.order.indexOf("dispatch") || f.order.includes("dispatch"), true);}
  });

  test("closes before exposing retry status and blocks all later authority", async () => {
    for (const status of [301, 401, 403, 429, 500]) {const f = fixture({status});
      const first = await f.session.execute(f.operation()); const counts = f.counts();
      assert.equal(first.outboundResponseBytes, 0); assert.equal(f.writes.length, 0);
      await f.session.execute(f.operation()); assert.deepEqual(f.counts(), counts);}
  });

  test("lost acknowledgement, truncation, unknown close and evidence loss permanently close admission", async () => {
    for (const item of [{dispatch: "lost" as const}, {dispatch: "throw" as const}, {truncated: true},
      {upstreamClosure: "unknown" as const}, {inboundClosure: "unknown" as const}, {evidence: "unknown" as const}]) {
      const f = fixture(item); const first = await f.session.execute(f.operation()); const counts = f.counts();
      assert.notEqual(first.outcome, "completed"); await f.session.execute(f.operation()); assert.deepEqual(f.counts(), counts);
    }
  });
});
