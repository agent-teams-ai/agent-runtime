import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createContainedTurnEgressGateway, createNodeEd25519EgressSigner,
  type ContainedTurnEgressDependencies, type ContainedTurnEgressRequest,
  type EgressTransportV1, type TrustedEgressHostIdentityV1 } from "../dist/composition.js";
import * as ordinaryRuntimeSecurity from "../dist/index.js";

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const keys = generateKeyPairSync("ed25519");
const signer = () => createNodeEd25519EgressSigner(Object.freeze({keyId: "key-1", keyGeneration: "key-gen-1",
  signerRevision: "signer-1", privateKey: keys.privateKey, publicKey: keys.publicKey}));
const host = (overrides: Partial<TrustedEgressHostIdentityV1> = {}): TrustedEgressHostIdentityV1 => Object.freeze({
  attemptId: "attempt-1", environmentId: "environment-1", gatewayId: "gateway-1", hostInstanceId: "host-instance-1",
  hostBootId: "host-boot-1", transportMode: "one_shot_https", ...overrides,
});
const route = (overrides: Record<string, unknown> = {}) => Object.freeze({
  contractVersion: "provider-route-authority/v1", tenantId: "tenant-1", projectId: "project-1",
  providerId: "provider-1", providerAccountRef: "account-1", providerRouteRef: "route-1",
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
const observation = (overrides: Record<string, unknown> = {}) => Object.freeze({
  canonicalAddresses: Object.freeze(["93.184.216.34"]), peerAddress: "93.184.216.34", peerPort: 443,
  tlsServerName: "api.example.com", tlsSpkiDigest: sha("spki"), alpn: "http/1.1",
  phase: "immediately_before_first_application_byte", ...overrides,
});
const request = (overrides: Record<string, unknown> = {}): ContainedTurnEgressRequest => ({
  scope: {tenantId: "tenant-1", projectId: "project-1", scopeDigest: sha("scope")},
  providerId: "provider-1", providerAccountRef: "account-1", providerRouteRef: "route-1",
  operationId: "operation-1", dispatch: {grantRequestId: "grant-request-1",
    grantProofId: "grant-proof-1", claimProofId: "claim-proof-1", claimBindingDigest: sha("claim-binding"),
    consumptionDigest: sha("consumption")}, requestId: "request-1", requestNonce: "nonce-1", method: "POST",
  path: "/v1/turn", headers: [{name: "content-type", value: "application/json"},
    {name: "x-request-class", value: "synthetic"}], body: Uint8Array.from([1, 2, 3, 4]),
  budgets: {requestBytes: 1_000, responseBytes: 2_000, deadlineMs: 200}, ...overrides,
} as ContainedTurnEgressRequest);

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {release = resolve;});
  return {promise, resolve: release};
};

interface HarnessOptions {
  route?: unknown; policy?: unknown; observation?: unknown;
  routeOutcome?: unknown; dispatchOutcome?: unknown; policyOutcome?: unknown;
  openFails?: boolean; closeFails?: boolean; executeThrows?: boolean; skipCallback?: boolean;
  completedWithoutCallback?: boolean; doubleCallback?: boolean; earlyCallback?: boolean;
  writeIndeterminate?: boolean; transportResult?: unknown;
  responseBytes?: number; holdOpen?: Promise<void>; holdBeforeCallback?: Promise<void>;
  mutateAtResolve?: () => void;
}
const harness = (options: HarnessOptions = {}) => {
  const events: string[] = [];
  const authorizations: string[] = [];
  const signatures: string[] = [];
  const dispatchInputs: unknown[] = [];
  const transported: {headers?: readonly Readonly<{name: string; value: string}>[]; body?: Uint8Array} = {};
  let callback: ((value: unknown) => Promise<unknown>) | undefined;
  let closeCount = 0;
  const transport: EgressTransportV1 = {
    async execute(input) {
      events.push("transport:execute");
      transported.headers = input.request.headers;
      transported.body = input.request.body;
      callback = input.beforeFirstByte;
      await options.holdBeforeCallback;
      if (options.executeThrows) {throw new Error("ambiguous write");}
      if (options.completedWithoutCallback) {
        events.push("transport:write");
        return {status: "completed", applicationBytesWritten: 1, responseBytes: 12, responseDigest: sha("response")};
      }
      if (options.skipCallback) {return {status: "not_sent", applicationBytesWritten: 0};}
      if (options.earlyCallback) {
        events.push("transport:early-callback");
        await input.beforeFirstByte(observation({phase: "queue_wait"}));
        return {status: "not_sent", applicationBytesWritten: 0};
      }
      events.push("transport:ready");
      const admission = await input.beforeFirstByte(options.observation ?? observation()) as
        {status: string; body?: string; envelope?: {signature?: string}};
      if (admission.body !== undefined) {authorizations.push(admission.body);}
      if (admission.envelope?.signature !== undefined) {signatures.push(admission.envelope.signature);}
      if (options.doubleCallback) {
        events.push("transport:callback-again");
        await input.beforeFirstByte(options.observation ?? observation());
        return {status: "not_sent", applicationBytesWritten: 0};
      }
      if (admission.status !== "authorized") {return {status: "not_sent", applicationBytesWritten: 0};}
      if (options.writeIndeterminate) {return {status: "write_indeterminate"};}
      events.push("transport:write");
      if (options.transportResult !== undefined) {return options.transportResult;}
      return {status: "completed", applicationBytesWritten: input.request.body.byteLength + 1,
        responseBytes: options.responseBytes ?? 12, responseDigest: sha("response")};
    },
    async close() {events.push("transport:close"); closeCount += 1; if (options.closeFails) {throw new Error("close failed");}},
  };
  const dependencies: ContainedTurnEgressDependencies = {
    routeAuthority: {
      async resolveExact() {events.push("route:resolve"); options.mutateAtResolve?.(); return options.route ?? route();},
      async revalidateExact() {events.push("route:revalidate"); return options.routeOutcome ?? {status: "current"};},
    },
    dispatchAuthority: {async revalidateClaimCommitted(input) {
      events.push("dispatch:claim_committed");
      dispatchInputs.push(input);
      return options.dispatchOutcome ?? {status: "claim_committed"};
    }},
    policyAuthority: {
      async resolve() {events.push("policy:resolve"); return options.policy ?? policy();},
      async revalidateExact() {events.push("policy:revalidate"); return options.policyOutcome ?? {status: "current", observedAt: 101};},
    },
    signer: signer(),
    transportGateway: {async openOneShotHttps() {
      events.push("transport:open"); await options.holdOpen;
      if (options.openFails) {throw new Error("open failed");}
      return transport;
    }},
  };
  return {dependencies, events, authorizations, signatures, dispatchInputs, transported, get callback() {return callback;},
    get closeCount() {return closeCount;}};
};

test("binds trusted host, exact consumed claim, route, policy, request bytes, and peer immediately before write", async () => {
  const fixture = harness();
  const outcome = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request());
  assert.deepEqual(outcome, {status: "completed", responseDigest: sha("response"), responseBytes: 12});
  assert.deepEqual(fixture.events, ["route:resolve", "policy:resolve", "transport:open", "transport:execute",
    "transport:ready", "route:revalidate", "dispatch:claim_committed", "policy:revalidate",
    "transport:write", "transport:close"]);
  const body = JSON.parse(fixture.authorizations[0] ?? "null") as Record<string, unknown>;
  assert.deepEqual({attemptId: body.attemptId, environmentId: body.environmentId, gatewayId: body.gatewayId,
    hostInstanceId: body.hostInstanceId, hostBootId: body.hostBootId, transportMode: body.transportMode}, host());
  assert.equal(body.grantProofId, "grant-proof-1");
  assert.equal(body.claimProofId, "claim-proof-1");
  assert.equal(body.claimBindingDigest, sha("claim-binding"));
  assert.equal(body.consumptionDigest, sha("consumption"));
  assert.deepEqual(fixture.dispatchInputs[0], {tenantId: "tenant-1", projectId: "project-1",
    scopeDigest: sha("scope"), providerId: "provider-1", operationId: "operation-1", attemptId: "attempt-1",
    grantRequestId: "grant-request-1", grantProofId: "grant-proof-1", claimProofId: "claim-proof-1",
    claimBindingDigest: sha("claim-binding"), consumptionDigest: sha("consumption")});
  assert.equal(body.policyRevision, "policy-revision-1");
  assert.deepEqual(body.policyMaxima, {requestBytes: 4_096, responseBytes: 8_192, deadlineMs: 300});
  assert.equal(body.routeRevision, "route-revision-1");
  assert.equal(body.tlsSpkiDigest, sha("spki"));
  assert.equal("headers" in body, false);
  assert.equal("body" in body, false);
  assert.match(body.headerDigest as string, /^sha256:/u);
  assert.match(body.bodyDigest as string, /^sha256:/u);
  assert.ok(Object.isFrozen(outcome));
});

test("trusted composition is exact, snapshots owners, and stays dormant outside composition", async () => {
  const fixture = harness();
  assert.throws(() => createContainedTurnEgressGateway({...host(), extra: true} as never, fixture.dependencies),
    /invalid contained turn egress composition/u);
  assert.throws(() => createContainedTurnEgressGateway(host(), {...fixture.dependencies, extra: true} as never),
    /invalid contained turn egress composition/u);
  assert.throws(() => createContainedTurnEgressGateway(new Proxy(host(), {}) as never, fixture.dependencies),
    /invalid contained turn egress composition/u);
  const gateway = createContainedTurnEgressGateway(host(), fixture.dependencies);
  fixture.dependencies.routeAuthority.resolveExact = async () => {throw new Error("mutated");};
  assert.equal((await gateway.exchange(request())).status, "completed");
  assert.equal("createContainedTurnEgressGateway" in ordinaryRuntimeSecurity, false);
});

test("copies ordered headers and body before every await and computes their real digests", async () => {
  const candidate = request();
  const originalBody = Uint8Array.from(candidate.body);
  const originalHeaders = structuredClone(candidate.headers);
  const fixture = harness({mutateAtResolve() {
    candidate.body.fill(9);
    (candidate.headers as {name: string; value: string}[])[0]!.value = "mutated-secret";
    (candidate as {path: string}).path = "/evil";
  }});
  assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(candidate)).status, "completed");
  assert.deepEqual(fixture.transported.body, originalBody);
  assert.deepEqual(fixture.transported.headers, originalHeaders);
  assert.notStrictEqual(fixture.transported.body, candidate.body);
  const authorization = JSON.parse(fixture.authorizations[0] ?? "null") as Record<string, unknown>;
  assert.equal(authorization.bodyDigest, `sha256:${createHash("sha256").update(originalBody).digest("hex")}`);
  const reversed = request({headers: originalHeaders.toReversed()});
  const second = harness();
  await createContainedTurnEgressGateway(host(), second.dependencies).exchange(reversed);
  assert.notEqual(JSON.parse(second.authorizations[0] ?? "null").headerDigest, authorization.headerDigest);
});

test("rejects hostile, secret-bearing, and unbounded request graphs before owner calls", async () => {
  const accessor = request() as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, "body", {enumerable: true, get() {throw new Error("read");}});
  const sharedBody = new Uint8Array(new SharedArrayBuffer(4));
  const headerAccessor = Object.defineProperty({name: "accept", value: "ok"}, "value",
    {enumerable: true, get() {throw new Error("read");}});
  const cases: unknown[] = [
    {...request(), extra: true}, accessor, new Proxy(request(), {}), request({body: sharedBody}),
    request({body: new Proxy(Uint8Array.from([1]), {})}), request({headers: [headerAccessor]}),
    request({headers: [{name: "authorization", value: "secret"}]}),
    request({headers: [{name: "Host", value: "evil.example"}]}),
    request({headers: [{name: "accept", value: "x\r\ninjected: true"}]}),
    request({path: "https://evil.example/v1"}), request({path: "/v1/%2e%2e/secret"}),
    request({body: new Uint8Array(1_048_577)}), request({budgets: {requestBytes: 1, responseBytes: 2_000, deadlineMs: 200}}),
  ];
  for (const value of cases) {
    const fixture = harness();
    assert.deepEqual(await createContainedTurnEgressGateway(host(), fixture.dependencies)
      .exchange(value as ContainedTurnEgressRequest),
    {status: "denied", reason: "invalid_request", deniedApplicationBytes: 0});
    assert.deepEqual(fixture.events, []);
  }
});

test("caller budgets cannot exceed Runtime Security policy maxima", async () => {
  const cases = [
    request({budgets: {requestBytes: 4_097, responseBytes: 2_000, deadlineMs: 200}}),
    request({budgets: {requestBytes: 1_000, responseBytes: 8_193, deadlineMs: 200}}),
    request({budgets: {requestBytes: 1_000, responseBytes: 2_000, deadlineMs: 301}}),
  ];
  for (const candidate of cases) {
    const fixture = harness();
    assert.deepEqual(await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(candidate),
      {status: "denied", reason: "budget_exceeded", deniedApplicationBytes: 0});
    assert.equal(fixture.events.includes("transport:open"), false);
  }
});

test("route authority is exact, trusted, and revalidated rather than inferred from caller destination", async () => {
  const mutations = [{tenantId: "tenant-2"}, {projectId: "project-2"}, {providerId: "provider-2"},
    {providerAccountRef: "account-2"}, {providerRouteRef: "route-2"}, {scheme: "http"}, {port: 8443},
    {host: "API.example.com"}, {host: "93.184.216.34", tlsServerName: "93.184.216.34"},
    {tlsServerName: "other.example.com"}, {pathConstraint: "/other"}, {authorityDigest: "opaque"},
    {extra: true}];
  for (const mutation of mutations) {
    const fixture = harness({route: route(mutation)});
    const outcome = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request());
    assert.equal(outcome.status, "denied", JSON.stringify(mutation));
    assert.equal(fixture.events.includes("transport:open"), false, JSON.stringify(mutation));
  }
  const drift = harness({routeOutcome: {status: "rejected", reason: "changed"}});
  assert.deepEqual(await createContainedTurnEgressGateway(host(), drift.dependencies).exchange(request()),
    {status: "denied", reason: "authority_drift", deniedApplicationBytes: 0});
});

test("only a currently claim_committed consumed dispatch authority permits bytes", async () => {
  for (const dispatchOutcome of [{status: "rejected", reason: "claim_not_committed"},
    {status: "indeterminate"}, {status: "current"}, {status: "claim_committed", extra: true}]) {
    const fixture = harness({dispatchOutcome});
    assert.deepEqual(await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request()),
      {status: "denied", reason: "dispatch_not_committed", deniedApplicationBytes: 0});
    assert.equal(fixture.events.includes("transport:write"), false);
  }
});

test("policy, key, time, expiry, and peer drift all deny with zero application bytes", async () => {
  const cases: readonly HarnessOptions[] = [
    {policyOutcome: {status: "rejected", reason: "policy_changed"}},
    {policyOutcome: {status: "rejected", reason: "key_changed"}},
    {policyOutcome: {status: "rejected", reason: "time_generation_changed"}},
    {policyOutcome: {status: "current", observedAt: 99}},
    {policy: policy({expiresAt: 101}), policyOutcome: {status: "current", observedAt: 101}},
    {observation: observation({peerAddress: "93.184.216.35"})},
    {observation: observation({peerPort: 444})},
    {observation: observation({tlsServerName: "other.example.com"})},
    {observation: observation({alpn: "h2"})},
  ];
  for (const options of cases) {
    const fixture = harness(options);
    const outcome = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request());
    assert.equal(outcome.status, "denied", JSON.stringify(options));
    assert.equal(fixture.events.includes("transport:write"), false);
    assert.equal(fixture.closeCount, 1);
  }
});

test("private, reserved, metadata, mapped, zoned, unsorted, and mixed DNS sets deny before bytes", async () => {
  const cases: readonly string[][] = [["10.0.0.1"], ["127.0.0.1"], ["169.254.169.254"],
    ["172.16.0.1"], ["192.168.0.1"], ["192.0.2.1"], ["198.18.0.1"], ["198.51.100.1"],
    ["203.0.113.1"], ["224.0.0.1"], ["::1"], ["fe80::1%eth0"], ["fc00::1"],
    ["::ffff:93.184.216.34"], ["2001:db8::1"], ["93.184.216.34", "10.0.0.1"],
    ["93.184.216.35", "93.184.216.34"]];
  for (const addresses of cases) {
    const fixture = harness({observation: observation({canonicalAddresses: addresses,
      peerAddress: addresses[0]})});
    const outcome = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request());
    assert.equal(outcome.status, "denied", addresses.join(","));
    assert.equal(fixture.events.includes("transport:write"), false);
  }
});

test("the transport callback is mandatory, exactly once, and closed against late use", async () => {
  const early = harness({earlyCallback: true});
  assert.deepEqual(await createContainedTurnEgressGateway(host(), early.dependencies).exchange(request()),
    {status: "denied", reason: "address_denied", deniedApplicationBytes: 0});
  assert.equal(early.events.includes("transport:write"), false);

  const skipped = harness({skipCallback: true});
  assert.deepEqual(await createContainedTurnEgressGateway(host(), skipped.dependencies).exchange(request()),
    {status: "denied", reason: "transport_denied", deniedApplicationBytes: 0});
  assert.deepEqual(await skipped.callback?.(observation()), {status: "denied"});

  const double = harness({doubleCallback: true});
  assert.deepEqual(await createContainedTurnEgressGateway(host(), double.dependencies).exchange(request()),
    {status: "denied", reason: "authorization_invalid", deniedApplicationBytes: 0});
  assert.equal(double.events.includes("transport:write"), false);

  const bypass = harness({completedWithoutCallback: true});
  assert.deepEqual(await createContainedTurnEgressGateway(host(), bypass.dependencies).exchange(request()),
    {status: "indeterminate", reason: "first_write_indeterminate"});
});

test("actual Ed25519 vectors reject body, identity, digest, and signature mutation", () => {
  const adapter = signer();
  const key = {keyId: "key-1", keyGeneration: "key-gen-1", signerRevision: "signer-1"};
  const body = JSON.stringify({contractVersion: "contained-turn-egress-authorization-body/v1", field: "original"});
  const envelope = adapter.sign(body, key) as ReturnType<typeof signer>["sign"] extends (...args: never[]) => infer Result ? Result : never;
  assert.equal(adapter.verify(body, envelope as never), true);
  assert.equal(adapter.verify(body.replace("original", "mutated"), envelope as never), false);
  for (const mutation of [{...envelope as object, keyId: "key-2"}, {...envelope as object, keyGeneration: "key-gen-2"},
    {...envelope as object, signerRevision: "signer-2"}, {...envelope as object, digest: sha("mutated")},
    {...envelope as object, signature: Buffer.from("mutated").toString("base64")}]) {
    assert.equal(adapter.verify(body, mutation as never), false, JSON.stringify(mutation));
  }
  assert.throws(() => adapter.sign(body, {...key, keyGeneration: "wrong"}), /signing authority mismatch/u);
});

test("authorization mutations change real signatures and every envelope is self-verifying", async () => {
  const variants: [TrustedEgressHostIdentityV1, ContainedTurnEgressRequest, HarnessOptions][] = [
    [host({gatewayId: "gateway-2"}), request(), {}], [host({attemptId: "attempt-2"}), request(), {}],
    [host(), request({requestNonce: "nonce-2"}), {}],
    [host(), request({dispatch: {...request().dispatch, claimProofId: "claim-proof-2"}}),
      {dispatchOutcome: {status: "claim_committed"}}],
    [host(), request(), {route: route({routeRevision: "route-revision-2"})}],
    [host(), request(), {policy: policy({policyRevision: "policy-revision-2"})}],
    [host(), request(), {observation: observation({tlsSpkiDigest: sha("spki-2")})}],
  ];
  const bodies = new Set<string>();
  const signatures = new Set<string>();
  const base = harness();
  await createContainedTurnEgressGateway(host(), base.dependencies).exchange(request());
  bodies.add(base.authorizations[0]!);
  signatures.add(base.signatures[0]!);
  for (const [identity, candidate, options] of variants) {
    const fixture = harness(options);
    const outcome = await createContainedTurnEgressGateway(identity, fixture.dependencies).exchange(candidate);
    assert.equal(outcome.status, "completed");
    bodies.add(fixture.authorizations[0]!);
    signatures.add(fixture.signatures[0]!);
  }
  assert.equal(bodies.size, variants.length + 1);
  assert.equal(signatures.size, variants.length + 1);
});

test("V1 never follows redirects", async () => {
  const fixture = harness({transportResult: {status: "redirect", applicationBytesWritten: 1,
    responseBytes: 1, responseDigest: sha("redirect"), location: "https://other.example/v1"}});
  assert.deepEqual(await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request()),
    {status: "indeterminate", reason: "response_invalid"});
  assert.equal(fixture.events.filter(event => event === "transport:open").length, 1);
  assert.equal(fixture.events.filter(event => event === "transport:write").length, 1);
});

test("one-shot, possible-write ambiguity, response bounds, close failure, and disposal races are honest", async () => {
  const ordinary = harness();
  const gateway = createContainedTurnEgressGateway(host(), ordinary.dependencies);
  assert.equal((await gateway.exchange(request())).status, "completed");
  assert.equal((await gateway.exchange(request())).status, "denied");
  assert.equal(await gateway.dispose(), "closed");
  assert.equal(await gateway.dispose(), "closed");
  assert.equal(ordinary.closeCount, 1);

  for (const options of [{executeThrows: true}, {writeIndeterminate: true}]) {
    const fixture = harness(options);
    assert.deepEqual(await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request()),
      {status: "indeterminate", reason: "first_write_indeterminate"});
  }
  const oversized = harness({responseBytes: 2_001});
  assert.deepEqual(await createContainedTurnEgressGateway(host(), oversized.dependencies).exchange(request()),
    {status: "indeterminate", reason: "response_invalid"});
  const failedClose = harness({closeFails: true});
  const quarantined = createContainedTurnEgressGateway(host(), failedClose.dependencies);
  assert.deepEqual(await quarantined.exchange(request()), {status: "indeterminate", reason: "close_failed"});
  assert.equal(await quarantined.dispose(), "quarantined");

  for (const stage of ["open", "callback"] as const) {
    const hold = deferred();
    const fixture = harness(stage === "open" ? {holdOpen: hold.promise} : {holdBeforeCallback: hold.promise});
    const racing = createContainedTurnEgressGateway(host(), fixture.dependencies);
    const pending = racing.exchange(request());
    while (!fixture.events.includes(stage === "open" ? "transport:open" : "transport:execute")) {await Promise.resolve();}
    const disposal = racing.dispose();
    hold.resolve();
    assert.equal(await disposal, "closed");
    assert.notEqual((await pending).status, "completed");
    assert.equal(fixture.events.includes("transport:write"), false);
    assert.ok(fixture.closeCount <= 1);
  }
});
