import assert from "node:assert/strict";
import { test } from "node:test";
import { createCurrentEgressOwner } from
  "../../../dist/features/provider-process-egress-authorization/composition/current-egress-owner.js";
import { approve, candidate, changed, current, deferred, digest, finalInput, fixture, provisional,
  resolveInput, scope } from "./current-egress-owner.fixture.ts";

const rsDrift: [string, unknown][] = [
  ["headVersion", "8"], ["authority.revoked", true],
  ["authority.operation.scope.tenantId", "foreign"], ["authority.operation.scope.projectId", "foreign"],
  ["authority.operation.scope.operationId", "foreign"], ["authority.operation.scope.scopeDigest", digest("foreign")],
  ["authority.operation.providerId", "foreign"], ["authority.operation.authorityGeneration", "foreign"],
  ["authority.operation.claimBindingDigest", digest("foreign")], ["authority.authorityRevision", "new-revision"],
  ["authority.acceptedAuthorityDigest", digest("foreign")], ["authority.authorityHeadDigest", digest("foreign")],
  ["authority.constraintsDigest", digest("foreign")], ["authority.containmentPolicyDigest", digest("foreign")],
  ["authority.requestDigest", digest("foreign")], ["authority.providerBindingDigest", digest("foreign")],
  ["authority.claimBeforeControlTime", 999], ["authority.ownerEvidenceRef", "runtime-security-evidence:v1:foreign"],
];
for (const [path, value] of rsDrift) {
  test(`final current observation rejects complete RS identity/version drift: ${path}`, async t => {
    const { input, state } = fixture(); const setup = candidate(input); t.after(() => setup.dispose());
    const decision = await provisional(setup);
    state.head = changed(state.head, path, value);
    const result = await setup.gateway.authorizeFirstApplicationByte(finalInput(decision));
    assert.equal(result.status, "denied");
    // Restoring the old facts cannot resurrect an owner that observed cutoff/drift.
    state.head = structuredClone(input.acceptedDispatch) as typeof state.head;
    assert.equal((await setup.owner.resolvePolicy(resolveInput())).status, "denied");
  });
}

test("RS bracketing rejects mixed snapshots and ABA even when full authority returns to A", async t => {
  for (const mode of ["different-authority", "ABA-version"]) {
    const { input, state } = fixture();
    const owner = createCurrentEgressOwner({ ...input, readPaEndorsement: async () => {
      if (mode === "ABA-version") { state.head.headVersion = "9"; }
      else { state.head.authority.constraintsDigest = digest("mixed-head"); }
      return state.pa;
    } }); t.after(() => owner.dispose());
    assert.notEqual((await owner.resolvePolicy(resolveInput())).status, "current");
    assert.deepEqual(state.calls, ["RS", "RS"]);
  }
});

test("absence and tombstones never become current", async t => {
  for (const head of [{ headVersion: "0", authority: null }, { headVersion: "8", authority: null }]) {
    const { input } = fixture(); const owner = createCurrentEgressOwner({ ...input, readRsHead: async () => head });
    t.after(() => owner.dispose());
    assert.notEqual((await owner.resolvePolicy(resolveInput())).status, "current");
  }
  const { input } = fixture();
  const owner = createCurrentEgressOwner({ ...input, readPaEndorsement: async () => null }); t.after(() => owner.dispose());
  assert.notEqual((await owner.resolvePolicy(resolveInput())).status, "current");
});

const paDrift: [string, unknown][] = [
  ["revoked", true], ["available", false], ["bindingRevision", 4],
  ["credentialBindingDigest", digest("changed-credential")], ["credentialGeneration", "next-generation"],
  ["routeAuthorityDigest", digest("independent-route-drift")], ["accessRef", "changed-access"],
  ["accountRef", "changed-account"], ["providerRouteRef", "changed-route"],
  ["operation.scope.tenantId", "foreign"], ["operation.scope.projectId", "foreign"],
  ["operation.scope.operationId", "foreign"], ["operation.scope.scopeDigest", digest("foreign")],
  ["operation.providerId", "foreign"], ["operation.authorityGeneration", "foreign"],
  ["operation.claimBindingDigest", digest("foreign")],
  ["route.credentialRecipeRef", "foreign-recipe"], ["route.credentialSlots", ["x-api-key"]],
  ["route.origin.hostname", "foreign.example.com"], ["route.method", "GET"],
  ["route.requestTarget.digest", digest("/foreign")], ["route.requestTarget.byteLength", 21],
  ["route.framing.contentLength", "unbound"],
];
for (const [path, value] of paDrift) {
  test(`candidate's final full match rejects PA current fact drift: ${path}`, async t => {
    const { input, state } = fixture(); const setup = candidate(input); t.after(() => setup.dispose());
    const decision = await provisional(setup);
    state.pa = changed(state.pa, path, value);
    assert.equal((await setup.gateway.authorizeFirstApplicationByte(finalInput(decision))).status, "denied");
  });
}

test("current rebuild preserves new PA facts instead of returning cached authority", async t => {
  const { input, state } = fixture(); const owner = createCurrentEgressOwner(input); t.after(() => owner.dispose());
  const before = await current(owner);
  state.pa = { ...state.pa, credentialGeneration: "generation-9", bindingRevision: 4,
    routeAuthorityDigest: digest("new-pa-endorsement") };
  const result = await owner.readCurrent({ scope: scope(), authorityRef: before.authorityRef });
  assert.equal(result.status, "current");
  if (result.status !== "current") {throw new Error("Expected authorized fixture result");}
  assert.equal(result.authority.providerAccess.credentialGeneration, "generation-9");
  assert.equal(result.authority.providerAccess.routeGeneration, "4");
  assert.equal(result.authority.providerAccess.routeAuthorityDigest, digest("new-pa-endorsement"));
  assert.notDeepEqual(result.authority.providerAccess, before.providerAccess);
  assert.deepEqual(state.calls, ["RS", "PA", "RS", "RS", "PA", "RS"]);
});

test("replacement supersedes the sole context even for an identical canonical request", async t => {
  const { input } = fixture(); const owner = createCurrentEgressOwner(input); t.after(() => owner.dispose());
  const first = await current(owner); const second = await current(owner);
  assert.notEqual(first.authorityRef, second.authorityRef);
  assert.equal((await owner.readCurrent({ scope: scope(), authorityRef: first.authorityRef })).status, "denied");
  assert.equal((await owner.readCurrent({ scope: scope(), authorityRef: second.authorityRef })).status, "current");
  await owner.resolvePolicy({ ...resolveInput(), request: changed(resolveInput().request, "method", "GET") });
  assert.equal((await owner.readCurrent({ scope: scope(), authorityRef: second.authorityRef })).status, "denied");
});

test("overlapping resolves never publish the older context or queue another borrowed callback", async t => {
  const { input, state } = fixture(); const gate = deferred<typeof state.head>(); let reads = 0;
  const owner = createCurrentEgressOwner({ ...input, readRsHead: async () => { reads += 1; return gate.promise; } });
  t.after(() => owner.dispose());
  const first = owner.resolvePolicy(resolveInput());
  assert.equal(reads, 1);
  const newer = await owner.resolvePolicy({ ...resolveInput(), authorizationRequestId: "newer" });
  assert.equal(newer.status, "denied");
  gate.resolve(state.head);
  assert.notEqual((await first).status, "current");
  assert.equal(reads, 1);
  assert.equal((await owner.resolvePolicy(resolveInput())).status, "denied");
});

test("reentrant callback disposal cannot publish late authority", async () => {
  const { input, state } = fixture();
  let owner: ReturnType<typeof createCurrentEgressOwner>;
  owner = createCurrentEgressOwner({ ...input, readPaEndorsement: async () => {
    owner.dispose(); return state.pa;
  } });
  assert.notEqual((await owner.resolvePolicy(resolveInput())).status, "current");
  assert.deepEqual(state.calls, ["RS"]);
});

test("committed-turn HTTP authorization outlives the initial claim window", async t => {
  const f = fixture();
  const acceptedDispatch = changed(f.input.acceptedDispatch, "authority.claimBeforeControlTime", 1050);
  f.state.head = structuredClone(acceptedDispatch) as typeof f.state.head;
  const setup = candidate(approve({...f.input, acceptedDispatch}), () => 1000 + f.state.now - 100); t.after(() => setup.dispose());
  const decision = await provisional(setup);
  assert.equal((await setup.gateway.authorizeFirstApplicationByte(finalInput(decision))).status, "authorized");
  f.state.now = 150; // Claim window closes; operation and HTTP lifetimes remain open.
  assert.equal((await setup.gateway.authorizeFirstApplicationByte(finalInput(decision))).status, "authorized");
  assert.equal((await setup.owner.resolvePolicy(resolveInput())).status, "current");
  const afterClaim = createCurrentEgressOwner(approve({...f.input, acceptedDispatch,
    timing: {...f.input.timing, controlTimeAtAnchor: 1050, monotonicAtAnchor: 150}}));
  t.after(() => afterClaim.dispose());
  assert.equal((await afterClaim.resolvePolicy(resolveInput())).status, "current");
  f.state.now = 10_100;
  assert.equal((await setup.owner.resolvePolicy(resolveInput())).status, "denied");
});
