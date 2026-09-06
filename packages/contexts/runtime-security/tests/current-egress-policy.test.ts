import assert from "node:assert/strict";
import { test } from "node:test";
import { types } from "node:util";
import { createCurrentEgressOwner } from
  "../dist/features/provider-process-egress-authorization/composition/current-egress-owner.js";
import { approve, candidate, changed, current, digest, finalInput, fixture, provisional,
  request, resolveInput, scope } from "./current-egress-owner.fixture.ts";

test("existing V2 candidate signs the exact rule and final match with real Ed25519", async t => {
  const { input, state } = fixture();
  const setup = candidate(input); t.after(() => setup.dispose());
  assert.equal(state.clockReads, 0);
  assert.deepEqual(state.calls, []);
  assert.equal(types.isAsyncFunction(setup.owner.resolvePolicy), true);
  assert.equal(types.isAsyncFunction(setup.owner.readCurrent), true);
  const decision = await provisional(setup);
  assert.deepEqual(state.calls, ["RS", "PA", "RS"]);
  assert.match(decision.policy.policyRevision, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(decision.policy.policyRevision, input.rule.expectedAcceptedConstraintsDigest);
  assert.equal(decision.policy.policyGeneration, input.operation.authorityGeneration);
  assert.equal(decision.providerAccess.routeGeneration, "3");
  assert.equal(decision.providerAccess.credentialGeneration, "credential-generation-8");
  assert.equal(decision.providerAccess.credentialBindingDigest, digest("original-credential"));
  assert.equal(decision.providerAccess.routeAuthorityDigest, digest("pa-owned-route"));
  assert.deepEqual(decision.policy.limits, input.rule.limits);
  const result = await setup.gateway.authorizeFirstApplicationByte(finalInput(decision));
  assert.equal(result.status, "authorized");
  assert.deepEqual(state.calls, ["RS", "PA", "RS", "RS", "PA", "RS"]);
  if (result.status !== "authorized") {throw new Error("Expected authorized fixture result");}
  assert.equal(result.grant.signature.algorithm, "ed25519");
  assert.match(result.grant.signature.value, /^[0-9a-f]{128}$/);
  assert.equal(setup.signer.hostEgressVerifierV2.verifyGrant(result.grant), true);
  assert.equal(setup.signer.hostEgressVerifierV2.verifyProvisionalDecision(decision), true);
  assert.deepEqual(result.grant.payload.policy, decision.policy);
  assert.deepEqual(result.grant.payload.providerAccess, decision.providerAccess);
  assert.equal(Object.isFrozen(result.grant.payload.policy.limits), true);
  assert.deepEqual(Object.keys(setup.owner).toSorted(), ["dispose", "readCurrent", "resolvePolicy"]);
});

const requestMismatches: [string, unknown][] = [
  ["method", "GET"], ["authority.hostname", "foreign.example.com"], ["authority.port", 444],
  ["requestTarget.digest", digest("/v1/messages?beta=false")], ["requestTarget.byteLength", 21],
  ["headers.credentialFields", []],
  ["headers.credentialFields.0.name", "x-api-key"],
  ["headers.credentialFields.0.credentialBindingDigest", digest("foreign-credential")],
  ["framing.protocol", "h2"], ["framing.authoritySource", ":authority"],
  ["framing.requestTarget", "pseudo-headers"], ["framing.contentLength", 127],
  ["framing.transferEncoding", "present"], ["framing.connectionSpecificHeaders", "present"],
];
for (const [path, value] of requestMismatches) {
  test(`exact rule rejects request mismatch: ${path}`, async t => {
    const setup = candidate(fixture().input); t.after(() => setup.dispose());
    const result = await setup.gateway.requestProvisional({
      contractVersion: "provider-process-egress-provisional/v2", authorizationRequestId: "request-1",
      request: changed(request(), path, value) });
    assert.equal(result.status, "denied");
  });
}

test("body and header content vary within the RS rule; caller cannot choose permissions", async t => {
  const { input } = fixture(); const owner = createCurrentEgressOwner(input); t.after(() => owner.dispose());
  const original = await current(owner);
  const modified = resolveInput();
  modified.request.body = { digest: digest("different-body"), byteLength: 1024 };
  modified.request.framing.contentLength = 1024;
  modified.request.headers.canonicalDigest = digest("different-headers");
  modified.request.headers.credentialFields[0]!.valueDigest = digest("different-rendering");
  const result = await owner.resolvePolicy(modified);
  assert.equal(result.status, "current");
  if (result.status !== "current") {throw new Error("Expected authorized fixture result");}
  assert.notEqual(result.authority.policy.authorizedRequestDigest, original.policy.authorizedRequestDigest);
  assert.deepEqual(result.authority.policy.limits, input.rule.limits);
  assert.equal((await owner.resolvePolicy({ ...modified, limits: { requestBytes: 9999 } } as never)).status, "denied");
  modified.request.body.byteLength = 1025; modified.request.framing.contentLength = 1025;
  assert.equal((await owner.resolvePolicy(modified)).status, "denied");
});

test("rule approval binds the whole policy and exact accepted dispatch, not opaque constraints alone", () => {
  const { input } = fixture();
  for (const [path, value] of [
    ["rule.limits.requestBytes", 2048], ["rule.limits.responseBytes", 16384],
    ["rule.limits.totalMilliseconds", 60000], ["rule.tlsPolicyDigest", digest("other-tls")],
    ["rule.decisionTtlMilliseconds", 2000], ["rule.revision", "other-revision"],
    ["rule.route.credentialRecipeRef", "other-recipe"],
    ["acceptedDispatch.headVersion", "8"],
    ["acceptedDispatch.authority.claimBindingDigest", digest("foreign")],
  ] as [string, unknown][]) {
    // Keep borrowed functions out of structuredClone.
    const { monotonicNow, readRsHead, readPaEndorsement, ...data } = input;
    assert.throws(() => createCurrentEgressOwner({ ...changed(data, path, value),
      monotonicNow, readRsHead, readPaEndorsement }), TypeError, path);
  }
  assert.throws(() => createCurrentEgressOwner({ ...input,
    approval: { ruleRevision: input.rule.revision,
      bindingDigest: input.acceptedDispatch.authority!.constraintsDigest } }), TypeError);
  const wrongExpected = approve({ ...input, rule: { ...input.rule,
    expectedAcceptedConstraintsDigest: digest("other-constraints") } });
  assert.throws(() => createCurrentEgressOwner(wrongExpected), TypeError);
  const wrongOperation = approve({ ...input, operation: { ...input.operation, providerId: "other" } });
  assert.throws(() => createCurrentEgressOwner(wrongOperation), TypeError);
  const wrongRevision = { ...input, approval: { ...input.approval, ruleRevision: "other" } };
  assert.throws(() => createCurrentEgressOwner(wrongRevision), TypeError);
});

test("explicit root reapproval changes policy revision despite equal dispatch constraints", async t => {
  const { input } = fixture(); const owner = createCurrentEgressOwner(input); t.after(() => owner.dispose());
  const replacement = createCurrentEgressOwner(approve({ ...input, rule: { ...input.rule,
    limits: { ...input.rule.limits, responseBytes: 2048 } } })); t.after(() => replacement.dispose());
  assert.notEqual((await current(owner)).policy.policyRevision, (await current(replacement)).policy.policyRevision);
});

test("invalid or unbounded rule fields reject even with fresh root approval", () => {
  const { input } = fixture();
  const invalid = [
    { ...input.rule, limits: { ...input.rule.limits, responseBytes: 256 * 1024 * 1024 + 1 } },
    { ...input.rule, limits: { ...input.rule.limits, requestBytes: -1 } },
    { ...input.rule, limits: { ...input.rule.limits, totalMilliseconds: 0 } },
    { ...input.rule, decisionTtlMilliseconds: 300001 },
    { ...input.rule, route: { ...input.rule.route, credentialSlots: ["authorization", "authorization"] } },
    { ...input.rule, route: { ...input.rule.route, requestTarget: { ...input.rule.route.requestTarget, byteLength: 16385 } } },
  ];
  for (const rule of invalid) {assert.throws(() => createCurrentEgressOwner(approve({ ...input, rule })), TypeError);}
});

test("scope and refs cannot cross operations or owners, including identical root inputs", async t => {
  const { input } = fixture();
  const first = createCurrentEgressOwner(input); const second = createCurrentEgressOwner(input);
  t.after(() => { first.dispose(); second.dispose(); });
  const a = await current(first); const b = await current(second);
  assert.notEqual(a.authorityRef, b.authorityRef);
  assert.equal((await first.readCurrent({ scope: scope(), authorityRef: b.authorityRef })).status, "denied");
  assert.equal((await first.readCurrent({ scope: scope(), authorityRef: "unknown" })).status, "denied");
  for (const key of ["tenantId", "projectId", "operationId", "scopeDigest"]) {
    const foreign = changed(scope(), key, key === "scopeDigest" ? digest("foreign") : "foreign");
    assert.equal((await first.readCurrent({ scope: foreign, authorityRef: a.authorityRef })).status, "denied");
    assert.equal((await second.resolvePolicy({ ...resolveInput(), scope: foreign })).status, "denied");
  }
  assert.equal((await first.readCurrent({ scope: scope(), authorityRef: a.authorityRef })).status, "current");
});
