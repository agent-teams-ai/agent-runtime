import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  assertDeepFrozen, authorizeProvisional, digest, feature, finalInput, provisionalInput,
  setControlTime,
} from "./provider-process-egress-authorization.fixtures.ts";

beforeEach(() => setControlTime(1_000));

test("provisional decision binds the complete authority and redacted canonical request intent", () => {
  const input = provisionalInput();
  const decision = authorizeProvisional();
  assert.equal(decision.scope.operationId, input.scope.operationId);
  assert.deepEqual(decision.providerRoute, input.providerRoute);
  assert.deepEqual(decision.generations, input.generations);
  assert.deepEqual(decision.origin, input.origin);
  assert.deepEqual(decision.resolverAuthority, input.resolverAuthority);
  assert.equal("addresses" in decision.resolverAuthority, false);
  assert.deepEqual(decision.certificate, input.certificate);
  assert.deepEqual(decision.budgets, input.budgets);
  assert.match(decision.requestIntentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(decision).includes(input.requestIntent.pathAndQuery), false);
  assertDeepFrozen(decision);
});

test("final authorization is pure and requires Host's durable first-byte consumption latch", () => {
  const authority = feature();
  const provisional = authorizeProvisional(authority);
  const result = authority.authorizeFirstApplicationByte(finalInput(provisional));
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {return;}
  assert.equal(result.grant.authority, "runtime-security-final-authorization-only");
  assert.equal(result.grant.poolingAuthorized, false);
  assert.equal(result.grant.automaticRetryAuthorized, false);
  assert.deepEqual(result.grant.consumption, {
    owner: "host-custody",
    latch: "durable-one-use-first-byte-journal",
    requiredBeforeFirstByte: true,
    grantProvesBytesSent: false,
    exactReplay: "return-original-durable-outcome",
    conflictingReplay: "fail-closed",
    journalKey: result.grant.boundaryUseId,
    requestFingerprint: result.grant.finalAuthorizationDigest,
  });
  assert.match(result.grant.finalAuthorizationDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.grant.scope, provisional.scope);
  assert.deepEqual(result.grant.providerRoute, provisional.providerRoute);
  assert.deepEqual(result.grant.generations, provisional.generations);
  assert.equal(result.grant.resolver.resolverIdentity, provisional.resolverAuthority.resolverIdentity);
  assert.match(result.grant.resolver.addressSetDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.grant.selectedPeer, { address: "93.184.216.34", port: 443 });
  assert.equal(result.grant.sniHostname, "api.example.com");
  assert.deepEqual(result.grant.certificate, provisional.certificate);
  assert.equal(result.grant.alpn, "h2");
  assert.deepEqual(result.grant.budgets, provisional.budgets);
  assertDeepFrozen(result);
  const serializedEvidence = JSON.stringify(result.grant.evidence);
  assert.equal(serializedEvidence.includes("/v1/"), false);
  assert.equal(serializedEvidence.includes("1000"), false);
  assert.equal(serializedEvidence.includes("synthetic-only"), false);
  assert.equal(JSON.stringify(result.grant).includes("/v1/messages"), false);
});

test("every current owner fact fails closed independently", () => {
  const cases = [
    ["scope_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, scope: { ...input.currentAuthority.scope,
        operationId: "operation-2" } } })],
    ["scope_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, scope: { ...input.currentAuthority.scope,
        tenantId: "tenant-2" } } })],
    ["scope_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, scope: { ...input.currentAuthority.scope,
        projectId: "project-2" } } })],
    ["scope_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, scope: { ...input.currentAuthority.scope,
        scopeDigest: digest("9") } } })],
    ["provider_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, providerRoute: {
        ...input.currentAuthority.providerRoute, providerRef: "provider-2" } } })],
    ["account_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, providerRoute: {
        ...input.currentAuthority.providerRoute, accountRef: "account-2" } } })],
    ["route_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, providerRoute: {
        ...input.currentAuthority.providerRoute, routeRef: "route-2" } } })],
    ["route_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, providerRoute: {
        ...input.currentAuthority.providerRoute, routeDigest: digest("9") } } })],
    ["credential_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, providerRoute: {
        ...input.currentAuthority.providerRoute, credentialBindingDigest: digest("9") } } })],
    ["policy_generation_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, generations: {
        ...input.currentAuthority.generations, policy: "policy-2" } } })],
    ["key_generation_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, generations: {
        ...input.currentAuthority.generations, key: "key-2" } } })],
    ["route_generation_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, generations: {
        ...input.currentAuthority.generations, route: "route-generation-2" } } })],
    ["credential_generation_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, generations: {
        ...input.currentAuthority.generations, credential: "credential-2" } } })],
    ["revoked", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, revoked: true } })],
    ["budget_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, budgets: {
        ...input.currentAuthority.budgets, requestBytes: 999 } } })],
    ["budget_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, budgets: {
        ...input.currentAuthority.budgets, responseBytes: 999 } } })],
    ["budget_mismatch", (input: ReturnType<typeof finalInput>) => ({ ...input,
      currentAuthority: { ...input.currentAuthority, budgets: {
        ...input.currentAuthority.budgets, totalMilliseconds: 999 } } })],
  ] as const;
  for (const [expected, mutate] of cases) {
    const authority = feature();
    const provisional = authorizeProvisional(authority);
    const result = authority.authorizeFirstApplicationByte(mutate(finalInput(provisional)) as never);
    assert.equal(result.status, "denied", expected);
    if (result.status === "denied") {assert.equal(result.evidence.issueCode, expected);}
  }
});

test("rotation, revocation, and expiry after queue wait return no first-byte grant", () => {
  const authority = feature();
  const provisional = authorizeProvisional(authority);
  setControlTime(1_100);
  const expired = authority.authorizeFirstApplicationByte(finalInput(provisional));
  assert.deepEqual(expired.status, "denied");
  if (expired.status === "denied") {assert.equal(expired.evidence.issueCode, "expired");}
  assert.equal("grant" in expired, false);
});

test("the single post-provisional resolution rejects duplicate, mixed and non-public addresses", () => {
  const authority = feature();
  const provisional = authorizeProvisional(authority);
  for (const addresses of [
    [{ family: "ipv4", address: "10.0.0.1", classification: "private" }],
    [{ family: "ipv4", address: "127.0.0.1", classification: "public" }],
    [{ family: "ipv4", address: "169.254.1.1", classification: "link-local" }],
    [{ family: "ipv4", address: "169.254.169.254", classification: "metadata" }],
    [{ family: "ipv4", address: "192.88.99.1", classification: "public" }],
    [{ family: "ipv4", address: "224.0.0.1", classification: "multicast" }],
    [{ family: "ipv4", address: "0.0.0.0", classification: "unspecified" }],
    [{ family: "ipv6", address: "fc00::1", classification: "ula" }],
    [{ family: "ipv6", address: "fe80::1", classification: "link-local" }],
    [{ family: "ipv6", address: "ff02::1", classification: "multicast" }],
    [{ family: "ipv6", address: "::", classification: "unspecified" }],
    [{ family: "ipv6", address: "::1", classification: "loopback" }],
    [{ family: "ipv6", address: "100::1", classification: "public" }],
    [{ family: "ipv4", address: "93.184.216.34", classification: "public" },
      { family: "ipv4", address: "93.184.216.34", classification: "public" }],
    [{ family: "ipv4", address: "93.184.216.34", classification: "public" },
      { family: "ipv6", address: "2606:2800:220:1:248:1893:25c8:1946", classification: "public" }],
    [{ family: "ipv6", address: "::ffff:7f00:1", classification: "mapped" }],
  ] as const) {
    const result = authority.authorizeFirstApplicationByte(finalInput(provisional, { resolver: {
      ...finalInput(provisional).resolver, addresses } }));
    assert.equal(result.status, "denied");
  }
  const second = authority.authorizeFirstApplicationByte(finalInput(provisional, {
    resolver: { ...finalInput(provisional).resolver, resolutionCount: 2 } }));
  assert.equal(second.status, "denied");
  for (const change of [
    { currentAuthority: { ...finalInput(provisional).currentAuthority,
      resolverIdentity: "resolver-2" } },
    { currentAuthority: { ...finalInput(provisional).currentAuthority,
      resolverEpoch: "resolver-epoch-2" } },
    { resolver: { ...finalInput(provisional).resolver, resolverIdentity: "resolver-2" } },
    { resolver: { ...finalInput(provisional).resolver, resolverEpoch: "resolver-epoch-2" } },
  ]) {
    const mismatch = authority.authorizeFirstApplicationByte(finalInput(provisional, change));
    assert.equal(mismatch.status, "denied");
    if (mismatch.status === "denied") {assert.equal(mismatch.evidence.issueCode, "resolver_mismatch");}
  }
});

test("wrong pinned destination, peer, SNI, certificate, and ALPN deny", () => {
  const changes = [
    [{ pinnedDestination: { address: "8.8.8.8", port: 443 } }, "pinned_destination_mismatch"],
    [{ pinnedDestination: { address: "93.184.216.34", port: 8443 } },
      "pinned_destination_mismatch"],
    [{ observedPeer: { address: "8.8.8.8", port: 443 } }, "peer_mismatch"],
    [{ observedPeer: { address: "93.184.216.34", port: 8443 } }, "peer_mismatch"],
    [{ sniHostname: "other.example.com" }, "sni_mismatch"],
    [{ sniHostname: "API.EXAMPLE.COM" }, "sni_mismatch"],
    [{ certificate: { validated: false, dnsIdentity: "api.example.com",
      certificateDigest: digest("4") } }, "certificate_invalid"],
    [{ certificate: { validated: true, dnsIdentity: "api.example.com",
      certificateDigest: digest("8") } }, "certificate_mismatch"],
    [{ certificate: { validated: true, dnsIdentity: "other.example.com",
      certificateDigest: digest("4") } }, "certificate_mismatch"],
    [{ certificate: { validated: true, dnsIdentity: "API.EXAMPLE.COM",
      certificateDigest: digest("4") } }, "certificate_mismatch"],
    [{ alpn: "http/1.1" }, "alpn_mismatch"],
  ] as const;
  for (const [change, issue] of changes) {
    const authority = feature();
    const provisional = authorizeProvisional(authority);
    const result = authority.authorizeFirstApplicationByte(finalInput(provisional, change as never));
    assert.equal(result.status, "denied");
    if (result.status === "denied") {assert.equal(result.evidence.issueCode, issue);}
  }
});

test("redirects, H3/UDP, CONNECT, SOCKS, generic proxies and upgrades are unsupported", () => {
  const provisionalChanges = [
    [{ redirectHop: 1 }, "redirect_denied"],
    [{ requestIntent: { ...provisionalInput().requestIntent, applicationProtocol: "h3" } },
      "unsupported_protocol"],
    [{ requestIntent: { ...provisionalInput().requestIntent, transportMode: "connect" } },
      "unsupported_proxy"],
    [{ requestIntent: { ...provisionalInput().requestIntent, transportMode: "socks" } },
      "unsupported_proxy"],
    [{ requestIntent: { ...provisionalInput().requestIntent, transportMode: "generic-proxy" } },
      "unsupported_proxy"],
    [{ requestIntent: { ...provisionalInput().requestIntent, upgradeMode: "websocket" } },
      "unsupported_upgrade"],
  ] as const;
  for (const [change, issue] of provisionalChanges) {
    const result = feature().requestProvisional(provisionalInput(change as never));
    assert.equal(result.status, "denied");
    if (result.status === "denied") {assert.equal(result.evidence.issueCode, issue);}
  }
  const authority = feature();
  const provisional = authorizeProvisional(authority);
  const udp = authority.authorizeFirstApplicationByte(finalInput(provisional, {
    transport: "udp-quic", alpn: "h3" }));
  assert.equal(udp.status, "denied");
  if (udp.status === "denied") {assert.equal(udp.evidence.issueCode, "unsupported_transport");}
  const redirected = authority.authorizeFirstApplicationByte(finalInput(provisional, {
    redirectHop: 1 }));
  assert.equal(redirected.status, "denied");
  if (redirected.status === "denied") {assert.equal(redirected.evidence.issueCode, "redirect_denied");}
});

test("exact final replay is deterministic and conflicts are observable for Host's durable latch", () => {
  const authority = feature();
  const provisional = authorizeProvisional(authority);
  const first = finalInput(provisional);
  const original = authority.authorizeFirstApplicationByte(first);
  assert.equal(original.status, "authorized");
  const replay = authority.authorizeFirstApplicationByte(first);
  assert.deepEqual(replay, original);
  const conflict = authority.authorizeFirstApplicationByte(finalInput(provisional, {
    connectionAttemptId: "connection-2",
  }));
  assert.equal(conflict.status, "authorized");
  if (original.status !== "authorized" || conflict.status !== "authorized") {return;}
  assert.equal(conflict.grant.boundaryUseId, original.grant.boundaryUseId);
  assert.notEqual(conflict.grant.finalAuthorizationDigest, original.grant.finalAuthorizationDigest);
  assert.equal(conflict.grant.consumption.conflictingReplay, "fail-closed");
  assert.equal(conflict.grant.consumption.journalKey, original.grant.consumption.journalKey);
  assert.notEqual(conflict.grant.consumption.requestFingerprint,
    original.grant.consumption.requestFingerprint);
});

test("final fingerprint binds every use identity and the normalized selected peer", () => {
  const authority = feature();
  const provisional = authorizeProvisional(authority);
  const grant = (change: Parameters<typeof finalInput>[1] = {}) => {
    const outcome = authority.authorizeFirstApplicationByte(finalInput(provisional, change));
    assert.equal(outcome.status, "authorized");
    if (outcome.status !== "authorized") {throw new Error("expected final authorization");}
    return outcome.grant;
  };
  const original = grant();
  for (const change of [
    { boundaryUseId: "boundary-use-2" },
    { connectionAttemptId: "connection-2" },
    { streamId: "stream-2" },
  ]) {
    assert.notEqual(grant(change).finalAuthorizationDigest, original.finalAuthorizationDigest);
  }
  const secondPeer = grant({
    resolver: { ...finalInput(provisional).resolver, addresses: [
      { family: "ipv4", address: "8.8.8.8", classification: "public" },
      { family: "ipv4", address: "93.184.216.34", classification: "public" },
    ] },
    pinnedDestination: { address: "8.8.8.8", port: 443 },
    observedPeer: { address: "8.8.8.8", port: 443 },
  });
  assert.deepEqual(secondPeer.selectedPeer, { address: "8.8.8.8", port: 443 });
  assert.notEqual(secondPeer.resolver.addressSetDigest, original.resolver.addressSetDigest);
  assert.notEqual(secondPeer.finalAuthorizationDigest, original.finalAuthorizationDigest);
});

test("request intent and signed provisional mutation fail closed deterministically", () => {
  const authority = feature();
  const first = authorizeProvisional(authority);
  const second = authorizeProvisional(feature());
  assert.equal(first.requestIntentDigest, second.requestIntentDigest);
  assert.equal(first.decisionDigest, second.decisionDigest);
  const requestMismatch = authority.authorizeFirstApplicationByte(finalInput(first, {
    requestIntent: { ...provisionalInput().requestIntent, bodyDigest: digest("6") } }));
  assert.equal(requestMismatch.status, "denied");
  if (requestMismatch.status === "denied") {
    assert.equal(requestMismatch.evidence.issueCode, "request_intent_mismatch");
  }
  const tampered = { ...first, providerRoute: { ...first.providerRoute, routeRef: "route-tampered" } };
  const invalid = authority.authorizeFirstApplicationByte(finalInput(tampered));
  assert.equal(invalid.status, "denied");
  if (invalid.status === "denied") {assert.equal(invalid.evidence.issueCode, "provisional_digest_invalid");}
});

test("each exact request-intent field is bound and HTTP/1.1 remains representable", () => {
  const intentChanges = [
    { method: "GET" }, { pathAndQuery: "/v1/other" }, { bodyDigest: digest("6") },
    { mediaType: "application/cbor" }, { applicationProtocol: "http/1.1" },
  ] as const;
  for (const change of intentChanges) {
    const authority = feature();
    const provisional = authorizeProvisional(authority);
    const result = authority.authorizeFirstApplicationByte(finalInput(provisional, {
      requestIntent: { ...provisionalInput().requestIntent, ...change } }));
    assert.equal(result.status, "denied");
    if (result.status === "denied") {assert.ok([
      "request_intent_mismatch", "alpn_mismatch",
    ].includes(result.evidence.issueCode));}
  }
  const authority = feature();
  const input = provisionalInput({ requestIntent: { ...provisionalInput().requestIntent,
    applicationProtocol: "http/1.1" } });
  const provisionalResult = authority.requestProvisional(input);
  assert.equal(provisionalResult.status, "authorized");
  if (provisionalResult.status !== "authorized") {return;}
  const final = finalInput(provisionalResult.decision, { alpn: "http/1.1", requestIntent: input.requestIntent });
  assert.equal(authority.authorizeFirstApplicationByte(final).status, "authorized");
});
