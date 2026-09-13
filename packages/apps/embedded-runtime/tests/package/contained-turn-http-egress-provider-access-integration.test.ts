import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, test} from "node:test";
import {createCredentialMaterializationRequestDigest, createInMemoryContainedTurnDispatchConsumptionV1} from "@agent-teams/provider-access/composition";
import {createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate, createNodeSha256EgressDigest,
  type EgressCurrentAuthorityV2} from "@agent-teams/runtime-security/composition";
import {createContainedTurnHttpProviderAccessAuthorization} from "../../dist/composition/contained-turn-http-provider-access.js";
import {bindContainedTurnHttpRuntimeSecurity} from "../../dist/composition/contained-turn-http-runtime-security.js";
import {canonical} from "../support/external/runtime-security/provider-process-egress-authorization.fixtures.ts";
import {createHostHttpEgressSession} from "@agent-teams/agent-execution/composition";
import type {HttpEgressOperation, HttpEgressReceipt,HostHttpGrant,HostHttpProvisionalDecision,
  HttpEgressBrokerPorts} from "@agent-teams/agent-execution/composition";

const enc = new TextEncoder(); const SECRET = "fixture-secret-do-not-observe";
const bytes = (value: string) => enc.encode(value);
async function* chunks(value: string): AsyncIterable<Uint8Array> {yield bytes(value);}
const digest = (parts: readonly Uint8Array[]) => {const hash = createHash("sha256");
  for (const part of parts) {hash.update(part);} return `sha256:${hash.digest("hex")}` as const;};
const key = Object.freeze({algorithm: "ed25519" as const, signatureEncoding: "hex-lower" as const,
  keyRef: "key-1", publicKeyDigest: "public-key-digest", keyGeneration: "key-generation-4",
  signerRevision: "signer-revision-2", hostReservationId: "custody-1"});
const signature = Object.freeze({...key, value: "a".repeat(128)});
const snapshot = Object.freeze({tenantId: "tenant-1", projectId: "project-1", scopeDigest: digest([bytes("scope")]),
  accessRef: "access-1", provider: "codex" as const, providerAccountRef: "account-1", providerRouteRef: "route-1",
  credentialBindingRef: "binding-1", ownerAuthorityDigest: digest([bytes("pa-original-binding")]), revision: 7,
  credentialGeneration: 11, availability: "available" as const, revocation: "active" as const});
const route = Object.freeze({routeReceiptDigest: "route-receipt", originHost: "provider.example", originPort: 443,
  upstreamMethod: "POST" as const, upstreamPath: "/fixed", forwardedRequestHeaderNames: Object.freeze(["content-type"] as const),
  credentialFieldNames: Object.freeze(["authorization"])});
const response = (status = 200) => `HTTP/1.1 ${status} Status\r\nContent-Length: 2\r\n\r\nok`;
const flipSignature = (value: string) => `${value[0] === "0" ? "1" : "0"}${value.slice(1)}`;
const scope = Object.freeze({tenantId: snapshot.tenantId, projectId: snapshot.projectId,
  operationId: "operation-1", scopeDigest: snapshot.scopeDigest});
const tlsPolicyDigest = digest([bytes("tls-policy")]);
const policy = (requestDigest: string) => Object.freeze({policyRef: "policy-1", policyRevision: "revision-3",
  policyGeneration: "policy-generation-9", authorizedRequestDigest: requestDigest,
  origin: Object.freeze({scheme: "https" as const, hostname: route.originHost, port: route.originPort}),
  dnsIdentity: route.originHost, tlsPolicyDigest, limits: Object.freeze({requestBytes: 1_000_000,
    responseBytes: 1_000_000, totalMilliseconds: 900}), decisionTtlMilliseconds: 100, revoked: false});
const providerAccess = Object.freeze({accessRef: snapshot.accessRef, providerRef: snapshot.provider,
  accountRef: snapshot.providerAccountRef, routeRef: snapshot.providerRouteRef,
  routeAuthorityDigest: digest([bytes("runtime-security-owned-route-authority")]),
  credentialBindingDigest: snapshot.ownerAuthorityDigest,
  routeGeneration: String(snapshot.revision), credentialGeneration: String(snapshot.credentialGeneration)});

// Synthetic policy/current-authority owners only: this lane composes real RS signing
// and verification with real PA application decisions, not production owner stores.
const realSecurityFixture = (drift?: "policyGeneration" | "credentialGeneration") => {
  let authority: EgressCurrentAuthorityV2 | undefined;
  const resolves: unknown[] = []; const reads: unknown[] = [];
  const candidate = createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate({
    scope, hostReservationId: "custody-1", keyRef: "key-1", keyGeneration: "key-generation-4",
    signerRevision: "signer-revision-2",
    clock: {read: () => ({authorityId: "clock-authority", epoch: "epoch-1", controlTime: 10})},
    authorityOwner: {
      async resolvePolicy(input) {
        resolves.push(input);
        authority = {authorityRef: "authority-1",
          policy: policy(createNodeSha256EgressDigest().digest(canonical(input.request))), providerAccess};
        return {status: "current", authority};
      },
      async readCurrent(input) {
        reads.push(input);
        if (authority === undefined) {throw new Error("fixture policy unresolved");}
        if (drift === "policyGeneration") {authority = {...authority,
          policy: {...authority.policy, policyGeneration: "policy-generation-10"}};}
        if (drift === "credentialGeneration") {authority = {...authority,
          providerAccess: {...authority.providerAccess, credentialGeneration: "12"}};}
        return {status: "current", authority};
      },
    },
  });
  try {return {candidate, binding: bindContainedTurnHttpRuntimeSecurity(candidate), resolves, reads};}
  catch (error) {candidate.dispose(); throw error;}
};

type Options = Readonly<{status?: number; paAuthorizeKind?: "authorized" | "observed"; firstObserveDenied?: boolean;
  revokeBeforeObserve?: boolean; revokeBeforeSecondObserve?: boolean; secondObserveDenied?: boolean;
  verifierProvisional?: boolean; verifierGrant?: boolean; substituteKey?: boolean;
  mutateProvisional?: (value: HostHttpProvisionalDecision) => HostHttpProvisionalDecision;
  mutateGrant?: (value: HostHttpGrant) => HostHttpGrant; journal?: "consumed" | "duplicate" | "mismatch" | "unknown";
  cut?: "current" | "revoked" | "unknown"; cutEpoch?: string; dispatch?: "success" | "lost" | "throw";
  truncated?: boolean; upstreamClosure?: "closed" | "unknown"; inboundClosure?: "closed" | "unknown";
  evidence?: "recorded" | "unknown"}>;

const fixture = (options: Options = {}, security?: ReturnType<typeof bindContainedTurnHttpRuntimeSecurity>) => {
  const order: string[] = []; const writes: Uint8Array[] = []; const wires: Uint8Array[] = [];
  const paInputs: Parameters<HttpEgressBrokerPorts["providerAccess"]["authorize"]>[0][] = [];
  const provisionalInputs: Parameters<HttpEgressBrokerPorts["runtimeSecurity"]["requestProvisional"]>[0][] = [];
  const finalInputs: Parameters<HttpEgressBrokerPorts["runtimeSecurity"]["authorizeFirstApplicationByte"]>[0][] = [];
  const decisions: HostHttpProvisionalDecision[] = []; const grants: HostHttpGrant[] = [];
  const journalInputs: {key: HostHttpGrant["payload"]["consumption"]["journalKey"]; requestFingerprint: string}[] = [];
  const consumed = new Map<string, string>();
  const materializedBuffers: Uint8Array[] = []; const wireBuffers: Uint8Array[] = [];
  let ids = 0; let observes = 0; let opens = 0; let journalCalls = 0; let renders = 0;
  const paBinding = Object.freeze({...snapshot, acceptedAuthorityDigest: "accepted:1", authorityHeadDigest: "authority:1",
    bindingDigest: "binding:1", bindingRevision: snapshot.revision, credentialBindingDigest: snapshot.ownerAuthorityDigest,
    claimBeforeControlTime: 1000, expiresAtControlTime: 1000, opaqueOwnerEvidenceRef: "pa:evidence"});
  const {revision: _revision, ownerAuthorityDigest: _ownerAuthorityDigest, ...paSeed} = paBinding;
  const pa = createInMemoryContainedTurnDispatchConsumptionV1({bindings: [paSeed], initialControlTime: 10});
  const paOutcomes: Awaited<ReturnType<typeof pa.materialization.authorize>>[] = [];
  const runtimeSecurity: HttpEgressBrokerPorts["runtimeSecurity"] = Object.freeze({
    requestProvisional: async (input: Parameters<HttpEgressBrokerPorts["runtimeSecurity"]["requestProvisional"]>[0]) => {
      order.push("rs-provisional"); provisionalInputs.push(input);
      if (security !== undefined) {
        const outcome = await security.runtimeSecurity.requestProvisional(input);
        if (outcome.status !== "authorized") {return outcome;}
        decisions.push(outcome.decision);
        return Object.freeze({status: "authorized" as const,
          decision: options.mutateProvisional?.(outcome.decision) ?? outcome.decision});
      }
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
    authorizeFirstApplicationByte: async (input: Parameters<HttpEgressBrokerPorts["runtimeSecurity"]["authorizeFirstApplicationByte"]>[0]) => {
      order.push("rs-final"); finalInputs.push(input);
      if (security !== undefined) {
        const outcome = await security.runtimeSecurity.authorizeFirstApplicationByte(input);
        if (outcome.status !== "authorized") {return outcome;}
        grants.push(outcome.grant);
        return Object.freeze({status: "authorized" as const,
          grant: options.mutateGrant?.(outcome.grant) ?? outcome.grant});
      }
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
    providerAccessSnapshot: snapshot, route, providerAccess: createContainedTurnHttpProviderAccessAuthorization({
      createRequestDigest: createCredentialMaterializationRequestDigest,
      authorization: {
        async authorize(input) {
          order.push("pa-authorize"); paInputs.push(input);
          const {requestDigest, ...unsigned} = input;
          assert.equal(requestDigest, await createCredentialMaterializationRequestDigest(unsigned));
          if (options.paAuthorizeKind === "observed") {await pa.materialization.authorize(input);}
          const outcome = await pa.materialization.authorize(input); paOutcomes.push(outcome); return outcome;
        },
        async observe(input) {
          observes += 1; order.push(`pa-observe-${observes}`);
          if ((observes === 1 && options.firstObserveDenied) || (observes === 2 && options.secondObserveDenied)) {
            return Object.freeze({kind: "indeterminate" as const});
          }
          if (options.revokeBeforeObserve || options.revokeBeforeSecondObserve && observes === 2) {
            await pa.control.replaceBindingHead({...paSeed, revocation: "revoked"});}
          const outcome = await pa.materialization.observe(input); paOutcomes.push(outcome); return outcome;
        },
      },
    }), materializer: Object.freeze({render: async (receipt: Parameters<HttpEgressBrokerPorts["materializer"]["render"]>[0]) => {order.push("render"); renders += 1;
      assert.equal(receipt.credentialBindingDigest, snapshot.ownerAuthorityDigest);
      const valueBytes = bytes(`Bearer ${SECRET}`); materializedBuffers.push(valueBytes);
      return Object.freeze([Object.freeze({name: "authorization", valueBytes})]);}}),
    runtimeSecurity, verifier: security?.verifier ?? Object.freeze({signingKey: key,
      verifyProvisionalDecision: () => options.verifierProvisional ?? true,
      verifyGrant: () => options.verifierGrant ?? true}),
    localAuthorityCut: Object.freeze({read: () => {return Object.freeze({
      status: journalCalls === 0 ? "current" as const : options.cut ?? "current",
      authorityId: "clock-authority", epoch: journalCalls === 0 ? "epoch-1" : options.cutEpoch ?? "epoch-1", controlTime: 10});}}),
    journal: Object.freeze({consume: (journalKey: Parameters<HttpEgressBrokerPorts["journal"]["consume"]>[0], requestFingerprint: string) => {
      journalCalls += 1; order.push("journal"); journalInputs.push({key: journalKey, requestFingerprint});
      if (options.journal !== undefined) {return options.journal;}
      const id = JSON.stringify(journalKey); const previous = consumed.get(id);
      if (previous !== undefined) {return previous === requestFingerprint ? "duplicate" : "mismatch";}
      consumed.set(id, requestFingerprint); return "consumed";
    }}),
    resolver: Object.freeze({resolve: async () => {order.push("resolve"); return Object.freeze({resolverIdentity: "resolver-1",
      resolverEpoch: "resolver-epoch-1", resolutionCount: 1 as const,
      addresses: Object.freeze([Object.freeze({family: "ipv4" as const, address: "93.184.216.34",
        classification: "public" as const})]), selectedAddress: "93.184.216.34"});}}),
    transport: Object.freeze({beginOpen: () => {order.push("open"); opens += 1; let closed = false;
      const binding = Object.freeze({peerAddress: "93.184.216.34", peerPort: 443, tlsProtocol: "TLSv1.3" as const,
        requestedSni: route.originHost, observedSni: route.originHost, chainValidated: true as const,
        dnsIdentity: route.originHost, certificateDigest: digest([bytes("certificate")]),
        tlsPolicyDigest, spkiDigest: digest([bytes("spki")]), alpn: "http/1.1" as const});
      return Object.freeze({ready: async () => Object.freeze({binding, dispatch: async (consume: () => Uint8Array | undefined) => {
        order.push("dispatch"); const wire = consume(); if (wire === undefined || closed) {return Object.freeze({status: "failed" as const,
          acceptedRequestBytes: 0, acknowledgement: "acknowledged" as const});}
        wireBuffers.push(wire); wires.push(wire.slice()); if (options.dispatch === "throw") {throw new Error("write failed");}
        if (options.dispatch === "lost") {return Object.freeze({status: "failed" as const, acceptedRequestBytes: "unknown" as const,
          acknowledgement: "lost" as const});}
        const body = options.truncated ? "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nok" : response(options.status);
        return Object.freeze({status: "response" as const, acceptedRequestBytes: wire.byteLength,
          acknowledgement: "acknowledged" as const, response: chunks(body)});}}), close: async () => {closed = true;
        order.push("upstream-close"); return Object.freeze({state: options.upstreamClosure ?? "closed",
          receiptDigest: "upstream-close-receipt"});}});}}),
    clock: Object.freeze({now: () => 10, within: async <T>(_deadline: number, operation: () => Promise<T>) => await operation()}),
    evidence: Object.freeze({digest, record: async (receipt: HttpEgressReceipt) => {order.push("evidence");
      assert.doesNotMatch(JSON.stringify(receipt), new RegExp(SECRET)); return options.evidence ?? "recorded";}}),
  });
  const session = createHostHttpEgressSession(deps);
  const operation = (): HttpEgressOperation => Object.freeze({operationId: "operation-1", attemptId: "attempt-1",
    expectedRequest: Object.freeze({requestId: `request-${ids + 1}`, method: "POST", path: "/invoke", host: "broker.invalid"}),
    connection: Object.freeze({request: chunks("POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}"),
      write: async (value: Uint8Array) => {order.push("write-response"); writes.push(value.slice());}, close: async () => {order.push("inbound-close");
        return Object.freeze({state: options.inboundClosure ?? "closed", receiptDigest: "inbound-close-receipt"});}}),
    limits: Object.freeze({maxInboundHeaderBytes: 2048, maxInboundBodyBytes: 1024, maxUpstreamHeaderBytes: 2048,
      maxOutputBytes: 4096, maxBufferedBytes: 256, maxUpstreamWireBytes: 8192, deadline: 1000, closureDeadline: 1100})});
  return {session, operation, order, writes, wires, paInputs, paOutcomes, provisionalInputs, finalInputs,
    decisions, grants, journalInputs, consumed, materializedBuffers, wireBuffers,
    dispose: () => {session.close(); for (const buffer of [...materializedBuffers, ...wireBuffers, ...wires, ...writes]) {buffer.fill(0);}},
    counts: () => ({ids, observes, opens, journalCalls, renders})};
};

describe("Host HTTP PA and signed RS integration", () => {
  test("permits two sequential successes with fresh PA and RS proofs", async () => {
    const f = fixture(); const first = await f.session.execute(f.operation()); const second = await f.session.execute(f.operation());
    assert.equal(first.outcome, "completed"); assert.equal(second.outcome, "completed");
    assert.deepEqual(f.counts(), {ids: 2, observes: 4, opens: 2, journalCalls: 2, renders: 2});
    assert.deepEqual(f.order.filter(step => ["pa-authorize", "render", "resolve", "open"].includes(step)),
      ["pa-authorize", "render", "resolve", "open", "pa-authorize", "render", "resolve", "open"]);
    assert.equal((f.provisionalInputs[0] as any).request.headers.credentialFields[0].credentialBindingDigest,
      snapshot.ownerAuthorityDigest); assert.doesNotMatch(JSON.stringify(f.finalInputs), new RegExp(SECRET));
    assert.match(new TextDecoder().decode(f.wires[0]), new RegExp(SECRET));
  });

  test("observed PA replay cannot render and both observation vetoes fail closed", async () => {
    for (const options of [{paAuthorizeKind: "observed" as const}, {firstObserveDenied: true}, {secondObserveDenied: true}]) {
      const f = fixture(options); const receipt = await f.session.execute(f.operation());
      assert.equal(receipt.outcome, "denied"); assert.equal(f.counts().journalCalls, 0);
      assert.equal(receipt.anomalyCode, options.paAuthorizeKind === "observed" ? "provider_access_denied" : "provider_generation_drift");
      assert.equal(f.order.includes("pa-authorize"), true);
      assert.equal(f.counts().observes, options.paAuthorizeKind === "observed" ? 0 : options.firstObserveDenied ? 1 : 2);
      if (options.paAuthorizeKind === "observed") {assert.equal(f.counts().renders, 0);}
      if (options.firstObserveDenied) {assert.equal(f.counts().opens, 0);}
      if (options.secondObserveDenied) {assert.equal(f.counts().opens, 1);}
    }
  });

  test("a real PA revocation prevents transport despite an earlier authorized receipt", async () => {
    const f = fixture({revokeBeforeObserve: true});
    const result = await f.session.execute(f.operation());
    assert.equal(result.outcome, "denied"); assert.equal(result.anomalyCode, "provider_generation_drift");
    assert.equal(result.firstByteState, "not_sent"); assert.equal(f.wires.length, 0);
    assert.equal(f.counts().opens, 0); assert.equal(f.counts().journalCalls, 0);
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
      const final = item.verifierGrant === false || item.mutateGrant !== undefined;
      assert.equal(result.anomalyCode, final ? "final_denied" : "provisional_denied");
      assert.equal(f.provisionalInputs.length, 1); assert.equal(f.finalInputs.length, final ? 1 : 0);
      assert.equal(result.firstByteState, "not_sent"); assert.equal(f.counts().journalCalls, 0);}
  });

  test("consumes signed journal key first and rejects duplicate, cut and epoch drift", async () => {
    for (const item of [{journal: "duplicate" as const}, {cut: "revoked" as const}, {cut: "unknown" as const},
      {cutEpoch: "epoch-other"}]) {const f = fixture(item); const result = await f.session.execute(f.operation());
      assert.equal(result.firstByteState, "not_sent"); assert.equal(f.counts().journalCalls, 1, JSON.stringify({item, result, counts: f.counts(), order: f.order}));
      assert.equal(result.anomalyCode, item.journal === "duplicate" ? "final_denied" : "provider_generation_drift");
      assert.deepEqual(f.order.filter(step => step === "dispatch" || step === "journal"), ["dispatch", "journal"]);
      assert.equal(f.wires.length, 0);}
  });

  test("closes before exposing retry status and blocks all later authority", async () => {
    for (const status of [301, 401, 403, 429, 500]) {const f = fixture({status});
      const first = await f.session.execute(f.operation()); const counts = f.counts();
      assert.equal(first.firstByteState, "sent"); assert.equal(f.wires.length, 1);
      assert.equal(first.anomalyCode, status === 301 ? "redirect_rejected" : status === 429 ? "upstream_rate_limited"
        : status === 500 ? "upstream_server_error" : "upstream_auth_rejected");
      assert.equal(first.upstreamClosure, "closed"); assert.equal(first.inboundClosure, "closed");
      assert.equal(first.outboundResponseBytes, 0); assert.equal(f.writes.length, 0);
      await f.session.execute(f.operation()); assert.deepEqual(f.counts(), counts);}
  });

  test("lost acknowledgement, truncation, unknown close and evidence loss permanently close admission", async () => {
    for (const item of [{dispatch: "lost" as const}, {dispatch: "throw" as const}, {truncated: true},
      {upstreamClosure: "unknown" as const}, {inboundClosure: "unknown" as const}, {evidence: "unknown" as const}]) {
      const f = fixture(item); const first = await f.session.execute(f.operation()); const counts = f.counts();
      assert.equal(f.wires.length, 1);
      assert.deepEqual(counts, {ids: 1, observes: 2, opens: 1, journalCalls: 1, renders: 1});
      if (item.dispatch !== undefined) {assert.equal(first.firstByteState, "uncertain");}
      if (item.truncated) {assert.equal(first.anomalyCode, "upstream_truncated");}
      if (item.upstreamClosure || item.inboundClosure) {assert.equal(first.anomalyCode, "closure_unproved");}
      if (item.evidence) {assert.equal(first.anomalyCode, "evidence_ack_lost");}
      assert.notEqual(first.outcome, "completed"); await f.session.execute(f.operation()); assert.deepEqual(f.counts(), counts);
    }
  });
});

const assertZeroed = (buffers: readonly Uint8Array[]) => {
  for (const buffer of buffers) {assert.ok(buffer.byteLength > 0); assert.ok(buffer.every(value => value === 0));}
};
const assertBeforeByteDenial = (f: ReturnType<typeof fixture>, receipt: HttpEgressReceipt,
  anomaly: HttpEgressReceipt["anomalyCode"], opened: boolean) => {
  assert.equal(receipt.outcome, "denied"); assert.equal(receipt.anomalyCode, anomaly);
  assert.equal(receipt.firstByteState, "not_sent"); assert.equal(receipt.upstreamRequestBytes, 0);
  assert.equal(receipt.outboundResponseBytes, 0); assert.equal(receipt.inboundClosure, "closed");
  assert.equal(receipt.upstreamClosure, opened ? "closed" : "not_opened");
  assert.equal(f.counts().opens, opened ? 1 : 0); assert.equal(f.counts().journalCalls, 0);
  assert.equal(f.wires.length, 0); assert.equal(f.writes.length, 0);
  assert.equal(f.materializedBuffers.length, 1); assertZeroed(f.materializedBuffers);
};

describe("Host HTTP with real Ed25519 RS binding and PA application", () => {
  test("two sequential broker requests consume fresh signed grants with original PA scope and fingerprint", async t => {
    const security = realSecurityFixture();
    t.after(() => {security.candidate.dispose(); assert.equal(security.candidate.isDisposed(), true);});
    const f = fixture({}, security.binding); t.after(f.dispose);
    const receipts = [await f.session.execute(f.operation()), await f.session.execute(f.operation())];
    assert.deepEqual(f.counts(), {ids: 2, observes: 4, opens: 2, journalCalls: 2, renders: 2});
    assert.deepEqual(f.paOutcomes.map(outcome => outcome.kind),
      ["authorized", "observed", "observed", "authorized", "observed", "observed"]);
    assert.equal(security.resolves.length, 2); assert.equal(security.reads.length, 2);
    assert.equal(f.decisions.length, 2); assert.equal(f.grants.length, 2); assert.equal(f.consumed.size, 2);
    assert.equal(f.wires.length, 2); assert.equal(f.wireBuffers.length, 2); assert.equal(f.materializedBuffers.length, 2);
    for (const [index, receipt] of receipts.entries()) {
      const decision = f.decisions[index]!; const grant = f.grants[index]!; const input = f.paInputs[index]!;
      assert.equal(receipt.outcome, "completed"); assert.equal(receipt.anomalyCode, "none");
      assert.equal(receipt.firstByteState, "sent"); assert.equal(receipt.upstreamRequestBytes, f.wires[index]!.byteLength);
      assert.equal(receipt.inboundClosure, "closed"); assert.equal(receipt.upstreamClosure, "closed");
      assert.equal(receipt.provisionalAuthorizationReceiptDigest, decision.decisionDigest);
      assert.equal(receipt.finalAuthorizationReceiptDigest, grant.finalAuthorizationDigest);
      assert.equal(security.candidate.hostEgressVerifierV2.verifyProvisionalDecision(decision), true);
      assert.equal(security.candidate.hostEgressVerifierV2.verifyGrant(grant), true);
      assert.equal(security.binding.verifier.verifyProvisionalDecision(decision), true);
      assert.equal(security.binding.verifier.verifyGrant(grant), true);
      assert.equal(grant.signature.algorithm, "ed25519"); assert.match(grant.signature.value, /^[a-f0-9]{128}$/);
      assert.deepEqual(decision.scope, scope); assert.deepEqual(grant.payload.scope, scope);
      assert.deepEqual(decision.providerAccess, providerAccess); assert.deepEqual(grant.payload.providerAccess, providerAccess);
      assert.equal(input.credentialBindingDigest, snapshot.ownerAuthorityDigest);
      assert.equal(input.scopeDigest, scope.scopeDigest); assert.equal(input.tenantId, scope.tenantId);
      assert.equal(input.projectId, scope.projectId); assert.equal(input.authorizationRequestId, `pa-${index + 1}`);
      assert.equal(grant.payload.authorizationRequestId, `rs-${index + 1}`);
      assert.equal(grant.payload.boundaryUseId, `boundary-${index + 1}`);
      assert.equal(grant.payload.connectionAttemptId, `connection-${index + 1}`);
      assert.equal(grant.payload.streamId, `stream-${index + 1}`);
      assert.deepEqual(grant.payload.request, f.provisionalInputs[index]!.request);
      assert.equal(grant.payload.request.headers.credentialFields[0]!.credentialBindingDigest, snapshot.ownerAuthorityDigest);
      const {requestFingerprint, ...consumption} = grant.payload.consumption;
      assert.equal(requestFingerprint, createNodeSha256EgressDigest().digest(canonical({...grant.payload, consumption})));
      assert.deepEqual(f.journalInputs[index], {key: {namespace: "provider-process-egress/v2",
        tenantId: scope.tenantId, projectId: scope.projectId, operationId: scope.operationId,
        boundaryUseId: grant.payload.boundaryUseId}, requestFingerprint});
      assert.equal(f.consumed.get(JSON.stringify(consumption.journalKey)), requestFingerprint);
      assert.match(new TextDecoder().decode(f.wires[index]), new RegExp(SECRET));
    }
    for (const outcome of f.paOutcomes) {
      assert.ok("receipt" in outcome); assert.equal(outcome.receipt.credentialBindingDigest, snapshot.ownerAuthorityDigest);
    }
    assert.notEqual(f.paInputs[0]!.requestDigest, f.paInputs[1]!.requestDigest);
    assert.notEqual(f.decisions[0]!.decisionDigest, f.decisions[1]!.decisionDigest);
    assert.notEqual(f.grants[0]!.finalAuthorizationDigest, f.grants[1]!.finalAuthorizationDigest);
    assert.notEqual(f.grants[0]!.signature.value, f.grants[1]!.signature.value);
    assert.notEqual(f.journalInputs[0]!.requestFingerprint, f.journalInputs[1]!.requestFingerprint);
    assert.deepEqual(f.order.filter(step => ["dispatch", "journal", "upstream-close", "inbound-close", "evidence"].includes(step)),
      ["dispatch", "journal", "upstream-close", "inbound-close", "evidence",
        "dispatch", "journal", "upstream-close", "inbound-close", "evidence"]);
    assert.equal(f.writes.reduce((total, value) => total + value.byteLength, 0),
      receipts.reduce((total, receipt) => total + receipt.outboundResponseBytes, 0));
    assertZeroed(f.materializedBuffers); assertZeroed(f.wireBuffers);
    assert.doesNotMatch(JSON.stringify([f.paOutcomes, f.decisions, f.grants, f.journalInputs, receipts]), new RegExp(SECRET));
  });

  test("current PA revocation after a real signed provisional decision denies before the first byte", async t => {
    const security = realSecurityFixture();
    t.after(() => {security.candidate.dispose(); assert.equal(security.candidate.isDisposed(), true);});
    const f = fixture({revokeBeforeSecondObserve: true}, security.binding); t.after(f.dispose);
    const receipt = await f.session.execute(f.operation());
    assertBeforeByteDenial(f, receipt, "provider_generation_drift", true);
    assert.equal(f.decisions.length, 1);
    assert.equal(security.binding.verifier.verifyProvisionalDecision(f.decisions[0]!), true);
    assert.deepEqual(f.paOutcomes.map(outcome => outcome.kind), ["authorized", "observed", "rejected"]);
    const revoked = f.paOutcomes[2]!; assert.equal(revoked.kind, "rejected");
    if (revoked.kind !== "rejected") {assert.fail("Expected current PA rejection");}
    assert.equal(revoked.reason, "revoked"); assert.equal(revoked.receipt.decision, "authorized");
    assert.equal(f.finalInputs.length, 0); assert.equal(f.grants.length, 0); assert.equal(security.reads.length, 0);
    const counts = f.counts(); await f.session.execute(f.operation()); assert.deepEqual(f.counts(), counts);
  });

  for (const drift of ["policyGeneration", "credentialGeneration"] as const) {
    test(`fresh RS ${drift} drift denies the broker final grant before the first byte`, async t => {
      const security = realSecurityFixture(drift);
      t.after(() => {security.candidate.dispose(); assert.equal(security.candidate.isDisposed(), true);});
      const f = fixture({}, security.binding); t.after(f.dispose);
      const receipt = await f.session.execute(f.operation());
      assertBeforeByteDenial(f, receipt, "final_denied", true);
      assert.equal(f.decisions.length, 1); assert.equal(f.finalInputs.length, 1); assert.equal(f.grants.length, 0);
      assert.equal(security.binding.verifier.verifyProvisionalDecision(f.decisions[0]!), true);
      assert.deepEqual(f.decisions[0]!.providerAccess, providerAccess);
      assert.equal(f.decisions[0]!.policy.policyGeneration, "policy-generation-9");
      assert.deepEqual(f.paOutcomes.map(outcome => outcome.kind), ["authorized", "observed", "observed"]);
      assert.equal(security.resolves.length, 1);
      assert.deepEqual(security.reads, [{scope, authorityRef: "authority-1"}]);
      const counts = f.counts(); await f.session.execute(f.operation()); assert.deepEqual(f.counts(), counts);
    });
  }

  const tampering: readonly {name: string; options: Options}[] = [
    {name: "provisional signature", options: {mutateProvisional: value => Object.freeze({...value,
      signature: Object.freeze({...value.signature, value: flipSignature(value.signature.value)})})}},
    {name: "final signature", options: {mutateGrant: value => Object.freeze({...value,
      signature: Object.freeze({...value.signature, value: flipSignature(value.signature.value)})})}},
    {name: "signed scope", options: {mutateProvisional: value => Object.freeze({...value,
      scope: Object.freeze({...value.scope, scopeDigest: digest([bytes("other-scope")])})})}},
    {name: "signed journal fingerprint", options: {mutateGrant: value => Object.freeze({...value,
      payload: Object.freeze({...value.payload, consumption: Object.freeze({...value.payload.consumption,
        requestFingerprint: digest([bytes("other-fingerprint")])})})})}},
  ];
  for (const {name, options} of tampering) {
    test(`real verifier rejects tampered ${name} before dispatch or journal consumption`, async t => {
      const security = realSecurityFixture();
      t.after(() => {security.candidate.dispose(); assert.equal(security.candidate.isDisposed(), true);});
      const f = fixture(options, security.binding); t.after(f.dispose);
      const receipt = await f.session.execute(f.operation()); const final = options.mutateGrant !== undefined;
      assertBeforeByteDenial(f, receipt, final ? "final_denied" : "provisional_denied", final);
      assert.equal(f.decisions.length, 1); assert.equal(f.finalInputs.length, final ? 1 : 0);
      assert.equal(f.grants.length, final ? 1 : 0); assert.equal(security.reads.length, final ? 1 : 0);
      assert.equal(security.binding.verifier.verifyProvisionalDecision(f.decisions[0]!), true);
      if (options.mutateProvisional) {
        assert.equal(security.binding.verifier.verifyProvisionalDecision(options.mutateProvisional(f.decisions[0]!)), false);
      }
      if (options.mutateGrant) {
        assert.equal(security.binding.verifier.verifyGrant(f.grants[0]!), true);
        assert.equal(security.binding.verifier.verifyGrant(options.mutateGrant(f.grants[0]!)), false);
      }
      const counts = f.counts(); await f.session.execute(f.operation()); assert.deepEqual(f.counts(), counts);
    });
  }
});
