import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  createNodeHmacEgressDecisionSeal,
  createNodeSha256EgressDigest,
  createProviderProcessEgressAuthorizationFeature,
} from "../dist/composition.js";
import {
  assertDeepFrozen, authorizeProvisional, feature, finalInput, provisionalInput, setControlTime,
} from "./provider-process-egress-authorization.fixtures.ts";

beforeEach(() => setControlTime(1_000));

test("boundary rejects extras, missing fields, malformed values, and prototype tricks", () => {
  const authority = feature();
  const candidates = [
    { ...provisionalInput(), unexpected: true },
    { ...provisionalInput(), origin: { hostname: "api.example.com", port: 443 } },
    { ...provisionalInput(), expiresAtControlTime: Number.NaN },
    { ...provisionalInput(), resolverAuthority: { ...provisionalInput().resolverAuthority,
      addresses: [] } },
    Object.assign(Object.create({ inherited: true }), provisionalInput()),
    { ...provisionalInput(), resolver: { ...provisionalInput().resolver,
      addresses: Array.from({ length: 1 }) } },
    { ...provisionalInput(), origin: { ...provisionalInput().origin, hostname: "127.0.0.1" } },
    { ...provisionalInput(), origin: { ...provisionalInput().origin, hostname: "8.8.8.8" } },
  ];
  for (const candidate of candidates) {
    const result = authority.requestProvisional(candidate as never);
    assert.equal(result.status, "denied");
    if (result.status === "denied") {
      assert.ok(["invalid_input", "origin_invalid"].includes(result.evidence.issueCode));
    }
  }
});

test("accessors and Proxy traps are rejected without invocation", () => {
  const authority = feature();
  let getterReads = 0;
  const accessor = { ...provisionalInput() } as Record<string, unknown>;
  Object.defineProperty(accessor, "origin", { enumerable: true, get() {
    getterReads += 1; return provisionalInput().origin;
  } });
  assert.equal(authority.requestProvisional(accessor as never).status, "denied");
  assert.equal(getterReads, 0);

  let proxyReads = 0;
  const proxy = new Proxy(provisionalInput(), {
    getOwnPropertyDescriptor(target, property) {
      proxyReads += 1; return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  assert.equal(authority.requestProvisional(proxy).status, "denied");
  assert.equal(proxyReads, 0);
});

test("cycles fail closed and never escape the boundary", () => {
  const input = provisionalInput() as unknown as Record<string, unknown>;
  input.resolverAuthority = input;
  const result = feature().requestProvisional(input as never);
  assert.equal(result.status, "denied");
  if (result.status === "denied") {assert.equal(result.evidence.issueCode, "invalid_input");}
});

test("inputs are detached before decisions and later caller mutation cannot alter authority", () => {
  const authority = feature();
  const input = provisionalInput();
  const sourceScope = input.scope as { tenantId: string };
  const sourceResolver = input.resolverAuthority as { resolverEpoch: string };
  const result = authority.requestProvisional(input);
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {return;}
  sourceScope.tenantId = "mutated-tenant";
  sourceResolver.resolverEpoch = "mutated-epoch";
  assert.equal(result.decision.scope.tenantId, "tenant-1");
  assert.equal(result.decision.resolverAuthority.resolverEpoch, "resolver-epoch-1");
  assertDeepFrozen(result);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(sourceScope), false);
});

test("hostile final DTOs cannot obtain a grant", () => {
  const authority = feature();
  const provisional = authorizeProvisional(authority);
  const valid = finalInput(provisional);
  for (const input of [
    { ...valid, extra: "authority" },
    { ...valid, provisional: { ...provisional, signature: {
      ...provisional.signature, value: "forged" } } },
    { ...valid, currentAuthority: { ...valid.currentAuthority, resolverEpoch: undefined } },
    { ...valid, observedAtControlTime: Number.POSITIVE_INFINITY },
  ]) {
    const result = authority.authorizeFirstApplicationByte(input as never);
    assert.equal(result.status, "denied");
    assert.equal("grant" in result, false);
    assertDeepFrozen(result);
  }
});

test("composition snapshots exact pure dependencies and rejects accessors and proxies", () => {
  const seal = createNodeHmacEgressDecisionSeal({ keyRef: "key", secret: "secret" });
  const valid = { clock: { now: () => 1_000 }, digest: createNodeSha256EgressDigest(),
    signer: seal, verifier: seal };
  assert.throws(() => createProviderProcessEgressAuthorizationFeature({ ...valid,
    ambientPolicy: {} } as never), TypeError);
  let reads = 0;
  const accessor = { ...valid } as Record<string, unknown>;
  Object.defineProperty(accessor, "clock", { enumerable: true, get() { reads += 1; return valid.clock; } });
  assert.throws(() => createProviderProcessEgressAuthorizationFeature(accessor as never), TypeError);
  assert.equal(reads, 0);
  const proxy = new Proxy(valid, {});
  assert.throws(() => createProviderProcessEgressAuthorizationFeature(proxy), TypeError);
});
