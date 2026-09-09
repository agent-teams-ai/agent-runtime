import assert from "node:assert/strict";
import {test} from "node:test";
import {createLinuxCodexLiveAdminRoute} from "./linux-codex-live-admin-route.ts";
import {policy} from "../../../../contexts/agent-execution/tests/fixtures/docker-engine-test-fixture.ts";
import {readContainedTurnRouteEnforcementTarget} from
  "../../../../contexts/agent-execution/dist/features/contained-agent-turn/composition/contained-turn-route-enforcement-capability.js";
import {snapshotRouteSelectionFacts} from
  "../../../../contexts/provider-access/dist/features/contained-turn-access/adapters/outbound/postgres/route-selection-data.js";
import type {LinuxCodexLivePins} from "./linux-codex-live-bootstrap.ts";

// Synthetic administration only. No setup, migration, engine observation or admission.
const fixture = () => {
  const route: LinuxCodexLivePins["route"] = {
    binding: {accessRef: "access:synthetic", availability: "available", bindingRevision: 1,
      credentialBindingDigest: "credential:digest:synthetic", credentialBindingRef: "credential:synthetic",
      credentialGeneration: 1, projectId: "project:synthetic", provider: "codex",
      providerAccountRef: "account:synthetic", providerRouteRef: "route:synthetic", revocation: "active",
      scopeDigest: "scope:synthetic", tenantId: "tenant:synthetic"},
    recipe: "codex-chatgpt", deadline: performance.now() + 60_000,
    operationAbortSignal: new AbortController().signal,
    descriptor: {id: "codex-chatgpt-responses/v1", provider: "codex", credentialMode: "chatgpt-account",
      originHost: "chatgpt.com", originPort: 443, upstreamMethod: "POST", upstreamPath: "/backend-api/codex/responses",
      credentialFieldNames: ["authorization", "chatgpt-account-id"],
      forwardedRequestHeaderNames: ["accept", "content-type", "user-agent", "originator", "version"],
      requiredHeaderNames: ["accept", "content-type", "user-agent", "originator", "version"],
      exactValues: {"content-type": "application/json", version: "0.153.4"}},
  };
  const {allowedNetworkName: _network, ...enginePolicy} = policy("/disposable/admin-route-synthetic");
  return {sourceRevision: "fb5cb195a4e0201c9efce1cfc741c5bb4822eced", route,
    hostBootId: "host-boot:synthetic", capabilityManifestRevision: "manifest:synthetic", enginePolicy,
    tools: {nsenter: {path: "/disposable/nsenter", sha256: "a".repeat(64)},
      nft: {path: "/disposable/nft", sha256: "b".repeat(64)}}};
};
const linux = {skip: process.platform !== "linux" || process.arch !== "x64"};

test("full administrative route configuration constructs a nominal capability", linux, async () => {
  const config = fixture();
  assert.throws(() => snapshotRouteSelectionFacts(config.route), TypeError);
  assert.throws(() => snapshotRouteSelectionFacts(structuredClone(config.route)), /PA route selection has an invalid shape/u);
  const capability = await createLinuxCodexLiveAdminRoute(config);
  assert.equal(readContainedTurnRouteEnforcementTarget(capability)?.provider, "codex");
  assert.equal(typeof capability.admission.admit, "function");
  assert.equal(config.route.operationAbortSignal.aborted, false);
});

test("route operational fields are excluded before cloning or reading them", linux, async () => {
  const config = fixture();
  for (const key of ["deadline", "operationAbortSignal"]) {
    Object.defineProperty(config.route, key, {enumerable: true, get() {throw new Error("operational field read");}});
  }
  const pending = createLinuxCodexLiveAdminRoute(config);
  // Detachment must precede the registry read's first await.
  Object.assign(config.route.binding, {provider: "claude"});
  Object.assign(config.route.descriptor.exactValues, {"content-type": "text/plain"});
  assert.equal(readContainedTurnRouteEnforcementTarget(await pending)?.provider, "codex");
});

test("malformed selected facts remain rejected by PA and the administrative constructor", linux, async () => {
  const changes = [
    (r: LinuxCodexLivePins["route"]) => Object.assign(r.binding, {extra: true}),
    (r: LinuxCodexLivePins["route"]) => {Reflect.deleteProperty(r.binding, "tenantId");},
    (r: LinuxCodexLivePins["route"]) => Object.assign(r.binding, {revocation: "revoked"}),
    (r: LinuxCodexLivePins["route"]) => Object.assign(r.descriptor, {extra: true}),
    (r: LinuxCodexLivePins["route"]) => Object.assign(r.descriptor, {originHost: "invalid.example"}),
    (r: LinuxCodexLivePins["route"]) => Object.assign(r, {recipe: "invalid"}),
    (r: LinuxCodexLivePins["route"]) => {
      Object.defineProperty(r.descriptor, "originHost", {enumerable: true, get() {assert.fail("accessor invoked");}});
    },
  ];
  for (const change of changes) {
    const config = fixture(); change(config.route);
    const {binding, recipe, descriptor} = config.route;
    assert.throws(() => snapshotRouteSelectionFacts({binding, recipe, descriptor}), TypeError);
    await assert.rejects(createLinuxCodexLiveAdminRoute(config), TypeError);
  }
});
