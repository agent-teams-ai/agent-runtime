import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createNodeSha256EgressDigest } from "../dist/composition.js";
import {
  assertDeepFrozen, authorizeProvisional, canonical, digest, finalInput, harness, provisionalInput,
  requestProjection, scope,
} from "./provider-process-egress-authorization.fixtures.ts";

const grantForTenant = async (tenantId: string) => {
  const setup = harness({ boundScope: scope(tenantId) });
  const provisional = await authorizeProvisional(setup.gateway);
  const outcome = await setup.gateway.authorizeFirstApplicationByte(finalInput(provisional));
  assert.equal(outcome.status, "authorized");
  if (outcome.status !== "authorized") {throw new Error("expected grant");}
  return outcome.grant.payload.consumption;
};

test("composition binds immutable scope and owner resolves policy from Host request facts", async () => {
  const setup = harness();
  const caller = provisionalInput();
  assert.deepEqual(Object.keys(caller).toSorted(),
    ["authorizationRequestId", "contractVersion", "request"].toSorted());
  const decision = await authorizeProvisional(setup.gateway, caller);
  assert.deepEqual(decision.scope, setup.boundScope);
  assert.equal(setup.state.resolveCalls.length, 1);
  assert.deepEqual(setup.state.resolveCalls[0], {
    scope: setup.boundScope, authorizationRequestId: caller.authorizationRequestId,
    request: caller.request,
  });
  assertDeepFrozen(setup.state.resolveCalls[0]);
  (setup.boundScope as { tenantId: string }).tenantId = "caller-mutation";
  assert.equal(decision.scope.tenantId, "tenant-1");
  assert.equal(decision.time.expiresAtControlTime, 1_100);
  assert.equal(decision.signingKey.keyGeneration, "key-generation-1");
  assert.equal(setup.seal.verify(decision.decisionDigest, decision.signature), true);
  assertDeepFrozen(decision);
});

test("final grant signs the complete payload and exposes only safe compact evidence", async () => {
  const setup = harness();
  const provisional = await authorizeProvisional(setup.gateway);
  const result = await setup.gateway.authorizeFirstApplicationByte(finalInput(provisional));
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {return;}
  const recomputed = createNodeSha256EgressDigest().digest(canonical(result.grant.payload));
  assert.equal(result.grant.finalAuthorizationDigest, recomputed);
  assert.equal(setup.seal.verify(recomputed, result.grant.signature), true);
  assert.deepEqual(result.grant.payload.resolver.normalizedAddresses, [
    { family: "ipv4", address: "93.184.216.34", classification: "public" },
  ]);
  assert.deepEqual(result.grant.payload.consumption.journalKey, {
    namespace: "provider-process-egress/v1", tenantId: "tenant-1", projectId: "project-1",
    operationId: "operation-1", boundaryUseId: "boundary-use-1",
  });
  assertDeepFrozen(result);
  const evidence = JSON.stringify(result.grant.evidence);
  assert.equal(evidence.includes("/v1/messages"), false);
  assert.equal(evidence.includes("authorization"), true);
  assert.equal(JSON.stringify(result.grant).includes("synthetic-only"), false);
});

test("every Runtime Security and Provider Access owner fact drift denies", async () => {
  const mutations = [
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      authorityRef: "authority-2" }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      policy: { ...value.policy, policyRef: "policy-2" } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      policy: { ...value.policy, policyRevision: "policy-revision-2" } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      policy: { ...value.policy, policyGeneration: "policy-generation-2" } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      policy: { ...value.policy, authorizedRequestDigest: digest("9") } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      policy: { ...value.policy, origin: { ...value.policy.origin, port: 8443 } } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      policy: { ...value.policy, dnsIdentity: "other.example.com" } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      policy: { ...value.policy, tlsPolicyDigest: digest("9") } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      policy: { ...value.policy, limits: { ...value.policy.limits, requestBytes: 999 } } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      policy: { ...value.policy, decisionTtlMilliseconds: 101 } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      policy: { ...value.policy, signingKey: { ...value.policy.signingKey,
        keyGeneration: "key-generation-2" } } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      providerAccess: { ...value.providerAccess, accessRef: "access-2" } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      providerAccess: { ...value.providerAccess, providerRef: "provider-2" } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      providerAccess: { ...value.providerAccess, accountRef: "account-2" } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      providerAccess: { ...value.providerAccess, routeRef: "route-2" } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      providerAccess: { ...value.providerAccess, routeAuthorityDigest: digest("9") } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      providerAccess: { ...value.providerAccess, credentialBindingDigest: digest("9") } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      providerAccess: { ...value.providerAccess, routeGeneration: "route-generation-2" } }),
    (value: ReturnType<typeof harness>["state"]["authority"]) => ({ ...value,
      providerAccess: { ...value.providerAccess, credentialGeneration: "credential-generation-2" } }),
  ];
  for (const mutate of mutations) {
    const setup = harness();
    const provisional = await authorizeProvisional(setup.gateway);
    setup.state.authority = mutate(setup.state.authority);
    const result = await setup.gateway.authorizeFirstApplicationByte(finalInput(provisional));
    assert.equal(result.status, "denied");
    if (result.status === "denied") {assert.equal(result.evidence.issueCode, "authority_drift");}
  }
});

test("missing, denied, throwing, malformed, and revoked owner reads fail closed", async () => {
  for (const outcome of [
    { status: "denied", reason: "policy_not_found" },
    { status: "denied", reason: "policy_denied" },
    { status: "denied", reason: "route_unavailable" },
    { status: "indeterminate", reason: "owner_unavailable" },
  ] as const) {
    const setup = harness();
    setup.state.resolveOutcome = outcome;
    assert.equal((await setup.gateway.requestProvisional(provisionalInput())).status, "denied");
  }
  const throwing = harness();
  throwing.state.resolveThrows = true;
  assert.equal((await throwing.gateway.requestProvisional(provisionalInput())).status, "denied");
  const malformed = harness();
  malformed.state.resolveOutcome = { status: "current", authority: {
    ...malformed.state.authority, extra: true,
  } } as never;
  assert.equal((await malformed.gateway.requestProvisional(provisionalInput())).status, "denied");
  const revoked = harness();
  revoked.state.authority = { ...revoked.state.authority,
    policy: { ...revoked.state.authority.policy, revoked: true } };
  const denied = await revoked.gateway.requestProvisional(provisionalInput());
  assert.equal(denied.status, "denied");
  if (denied.status === "denied") {assert.equal(denied.evidence.issueCode, "revoked");}

  const currentFailure = harness();
  const provisional = await authorizeProvisional(currentFailure.gateway);
  currentFailure.state.currentThrows = true;
  assert.equal((await currentFailure.gateway.authorizeFirstApplicationByte(
    finalInput(provisional))).status, "denied");
});

test("clock identity, process epoch, expiry, and monotonic regression are authoritative", async () => {
  const restarted = harness();
  const old = await authorizeProvisional(restarted.gateway);
  restarted.clock.epoch = "process-epoch-2";
  const oldEpoch = await restarted.gateway.authorizeFirstApplicationByte(finalInput(old));
  assert.equal(oldEpoch.status, "denied");
  if (oldEpoch.status === "denied") {assert.equal(oldEpoch.evidence.issueCode, "clock_epoch_mismatch");}

  const identity = harness();
  const identityDecision = await authorizeProvisional(identity.gateway);
  identity.clock.authorityId = "clock-authority-2";
  assert.equal((await identity.gateway.authorizeFirstApplicationByte(
    finalInput(identityDecision))).status, "denied");

  const regression = harness();
  const regressionDecision = await authorizeProvisional(regression.gateway);
  regression.clock.controlTime = 999;
  const regressed = await regression.gateway.authorizeFirstApplicationByte(finalInput(regressionDecision));
  assert.equal(regressed.status, "denied");
  if (regressed.status === "denied") {
    assert.equal(regressed.evidence.issueCode, "control_time_regressed");
  }

  const expired = harness();
  const expiring = await authorizeProvisional(expired.gateway);
  expired.clock.controlTime = 1_100;
  const expiry = await expired.gateway.authorizeFirstApplicationByte(finalInput(expiring));
  assert.equal(expiry.status, "denied");
  if (expiry.status === "denied") {assert.equal(expiry.evidence.issueCode, "expired");}
  assert.deepEqual(Object.keys(expired.clock).toSorted(),
    ["authorityId", "controlTime", "epoch"].toSorted());
});

test("exact HTTP/1.1 request projection mutations deny and H2/H3 remain typed unsupported", async () => {
  const setup = harness();
  const provisional = await authorizeProvisional(setup.gateway);
  const original = requestProjection();
  const mutations = [
    { method: "GET" }, { scheme: "https", authority: { hostname: "other.example.com", port: 443 } },
    { authority: { hostname: "api.example.com", port: 8443 } }, { pathAndQuery: "/other" },
    { headers: { ...original.headers, canonicalDigest: digest("9") } },
    { headers: { ...original.headers, fieldCount: 5 } },
    { headers: { ...original.headers, credentialFields: [{ ...original.headers.credentialFields[0]!,
      valueDigest: digest("9") }] } },
    { body: { ...original.body, digest: digest("9") } },
    { body: { ...original.body, byteLength: 127 } },
    { framing: { ...original.framing, contentLength: 127 } },
  ] as const;
  for (const mutation of mutations) {
    const result = await setup.gateway.authorizeFirstApplicationByte(finalInput(provisional, {
      request: { ...original, ...mutation } as never,
    }));
    assert.equal(result.status, "denied");
  }
  for (const protocol of ["h2", "h3"] as const) {
    const request = requestProjection({ framing: { ...original.framing, protocol } });
    const result = await harness({ initialAuthority: undefined }).gateway.requestProvisional(
      provisionalInput({ request }));
    assert.equal(result.status, "denied");
    if (result.status === "denied") {assert.equal(result.evidence.issueCode, "unsupported_protocol");}
  }
  for (const framing of [
    { transferEncoding: "present" }, { connectionSpecificHeaders: "present" },
    { requestTarget: "pseudo-headers" }, { authoritySource: ":authority" }, { contentLength: null },
  ] as const) {
    const request = requestProjection({ framing: { ...original.framing, ...framing } as never });
    const result = await harness().gateway.requestProvisional(provisionalInput({ request }));
    assert.equal(result.status, "denied");
  }
});

test("address, peer, TLS, certificate, ALPN, and redirect observations fail closed", async () => {
  const changes = [
    { pinnedDestination: { address: "8.8.8.8", port: 443 } },
    { pinnedDestination: { address: "93.184.216.34", port: 8443 } },
    { observedPeer: { address: "8.8.8.8", port: 443 } },
    { observedPeer: { address: "93.184.216.34", port: 8443 } },
  ];
  for (const change of changes) {
    const setup = harness();
    const provisional = await authorizeProvisional(setup.gateway);
    assert.equal((await setup.gateway.authorizeFirstApplicationByte(
      finalInput(provisional, change))).status, "denied");
  }
  const tlsChanges = [
    { sniHostname: "other.example.com" }, { certificateValidated: false },
    { dnsIdentity: "other.example.com" }, { certificateDigest: "not-a-digest" },
    { tlsPolicyDigest: digest("9") }, { alpn: "h2" },
  ] as const;
  for (const change of tlsChanges) {
    const setup = harness();
    const provisional = await authorizeProvisional(setup.gateway);
    const base = finalInput(provisional);
    assert.equal((await setup.gateway.authorizeFirstApplicationByte(finalInput(provisional, {
      tls: { ...base.tls, ...change } as never,
    }))).status, "denied");
  }
  const redirected = harness();
  const provisional = await authorizeProvisional(redirected.gateway);
  assert.equal((await redirected.gateway.authorizeFirstApplicationByte(
    finalInput(provisional, { redirectHop: 1 }))).status, "denied");
});

test("mutating each critical final signed field invalidates the final signature", async () => {
  const setup = harness();
  const provisional = await authorizeProvisional(setup.gateway);
  const outcome = await setup.gateway.authorizeFirstApplicationByte(finalInput(provisional));
  assert.equal(outcome.status, "authorized");
  if (outcome.status !== "authorized") {return;}
  const payload = outcome.grant.payload;
  const mutations = [
    { ...payload, authorityRef: "authority-2" },
    { ...payload, scope: { ...payload.scope, tenantId: "tenant-2" } },
    { ...payload, policy: { ...payload.policy, policyGeneration: "policy-generation-2" } },
    { ...payload, policy: { ...payload.policy, signingKey: { ...payload.policy.signingKey,
      keyGeneration: "key-generation-2" } } },
    { ...payload, providerAccess: { ...payload.providerAccess,
      credentialGeneration: "credential-generation-2" } },
    { ...payload, resolver: { ...payload.resolver, normalizedAddresses: [{
      family: "ipv4", address: "8.8.8.8", classification: "public",
    }] } },
    { ...payload, selectedPeer: { ...payload.selectedPeer, port: 8443 } },
    { ...payload, tls: { ...payload.tls, certificateDigest: digest("9") } },
    { ...payload, tls: { ...payload.tls, alpn: "h2" } },
    { ...payload, limits: { ...payload.limits, responseBytes: 9_999 } },
    { ...payload, request: { ...payload.request, headers: { ...payload.request.headers,
      canonicalDigest: digest("9") } } },
    { ...payload, request: { ...payload.request, body: { ...payload.request.body,
      byteLength: 127 } } },
    { ...payload, time: { ...payload.time, expiresAtControlTime: 1_101 } },
    { ...payload, time: { ...payload.time, epoch: "process-epoch-2" } },
    { ...payload, consumption: { ...payload.consumption, journalKey: {
      ...payload.consumption.journalKey, tenantId: "tenant-2" } } },
  ];
  const digestPort = createNodeSha256EgressDigest();
  for (const mutation of mutations) {
    const changedDigest = digestPort.digest(canonical(mutation));
    assert.notEqual(changedDigest, outcome.grant.finalAuthorizationDigest);
    assert.equal(setup.seal.verify(changedDigest, outcome.grant.signature), false);
  }
  assert.equal(setup.seal.verify(outcome.grant.finalAuthorizationDigest, {
    ...outcome.grant.signature, keyGeneration: "key-generation-2",
  }), false);
});

test("tenant/project/operation journal namespace separates the same boundary use", async () => {
  const first = await grantForTenant("tenant-1");
  const second = await grantForTenant("tenant-2");
  assert.notDeepEqual(first.journalKey, second.journalKey);
  assert.notEqual(first.requestFingerprint, second.requestFingerprint);
});

test("special-use IPv6 is denied conservatively and ordinary global unicast is accepted", async () => {
  const denied = ["2001::1", "2001:2::1", "2001:db8::1", "2002::1",
    "2620:4f:8000::1", "3fff::1", "::ffff:7f00:1", "fc00::1", "fe80::1", "ff02::1"];
  for (const address of denied) {
    const setup = harness();
    const provisional = await authorizeProvisional(setup.gateway);
    const input = finalInput(provisional, { resolver: { resolverIdentity: "resolver-1",
      resolverEpoch: "resolver-epoch-1", resolutionCount: 1,
      addresses: [{ family: "ipv6", address, classification: "public" }] },
      pinnedDestination: { address, port: 443 }, observedPeer: { address, port: 443 } });
    assert.equal((await setup.gateway.authorizeFirstApplicationByte(input)).status, "denied", address);
  }
  const setup = harness();
  const provisional = await authorizeProvisional(setup.gateway);
  const address = "2606:2800:220:1:248:1893:25c8:1946";
  const allowed = await setup.gateway.authorizeFirstApplicationByte(finalInput(provisional, {
    resolver: { resolverIdentity: "resolver-1", resolverEpoch: "resolver-epoch-1", resolutionCount: 1,
      addresses: [{ family: "ipv6", address, classification: "public" }] },
    pinnedDestination: { address, port: 443 }, observedPeer: { address, port: 443 },
  }));
  assert.equal(allowed.status, "authorized");
});

test("the dormant default route and Agent Execution seven-port composition remain unchanged", () => {
  const root = new URL("../../../../", import.meta.url);
  const readiness = readFileSync(new URL("docs/architecture/readiness.md", root), "utf8");
  assert.match(readiness, /route-enforcement-unqualified/);
  const factory = readFileSync(
    new URL("packages/contexts/agent-execution/src/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.ts", root),
    "utf8",
  );
  const keys = ["operationStore", "security", "providerAccess", "workspace", "artifacts", "custody",
    "provider"];
  for (const key of keys) {assert.match(factory, new RegExp(`readonly ${key}:`));}
  assert.equal(factory.includes("egressAuthorityOwner"), false);
});
