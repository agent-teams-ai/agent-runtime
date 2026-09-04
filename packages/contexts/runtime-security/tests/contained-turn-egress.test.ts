import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createContainedTurnEgressGateway, createNodeEd25519EgressSigner,
  type ContainedTurnEgressDependencies, type ContainedTurnEgressRequest,
  type EgressAuthorizationBodyV1, type EgressTransportV1, type NetworkAddressV1,
  type TrustedEgressHostIdentityV1 } from "../dist/composition.js";
import * as ordinaryRuntimeSecurity from "../dist/index.js";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
  routeRevision: "route-revision-1", authorityDigest: sha("route-authority"), scheme: "https",
  host: "api.example.com", port: 443, tlsServerName: "api.example.com", pathConstraint: "/v1/turn", ...overrides,
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
const observation = (overrides: Record<string, unknown> = {}) => Object.freeze({
  canonicalAddresses: Object.freeze([v4()]), peerAddress: v4(), peerPort: 443, tlsServerName: "api.example.com",
  tlsSpkiDigest: sha("spki"), alpn: "http/1.1", phase: "immediately_before_first_application_byte", ...overrides,
});
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
  ...binding, operationId: "operation-1", dispatch, requestId: "request-1", requestNonce: "nonce-1", method: "POST",
  path: "/v1/turn", headers: [{name: "content-type", value: "application/json"},
    {name: "x-request-class", value: "synthetic"}], body: Uint8Array.from([1, 2, 3, 4]),
  budgets: {requestBytes: 1_000, responseBytes: 2_000, deadlineMs: 200}, ...overrides,
} as ContainedTurnEgressRequest);
const applicationBytes = (candidate: ContainedTurnEgressRequest) => candidate.body.byteLength +
  candidate.headers.reduce((total, header) => total + Buffer.byteLength(header.name) + Buffer.byteLength(header.value) + 4, 2);
const deferred = () => {let release!: () => void; const promise = new Promise<void>(resolve => {release = resolve;});
  return {promise, resolve: release};};

interface HarnessOptions {
  route?: unknown; policy?: unknown; observation?: unknown; routeOutcome?: unknown; dispatchOutcome?: unknown;
  policyOutcome?: unknown; openFails?: boolean; closeFails?: boolean; executeThrows?: boolean;
  skipCallback?: boolean; completedWithoutCallback?: boolean; reentrantCallback?: boolean; doubleConsume?: boolean;
  unawaitedCallback?: boolean; writeIndeterminate?: boolean; transportResult?: unknown; responseBytes?: number;
  partialWrite?: boolean; signerThenable?: boolean; verifierThenable?: boolean; consumptionThenable?: boolean;
  holdOpen?: Promise<void>; holdAuthority?: Promise<void>; holdExecute?: Promise<void>; holdClose?: Promise<void>;
  mutateAtResolve?: () => void;
}
const harness = (options: HarnessOptions = {}) => {
  const events: string[] = []; const authorizations: EgressAuthorizationBodyV1[] = [];
  const canonicalBodies: Uint8Array[] = []; const dispatchInputs: unknown[] = [];
  const transported: {headers?: readonly Readonly<{name: string; value: string}>[]; body?: Uint8Array} = {};
  let callback: ((value: unknown) => Promise<unknown>) | undefined; let closeCount = 0;
  const transport: EgressTransportV1 = {
    async execute(input) {
      events.push("transport:execute"); transported.headers = input.request.headers; transported.body = input.request.body;
      callback = input.beforeFirstByte;
      if (options.executeThrows) {throw new Error("ambiguous write");}
      if (options.completedWithoutCallback) {events.push("transport:write"); return {status: "completed",
        applicationBytesWritten: applicationBytes(request()), responseBytes: 12, responseDigest: sha("response"),
        authorizationConsumption: undefined};}
      if (options.skipCallback) {return {status: "not_sent", applicationBytesWritten: 0};}
      if (options.unawaitedCallback) {void input.beforeFirstByte(options.observation ?? observation());
        return {status: "completed", applicationBytesWritten: applicationBytes(request()), responseBytes: 12,
          responseDigest: sha("response"), authorizationConsumption: undefined};}
      if (options.reentrantCallback) {const first = input.beforeFirstByte(options.observation ?? observation());
        const second = input.beforeFirstByte(options.observation ?? observation()); await Promise.all([first, second]);
        return {status: "not_sent", applicationBytesWritten: 0};}
      events.push("transport:ready"); const admission = await input.beforeFirstByte(options.observation ?? observation()) as
        {status: string; body?: EgressAuthorizationBodyV1; canonicalBody?: Uint8Array; consume?: () => unknown};
      if (admission.body !== undefined) {authorizations.push(admission.body);}
      if (admission.canonicalBody !== undefined) {canonicalBodies.push(admission.canonicalBody);}
      if (admission.status !== "authorized" || admission.consume === undefined) {
        return {status: "not_sent", applicationBytesWritten: 0};
      }
      const consumed = admission.consume(); if (options.doubleConsume) {admission.consume();}
      const authorizationConsumption = options.consumptionThenable ? Promise.resolve(consumed) : consumed;
      await options.holdExecute;
      if (options.writeIndeterminate) {return {status: "write_indeterminate"};}
      events.push("transport:write");
      if (options.transportResult !== undefined) {return options.transportResult;}
      return {status: "completed", applicationBytesWritten: options.partialWrite ? 1 : applicationBytes(request()),
        responseBytes: options.responseBytes ?? 12, responseDigest: sha("response"), authorizationConsumption};
    },
    async close() {events.push("transport:close"); closeCount += 1; await options.holdClose;
      if (options.closeFails) {throw new Error("close failed");}},
  };
  const realSigner = signer();
  const dependencies: ContainedTurnEgressDependencies = {
    routeAuthority: {
      async resolveExact() {events.push("route:resolve"); options.mutateAtResolve?.(); return options.route ?? route();},
      async revalidateExact() {events.push("route:revalidate"); return options.routeOutcome ?? {status: "current"};},
    },
    dispatchAuthority: {async observeDispatchConsumption(input) {events.push("dispatch:observe");
      dispatchInputs.push(input); await options.holdAuthority; return options.dispatchOutcome ??
        {status: "consumed", receipt: receipt(), lifecycleState: "claim_committed"};}},
    policyAuthority: {
      async resolve() {events.push("policy:resolve"); return options.policy ?? policy();},
      async revalidateExact() {events.push("policy:revalidate"); return options.policyOutcome ?? {status: "current", observedAt: 101};},
    },
    signer: {
      sign(body, key) {const value = realSigner.sign(body, key);
        // oxlint-disable-next-line unicorn/no-thenable -- adversarial boundary fixture
        return options.signerThenable ? {...value as object, then() {}} : value;},
      // oxlint-disable-next-line unicorn/no-thenable -- adversarial boundary fixture
      verify(body, envelope) {return options.verifierThenable ? {then() {}} : realSigner.verify(body, envelope);},
    },
    transportGateway: {async openOneShotHttps() {events.push("transport:open"); await options.holdOpen;
      if (options.openFails) {throw new Error("open failed");} return transport;}},
  };
  return {dependencies, events, authorizations, canonicalBodies, dispatchInputs, transported,
    get callback() {return callback;}, get closeCount() {return closeCount;}};
};

test("binds exact route, credential, committed authority receipt, canonical request, policy, and peer", async () => {
  const fixture = harness(); const outcome = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request());
  assert.deepEqual(outcome, {status: "completed", responseDigest: sha("response"), responseBytes: 12});
  assert.deepEqual(fixture.events, ["route:resolve", "policy:resolve", "transport:open", "transport:execute",
    "transport:ready", "route:revalidate", "dispatch:observe", "policy:revalidate", "transport:write", "transport:close"]);
  const body = fixture.authorizations[0]!;
  assert.deepEqual({credentialBindingRef: body.credentialBindingRef, credentialBindingDigest: body.credentialBindingDigest,
    credentialGeneration: body.credentialGeneration, credentialRevision: body.credentialRevision}, binding);
  assert.deepEqual(body.dispatchReceipt, receipt()); assert.deepEqual(fixture.dispatchInputs, [dispatch]);
  assert.equal(body.routeRevision, "route-revision-1"); assert.equal(body.routeAuthorityDigest, sha("route-authority"));
  assert.equal(body.requestBytes, applicationBytes(request())); assert.match(body.requestDigest, /^sha256:/u);
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
    {routeRevision: ""}, {authorityDigest: "opaque"}, {scheme: "http"}, {host: "93.184.216.34"},
    {tlsServerName: "other.example.com"}, {pathConstraint: "/other"}, {extra: true}]) {
    const fixture = harness({route: route(mutation)}); assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies)
      .exchange(request())).status, "denied", JSON.stringify(mutation)); assert.equal(fixture.events.includes("transport:open"), false);}
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
    v6("00000000000000000000ffff5db8d822"), {family: "ipv6", bytesHex: "::ffff:5db8:d822"},
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
});

test("final boundary rejects skipped, unawaited, reentrant, double, and thenable authorization use", async () => {
  for (const options of [{skipCallback: true}, {reentrantCallback: true}, {doubleConsume: true},
    {unawaitedCallback: true}, {signerThenable: true}, {verifierThenable: true}, {consumptionThenable: true}]) {
    const fixture = harness(options); const outcome = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request());
    assert.notEqual(outcome.status, "completed", JSON.stringify(options));
    if (outcome.status === "denied") {assert.equal(outcome.deniedApplicationBytes, 0);}
  }
  const skipped = harness({skipCallback: true}); await createContainedTurnEgressGateway(host(), skipped.dependencies).exchange(request());
  assert.deepEqual(await skipped.callback?.(observation()), {status: "denied"});
});

test("completed binds exact authorization consumption and all authorized application bytes", async () => {
  for (const options of [{partialWrite: true}, {completedWithoutCallback: true},
    {transportResult: {status: "completed", applicationBytesWritten: applicationBytes(request()), responseBytes: 1,
      responseDigest: sha("response"), authorizationConsumption: {authorizationDigest: sha("forged")}}},
    {transportResult: {status: "redirect", applicationBytesWritten: applicationBytes(request())}}]) {
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
    {...envelope, signature: Buffer.from("mutated").toString("base64")}]) {assert.equal(adapter.verify(body, mutation), false);}
  assert.throws(() => adapter.sign(body, {...key, keyGeneration: "wrong"}), /signing authority mismatch/u);
});

test("real closing state waits for open, callback, execute, and close; late transport closes once", async () => {
  for (const stage of ["open", "callback", "execute", "close"] as const) {
    const hold = deferred(); const options: HarnessOptions = stage === "open" ? {holdOpen: hold.promise} :
      stage === "callback" ? {holdAuthority: hold.promise} : stage === "execute" ? {holdExecute: hold.promise} :
        {holdClose: hold.promise};
    const fixture = harness(options); const gateway = createContainedTurnEgressGateway(host(), fixture.dependencies);
    const pending = gateway.exchange(request()); const marker = stage === "open" ? "transport:open" : stage === "callback" ?
      "dispatch:observe" : stage === "execute" ? "policy:revalidate" : "transport:close";
    while (!fixture.events.includes(marker)) {await Promise.resolve();}
    let disposed = false; const disposal = gateway.dispose().then(value => {disposed = true; return value;});
    await Promise.resolve(); assert.equal(disposed, false); hold.resolve();
    assert.equal(await disposal, "closed"); const outcome = await pending;
    if (stage !== "close") {assert.notEqual(outcome.status, "completed");} else {assert.equal(outcome.status, "completed");}
    assert.equal(fixture.closeCount, 1);
    assert.equal(await gateway.dispose(), "closed"); assert.equal(fixture.closeCount, 1);
  }
});

test("ambiguity and close failure quarantine without retry", async () => {
  for (const options of [{executeThrows: true}, {writeIndeterminate: true}]) {const fixture = harness(options);
    assert.deepEqual(await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request()),
      {status: "indeterminate", reason: "first_write_indeterminate"});}
  const fixture = harness({closeFails: true}); const gateway = createContainedTurnEgressGateway(host(), fixture.dependencies);
  assert.deepEqual(await gateway.exchange(request()), {status: "indeterminate", reason: "close_failed"});
  assert.equal(await gateway.dispose(), "quarantined"); assert.equal(await gateway.dispose(), "quarantined");
  assert.equal(fixture.closeCount, 1);
});
