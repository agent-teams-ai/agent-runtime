import assert from "node:assert/strict";
import test from "node:test";
import { createContainedTurnHttpEgressRoute, createContainedTurnHttpUpstreamTransport }
  from "../dist/composition/contained-turn-http-egress-upstream.js";
import { SYNTHETIC_LOOPBACK_CA } from "./support/external/agent-execution/fixtures/http-egress-tls/synthetic-loopback-certificates.ts";
import { harness, selection } from "./support/external/provider-access/features/contained-turn-access/route-selection-fixture.ts";

type Recipe = Parameters<typeof selection>[0];
const endorsed = async (recipe: Recipe) => {
  const paHarness = await harness(selection(recipe));
  const owner = paHarness.owner();
  await owner.control.endorse(1);
  const current = await owner.readCurrent();
  assert.ok(current, "the PA route selection owner must publish a current endorsement");
  return {current, input: selection(recipe)};
};

const CASES = [
  ["codex-chatgpt", "codex", "chatgpt.com", "/backend-api/codex/responses"],
  ["codex-api", "codex", "api.openai.com", "/v1/responses"],
  ["claude-oauth", "claude", "api.anthropic.com", "/v1/messages?beta=true"],
  ["claude-api", "claude", "api.anthropic.com", "/v1/messages?beta=true"],
] as const;

test("every endorsed recipe projects the Host catalog route it names", async () => {
  for (const [recipe, provider, host, path] of CASES) {
    const {current, input} = await endorsed(recipe);
    const {route} = await createContainedTurnHttpEgressRoute({current, provider});
    assert.equal(route.requestProfile, input.descriptor.id, recipe);
    assert.equal(route.originHost, host); assert.equal(route.originPort, 443);
    assert.equal(route.upstreamMethod, "POST"); assert.equal(route.upstreamPath, path);
    assert.deepEqual([...route.credentialFieldNames], [...input.descriptor.credentialFieldNames]);
    // The route receipt is the endorsement's own authority digest, never a
    // caller string and never the binding revision.
    assert.equal(route.routeReceiptDigest, current.routeAuthorityDigest);
    assert.ok(Object.isFrozen(route));
  }
});

test("the snapshot carries Provider Access facts verbatim", async () => {
  const {current, input} = await endorsed("codex-chatgpt");
  const {providerAccessSnapshot} = await createContainedTurnHttpEgressRoute({current, provider: "codex"});
  assert.deepEqual(Object.keys(providerAccessSnapshot).toSorted(), ["accessRef", "availability",
    "credentialBindingRef", "credentialGeneration", "ownerAuthorityDigest", "projectId", "provider",
    "providerAccountRef", "providerRouteRef", "revision", "revocation", "scopeDigest", "tenantId"]);
  for (const key of ["tenantId", "projectId", "scopeDigest", "accessRef", "provider", "providerAccountRef",
    "providerRouteRef", "credentialBindingRef", "availability", "revocation"] as const) {
    assert.equal(providerAccessSnapshot[key], input.binding[key], key);
  }
  // The broker compares the receipt against PA's own opaque digest, so the
  // normalized credential binding digest must never be substituted for it.
  assert.equal(providerAccessSnapshot.ownerAuthorityDigest, input.binding.credentialBindingDigest);
  assert.equal(providerAccessSnapshot.revision, input.binding.bindingRevision);
  assert.equal(providerAccessSnapshot.credentialGeneration, input.binding.credentialGeneration);
  assert.ok(Object.isFrozen(providerAccessSnapshot));
});

test("an endorsement the Host catalog does not carry is refused", async () => {
  const {current} = await endorsed("codex-chatgpt");
  // The accepted provider must agree with both PA facts.
  await assert.rejects(createContainedTurnHttpEgressRoute({current, provider: "claude"}));
  const drift = (change: Record<string, unknown>) => ({...(current as object),
    descriptor: {...(current as {descriptor: object}).descriptor, ...change}});
  // PA validates its own endorsement digest first, so a descriptor changed after
  // endorsement is refused before this projection can read it.
  for (const change of [{id: "claude-api-key-messages/v1"}, {id: "unknown-profile/v1"},
    {originHost: "attacker.example"}, {upstreamPath: "/exfiltrate"},
    {forwardedRequestHeaderNames: ["accept", "content-type", "x-not-in-catalog"]}]) {
    await assert.rejects(createContainedTurnHttpEgressRoute({current: drift(change), provider: "codex"}),
      JSON.stringify(change));
  }
});

test("the upstream transport port is the implemented one-shot TLS adapter", async () => {
  // Disposable synthetic trust material; the production anchors come from
  // trusted deployment composition, exactly like the route owner's tool pins.
  const transport = createContainedTurnHttpUpstreamTransport({
    certificateAuthorities: [SYNTHETIC_LOOPBACK_CA], connectTimeoutMs: 1_000});
  assert.throws(() => createContainedTurnHttpUpstreamTransport({certificateAuthorities: []}));
  assert.equal(typeof transport.beginOpen, "function");
  // It refuses a target it cannot pin instead of resolving or retrying one.
  assert.throws(() => transport.beginOpen({originHost: "provider.example", originPort: 443,
    selectedAddress: "provider.example", sni: "provider.example", alpn: "http/1.1"}));
  const attempt = transport.beginOpen({originHost: "provider.example", originPort: 443,
    selectedAddress: "93.184.216.34", sni: "provider.example", alpn: "http/1.1"});
  assert.equal(typeof attempt.ready, "function");
  assert.equal((await attempt.close()).state, "closed");
});
