import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createNodeHmacEgressDecisionSeal,
  createNodeSha256EgressDigest,
  createProviderProcessEgressAuthorizationFeature,
  type RequestFinalEgressAuthorizationV1,
  type RequestProvisionalEgressAuthorizationV1,
} from "../dist/composition.js";
import {
  assertDeepFrozen, authorityFor, authorizeProvisional, finalInput, harness, provisionalInput, scope,
} from "./provider-process-egress-authorization.fixtures.ts";

test("caller inputs reject authority, scope, generation, expiry, route, budget, and unknown extras", async () => {
  const querySecret = "synthetic-query-secret-must-not-cross-rs";
  const candidates = [
    { ...provisionalInput(), scope: scope() },
    { ...provisionalInput(), policy: authorityFor().policy },
    { ...provisionalInput(), currentAuthority: authorityFor() },
    { ...provisionalInput(), generations: {} },
    { ...provisionalInput(), expiresAtControlTime: 1_100 },
    { ...provisionalInput(), routePermission: true },
    { ...provisionalInput(), budgets: authorityFor().policy.limits },
    { ...provisionalInput(), request: { ...provisionalInput().request,
      pathAndQuery: `/v1/messages?api_key=${querySecret}` } },
    { ...provisionalInput(), unexpected: true },
  ];
  for (const candidate of candidates) {
    const result = await harness().gateway.requestProvisional(candidate as never);
    assert.equal(result.status, "denied");
    if (result.status === "denied") {assert.equal(result.evidence.issueCode, "invalid_input");}
    assert.equal(JSON.stringify(result).includes(querySecret), false);
  }
  const symbolInput = provisionalInput() as RequestProvisionalEgressAuthorizationV1 &
    { [key: symbol]: boolean };
  symbolInput[Symbol("hidden-policy")] = true;
  assert.equal((await harness().gateway.requestProvisional(symbolInput)).status, "denied");
  const setup = harness();
  const provisional = await authorizeProvisional(setup.gateway);
  for (const extra of [
    { currentAuthority: authorityFor() }, { policy: authorityFor().policy },
    { observedAtControlTime: 1_000 }, { expiry: 1_100 }, { routePermission: true },
  ]) {
    const result = await setup.gateway.authorizeFirstApplicationByte({
      ...finalInput(provisional), ...extra,
    } as never);
    assert.equal(result.status, "denied");
  }
  const symbolFinal = finalInput(provisional) as RequestFinalEgressAuthorizationV1 &
    { [key: symbol]: boolean };
  symbolFinal[Symbol("hidden-authority")] = true;
  assert.equal((await setup.gateway.authorizeFirstApplicationByte(symbolFinal)).status, "denied");
});

test("request-target bytes remain Host-only while their exact commitment crosses Runtime Security", async () => {
  const querySecret = "synthetic-query-secret-must-not-cross-rs";
  const rejected = harness();
  const oldRawTarget = await rejected.gateway.requestProvisional({ ...provisionalInput(), request: {
    ...provisionalInput().request, pathAndQuery: `/v1/messages?api_key=${querySecret}`,
  } } as never);
  assert.equal(oldRawTarget.status, "denied");
  assert.equal(rejected.state.resolveCalls.length, 0);
  assert.equal(JSON.stringify(oldRawTarget).includes(querySecret), false);
  const setup = harness();
  const input = provisionalInput({ request: { ...provisionalInput().request,
    requestTarget: { digest: "sha256:" + "b".repeat(64), byteLength: 57 } } });
  setup.state.authority = authorityFor(input.request);
  const provisional = await authorizeProvisional(setup.gateway, input);
  const final = await setup.gateway.authorizeFirstApplicationByte(finalInput(provisional));
  assert.equal(final.status, "authorized");
  for (const value of [setup.state.resolveCalls, provisional, final]) {
    assert.equal(JSON.stringify(value).includes(querySecret), false);
  }
  assert.deepEqual(provisional.request.requestTarget, input.request.requestTarget);
  assert.equal("pathAndQuery" in provisional.request, false);
});

test("input accessors, Proxies, cycles, sparse arrays, and prototypes fail without getter invocation", async () => {
  const setup = harness();
  let reads = 0;
  const accessor = { ...provisionalInput() } as Record<string, unknown>;
  Object.defineProperty(accessor, "request", { enumerable: true, get() {
    reads += 1; return provisionalInput().request;
  } });
  assert.equal((await setup.gateway.requestProvisional(accessor as never)).status, "denied");
  assert.equal(reads, 0);

  let proxyReads = 0;
  const proxy = new Proxy(provisionalInput(), { getOwnPropertyDescriptor(target, property) {
    proxyReads += 1; return Reflect.getOwnPropertyDescriptor(target, property);
  } });
  assert.equal((await setup.gateway.requestProvisional(proxy)).status, "denied");
  assert.equal(proxyReads, 0);

  const cyclic = provisionalInput() as unknown as Record<string, unknown>;
  cyclic.request = cyclic;
  assert.equal((await setup.gateway.requestProvisional(cyclic as never)).status, "denied");
  assert.equal((await setup.gateway.requestProvisional(Object.assign(Object.create({ inherited: true }),
    provisionalInput()) as never)).status, "denied");
  const sparse = provisionalInput();
  (sparse.request.headers as { credentialFields: unknown[] }).credentialFields = Array(1);
  assert.equal((await setup.gateway.requestProvisional(sparse)).status, "denied");
  const oversized = provisionalInput();
  (oversized.request.headers as { credentialFields: unknown[] }).credentialFields =
    Array.from({ length: 257 }, () => ({ name: "authorization",
      credentialBindingDigest: "", valueDigest: "", byteLength: 1 }));
  assert.equal((await setup.gateway.requestProvisional(oversized)).status, "denied");
});

test("async owner results are detached exact records and hostile values fail closed", async () => {
  const setup = harness();
  const source = authorityFor();
  setup.state.authority = source;
  const result = await setup.gateway.requestProvisional(provisionalInput());
  assert.equal(result.status, "authorized");
  if (result.status === "authorized") {
    setup.state.authority = { ...source, policy: { ...source.policy, policyRef: "mutated" } };
    assert.equal(result.decision.policy.policyRef, "policy-1");
    assertDeepFrozen(result);
  }

  const proxied = harness();
  proxied.state.resolveOutcome = new Proxy({ status: "current", authority: authorityFor() }, {}) as never;
  const proxyResult = await proxied.gateway.requestProvisional(provisionalInput());
  assert.equal(proxyResult.status, "denied");
  if (proxyResult.status === "denied") {assert.equal(proxyResult.evidence.issueCode, "owner_malformed");}

  const getter = harness();
  let reads = 0;
  const hostile = { status: "current" } as Record<string, unknown>;
  Object.defineProperty(hostile, "authority", { enumerable: true, get() {
    reads += 1; return authorityFor();
  } });
  getter.state.resolveOutcome = hostile as never;
  assert.equal((await getter.gateway.requestProvisional(provisionalInput())).status, "denied");
  assert.equal(reads, 0);

  const symbolOwner = harness();
  const ownerOutcome = { status: "current" as const, authority: authorityFor() } as
    { status: "current"; authority: ReturnType<typeof authorityFor>; [key: symbol]: boolean };
  ownerOutcome[Symbol("hidden-owner-fact")] = true;
  symbolOwner.state.resolveOutcome = ownerOutcome;
  assert.equal((await symbolOwner.gateway.requestProvisional(provisionalInput())).status, "denied");
});

test("composition validates and snapshots the exact six dependencies and method references once", async () => {
  const seal = createNodeHmacEgressDecisionSeal({ keyRef: "egress-key", secret: "synthetic-only" });
  let originalCalls = 0;
  const owner = { async resolvePolicy() { originalCalls += 1;
    return { status: "current" as const, authority: authorityFor() }; },
  async readCurrent() {return { status: "current" as const, authority: authorityFor() };} };
  const valid = { scope: scope(), authorityOwner: owner,
    clock: { read: () => ({ authorityId: "clock-authority-1", epoch: "process-epoch-1",
      controlTime: 1_000 }) }, digest: createNodeSha256EgressDigest(), signer: seal, verifier: seal };
  const gateway = createProviderProcessEgressAuthorizationFeature(valid).hostEgressAuthorizationV1;
  owner.resolvePolicy = async () => {throw new Error("replacement must not run");};
  assert.equal((await gateway.requestProvisional(provisionalInput())).status, "authorized");
  assert.equal(originalCalls, 1);

  assert.throws(() => createProviderProcessEgressAuthorizationFeature({ ...valid,
    ambientPolicy: {} } as never), TypeError);
  assert.throws(() => createProviderProcessEgressAuthorizationFeature({ ...valid,
    authorityOwner: {} } as never), TypeError);
  let reads = 0;
  const accessor = { ...valid } as Record<string, unknown>;
  Object.defineProperty(accessor, "clock", { enumerable: true, get() {reads += 1; return valid.clock;} });
  assert.throws(() => createProviderProcessEgressAuthorizationFeature(accessor as never), TypeError);
  assert.equal(reads, 0);
  assert.throws(() => createProviderProcessEgressAuthorizationFeature(new Proxy(valid, {})), TypeError);
  const symbolDependencies = { ...valid } as typeof valid & { [key: symbol]: boolean };
  symbolDependencies[Symbol("ambient-dependency")] = true;
  assert.throws(() => createProviderProcessEgressAuthorizationFeature(symbolDependencies), TypeError);

  let signerAlias: ReturnType<typeof seal.sign> | undefined;
  const detachedSignerGateway = createProviderProcessEgressAuthorizationFeature({ ...valid,
    authorityOwner: {
      async resolvePolicy() {return { status: "current" as const, authority: authorityFor() };},
      async readCurrent() {return { status: "current" as const, authority: authorityFor() };},
    },
    signer: { sign(value, key) {
      signerAlias = { ...seal.sign(value, key) };
      return signerAlias;
    } },
  }).hostEgressAuthorizationV1;
  const detached = await detachedSignerGateway.requestProvisional(provisionalInput());
  assert.equal(detached.status, "authorized");
  if (detached.status === "authorized" && signerAlias !== undefined) {
    (signerAlias as { value: string }).value = "mutated-by-signer";
    assert.notEqual(detached.decision.signature.value, signerAlias.value);
    assertDeepFrozen(detached.decision.signature);
  }
  const nonBooleanVerifier = createProviderProcessEgressAuthorizationFeature({ ...valid,
    authorityOwner: {
      async resolvePolicy() {return { status: "current" as const, authority: authorityFor() };},
      async readCurrent() {return { status: "current" as const, authority: authorityFor() };},
    }, verifier: { verify: () => ({ truthy: true }) as never },
  }).hostEgressAuthorizationV1;
  assert.equal((await nonBooleanVerifier.requestProvisional(provisionalInput())).status, "denied");
});

test("tampered provisional decisions and signatures never produce a final grant", async () => {
  const setup = harness();
  const provisional = await authorizeProvisional(setup.gateway);
  const tampered = [
    { ...provisional, requestDigest: "sha256:" + "9".repeat(64) },
    { ...provisional, time: { ...provisional.time, expiresAtControlTime: 1_101 } },
    { ...provisional, signingKey: { ...provisional.signingKey, keyGeneration: "key-generation-2" } },
    { ...provisional, signature: { ...provisional.signature, value: "forged" } },
  ];
  for (const decision of tampered) {
    const result = await setup.gateway.authorizeFirstApplicationByte(finalInput(decision as never));
    assert.equal(result.status, "denied");
    assert.equal("grant" in result, false);
  }

  let digestFails = false;
  const digestPort = createNodeSha256EgressDigest();
  const failureSeal = createNodeHmacEgressDecisionSeal({
    keyRef: "egress-key", secret: "synthetic-only",
  });
  const failureGateway = createProviderProcessEgressAuthorizationFeature({
    scope: scope(), authorityOwner: {
      async resolvePolicy() {return { status: "current" as const, authority: authorityFor() };},
      async readCurrent() {return { status: "current" as const, authority: authorityFor() };},
    },
    clock: { read: () => ({ authorityId: "clock-authority-1", epoch: "process-epoch-1",
      controlTime: 1_000 }) },
    digest: { digest(value) {
      if (digestFails) {throw new Error("synthetic digest failure");}
      return digestPort.digest(value);
    } }, signer: failureSeal, verifier: failureSeal,
  }).hostEgressAuthorizationV1;
  const beforeFailure = await authorizeProvisional(failureGateway);
  digestFails = true;
  const digestFailure = await failureGateway.authorizeFirstApplicationByte(finalInput(beforeFailure));
  assert.equal(digestFailure.status, "denied");
  if (digestFailure.status === "denied") {assert.equal(digestFailure.evidence.phase, "final");}
});
