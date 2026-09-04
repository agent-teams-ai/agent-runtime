import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createNodeSha256EgressDigest } from "../dist/composition.js";
import {
  assertDeepFrozen, authorityFor, authorizeProvisional, canonical, digest, finalInput, harness,
  provisionalInput, requestProjection, scope,
} from "./provider-process-egress-authorization.fixtures.ts";

const grantForTenant = async (tenantId: string) => {
  const setup = harness({ boundScope: scope(tenantId) });
  const provisional = await authorizeProvisional(setup.gateway);
  const outcome = await setup.gateway.authorizeFirstApplicationByte(finalInput(provisional));
  assert.equal(outcome.status, "authorized");
  if (outcome.status !== "authorized") {throw new Error("expected grant");}
  return outcome.grant.payload.consumption;
};

type ChangedGrantFact = "none" | "policy" | "key" | "route" | "credential" |
  "peer" | "tls" | "clock" | "expiry";
const grantWithChangedFacts = async (change: ChangedGrantFact) => {
  const request = change === "credential" ? requestProjection({ headers: {
    ...requestProjection().headers, credentialFields: [{
      ...requestProjection().headers.credentialFields[0]!,
      credentialBindingDigest: digest("9"),
    }],
  } }) : requestProjection();
  let authority = authorityFor(request);
  if (change === "policy") {authority = { ...authority,
    policy: { ...authority.policy, policyRevision: "policy-revision-2" } };}
  if (change === "key") {authority = { ...authority, policy: { ...authority.policy,
    signingKey: { ...authority.policy.signingKey, keyGeneration: "key-generation-2" } } };}
  if (change === "route") {authority = { ...authority, providerAccess: {
    ...authority.providerAccess, routeGeneration: "route-generation-2" } };}
  if (change === "credential") {authority = { ...authority, providerAccess: {
    ...authority.providerAccess, credentialBindingDigest: digest("9"),
    credentialGeneration: "credential-generation-2" } };}
  if (change === "expiry") {authority = { ...authority, policy: {
    ...authority.policy, decisionTtlMilliseconds: 101 } };}
  const setup = harness({ initialAuthority: authority });
  const provisional = await authorizeProvisional(setup.gateway, provisionalInput({ request }));
  if (change === "clock") {setup.clock.controlTime = 1_001;}
  const network = change === "peer" ? {
    resolver: { resolverIdentity: "resolver-1", resolverEpoch: "resolver-epoch-1",
      resolutionCount: 1, addresses: [{ family: "ipv4" as const, address: "8.8.8.8",
        classification: "public" as const }] },
    pinnedDestination: { address: "8.8.8.8", port: 443 },
    observedPeer: { address: "8.8.8.8", port: 443 },
  } : {};
  const base = finalInput(provisional, network);
  const input = change === "tls" ? finalInput(provisional, {
    tls: { ...base.tls, certificateDigest: digest("9") },
  }) : base;
  const result = await setup.gateway.authorizeFirstApplicationByte(input);
  assert.equal(result.status, "authorized", change);
  if (result.status !== "authorized") {throw new Error(`denied ${change}`);}
  return result.grant.payload.consumption;
};

const authorizeTargetCommitment = async (requestTarget: {
  readonly digest: string;
  readonly byteLength: number;
}) => {
  const request = requestProjection({ requestTarget });
  const setup = harness({ initialAuthority: authorityFor(request) });
  const provisional = await authorizeProvisional(setup.gateway, provisionalInput({ request }));
  assert.equal(provisional.policy.authorizedRequestDigest, provisional.requestDigest);
  const final = await setup.gateway.authorizeFirstApplicationByte(finalInput(provisional));
  assert.equal(final.status, "authorized");
  if (final.status !== "authorized") {throw new Error("expected target-bound grant");}
  return { requestDigest: provisional.requestDigest, decisionDigest: provisional.decisionDigest,
    finalDigest: final.grant.finalAuthorizationDigest,
    fingerprint: final.grant.payload.consumption.requestFingerprint };
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

test("fixed V1 serializers bind consumption, grant, and derived compact evidence", async () => {
  const setup = harness();
  const provisional = await authorizeProvisional(setup.gateway);
  const result = await setup.gateway.authorizeFirstApplicationByte(finalInput(provisional));
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {return;}
  const digestPort = createNodeSha256EgressDigest();
  const { requestFingerprint: _requestFingerprint, ...consumption } =
    result.grant.payload.consumption;
  const consumptionPreimage = { ...result.grant.payload, consumption };
  assert.deepEqual(Object.keys(consumptionPreimage), Object.keys(result.grant.payload));
  assert.deepEqual(Object.keys(consumption), ["owner", "journalKey"]);
  assert.equal(result.grant.payload.consumption.requestFingerprint,
    digestPort.digest(canonical(consumptionPreimage)));
  const signingDocument = { payload: result.grant.payload,
    evidence: { contractVersion: "provider-process-egress-grant-evidence/v1" } };
  const recomputed = digestPort.digest(canonical(signingDocument));
  assert.equal(result.grant.finalAuthorizationDigest, recomputed);
  assert.equal(setup.seal.verify(recomputed, result.grant.signature), true);
  assert.equal(result.grant.payload.redirectHop, 0);
  assert.equal(result.grant.payload.provisionalDecisionDigest, provisional.decisionDigest);
  assert.deepEqual(result.grant.payload.resolver.normalizedAddresses, [
    { family: "ipv4", address: "93.184.216.34", classification: "public" },
  ]);
  assert.deepEqual(result.grant.payload.consumption.journalKey, {
    namespace: "provider-process-egress/v1", tenantId: "tenant-1", projectId: "project-1",
    operationId: "operation-1", boundaryUseId: "boundary-use-1",
  });
  assert.deepEqual(result.grant.evidence, {
    contractVersion: "provider-process-egress-grant-evidence/v1",
    authorizationRef: result.grant.payload.authorizationRequestId,
    boundaryUseRef: result.grant.payload.boundaryUseId,
    decisionDigest: result.grant.payload.provisionalDecisionDigest,
    finalAuthorizationDigest: result.grant.finalAuthorizationDigest,
  });
  const hypotheticalV2Preimage = { ...consumptionPreimage,
    contractVersion: "provider-process-first-application-byte-grant/v2" };
  assert.notEqual(digestPort.digest(canonical(hypotheticalV2Preimage)),
    result.grant.payload.consumption.requestFingerprint);
  assertDeepFrozen(result);
  const evidence = JSON.stringify(result.grant.evidence);
  assert.equal(evidence.includes("/v1/messages"), false);
  assert.equal(evidence.includes("authorization"), true);
  assert.equal(JSON.stringify(result.grant).includes("synthetic-only"), false);
});

test("request-target digest and length bind owner policy, provisional, final, and consumption identity", async () => {
  const baseline = await authorizeTargetCommitment({ digest: digest("a"), byteLength: 24 });
  const changedDigest = await authorizeTargetCommitment({ digest: digest("b"), byteLength: 24 });
  const changedLength = await authorizeTargetCommitment({ digest: digest("a"), byteLength: 25 });
  for (const changed of [changedDigest, changedLength]) {
    assert.notEqual(changed.requestDigest, baseline.requestDigest);
    assert.notEqual(changed.decisionDigest, baseline.decisionDigest);
    assert.notEqual(changed.finalDigest, baseline.finalDigest);
    assert.notEqual(changed.fingerprint, baseline.fingerprint);
  }
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
  const resolveThrown = await throwing.gateway.requestProvisional(provisionalInput());
  assert.equal(resolveThrown.status, "denied");
  if (resolveThrown.status === "denied") {
    assert.equal(resolveThrown.evidence.issueCode, "owner_unavailable");
  }
  const malformed = harness();
  malformed.state.resolveOutcome = { status: "current", authority: {
    ...malformed.state.authority, extra: true,
  } } as never;
  const resolveMalformed = await malformed.gateway.requestProvisional(provisionalInput());
  assert.equal(resolveMalformed.status, "denied");
  if (resolveMalformed.status === "denied") {
    assert.equal(resolveMalformed.evidence.issueCode, "owner_malformed");
  }
  const revoked = harness();
  revoked.state.authority = { ...revoked.state.authority,
    policy: { ...revoked.state.authority.policy, revoked: true } };
  const denied = await revoked.gateway.requestProvisional(provisionalInput());
  assert.equal(denied.status, "denied");
  if (denied.status === "denied") {assert.equal(denied.evidence.issueCode, "revoked");}

  const currentFailure = harness();
  const provisional = await authorizeProvisional(currentFailure.gateway);
  currentFailure.state.currentThrows = true;
  const currentThrown = await currentFailure.gateway.authorizeFirstApplicationByte(
    finalInput(provisional));
  assert.equal(currentThrown.status, "denied");
  if (currentThrown.status === "denied") {
    assert.equal(currentThrown.evidence.issueCode, "owner_unavailable");
  }

  const malformedCurrent = harness();
  const malformedCurrentProvisional = await authorizeProvisional(malformedCurrent.gateway);
  malformedCurrent.state.currentOutcome = { status: "current", authority: {
    ...malformedCurrent.state.authority, extra: true,
  } } as never;
  const currentMalformed = await malformedCurrent.gateway.authorizeFirstApplicationByte(
    finalInput(malformedCurrentProvisional));
  assert.equal(currentMalformed.status, "denied");
  if (currentMalformed.status === "denied") {
    assert.equal(currentMalformed.evidence.issueCode, "owner_malformed");
  }
});

test("consumption identity binds all final grant facts and is deterministic for identical facts", async () => {
  const baseline = await grantWithChangedFacts("none");
  assert.deepEqual(await grantWithChangedFacts("none"), baseline);
  for (const change of ["policy", "key", "route", "credential", "peer", "tls", "clock",
    "expiry"] as const) {
    const changed = await grantWithChangedFacts(change);
    assert.deepEqual(changed.journalKey, baseline.journalKey, change);
    assert.notEqual(changed.requestFingerprint, baseline.requestFingerprint, change);
  }
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
    { authority: { hostname: "api.example.com", port: 8443 } },
    { requestTarget: { digest: digest("9"), byteLength: 24 } },
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
  const rejectedRedirect = await redirected.gateway.authorizeFirstApplicationByte(
    finalInput(provisional, { redirectHop: 1 }));
  assert.equal(rejectedRedirect.status, "denied");
  assert.equal(redirected.state.currentCalls.length, 0);
});

test("mutating each critical final signed field invalidates the final signature", async () => {
  const setup = harness();
  const provisional = await authorizeProvisional(setup.gateway);
  const outcome = await setup.gateway.authorizeFirstApplicationByte(finalInput(provisional));
  assert.equal(outcome.status, "authorized");
  if (outcome.status !== "authorized") {return;}
  const payload = outcome.grant.payload;
  const mutations = [
    { ...payload, contractVersion: "provider-process-first-application-byte-grant/v2" },
    { ...payload, authorizationRequestId: "authorization-2" },
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
    { ...payload, resolver: { ...payload.resolver, resolverEpoch: "resolver-epoch-2" } },
    { ...payload, selectedPeer: { ...payload.selectedPeer, port: 8443 } },
    { ...payload, tls: { ...payload.tls, certificateDigest: digest("9") } },
    { ...payload, tls: { ...payload.tls, alpn: "h2" } },
    { ...payload, limits: { ...payload.limits, responseBytes: 9_999 } },
    { ...payload, request: { ...payload.request, headers: { ...payload.request.headers,
      canonicalDigest: digest("9") } } },
    { ...payload, request: { ...payload.request,
      requestTarget: { ...payload.request.requestTarget, byteLength: 25 } } },
    { ...payload, request: { ...payload.request, body: { ...payload.request.body,
      byteLength: 127 } } },
    { ...payload, requestDigest: digest("9") },
    { ...payload, time: { ...payload.time, expiresAtControlTime: 1_101 } },
    { ...payload, time: { ...payload.time, epoch: "process-epoch-2" } },
    { ...payload, boundaryUseId: "boundary-use-2" },
    { ...payload, connectionAttemptId: "connection-2" },
    { ...payload, streamId: "stream-2" },
    { ...payload, redirectHop: 1 },
    { ...payload, provisionalDecisionDigest: digest("9") },
    { ...payload, automaticRetryAuthorized: true },
    { ...payload, poolingAuthorized: true },
    { ...payload, consumption: { ...payload.consumption, journalKey: {
      ...payload.consumption.journalKey, tenantId: "tenant-2" } } },
  ];
  const digestPort = createNodeSha256EgressDigest();
  for (const mutation of mutations) {
    const changedDigest = digestPort.digest(canonical({ payload: mutation,
      evidence: { contractVersion: "provider-process-egress-grant-evidence/v1" } }));
    assert.notEqual(changedDigest, outcome.grant.finalAuthorizationDigest);
    assert.equal(setup.seal.verify(changedDigest, outcome.grant.signature), false);
  }
  assert.equal(setup.seal.verify(outcome.grant.finalAuthorizationDigest, {
    ...outcome.grant.signature, keyGeneration: "key-generation-2",
  }), false);
});

test("every compact evidence substitution is detected from authenticated values", async () => {
  const setup = harness();
  const provisional = await authorizeProvisional(setup.gateway);
  const outcome = await setup.gateway.authorizeFirstApplicationByte(finalInput(provisional));
  assert.equal(outcome.status, "authorized");
  if (outcome.status !== "authorized") {return;}
  const { grant } = outcome;
  const matches = (evidence: typeof grant.evidence): boolean => {
    const documentDigest = createNodeSha256EgressDigest().digest(canonical({ payload: grant.payload,
      evidence: { contractVersion: evidence.contractVersion } }));
    return evidence.contractVersion === "provider-process-egress-grant-evidence/v1" &&
      evidence.authorizationRef === grant.payload.authorizationRequestId &&
      evidence.boundaryUseRef === grant.payload.boundaryUseId &&
      evidence.decisionDigest === grant.payload.provisionalDecisionDigest &&
      evidence.finalAuthorizationDigest === grant.finalAuthorizationDigest &&
      documentDigest === grant.finalAuthorizationDigest &&
      setup.seal.verify(documentDigest, grant.signature);
  };
  assert.equal(matches(grant.evidence), true);
  for (const evidence of [
    { ...grant.evidence, contractVersion: "provider-process-egress-grant-evidence/v2" },
    { ...grant.evidence, authorizationRef: "authorization-2" },
    { ...grant.evidence, boundaryUseRef: "boundary-use-2" },
    { ...grant.evidence, decisionDigest: digest("9") },
    { ...grant.evidence, finalAuthorizationDigest: digest("9") },
  ]) {
    assert.equal(matches(evidence as typeof grant.evidence), false);
  }
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
