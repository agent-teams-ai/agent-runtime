import assert from "node:assert/strict";
import test from "node:test";
import {createDockerLinuxExclusiveRouteAdmission} from
  "../../../dist/features/contained-agent-turn/composition/docker-linux-exclusive-route-admission.js";
import {createDockerLinuxExclusiveRouteAdmission as packedFactory} from "../../../dist/composition.js";
import {container, subject} from "../../fixtures/host-http-egress-v4-fixture.ts";

/** The pinned Codex Linux tuple the route owner admits; no tool is opened when
 * the platform, privilege or container observation already refuses. */
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
const endpoint = Object.freeze({address: "172.30.0.1", port: 18_443});
const request = (signal = new AbortController().signal) => Object.freeze({
  authority: {...container}, endpoint, signal, deadlineEpochMs: Date.now() + 5_000, lifetimeMs: 20_000,
});
const admission = (inspections: unknown[]) => {
  const engine = {inspect: async () => inspections.shift() ?? {authority: {...container},
    engine: subject.attempt, cgroupTree: "unobserved", existence: "absent"}};
  return createDockerLinuxExclusiveRouteAdmission({binding, engine: engine as never, nsenter: pin, nft: pin});
};

test("the packed composition exports the same production route admission factory", () => {
  assert.equal(packedFactory, createDockerLinuxExclusiveRouteAdmission);
});

test("a container the Engine cannot observe as running is refused without opening anything", async () => {
  const route = admission([]);
  assert.deepEqual(await route.admit(request()), {kind: "unsupported", reason: "owner"});
  // Nothing was opened, so there is no namespace or descriptor to release.
  assert.equal(await route.releaseAfterContainerRemoval(), "none");
});

test("admission is one-use and refuses an already cut off or expired request", async () => {
  const cut = new AbortController(); cut.abort();
  assert.deepEqual(await admission([]).admit(request(cut.signal)), {kind: "unsupported", reason: "owner"});
  const expired = admission([]);
  assert.deepEqual(await expired.admit({...request(), deadlineEpochMs: Date.now() - 1}),
    {kind: "unsupported", reason: "owner"});
  const once = admission([]);
  assert.deepEqual(await once.admit(request()), {kind: "unsupported", reason: "owner"});
  assert.deepEqual(await once.admit(request()), {kind: "unsupported", reason: "owner"});
});

test("an unpinned tool refuses and keeps the opened namespace quarantined", async t => {
  if (process.platform !== "linux" || process.arch !== "x64" || process.geteuid?.() !== 0) {
    t.skip("the exclusive route owner opens a container network namespace as root on linux-x64");
    return;
  }
  // The observation names this very process, so the namespace it opens is the
  // Host's own: the owner must refuse and still retain its descriptors.
  const present = {authority: {...container}, engine: {...subject.attempt, cgroupVersion: "2"},
    cgroupTree: "unobserved", existence: "present",
    state: {running: true, hostPid: process.pid, startedAt: "2026-01-01T00:00:00Z"},
    resources: {seccompProfileSha256: undefined as unknown as string}};
  const seccomp = await import(
    "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/linux-exclusive-route-policy.js");
  present.resources.seccompProfileSha256 = seccomp.linuxExclusiveRouteSeccomp().sha256;
  const route = admission([present, present]);
  assert.deepEqual(await route.admit(request()), {kind: "unsupported", reason: "owner"});
  // A failed opening never becomes a clean release; its custody stays quarantined.
  assert.equal(await route.releaseAfterContainerRemoval(), "quarantined");
});
