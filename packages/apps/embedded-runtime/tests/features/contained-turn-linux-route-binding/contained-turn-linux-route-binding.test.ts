import assert from "node:assert/strict";
import test from "node:test";
import { createContainedTurnLinuxRouteBinding, type ContainedTurnLinuxRouteCampaign }
  from "../../../dist/composition/contained-turn-linux-route-binding.js";
import { installLinuxExclusiveRoute } from
  "@agent-teams/agent-execution/composition";
import { harness, selection } from "../../package/support/external/provider-access/features/contained-turn-access/route-selection-fixture.ts";

/** Product facts the trusted deployment composition owns; none of them is a
 * Provider Access fact and none is read from the environment here. */
const campaign: ContainedTurnLinuxRouteCampaign = Object.freeze({
  operationId: "operation:test", attemptId: "attempt:test", custodyId: "custody:test",
  hostBootId: "boot:test", executionGenerationId: "generation:test", authorityVectorDigest: "authority:test",
  sourceRevision: "f80683e31aa329c4a1eb3347efa45eb93b452f32",
  adapterRevision: "adapter:test", binaryRevision: "@openai/codex:0.153.4+linux-x64",
  capabilityManifestRevision: "manifest:test",
});

const endorsed = async () => {
  const paHarness = await harness(selection("codex-chatgpt"));
  const owner = paHarness.owner();
  await owner.control.endorse(1);
  const current = await owner.readCurrent();
  assert.ok(current, "the PA route selection owner must publish a current endorsement");
  return {current, binding: selection("codex-chatgpt").binding};
};

/** The route owner validates its 21-field binding before anything else, so an
 * endpoint failure proves the binding itself was accepted. */
const refusalOf = (binding: unknown): string => {
  try {
    installLinuxExclusiveRoute({binding, endpoint: {address: "8.8.8.8", port: 443}, lifetimeMs: 20_000,
      startedAtMs: 0, kernel: {}, monotonicNow: () => 0, scheduleCutoff: () => () => {}} as never);
  } catch (error) {return (error as Error).message;}
  return "installed";
};

test("the projected binding carries Provider Access facts verbatim", async () => {
  const {current, binding} = await endorsed();
  const projected = await createContainedTurnLinuxRouteBinding({campaign, current, provider: "codex"});
  assert.deepEqual(Object.keys(projected).toSorted(), ["accessRef", "adapterRevision", "attemptId",
    "authorityVectorDigest", "binaryRevision", "bindingRevision", "capabilityManifestRevision",
    "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "custodyId",
    "executionGenerationId", "hostBootId", "operationId", "projectId", "providerAccountRef",
    "providerRouteRef", "routeRevision", "scopeDigest", "sourceRevision", "tenantId"]);
  for (const key of ["tenantId", "projectId", "scopeDigest", "accessRef", "providerAccountRef",
    "providerRouteRef", "bindingRevision", "credentialBindingRef", "credentialBindingDigest",
    "credentialGeneration"] as const) {
    assert.deepEqual(projected[key], binding[key], key);
  }
  // The route's own identity revision, not a copy of the binding revision.
  assert.equal(projected.routeRevision, current.routeAuthorityDigest);
  assert.notEqual(projected.routeRevision, String(projected.bindingRevision));
  assert.ok(Object.isFrozen(projected));
});

test("the Linux route owner accepts the projected binding", async () => {
  const {current} = await endorsed();
  const projected = await createContainedTurnLinuxRouteBinding({campaign, current, provider: "codex"});
  assert.equal(refusalOf(projected),
    "exclusive broker endpoint must be exact private IPv4 and unprivileged TCP port");
  // The same owner refuses a binding whose product facts drifted.
  assert.equal(refusalOf({...projected, sourceRevision: "not-a-source-revision"}),
    "exclusive route requires an exact supported Linux candidate and source revision");
  const {accessRef: _dropped, ...incomplete} = projected;
  assert.equal(refusalOf(incomplete), "invalid exact route binding");
});

test("a provider the endorsement does not name is refused", async () => {
  const {current} = await endorsed();
  await assert.rejects(createContainedTurnLinuxRouteBinding({campaign, current, provider: "claude"}));
});

test("campaign facts are exact inert data, never getters or partial records", async () => {
  const {current} = await endorsed();
  const {custodyId: _missing, ...partial} = campaign;
  await assert.rejects(createContainedTurnLinuxRouteBinding(
    {campaign: partial as ContainedTurnLinuxRouteCampaign, current, provider: "codex"}));
  await assert.rejects(createContainedTurnLinuxRouteBinding(
    {campaign: {...campaign, extra: "fact"} as ContainedTurnLinuxRouteCampaign, current, provider: "codex"}));
  await assert.rejects(createContainedTurnLinuxRouteBinding(
    {campaign: {...campaign, attemptId: "attempt with space"}, current, provider: "codex"}));
  const getter = Object.defineProperties({...campaign} as Record<string, unknown>,
    {operationId: {enumerable: true, get: () => "operation:injected"}});
  await assert.rejects(createContainedTurnLinuxRouteBinding(
    {campaign: getter as unknown as ContainedTurnLinuxRouteCampaign, current, provider: "codex"}));
  await assert.rejects(createContainedTurnLinuxRouteBinding(
    {campaign: new Proxy({...campaign}, {}), current, provider: "codex"}));
});

test("an endorsement Provider Access does not validate cannot become a route binding", async () => {
  const {current} = await endorsed();
  for (const broken of [undefined, {}, {...current, routeAuthorityDigest: "sha256:0"},
    {...current, binding: {...current.binding, revocation: "revoked"}},
    {...current, binding: {...current.binding, availability: "unavailable"}}]) {
    await assert.rejects(createContainedTurnLinuxRouteBinding({campaign, current: broken, provider: "codex"}));
  }
});
