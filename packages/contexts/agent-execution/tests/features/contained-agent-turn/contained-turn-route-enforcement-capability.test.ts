import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTAINED_TURN_ROUTE_QUALIFICATION_DIMENSIONS, createContainedTurnRouteEnforcement,
  readContainedTurnRouteEnforcementTarget,
} from "../../../dist/features/contained-agent-turn/composition/contained-turn-route-enforcement-capability.js";
import {createContainedTurnRouteEnforcement as packedFactory} from "../../../dist/composition.js";

/** The pinned Codex Linux tuple the route owner admits. */
const binding = Object.freeze({
  tenantId: "tenant:test", projectId: "project:test", scopeDigest: "scope:test", operationId: "operation:test",
  attemptId: "attempt:test", custodyId: "custody:test", sourceRevision: "f80683e31aa329c4a1eb3347efa45eb93b452f32",
  binaryRevision: "@openai/codex:0.153.4+linux-x64", hostBootId: "boot:test", executionGenerationId: "generation:test",
  adapterRevision: "adapter:test", capabilityManifestRevision: "manifest:test", authorityVectorDigest: "authority:test",
  providerAccountRef: "account:test", accessRef: "access:test", bindingRevision: 3, credentialBindingRef: "credential:test",
  providerRouteRef: "route:test", routeRevision: "revision:1", credentialBindingDigest: "pa-opaque-binding:test",
  credentialGeneration: 7,
});
const pin = Object.freeze({path: "/usr/sbin/nft-that-does-not-exist", sha256: "a".repeat(64)});
const engine = Object.freeze({inspect: async () => {throw new Error("unreachable in this test");}});
const target = Object.freeze({
  provider: "openai-codex", providerAdapter: binding.adapterRevision, binaryClosure: binding.binaryRevision,
  platform: "linux-x64", credentialRoute: "provider-access-owned-material", storageTopology: "single-host-docker",
  transportTopology: "linux-exclusive-http-route", failureDomain: "single-host",
});
const mint = (overrides: Readonly<Record<string, unknown>> = {}) => createContainedTurnRouteEnforcement({
  binding, engine: engine as never, nsenter: pin, nft: pin,
  qualificationTarget: Object.freeze({...target, ...overrides}) as never,
});

test("the packed composition exports the same capability factory", () => {
  assert.equal(packedFactory, createContainedTurnRouteEnforcement);
  assert.deepEqual([...CONTAINED_TURN_ROUTE_QUALIFICATION_DIMENSIONS], [
    "provider", "providerAdapter", "binaryClosure", "platform", "credentialRoute",
    "storageTopology", "transportTopology", "failureDomain",
  ]);
});

test("a minted capability carries the promoted tuple and the route admission", () => {
  const capability = mint();
  assert.deepEqual(readContainedTurnRouteEnforcementTarget(capability), target);
  assert.equal(typeof capability.admission.admit, "function");
  assert.equal(typeof capability.admission.releaseAfterContainerRemoval, "function");
  assert.equal(Object.isFrozen(capability), true);
  // The resolved tuple is this module's own frozen copy, not the caller's object.
  assert.notEqual(readContainedTurnRouteEnforcementTarget(capability), target);
  assert.equal(Object.isFrozen(readContainedTurnRouteEnforcementTarget(capability)), true);
});

test("structural twins, proxies and copies of a capability carry no target", () => {
  const capability = mint();
  let reads = 0;
  const twin = Object.freeze({admission: capability.admission});
  const spread = Object.freeze({...capability});
  const wrapped = new Proxy(capability, {get() {reads += 1; throw new Error("must never be consulted");}});
  for (const impostor of [twin, spread, wrapped, {}, Object.create(null), undefined, null, "capability", 7,
    Object.freeze({admission: capability.admission, target}), capability.admission]) {
    assert.equal(readContainedTurnRouteEnforcementTarget(impostor), undefined);
  }
  assert.equal(reads, 0);
});

test("a tuple that is not one complete scalar tuple bound to the binding is refused", () => {
  for (const overrides of [
    {binaryClosure: "@openai/codex:0.150.1+linux-x64"},
    {providerAdapter: "some-other-adapter"},
    {provider: "*"}, {provider: "ANY"}, {provider: "all"},
    {provider: ""}, {provider: "provider with space"}, {provider: 7 as unknown as string},
  ]) {
    assert.throws(() => mint(overrides), TypeError, JSON.stringify(overrides));
  }
  assert.throws(() => createContainedTurnRouteEnforcement({
    binding, engine: engine as never, nsenter: pin, nft: pin,
    qualificationTarget: Object.freeze({...target, extra: "dimension"}) as never,
  }), TypeError);
  const missing: Record<string, unknown> = {...target};
  delete missing.failureDomain;
  assert.throws(() => createContainedTurnRouteEnforcement({
    binding, engine: engine as never, nsenter: pin, nft: pin, qualificationTarget: missing as never,
  }), TypeError);
  for (const invalid of [undefined, null, "target", 7]) {
    assert.throws(() => createContainedTurnRouteEnforcement({
      binding, engine: engine as never, nsenter: pin, nft: pin, qualificationTarget: invalid as never,
    }), TypeError);
  }
});

test("an accessor-backed tuple is refused rather than read twice", () => {
  const shifting = Object.create(null) as Record<string, unknown>;
  for (const dimension of CONTAINED_TURN_ROUTE_QUALIFICATION_DIMENSIONS) {
    Object.defineProperty(shifting, dimension, {enumerable: true, get: () => target[dimension]});
  }
  assert.throws(() => createContainedTurnRouteEnforcement({
    binding, engine: engine as never, nsenter: pin, nft: pin, qualificationTarget: shifting as never,
  }), TypeError);
});
