import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createContainedTurnEgressGateway, createNodeEd25519EgressSigner,
  type ContainedTurnEgressDependencies, type ContainedTurnEgressRequest,
  type EgressAuthorizationBodyV1, type EgressTransportV1, type NetworkAddressV1,
  type TrustedEgressHostIdentityV1 } from "../dist/composition.js";
import * as ordinaryRuntimeSecurity from "../dist/index.js";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const utf8 = new TextEncoder();
const frame = (tag: string, values: readonly (string | Uint8Array)[]) => {const fields = [utf8.encode(tag),
  ...values.map(value => typeof value === "string" ? utf8.encode(value) : value)];
  const bytes = new Uint8Array(fields.reduce((n, value) => n + value.byteLength + 4, 0));
  const view = new DataView(bytes.buffer); let offset = 0; for (const value of fields) {view.setUint32(offset, value.byteLength);
    offset += 4; bytes.set(value, offset); offset += value.byteLength;} return bytes;};
const keys = generateKeyPairSync("ed25519");
const signer = () => createNodeEd25519EgressSigner(Object.freeze({keyId: "key-1", keyGeneration: "key-gen-1",
  signerRevision: "signer-1", privateKey: keys.privateKey, publicKey: keys.publicKey}));
const host = (overrides: Partial<TrustedEgressHostIdentityV1> = {}): TrustedEgressHostIdentityV1 => Object.freeze({
  attemptId: "attempt-1", environmentId: "environment-1", gatewayId: "gateway-1", hostInstanceId: "host-instance-1",
  hostBootId: "host-boot-1", transportMode: "one_shot_https", ...overrides,
});
const binding = Object.freeze({credentialBindingRef: "credential-binding-1", credentialBindingDigest: sha("credential"),
  credentialGeneration: "credential-generation-1", credentialRevision: "credential-revision-1"});
const route = (overrides: Record<string, unknown> = {}) => Object.freeze({
  contractVersion: "provider-route-authority/v1", tenantId: "tenant-1", projectId: "project-1",
  providerId: "provider-1", providerAccountRef: "account-1", providerRouteRef: "route-1", ...binding,
  scopeDigest: sha("scope"), resolutionAuthorityId: "resolver-1", resolutionGeneration: "resolver-generation-1",
  routeRevision: "route-revision-1", authorityDigest: sha("route-authority"), scheme: "https",
  host: "api.example.com", port: 443, tlsServerName: "api.example.com", pathConstraint: "/v1/turn", ...overrides,
  allowedTlsSpkiDigests: Object.freeze([sha("spki")]),
  tlsPinSetDigest: sha(frame("contained-turn-egress-tls-pin-set/v1", [sha("spki")])),
  tlsPinSetGeneration: "pin-generation-1", tlsPinSetRevision: "pin-revision-1", ...overrides,
});
const policy = (overrides: Record<string, unknown> = {}) => Object.freeze({
  contractVersion: "contained-turn-egress-policy/v1", policyId: "policy-1", policyRevision: "policy-revision-1",
  policyGeneration: "policy-generation-1", keyId: "key-1", keyGeneration: "key-gen-1",
  signerRevision: "signer-1", timeAuthorityId: "clock-1", timeGeneration: "clock-generation-1",
  observedAt: 100, expiresAt: 500, maxRequestBytes: 4_096, maxResponseBytes: 8_192,
  maxDeadlineMs: 300, ...overrides,
});
const v4 = (bytesHex = "5db8d822"): NetworkAddressV1 => Object.freeze({family: "ipv4", bytesHex});
const v6 = (bytesHex = "26062800022000010248189325c81946"): NetworkAddressV1 => Object.freeze({family: "ipv6", bytesHex});
const observation = (overrides: Record<string, unknown> = {}) => {const addresses = (overrides.canonicalAddresses ?? [v4()]) as NetworkAddressV1[];
  return Object.freeze({canonicalAddresses: Object.freeze(addresses), peerAddress: v4(), peerPort: 443, tlsServerName: "api.example.com",
  tlsSpkiDigest: sha("spki"), alpn: "http/1.1", phase: "immediately_before_first_application_byte",
  resolutionAuthorityId: "resolver-1", resolutionGeneration: "resolver-generation-1",
  answerSetDigest: sha(frame("contained-turn-egress-answer-set/v1", addresses.map(address => `${address.family}:${address.bytesHex}`))),
  ...overrides});};
const dispatch = Object.freeze({purpose: "contained-turn.provider-dispatch/v1" as const, operationId: "operation-1",
  scope: Object.freeze({tenantId: "tenant-1", projectId: "project-1", scopeDigest: sha("scope")}),
  grantRequestId: "grant-request-1", requestDigest: sha("dispatch-request"), providerId: "provider-1",
  authorityGeneration: "authority-generation-1", providerBindingDigest: sha("provider-binding"),
  claimBindingDigest: sha("claim-binding"), acceptedAuthorityDigest: sha("accepted-authority"),
  expectedAuthorityHeadDigest: sha("authority-head"), expectedAuthorityRevision: "authority-revision-1",
  expectedConstraintsDigest: sha("constraints"), expectedContainmentPolicyDigest: sha("containment-policy")});
const receipt = (overrides: Record<string, unknown> = {}) => Object.freeze({
  contractVersion: "contained-turn-dispatch-consumption/v1", purpose: dispatch.purpose,
  operationId: dispatch.operationId, scope: dispatch.scope, grantRequestId: dispatch.grantRequestId,
  requestDigest: dispatch.requestDigest, providerId: dispatch.providerId,
  authorityGeneration: dispatch.authorityGeneration, providerBindingDigest: dispatch.providerBindingDigest,
  claimBindingDigest: dispatch.claimBindingDigest, acceptedAuthorityDigest: dispatch.acceptedAuthorityDigest,
  authorityHeadDigestAtConsumption: dispatch.expectedAuthorityHeadDigest,
  authorityRevision: dispatch.expectedAuthorityRevision, constraintsDigest: dispatch.expectedConstraintsDigest,
  containmentPolicyDigest: dispatch.expectedContainmentPolicyDigest, consumptionDigest: sha("consumption"),
  claimBeforeControlTime: 200, consumedAtControlTime: 100, ownerEvidenceRef: "evidence-1", ...overrides,
});
const request = (overrides: Record<string, unknown> = {}): ContainedTurnEgressRequest => ({
  scope: dispatch.scope, providerId: "provider-1", providerAccountRef: "account-1", providerRouteRef: "route-1",
  ...binding, resolutionAuthorityId: "resolver-1", resolutionGeneration: "resolver-generation-1",
  operationId: "operation-1", dispatch, requestId: "request-1", requestNonce: "nonce-1", method: "POST",
  path: "/v1/turn", headers: [{name: "content-type", value: "application/json"},
    {name: "x-request-class", value: "synthetic"}], body: Uint8Array.from([1, 2, 3, 4]),
  budgets: {requestBytes: 1_000, responseBytes: 2_000, deadlineMs: 200}, ...overrides,
} as ContainedTurnEgressRequest);
const wire = (candidate: ContainedTurnEgressRequest, hostname = "api.example.com") => Buffer.concat([Buffer.from(`${candidate.method} ${candidate.path} HTTP/1.1\r\nHost: ${hostname}\r\nContent-Length: ${candidate.body.byteLength}\r\n`),
  ...candidate.headers.map(header => Buffer.from(`${header.name}: ${header.value}\r\n`)), Buffer.from("\r\n"), candidate.body]);
const applicationBytes = (candidate: ContainedTurnEgressRequest) => wire(candidate).byteLength;
const stall = () => {const start = performance.now(); while (performance.now() - start < 210) {/* Synthetic CPU delay. */}};
const deferred = () => {let release!: () => void; const promise = new Promise<void>(resolve => {release = resolve;});
  return {promise, resolve: release};};
const spoof = <Value>(values: Value[]) => {Object.defineProperties(values, {every: {value() {return true;}, enumerable: true},
  some: {value() {return false;}, enumerable: true}, map: {value() {return [];}, enumerable: true},
  [Symbol.iterator]: {value() {throw new Error("iterator called");}, enumerable: false}}); return values;};
const deniedRequest = async (candidate: ContainedTurnEgressRequest) => {
  const fixture = harness();
  const result = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(candidate);
  assert.deepEqual(result, {status: "denied", reason: "invalid_request", deniedApplicationBytes: 0});
  assert.deepEqual(fixture.events, []);
};

interface HarnessOptions {
  route?: unknown; policy?: unknown; observation?: unknown; routeOutcome?: unknown; dispatchOutcome?: unknown;
  policyOutcome?: unknown; openFails?: boolean; closeFails?: boolean; executeThrows?: boolean;
  skipCallback?: boolean; completedWithoutCallback?: boolean; reentrantCallback?: boolean; doubleConsume?: boolean;
  unawaitedCallback?: boolean; writeIndeterminate?: boolean; transportResult?: unknown; responseBytes?: number;
  partialWrite?: boolean; signerThenable?: boolean; verifierThenable?: boolean; consumptionThenable?: boolean;
  onSign?: () => void; onVerify?: () => void; onWrite?: () => void;
  consumeOutcome?: unknown; onConsume?: () => void;
  mutateAuthorization?: boolean; repeatedWrite?: boolean;
  mutateRetainedWrite?: boolean; mutateResultDuringClose?: boolean; onClose?: () => void | Promise<void>;
  holdOpen?: Promise<void>; holdAuthority?: Promise<void>; holdExecute?: Promise<void>; holdClose?: Promise<void>;
  mutateAtResolve?: () => void;
}
const harness = (options: HarnessOptions = {}) => {
  const events: string[] = []; const authorizations: EgressAuthorizationBodyV1[] = [];
  const canonicalBodies: Uint8Array[] = []; const dispatchInputs: unknown[] = [];
  const routeInputs: unknown[] = []; let retainedWrite: {authorization: {canonicalBody: Uint8Array}; applicationBytes: Uint8Array} | undefined;
  const emittedApplicationBytes: Uint8Array[] = []; let writerUsed = false;
  let returnedResult: Record<string, unknown> | undefined;
  const transported: {headers?: readonly Readonly<{name: string; value: string}>[]; body?: Uint8Array} = {};
  let callback: ((value: unknown) => Promise<unknown>) | undefined;
  let closeCount = 0;
  const transport: EgressTransportV1 = {
    async execute(input) {
      events.push("transport:execute"); transported.headers = input.request.headers; transported.body = input.request.body;
      callback = input.beforeFirstWrite;
      const exactWire = wire({...request(), path: input.target.path, method: input.request.method,
        headers: input.request.headers, body: input.request.body}, input.target.host); const applicationBytesDigest = sha(exactWire);
      const observed = {applicationBytesDigest, applicationBytes: exactWire.byteLength,
        ...(options.observation ?? observation())};
      if (options.executeThrows) {throw new Error("ambiguous write");}
      if (options.completedWithoutCallback) {events.push("transport:write"); return Object.freeze({status: "completed",
        responseBytes: 12, responseDigest: sha("response"), boundaryReceipt: {}});}
      if (options.skipCallback) {return Object.freeze({status: "not_sent"});}
      if (options.unawaitedCallback) {void input.beforeFirstWrite(observed);
        return Object.freeze({status: "completed", responseBytes: 12, responseDigest: sha("response"), boundaryReceipt: {}});}
      if (options.reentrantCallback) {const first = input.beforeFirstWrite(observed);
        const second = input.beforeFirstWrite(observed); await Promise.all([first, second]); return Object.freeze({status: "not_sent"});}
      events.push("transport:ready"); const admission = await input.beforeFirstWrite(observed) as
        {status: string; boundaryReceipt?: unknown};
      if (admission.status !== "written") {return Object.freeze({status: "not_sent"});}
      if (options.doubleConsume) {await input.beforeFirstWrite(observed);}
      await options.holdExecute;
      if (options.mutateRetainedWrite && retainedWrite !== undefined) {retainedWrite.authorization.canonicalBody.fill(9);
        retainedWrite.applicationBytes.fill(9);}
      if (options.writeIndeterminate) {return Object.freeze({status: "write_indeterminate"});}
      if (options.transportResult !== undefined) {return options.transportResult;}
      returnedResult = {status: "completed", responseBytes: options.responseBytes ?? 12,
        responseDigest: sha("response"), boundaryReceipt: admission.boundaryReceipt};
      return options.mutateResultDuringClose ? returnedResult : Object.freeze(returnedResult);
    },
    async close() {events.push("transport:close"); closeCount += 1; await options.onClose?.(); await options.holdClose;
      if (options.mutateResultDuringClose && returnedResult !== undefined) {returnedResult.boundaryReceipt = {};
        returnedResult.responseDigest = sha("repaired");}
      if (options.closeFails) {throw new Error("close failed");}},
  };
  const realSigner = signer();
  const firstWrite = {writeExact(value: unknown) {
    if (writerUsed) {throw new Error("exact writer already used");} writerUsed = true;
    const gate = value as {consumeAuthorization(): boolean}; options.onWrite?.();
    if (!gate.consumeAuthorization()) {return;}
    events.push("transport:write"); const safe = value as {authorization: {body: EgressAuthorizationBodyV1;
      canonicalBody: Uint8Array}; applicationBytes: Uint8Array}; authorizations.push(safe.authorization.body);
    retainedWrite = safe; canonicalBodies.push(safe.authorization.canonicalBody.slice());
    emittedApplicationBytes.push(safe.applicationBytes.slice());
    if (options.mutateAuthorization) {safe.authorization.canonicalBody[0] ^= 1;}
    if (options.partialWrite || options.repeatedWrite) {return {applicationBytesWritten: options.partialWrite ? 1 : 2};}
    if (options.consumptionThenable) {return Promise.resolve();}
  }};
  const dependencies: ContainedTurnEgressDependencies = {
    routeAuthority: {
      async resolveExact(input) {events.push("route:resolve"); routeInputs.push(input); options.mutateAtResolve?.();
        return options.route ?? route();},
      async revalidateExact() {events.push("route:revalidate"); return options.routeOutcome ?? Object.freeze({status: "current" as const});},
    },
    dispatchAuthority: {async observeDispatchConsumption(input) {events.push("dispatch:observe");
      dispatchInputs.push(input); await options.holdAuthority; return options.dispatchOutcome ??
        Object.freeze({status: "consumed" as const, receipt: receipt(), lifecycleState: "claim_committed" as const});}},
    policyAuthority: {
      consumeFirstWrite() {options.onConsume?.(); return options.consumeOutcome ?? Object.freeze({status: "current", observedAt: 101});},
      async resolve() {events.push("policy:resolve"); return options.policy ?? policy();},
      async revalidateExact() {events.push("policy:revalidate"); return options.policyOutcome ??
        Object.freeze({status: "current" as const, observedAt: 101});},
    },
    signer: {
      sign(body, key) {options.onSign?.(); const value = realSigner.sign(body, key);
        // oxlint-disable-next-line unicorn/no-thenable -- adversarial boundary fixture
        return options.signerThenable ? {...value as object, then() {}} : value;},
      // oxlint-disable-next-line unicorn/no-thenable -- adversarial boundary fixture
      verify(body, envelope) {options.onVerify?.(); return options.verifierThenable ? {then() {}} : realSigner.verify(body, envelope);},
    },
    transportGateway: {async openOneShotHttps() {events.push("transport:open"); await options.holdOpen;
      if (options.openFails) {throw new Error("open failed");} return {transport, firstWrite};}},
  };
  return {dependencies, transport, events, authorizations, canonicalBodies, dispatchInputs, routeInputs, transported,
    firstWrite, emittedApplicationBytes, get callback() {return callback;}, get closeCount() {return closeCount;}};
};

test("binds exact route, credential, committed authority receipt, canonical request, policy, and peer", async () => {
  const fixture = harness(); const outcome = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request());
  assert.deepEqual(outcome, {status: "completed", responseDigest: sha("response"), responseBytes: 12,
    applicationBytesDigest: sha(wire(request())), applicationBytesWritten: applicationBytes(request())});
  assert.deepEqual(fixture.events, ["route:resolve", "policy:resolve", "transport:open", "transport:execute",
    "transport:ready", "dispatch:observe", "policy:revalidate", "route:revalidate", "transport:write", "transport:close"]);
  const body = fixture.authorizations[0]!;
  assert.deepEqual({credentialBindingRef: body.credentialBindingRef, credentialBindingDigest: body.credentialBindingDigest,
    credentialGeneration: body.credentialGeneration, credentialRevision: body.credentialRevision}, binding);
  assert.deepEqual(body.dispatchReceipt, receipt()); assert.deepEqual(fixture.dispatchInputs, [dispatch]);
  assert.deepEqual(fixture.routeInputs, [{tenantId: "tenant-1", projectId: "project-1", scopeDigest: sha("scope"),
    providerId: "provider-1", providerAccountRef: "account-1", providerRouteRef: "route-1", ...binding,
    resolutionAuthorityId: "resolver-1", resolutionGeneration: "resolver-generation-1"}]);
  assert.equal(body.routeRevision, "route-revision-1"); assert.equal(body.routeAuthorityDigest, sha("route-authority"));
  assert.equal(body.applicationBytes, applicationBytes(request())); assert.equal(body.applicationBytesDigest, sha(wire(request())));
  assert.match(body.requestDigest, /^sha256:/u); assert.equal("path" in body.target, false);
  assert.equal("headers" in body, false); assert.equal("body" in body, false); assert.ok(Object.isFrozen(outcome));
});

test("provider-neutral contracts use fixed-width tagged addresses and keep the feature dormant", async () => {
  for (const address of [v4(), v6()]) {
    const fixture = harness({observation: observation({canonicalAddresses: [address], peerAddress: address})});
    assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request())).status, "completed");
  }
  assert.equal("createContainedTurnEgressGateway" in ordinaryRuntimeSecurity, false);
});

test("copies inputs before awaits and deterministic canonical bytes bind header order and body", async () => {
  const candidate = request(); const originalBody = Uint8Array.from(candidate.body); const originalHeaders = structuredClone(candidate.headers);
  const first = harness({mutateAtResolve() {candidate.body.fill(9);
    (candidate.headers as {name: string; value: string}[])[0]!.value = "mutated-secret";}});
  assert.equal((await createContainedTurnEgressGateway(host(), first.dependencies).exchange(candidate)).status, "completed");
  assert.deepEqual(first.transported.body, originalBody); assert.deepEqual(first.transported.headers, originalHeaders);
  const same = harness(); await createContainedTurnEgressGateway(host(), same.dependencies).exchange(request());
  assert.deepEqual(first.canonicalBodies[0], same.canonicalBodies[0]);
  const reversed = harness(); await createContainedTurnEgressGateway(host(), reversed.dependencies)
    .exchange(request({headers: originalHeaders.toReversed()}));
  assert.notDeepEqual(reversed.canonicalBodies[0], same.canonicalBodies[0]);
  const changed = harness(); await createContainedTurnEgressGateway(host(), changed.dependencies)
    .exchange(request({body: Uint8Array.from([1, 2, 3, 5])}));
  assert.notDeepEqual(changed.canonicalBodies[0], same.canonicalBodies[0]);
});

test("redacts query targets and binds versioned path, request, and exact wire digests", async () => {
  const path = "/v1/turn?access_token=QUERY_SECRET_739";
  const fixture = harness({route: route({pathConstraint: path})});
  const outcome = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request({path}));
  assert.equal(outcome.status, "completed"); const body = fixture.authorizations[0]!;
  assert.equal("path" in body.target, false); assert.match(body.target.pathDigest, /^sha256:[\da-f]{64}$/u);
  assert.equal(Buffer.from(fixture.canonicalBodies[0]!).includes(Buffer.from("QUERY_SECRET_739")), false);
  assert.equal(body.applicationBytesDigest, sha(wire(request({path}))));
});

test("rejects hostile request graphs and every route or credential authority mismatch before transport", async () => {
  const accessor = request() as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, "body", {enumerable: true, get() {throw new Error("read");}});
  const badRequests: unknown[] = [{...request(), extra: true}, accessor, new Proxy(request(), {}),
    request({body: new Uint8Array(new SharedArrayBuffer(4))}), request({headers: [{name: "authorization", value: "secret"}]}),
    request({headers: [{name: "accept", value: "x\r\ninjected: true"}]}), request({path: "/v1/%2e%2e/secret"}),
    request({budgets: {requestBytes: 1, responseBytes: 2_000, deadlineMs: 200}})];
  for (const value of badRequests) {const fixture = harness(); assert.deepEqual(await createContainedTurnEgressGateway(host(), fixture.dependencies)
    .exchange(value as ContainedTurnEgressRequest), {status: "denied", reason: "invalid_request", deniedApplicationBytes: 0});
    assert.deepEqual(fixture.events, []);}
  for (const mutation of [{tenantId: "tenant-2"}, {projectId: "project-2"}, {providerId: "provider-2"},
    {providerAccountRef: "account-2"}, {providerRouteRef: "route-2"}, {credentialBindingRef: "credential-binding-2"},
    {credentialBindingDigest: sha("other")}, {credentialGeneration: "other"}, {credentialRevision: "other"},
    {scopeDigest: sha("other")}, {resolutionAuthorityId: "attacker-resolver"}, {resolutionGeneration: "attacker-generation"},
    {routeRevision: ""}, {authorityDigest: "opaque"}, {scheme: "http"}, {host: "93.184.216.34"},
    {tlsServerName: "other.example.com"}, {pathConstraint: "/other"}, {tlsPinSetDigest: sha("wrong")},
    {allowedTlsSpkiDigests: ["opaque"]}, {tlsPinSetGeneration: ""}, {tlsPinSetRevision: ""}, {extra: true}]) {
    const fixture = harness({route: route(mutation)}); assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies)
      .exchange(request())).status, "denied", JSON.stringify(mutation)); assert.equal(fixture.events.includes("transport:open"), false);}
});

test("snapshots typed-array internal slots before allocation without species, methods, or accessors", async () => {
  const hostileSpecies = {get [Symbol.species](): never {throw new Error("species accessed");}};
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  Object.defineProperties(shared, {buffer: {get(): ArrayBuffer {throw new Error("shadowed buffer accessed");}},
    constructor: {value: hostileSpecies}});
  await deniedRequest(request({body: shared}));

  const detached = new Uint8Array(4); structuredClone(detached.buffer, {transfer: [detached.buffer]});
  await deniedRequest(request({body: detached}));

  class HostileBytes extends Uint8Array {public static get [Symbol.species](): never {throw new Error("species accessed");}}
  await deniedRequest(request({body: new HostileBytes([1, 2, 3, 4])}));
  await deniedRequest(request({body: new Proxy(Uint8Array.from([1, 2, 3, 4]), {})}));

  let overLimitSpeciesReads = 0; const overLimit = new Uint8Array(1_048_577);
  Object.defineProperty(overLimit, "constructor", {value: {get [Symbol.species](): never {
    overLimitSpeciesReads += 1; throw new Error("over-limit copy allocated");}}});
  await deniedRequest(request({body: overLimit})); assert.equal(overLimitSpeciesReads, 0);

  const resizable = new ArrayBuffer(8, {maxByteLength: 16}); const resizableView = new Uint8Array(resizable);
  Object.defineProperty(resizableView, "buffer", {get(): ArrayBuffer {throw new Error("shadowed buffer accessed");}});
  await deniedRequest(request({body: resizableView}));
});

test("only the existing authority's exact claim_committed receipt permits bytes", async () => {
  const outcomes = [{status: "consumed", receipt: receipt(), lifecycleState: "consumed_pending"},
    {status: "consumed", receipt: receipt({providerId: "provider-2"}), lifecycleState: "claim_committed"},
    {status: "consumed", receipt: receipt({credential: "secret"}), lifecycleState: "claim_committed"},
    {status: "prevented", evidence: {}}, {status: "indeterminate", reason: "owner_unavailable"},
    {status: "consumed", receipt: receipt(), lifecycleState: "claim_committed", extra: true}];
  for (const dispatchOutcome of outcomes) {const fixture = harness({dispatchOutcome});
    assert.deepEqual(await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request()),
      {status: "denied", reason: "dispatch_not_committed", deniedApplicationBytes: 0});
    assert.equal(fixture.events.includes("transport:write"), false);}
});

test("denies private, reserved, metadata, mapped, zoned, noncanonical, duplicate, unsorted, and peer-mismatch addresses", async () => {
  const bad: unknown[] = [v4("0a000001"), v4("7f000001"), v4("a9fea9fe"), v4("c0a80001"), v4("c0000201"),
    v4("c6120001"), v4("c6336401"), v4("cb007101"), v4("e0000001"), v6("00000000000000000000000000000001"),
    v6("fe800000000000000000000000000001"), v6("fc000000000000000000000000000001"),
    v6("00000000000000000000ffff5db8d822"), v6("0000000000000000000000005db8d822"),
    v6("0064ff9b00000000000000005db8d822"), v6("40000000000000000000000000000001"),
    v6("5f000000000000000000000000000001"),
    v6("fec00000000000000000000000000001"), {family: "ipv6", bytesHex: "::ffff:5db8:d822"},
    {family: "ipv6", bytesHex: "0000:0000:0000:0000:0000:ffff:5db8:d822"},
    {family: "ipv6", bytesHex: "fe80::1%eth0"}, {family: "ipv4", bytesHex: "5DB8D822"}];
  for (const address of bad) {const fixture = harness({observation: observation({canonicalAddresses: [address], peerAddress: address})});
    assert.deepEqual(await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request()),
      {status: "denied", reason: "address_denied", deniedApplicationBytes: 0});}
  for (const addresses of [[v4(), v4()], [v6(), v4()]]) {const fixture = harness({observation: observation({canonicalAddresses: addresses,
    peerAddress: addresses[0]})}); assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies)
      .exchange(request())).status, "denied");}
  const peer = harness({observation: observation({peerAddress: v4("5db8d823")})});
  assert.equal((await createContainedTurnEgressGateway(host(), peer.dependencies).exchange(request())).status, "denied");
  for (const mutation of [{answerSetDigest: sha("substitution")}, {resolutionAuthorityId: ""},
    {resolutionGeneration: ""}]) {const fixture = harness({observation: observation(mutation)});
    assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request())).status, "denied");}
});

test("IPv6 V1 denies special-purpose ranges at exact boundaries while allowing adjacent globals", async () => {
  const denied = ["20010000000000000000000000000000", "200101ffffffffffffffffffffffffff",
    "20010db8000000000000000000000000", "20010db8ffffffffffffffffffffffff",
    "20020000000000000000000000000000", "2002ffffffffffffffffffffffffffff",
    "3fff0000000000000000000000000000", "3fff0fffffffffffffffffffffffffff"];
  const allowed = ["2000ffffffffffffffffffffffffffff", "20010200000000000000000000000000",
    "20010db7ffffffffffffffffffffffff", "20010db9000000000000000000000000",
    "2001ffffffffffffffffffffffffffff", "20030000000000000000000000000000",
    "3ffeffffffffffffffffffffffffffff", "3fff1000000000000000000000000000",
    "24040000000000000000000000000001", "26060000000000000000000000000001", "2a000000000000000000000000000001"];
  for (const bytesHex of denied) {const address = v6(bytesHex); const fixture = harness({observation:
    observation({canonicalAddresses: [address], peerAddress: address})});
    assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request())).status, "denied", bytesHex);}
  for (const bytesHex of allowed) {const address = v6(bytesHex); const fixture = harness({observation:
    observation({canonicalAddresses: [address], peerAddress: address})});
    assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request())).status, "completed", bytesHex);}
});

test("stateful exact writer emits the authorized bytes once and execute remains held after write", async () => {
  const hold = deferred(); const fixture = harness({holdExecute: hold.promise});
  const pending = createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request());
  while (!fixture.events.includes("transport:write")) {await Promise.resolve();}
  let settled = false; void pending.then(() => {settled = true; return settled;}); await Promise.resolve();
  assert.equal(settled, false); assert.equal(fixture.emittedApplicationBytes.length, 1);
  assert.deepEqual(fixture.emittedApplicationBytes[0], Uint8Array.from(wire(request())));
  assert.throws(() => fixture.firstWrite.writeExact({}), /already used/u);
  assert.equal(fixture.emittedApplicationBytes.length, 1); hold.resolve();
  assert.equal((await pending).status, "completed");
});

test("TLS pin set membership and exact wire observations deny before any write", async () => {
  for (const mutation of [{tlsSpkiDigest: sha("unapproved")}, {applicationBytesDigest: sha("changed-wire")},
    {applicationBytes: 1}]) {const fixture = harness({observation: observation(mutation)});
    assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request())).status, "denied");
    assert.equal(fixture.events.includes("transport:write"), false);}
  const rotated = harness({routeOutcome: {status: "rejected", reason: "changed"}});
  assert.deepEqual(await createContainedTurnEgressGateway(host(), rotated.dependencies).exchange(request()),
    {status: "denied", reason: "authority_drift", deniedApplicationBytes: 0});
  assert.equal(rotated.events.includes("transport:write"), false);
});

test("final boundary rejects skipped, unawaited, reentrant, double, and thenable authorization use", async () => {
  for (const options of [{skipCallback: true}, {reentrantCallback: true}, {doubleConsume: true},
    {unawaitedCallback: true}, {signerThenable: true}, {verifierThenable: true}, {consumptionThenable: true},
    {mutateAuthorization: true}, {repeatedWrite: true}]) {
    const fixture = harness(options); const outcome = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request());
    assert.notEqual(outcome.status, "completed", JSON.stringify(options));
    if (outcome.status === "denied") {assert.equal(outcome.deniedApplicationBytes, 0);}
  }
  const skipped = harness({skipCallback: true}); await createContainedTurnEgressGateway(host(), skipped.dependencies).exchange(request());
  assert.deepEqual(await skipped.callback?.(observation()), {status: "denied"});
});

test("rejects mutable authority claims, hostile dense arrays, and detached request buffers", async () => {
  const mutableRoute = {...route()}; const mutableCurrent = {status: "current"};
  const mutablePrevented = {status: "prevented", evidence: {}};
  for (const options of [{route: mutableRoute}, {routeOutcome: mutableCurrent}, {dispatchOutcome: mutablePrevented}]) {
    const fixture = harness(options); assert.notEqual((await createContainedTurnEgressGateway(host(), fixture.dependencies)
      .exchange(request())).status, "completed");
  }
  const hostileRequests = [request({headers: spoof([{name: "content-type", value: "application/json"}])})];
  for (const candidate of hostileRequests) {const fixture = harness(); assert.deepEqual(
    await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(candidate),
    {status: "denied", reason: "invalid_request", deniedApplicationBytes: 0});}
  for (const mutation of [{allowedTlsSpkiDigests: spoof([sha("spki")])}]) {const fixture = harness({route: route(mutation)});
    assert.notEqual((await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request())).status, "completed");}
  const hostileAddresses = spoof([v4()]); const hostileObservation = observation({canonicalAddresses: hostileAddresses});
  const addressFixture = harness({observation: hostileObservation});
  assert.notEqual((await createContainedTurnEgressGateway(host(), addressFixture.dependencies).exchange(request())).status, "completed");
  const bytes = new Uint8Array(4); structuredClone(bytes.buffer, {transfer: [bytes.buffer]});
  const detached = harness(); assert.deepEqual(await createContainedTurnEgressGateway(host(), detached.dependencies)
    .exchange(request({body: bytes})), {status: "denied", reason: "invalid_request", deniedApplicationBytes: 0});
});

test("quarantines lying writers, retained-byte mutation, mutable completion, and late callbacks", async () => {
  for (const options of [{partialWrite: true}, {mutateRetainedWrite: true}, {mutateResultDuringClose: true}]) {
    const fixture = harness(options); const gateway = createContainedTurnEgressGateway(host(), fixture.dependencies);
    assert.equal((await gateway.exchange(request())).status, "indeterminate", JSON.stringify(options));
    assert.equal(await gateway.dispose(), "quarantined");
  }
  const late = harness(); const gateway = createContainedTurnEgressGateway(host(), late.dependencies);
  assert.equal((await gateway.exchange(request())).status, "completed");
  assert.deepEqual(await late.callback?.(observation()), {status: "denied"}); assert.equal(await gateway.dispose(), "quarantined");
});

test("reentrant disposal during transport close quarantines without cyclic await", async () => {
  let gateway: ReturnType<typeof createContainedTurnEgressGateway>; let reentrant: Promise<"closed" | "quarantined"> | undefined;
  const fixture = harness({onClose() {reentrant = gateway.dispose(); return reentrant;}});
  gateway = createContainedTurnEgressGateway(host(), fixture.dependencies);
  assert.equal((await gateway.exchange(request())).status, "indeterminate"); assert.equal(await reentrant, "quarantined");
  assert.equal(await gateway.dispose(), "quarantined"); assert.equal(fixture.closeCount, 1);
});

test("reentrant signer and verifier disposal writes zero application bytes", async () => {
  for (const boundary of ["sign", "verify"] as const) {
    let gateway: ReturnType<typeof createContainedTurnEgressGateway>;
    let disposal: Promise<"closed" | "quarantined"> | undefined;
    const dispose = () => {disposal = gateway.dispose();};
    const fixture = harness(boundary === "sign" ? {onSign: dispose} : {onVerify: dispose});
    gateway = createContainedTurnEgressGateway(host(), fixture.dependencies);
    const outcome = await gateway.exchange(request());
    assert.deepEqual(outcome, {status: "denied", reason: "authorization_invalid", deniedApplicationBytes: 0});
    assert.equal(fixture.events.includes("transport:write"), false); assert.equal(await disposal, "closed");
    assert.equal(fixture.closeCount, 1);
  }
});

test("native await assimilates each foreign async owner and transport result exactly once", async () => {
  const fixture = harness(); let assimilations = 0;
  // oxlint-disable-next-line unicorn/no-thenable -- Deliberate hostile fixture verifies foreign thenable assimilation.
  const foreign = (value: unknown) => ({then(resolve: (settled: unknown) => void, reject: (error: unknown) => void) {
    assimilations += 1; Promise.resolve(value).then(resolve, reject);}});
  const wrap = (owner: Record<string, unknown>, name: string) => {const original = owner[name] as (...args: unknown[]) => unknown;
    owner[name] = (...args: unknown[]) => foreign(Reflect.apply(original, owner, args));};
  wrap(fixture.dependencies.routeAuthority as unknown as Record<string, unknown>, "resolveExact");
  wrap(fixture.dependencies.routeAuthority as unknown as Record<string, unknown>, "revalidateExact");
  wrap(fixture.dependencies.dispatchAuthority as unknown as Record<string, unknown>, "observeDispatchConsumption");
  wrap(fixture.dependencies.policyAuthority as unknown as Record<string, unknown>, "resolve");
  wrap(fixture.dependencies.policyAuthority as unknown as Record<string, unknown>, "revalidateExact");
  wrap(fixture.dependencies.transportGateway as unknown as Record<string, unknown>, "openOneShotHttps");
  wrap(fixture.transport as unknown as Record<string, unknown>, "execute");
  wrap(fixture.transport as unknown as Record<string, unknown>, "close");
  assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request())).status, "completed");
  assert.equal(assimilations, 8);
});

test("completed binds exact authorization consumption and all authorized application bytes", async () => {
  for (const options of [{partialWrite: true}, {completedWithoutCallback: true},
    {transportResult: {status: "completed", responseBytes: 1, responseDigest: sha("response"), boundaryReceipt: {}}},
    {transportResult: {status: "redirect"}}]) {
    const fixture = harness(options); const outcome = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request());
    assert.equal(outcome.status, "indeterminate", JSON.stringify(options));
  }
  const oversized = harness({responseBytes: 2_001});
  assert.deepEqual(await createContainedTurnEgressGateway(host(), oversized.dependencies).exchange(request()),
    {status: "indeterminate", reason: "response_invalid"});
});

test("actual Ed25519 vectors reject byte, identity, digest, signature, and async mutation", () => {
  const adapter = signer(); const key = {keyId: "key-1", keyGeneration: "key-gen-1", signerRevision: "signer-1"};
  const body = Uint8Array.from([0, 1, 2, 3]); const envelope = adapter.sign(body, key) as
    {keyId: string; keyGeneration: string; signerRevision: string; digest: string; signature: string};
  assert.equal(adapter.verify(body, envelope), true); assert.equal(adapter.verify(Uint8Array.from([0, 1, 2, 4]), envelope), false);
  for (const mutation of [{...envelope, keyId: "key-2"}, {...envelope, digest: sha("mutated")},
    {...envelope, signature: Buffer.from("mutated").toString("base64")}, {...envelope, signature: ` ${envelope.signature}`},
    {...envelope, signature: `${envelope.signature}\n`}, {...envelope, signature: `${envelope.signature}AA`},
    {...envelope, signature: envelope.signature.slice(0, -2)}]) {assert.equal(adapter.verify(body, mutation), false);}
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const index = alphabet.indexOf(envelope.signature[85]!); const alias = alphabet[(index & 48) | ((index + 1) & 15)]!;
  assert.equal(adapter.verify(body, {...envelope, signature: `${envelope.signature.slice(0, 85)}${alias}==`}), false);
  assert.throws(() => adapter.sign(body, {...key, keyGeneration: "wrong"}), /signing authority mismatch/u);
});

test("disposal cancels owner waits and quarantines unsettled acquisition or close; late transport closes once", async () => {
  for (const stage of ["open", "callback", "execute", "close"] as const) {
    const hold = deferred(); const options: HarnessOptions = stage === "open" ? {holdOpen: hold.promise} :
      stage === "callback" ? {holdAuthority: hold.promise} : stage === "execute" ? {holdExecute: hold.promise} :
        {holdClose: hold.promise};
    const fixture = harness(options); const gateway = createContainedTurnEgressGateway(host(), fixture.dependencies);
    const pending = gateway.exchange(request()); const marker = stage === "open" ? "transport:open" : stage === "callback" ?
      "dispatch:observe" : stage === "execute" ? "policy:revalidate" : "transport:close";
    while (!fixture.events.includes(marker)) {await Promise.resolve();}
    let disposed = false; const disposal = gateway.dispose().then(value => {disposed = true; return value;});
    const unsettledResource = stage === "open" || stage === "close";
    await Promise.resolve(); assert.equal(disposed, unsettledResource); hold.resolve();
    assert.equal(await disposal, unsettledResource ? "quarantined" : "closed"); const outcome = await pending;
    assert.notEqual(outcome.status, "completed"); assert.equal(fixture.closeCount, 1);
    assert.equal(await gateway.dispose(), unsettledResource ? "quarantined" : "closed"); assert.equal(fixture.closeCount, 1);
  }
});

test("ambiguity and close failure quarantine without retry", async () => {
  for (const options of [{executeThrows: true}, {writeIndeterminate: true}]) {const fixture = harness(options);
    const gateway = createContainedTurnEgressGateway(host(), fixture.dependencies);
    assert.deepEqual(await gateway.exchange(request()), {status: "indeterminate", reason: "first_write_indeterminate"});
    assert.equal(await gateway.dispose(), "quarantined");}
  const fixture = harness({closeFails: true}); const gateway = createContainedTurnEgressGateway(host(), fixture.dependencies);
  assert.deepEqual(await gateway.exchange(request()), {status: "indeterminate", reason: "close_failed"});
  assert.equal(await gateway.dispose(), "quarantined"); assert.equal(await gateway.dispose(), "quarantined");
  assert.equal(fixture.closeCount, 1);
});

test("joint emission authorization rejects route, policy and revocation drift after every earlier check", async () => {
  for (const stage of ["route", "sign", "verify", "writer"] as const) {
    for (const changed of ["route", "policy", "revoked"] as const) {
      let current = true; const revoke = () => {current = false;};
      const fixture = harness(stage === "sign" ? {onSign: revoke} : stage === "verify" ? {onVerify: revoke} :
        stage === "writer" ? {onWrite: revoke} : {});
      const owner = fixture.dependencies.policyAuthority;
      owner.consumeFirstWrite = expected => {
        assert.deepEqual(expected.route, route()); assert.deepEqual(expected.policy, policy());
        assert.equal(expected.issuedAt, 101);
        return Object.freeze(current ? {status: "current", observedAt: 101} : {status: changed});
      };
      if (stage === "route") {fixture.dependencies.routeAuthority.revalidateExact = async () => {
        await Promise.resolve(); revoke(); return Object.freeze({status: "current"});};}
      const gateway = createContainedTurnEgressGateway(host(), fixture.dependencies);
      assert.equal((await gateway.exchange(request())).status, "denied", `${stage}:${changed}`);
      assert.equal(fixture.emittedApplicationBytes.length, 0); assert.equal(fixture.closeCount, 1);
      assert.equal(await gateway.dispose(), "closed");
    }
  }
});

test("emission checks control expiry, rollback, deadline equality and monotonic lease after synchronous callbacks", async () => {
  for (const observedAt of [100, 300, 500, Number.NaN]) {
    const fixture = harness({consumeOutcome: Object.freeze({status: "current", observedAt})});
    assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request())).status, "denied");
    assert.equal(fixture.emittedApplicationBytes.length, 0); assert.equal(fixture.closeCount, 1);
  }
  // A stalled control clock must not extend the short-lived permit during signing, owner work or writer preparation.
  for (const stage of ["route", "sign", "verify", "writer", "consume"] as const) {
    const fixture = harness(stage === "sign" ? {onSign: stall} : stage === "verify" ? {onVerify: stall} :
      stage === "writer" ? {onWrite: stall} : stage === "consume" ? {onConsume: stall} : {});
    if (stage === "route") {fixture.dependencies.routeAuthority.revalidateExact = async () => {
      stall(); return Object.freeze({status: "current"});};}
    assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request())).status, "denied", stage);
    assert.equal(fixture.emittedApplicationBytes.length, 0); assert.equal(fixture.closeCount, 1);
  }
});

test("joint capability rejects async, duplicate and escaped consumption without permitting late bytes", async () => {
  for (const consumeOutcome of [Promise.resolve(Object.freeze({status: "current", observedAt: 101})),
    Object.freeze({status: "current", observedAt: 101, extra: true})]) {
    const fixture = harness({consumeOutcome});
    assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request())).status, "denied");
    assert.equal(fixture.emittedApplicationBytes.length, 0); assert.equal(fixture.closeCount, 1);
  }
  for (const mode of ["duplicate", "escaped"] as const) {
    const fixture = harness(); let consume: (() => boolean) | undefined;
    fixture.firstWrite.writeExact = (value: unknown) => {
      consume = (value as {consumeAuthorization(): boolean}).consumeAuthorization;
      if (mode === "duplicate") {assert.equal(consume(), true); assert.equal(consume(), false);}
    };
    const gateway = createContainedTurnEgressGateway(host(), fixture.dependencies);
    assert.equal((await gateway.exchange(request())).status, "indeterminate");
    assert.equal(consume?.(), false); assert.equal(fixture.emittedApplicationBytes.length, 0);
    assert.equal(fixture.closeCount, 1); assert.equal(await gateway.dispose(), "quarantined");
  }
});

test("all async owner callbacks can await reentrant disposal across settlement without a self-flight deadlock", {timeout: 5_000}, async () => {
  for (const stage of ["route-resolve", "policy-resolve", "dispatch", "policy-revalidate", "route-revalidate", "open", "execute", "close"]) {
    const fixture = harness(); let gateway: ReturnType<typeof createContainedTurnEgressGateway>;
    let observed: string | undefined;
    const targets: Record<string, [object, string]> = {
      "route-resolve": [fixture.dependencies.routeAuthority, "resolveExact"],
      "policy-resolve": [fixture.dependencies.policyAuthority, "resolve"],
      dispatch: [fixture.dependencies.dispatchAuthority, "observeDispatchConsumption"],
      "policy-revalidate": [fixture.dependencies.policyAuthority, "revalidateExact"],
      "route-revalidate": [fixture.dependencies.routeAuthority, "revalidateExact"],
      open: [fixture.dependencies.transportGateway, "openOneShotHttps"], execute: [fixture.transport, "execute"],
      close: [fixture.transport, "close"],
    };
    const [target, method] = targets[stage]!; const owner = target as Record<string, unknown>;
    const original = owner[method] as (...args: unknown[]) => unknown;
    owner[method] = async (...args: unknown[]) => {
      await new Promise<void>(resolve => {setImmediate(resolve);});
      observed = await gateway.dispose(); return await Reflect.apply(original, target, args);
    };
    gateway = createContainedTurnEgressGateway(host(), fixture.dependencies);
    assert.notEqual((await gateway.exchange(request())).status, "completed", stage);
    await new Promise<void>(resolve => {setImmediate(resolve);});
    assert.equal(observed, "quarantined", stage); assert.equal(await gateway.dispose(), "quarantined", stage);
    assert.equal(fixture.emittedApplicationBytes.length, stage === "close" ? 1 : 0, stage);
    assert.equal(fixture.closeCount, stage.endsWith("resolve") ? 0 : 1, stage);
  }
});

test("registers exchange flight before the first synchronous owner callback can dispose", async () => {
  let gateway: ReturnType<typeof createContainedTurnEgressGateway>; let disposal: Promise<string> | undefined;
  const hold = deferred(); const fixture = harness();
  fixture.dependencies.routeAuthority.resolveExact = () => {disposal = gateway.dispose();
    return hold.promise.then(() => route()) as ReturnType<typeof fixture.dependencies.routeAuthority.resolveExact>;};
  gateway = createContainedTurnEgressGateway(host(), fixture.dependencies);
  const flight = gateway.exchange(request());
  assert.equal(await disposal, "quarantined"); assert.notEqual((await flight).status, "completed");
  hold.resolve(); assert.deepEqual(fixture.events, []); assert.equal(fixture.emittedApplicationBytes.length, 0);
});

test("dispatch consumption at claimBefore is expired while the immediately preceding time is valid", async () => {
  for (const consumedAtControlTime of [199, 200, 201]) {
    const fixture = harness({dispatchOutcome: Object.freeze({status: "consumed", lifecycleState: "claim_committed",
      receipt: receipt({claimBeforeControlTime: 200, consumedAtControlTime})})});
    const result = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request());
    assert.equal(result.status, consumedAtControlTime === 199 ? "completed" : "denied");
    assert.equal(fixture.emittedApplicationBytes.length, consumedAtControlTime === 199 ? 1 : 0);
    assert.equal(fixture.closeCount, 1);
  }
});

test("retains bounded close before validating malformed sessions and reports unavailable closure honestly", async () => {
  for (const defect of ["writer-missing", "writer-accessor", "writer-proxy", "session-extra", "execute-accessor", "close-accessor", "close-missing", "transport-proxy", "close-throws"]) {
    const fixture = harness(); let accessorCalls = 0; let closeCalls = 0;
    const transport: Record<string, unknown> = {execute: fixture.transport.execute, close() {
      assert.equal(this, transport); closeCalls += 1;
      if (defect === "close-throws") {throw new Error("synthetic closure failure");} return Promise.resolve();}};
    const session: Record<string, unknown> = {transport, firstWrite: {}};
    const forbidden = () => {accessorCalls += 1; throw new Error("caller accessor invoked");};
    if (defect === "writer-accessor") {Object.defineProperty(session, "firstWrite", {get: forbidden});}
    if (defect === "writer-proxy") {session.firstWrite = new Proxy({}, {ownKeys: forbidden});}
    if (defect === "session-extra") {session.extra = true;}
    if (defect === "execute-accessor") {Object.defineProperty(transport, "execute", {get: forbidden});}
    if (defect === "close-accessor") {Object.defineProperty(transport, "close", {get: forbidden});}
    if (defect === "close-missing") {delete transport.close;}
    if (defect === "transport-proxy") {session.transport = new Proxy(transport, {getOwnPropertyDescriptor: forbidden});}
    fixture.dependencies.transportGateway.openOneShotHttps = async () => session;
    const gateway = createContainedTurnEgressGateway(host(), fixture.dependencies); const result = await gateway.exchange(request());
    const callableClose = !["close-accessor", "close-missing", "transport-proxy"].includes(defect);
    const closed = callableClose && defect !== "close-throws";
    assert.deepEqual(result, closed ? {status: "denied", reason: "transport_denied", deniedApplicationBytes: 0} :
      {status: "indeterminate", reason: "close_failed"}, defect);
    assert.equal(await gateway.dispose(), closed ? "closed" : "quarantined");
    assert.equal(closeCalls, callableClose ? 1 : 0); assert.equal(accessorCalls, 0);
    assert.equal(fixture.emittedApplicationBytes.length, 0);
  }
});

test("million-length sparse and accessor arrays fail before enumeration, frozen scans, methods or iterators", async () => {
  for (const kind of ["headers", "pins", "addresses"] as const) {
    for (const accessor of [false, true]) {
      const values: unknown[] = []; values.length = 1_000_000; let calls = 0;
      if (accessor) {Object.defineProperty(values, "0", {get() {calls += 1; throw new Error("array getter");}});}
      const fixture = harness(kind === "pins" ? {route: route({allowedTlsSpkiDigests: values})} :
        kind === "addresses" ? {observation: {...observation(), canonicalAddresses: values}} : {});
      const descriptors = Object.getOwnPropertyDescriptors; const frozen = Object.isFrozen;
      Object.getOwnPropertyDescriptors = value => {if (value === values) {calls += 1; throw new Error("array enumerated");}
        return descriptors(value);};
      Object.isFrozen = value => {if (value === values) {calls += 1; throw new Error("array scanned");} return frozen(value);};
      try {
        const result = await createContainedTurnEgressGateway(host(), fixture.dependencies)
          .exchange(request(kind === "headers" ? {headers: values} : {}));
        assert.equal(result.status, "denied"); assert.equal(calls, 0);
        assert.equal(fixture.emittedApplicationBytes.length, 0); assert.equal(fixture.closeCount, kind === "addresses" ? 1 : 0);
      } finally {Object.getOwnPropertyDescriptors = descriptors; Object.isFrozen = frozen;}
    }
  }
});

test("oversized ASCII host is rejected before lowercase, split or encoding and valid hosts retain wire budgets", async context => {
  for (const hostname of [`${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(62)}`, "a.".repeat(500_000)]) {
    const fixture = harness({route: route({host: hostname, tlsServerName: hostname})}); let calls = 0;
    const lower = String.prototype.toLowerCase; const split = String.prototype.split; const encode = TextEncoder.prototype.encode;
    context.mock.method(String.prototype, "toLowerCase", function () {if (String(this) === hostname) {calls += 1; throw new Error("host lowered");}
      return Reflect.apply(lower, this, []);});
    context.mock.method(String.prototype, "split", function (...args: Parameters<typeof split>) {if (String(this) === hostname) {calls += 1; throw new Error("host split");}
      return Reflect.apply(split, this, args);});
    context.mock.method(TextEncoder.prototype, "encode", function (value) {if (value?.includes(hostname)) {calls += 1; throw new Error("host encoded");}
      return Reflect.apply(encode, this, [value]);});
    try {
      assert.deepEqual(await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request()),
        {status: "denied", reason: "route_unavailable", deniedApplicationBytes: 0});
      assert.equal(calls, 0); assert.equal(fixture.emittedApplicationBytes.length, 0); assert.equal(fixture.closeCount, 0);
    } finally {context.mock.restoreAll();}
  }
  const fixture = harness(); const bytes = applicationBytes(request());
  assert.deepEqual(await createContainedTurnEgressGateway(host(), fixture.dependencies)
    .exchange(request({budgets: {requestBytes: bytes - 1, responseBytes: 2_000, deadlineMs: 200}})),
    {status: "denied", reason: "invalid_request", deniedApplicationBytes: 0});
  assert.equal(fixture.emittedApplicationBytes.length, 0); assert.equal(fixture.closeCount, 0);
});

test("a 253-character DNS host remains valid and the full Host header counts against the wire budget", async () => {
  const hostname = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
  assert.equal(hostname.length, 253);
  for (const delta of [0, -1]) {
    const fixture = harness({route: route({host: hostname, tlsServerName: hostname}), observation: observation({tlsServerName: hostname})});
    const bytes = wire(request(), hostname).byteLength;
    const outcome = await createContainedTurnEgressGateway(host(), fixture.dependencies)
      .exchange(request({budgets: {requestBytes: bytes + delta, responseBytes: 2_000, deadlineMs: 200}}));
    assert.equal(outcome.status, delta === 0 ? "completed" : "denied");
    assert.equal(fixture.emittedApplicationBytes.length, delta === 0 ? 1 : 0);
  }
});
