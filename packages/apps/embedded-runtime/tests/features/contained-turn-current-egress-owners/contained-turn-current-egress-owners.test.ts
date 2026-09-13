import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeHttpRequestProfile } from "@agent-teams/agent-execution/composition";
import { snapshotRouteSelectionCurrent } from "@agent-teams/provider-access/composition";
import { createContainedTurnCurrentEgressOwners } from "../../../dist/composition/contained-turn-current-egress-owners.js";
import { changed, choices, digest, fixture, redigest } from "../../contained-turn-current-egress-owners.fixture.ts";

for (const [recipe, profile] of choices) {
  test(`${recipe}: real PA owner and RS current owner sign before and after the claim cutoff`, async () => {
    const f = await fixture(recipe, profile);
    try {
      assert.deepEqual(f.state.calls, []); assert.equal(f.state.clockReads, 0);
      assert.deepEqual(Object.keys(f.owner).toSorted(), ["dispose", "readCurrent", "resolvePolicy"]);
      const setupWrites = f.paHarness.calls.filter(call => /^(INSERT|UPDATE|CREATE)/u.test(call.sql)).length;
      const decision = await f.provisional();
      assert.deepEqual(f.state.calls, ["RS", "PA", "RS"]);
      assert.equal(f.binding.verifier.verifyProvisionalDecision(decision), true);
      f.state.now = 110; // Control time 1010, past accepted claimBeforeControlTime 1005.
      const result = await f.binding.runtimeSecurity.authorizeFirstApplicationByte(f.finalInput(decision));
      assert.equal(result.status, "authorized");
      if (result.status !== "authorized") {throw new Error("Expected signed final grant");}
      assert.equal(f.candidate.hostEgressVerifierV2.verifyGrant(result.grant), true);
      assert.deepEqual(result.grant.payload.providerAccess, {
        accessRef: f.endorsed.binding.accessRef, providerRef: f.endorsed.binding.provider,
        accountRef: f.endorsed.binding.providerAccountRef, routeRef: f.endorsed.binding.providerRouteRef,
        routeAuthorityDigest: f.endorsed.routeAuthorityDigest,
        credentialBindingDigest: f.endorsed.binding.credentialBindingDigest, routeGeneration: "3", credentialGeneration: "17",
      });
      assert.deepEqual(f.state.calls, ["RS", "PA", "RS", "RS", "PA", "RS"]);
      assert.equal(f.paHarness.calls.filter(call => /^(INSERT|UPDATE|CREATE)/u.test(call.sql)).length, setupWrites);
    } finally { f.dispose(); }
  });
}

const rsDrifts: readonly [string, unknown][] = [
  ["headVersion", "9007199254740994"], ["headVersion", "0"], ["headVersion", "01"],
  ["authority", undefined], ["authority", null], ["authority.decision", "denied"],
  ["authority.purpose", "other"], ["authority.operationId", "foreign-operation"],
  ["authority.scope.tenantId", "foreign-tenant"], ["authority.scope.projectId", "foreign-project"],
  ["authority.scope.scopeDigest", digest("foreign-scope")], ["authority.providerId", "foreign-provider"],
  ["authority.authorityGeneration", "foreign-generation"], ["authority.claimBindingDigest", digest("claim-drift")],
  ["authority.authorityRevision", "revision-8"], ["authority.acceptedAuthorityDigest", digest("accepted-drift")],
  ["authority.authorityHeadDigest", digest("head-drift")], ["authority.constraintsDigest", digest("constraints-drift")],
  ["authority.containmentPolicyDigest", digest("containment-drift")], ["authority.requestDigest", digest("request-drift")],
  ["authority.providerBindingDigest", digest("provider-drift")], ["authority.claimBeforeControlTime", 1_006],
  ["authority.revoked", true], ["authority.ownerEvidenceRef", "runtime-security-evidence:v1:other"],
];
for (const [path, value] of rsDrifts) {
  test(`actual RS ${path}=${String(value)} drift cannot issue a final grant`, async () => {
    const f = await fixture();
    try {
      const decision = await f.provisional();
      f.state.head = changed(f.state.head, path, value);
      assert.deepEqual(await f.binding.runtimeSecurity.authorizeFirstApplicationByte(f.finalInput(decision)), { status: "denied" });
      assert.equal(f.binding.verifier.verifyProvisionalDecision(decision), true);
    } finally { f.dispose(); }
  });
}

test("RS / PA / RS disagreement denies the initial decision, without substituting the accepted head", async () => {
  const f = await fixture();
  try {
    f.state.afterPa = () => { f.state.head = { ...f.state.head, headVersion: "9007199254740994" }; };
    assert.deepEqual(await f.binding.runtimeSecurity.requestProvisional({ contractVersion: "provider-process-egress-provisional/v2",
      authorizationRequestId: "request-1", request: f.request }), { status: "denied" });
    assert.deepEqual(f.state.calls, ["RS", "PA", "RS"]);
  } finally { f.dispose(); }
});

for (const kind of ["absent-row", "revoked", "unavailable", "generation", "digest", "RS-outage", "PA-outage"] as const) {
  test(`actual PA owner/repository ${kind} fails closed`, async () => {
    const f = await fixture();
    try {
      const decision = await f.provisional();
      if (kind === "absent-row") { f.paHarness.state.rows = []; }
      else if (kind === "unavailable") { f.paHarness.state.unavailable = true; }
      else if (kind === "RS-outage") { f.state.rsFailure = true; }
      else if (kind === "PA-outage") { f.state.paFailure = true; }
      else { f.paHarness.state.binding = changed(f.endorsed.binding,
        kind === "revoked" ? "revocation" : kind === "generation" ? "credentialGeneration" : "credentialBindingDigest",
        kind === "revoked" ? "revoked" : kind === "generation" ? 18 : digest("new-credential")); }
      assert.deepEqual(await f.binding.runtimeSecurity.authorizeFirstApplicationByte(f.finalInput(decision)), { status: "denied" });
    } finally { f.dispose(); }
  });
}

for (const [path, value] of [
  ["binding.credentialGeneration", 18], ["binding.credentialBindingDigest", digest("new-credential")],
  ["binding.bindingRevision", 4], ["binding.providerAccountRef", "new-account"],
] as const) {
  test(`valid re-endorsed PA ${path} drift invalidates the prior signed decision`, async () => {
    const f = await fixture();
    try {
      const decision = await f.provisional();
      const current = await redigest(changed(f.endorsed, path, value));
      await snapshotRouteSelectionCurrent(current);
      f.state.paOverride = { value: current };
      assert.deepEqual(await f.binding.runtimeSecurity.authorizeFirstApplicationByte(f.finalInput(decision)), { status: "denied" });
    } finally { f.dispose(); }
  });
}

for (const field of ["tenantId", "projectId", "scopeDigest", "provider"] as const) {
  test(`PA-valid foreign ${field} is rejected by the outer ACL`, async () => {
    const f = await fixture();
    try {
      const decision = await f.provisional();
      const current = field === "provider" ? { ...f.endorsed, binding: { ...f.endorsed.binding, provider: "claude" as const },
        recipe: "claude-api" as const, descriptor: nativeHttpRequestProfile("claude-api-key-messages/v1")! } :
        changed(f.endorsed, `binding.${field}`, field === "scopeDigest" ? digest("foreign-scope") : "foreign");
      const validated = await snapshotRouteSelectionCurrent(await redigest(current));
      f.state.paOverride = { value: validated };
      assert.deepEqual(await f.binding.runtimeSecurity.authorizeFirstApplicationByte(f.finalInput(decision)), { status: "denied" });
    } finally { f.dispose(); }
  });
}

for (const drift of ["forwarded-headers", "required-headers", "version", "query", "id", "credential-mode"] as const) {
  test(`PA descriptor ${drift} must match the complete explicitly selected Host profile`, async () => {
    const f = await fixture("claude-oauth", "claude-authorization-messages/v1");
    try {
      const decision = await f.provisional();
      const descriptor = f.endorsed.descriptor;
      const current = drift === "forwarded-headers" ? changed(f.endorsed, "descriptor.forwardedRequestHeaderNames",
        [...descriptor.forwardedRequestHeaderNames, "x-extra"]) :
        drift === "required-headers" ? changed(f.endorsed, "descriptor.requiredHeaderNames", [...descriptor.requiredHeaderNames].toReversed()) :
        drift === "version" ? changed(f.endorsed, "descriptor.exactValues.anthropic-version", "2023-06-02") :
        drift === "query" ? changed(f.endorsed, "descriptor.upstreamPath", "/v1/messages?beta=false") :
        drift === "id" ? changed(f.endorsed, "descriptor.id", "claude-authorization-messages/v2") :
        changed(f.endorsed, "descriptor.credentialMode", "api-key");
      const reendorsed = await redigest(current);
      // These three are PA-valid facts: it is specifically the full Host descriptor
      // comparison, not just recipe/id validation, that must reject them.
      if (["forwarded-headers", "required-headers", "version"].includes(drift)) { await snapshotRouteSelectionCurrent(reendorsed); }
      f.state.paOverride = { value: reendorsed };
      assert.deepEqual(await f.binding.runtimeSecurity.authorizeFirstApplicationByte(f.finalInput(decision)), { status: "denied" });
    } finally { f.dispose(); }
  });
}

for (const malformed of ["digest", "generation", "revoked", "availability", "null", "absent", "accessor", "proxy"] as const) {
  test(`malformed PA ${malformed} never becomes current authority`, async () => {
    const f = await fixture();
    let traps = 0;
    try {
      const decision = await f.provisional();
      const value = malformed === "digest" ? changed(f.endorsed, "routeAuthorityDigest", digest("forged")) :
        malformed === "generation" ? changed(f.endorsed, "routeGeneration", "4") :
        malformed === "revoked" ? changed(f.endorsed, "binding.revocation", "revoked") :
        malformed === "availability" ? changed(f.endorsed, "binding.availability", "unavailable") :
        malformed === "null" ? null : malformed === "absent" ? undefined : malformed === "proxy" ?
          new Proxy({}, { ownKeys() { traps++; throw new Error("proxy executed"); } }) :
          Object.defineProperty({ ...f.endorsed }, "binding", { get() { traps++; throw new Error("getter executed"); } });
      f.state.paOverride = { value };
      assert.deepEqual(await f.binding.runtimeSecurity.authorizeFirstApplicationByte(f.finalInput(decision)), { status: "denied" });
      assert.equal(traps, 0);
    } finally { f.dispose(); }
  });
}

test("construction snapshots configuration, reader identities and receivers without reads or writes", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.state.calls, []); assert.equal(f.state.clockReads, 0);
    const reads = f.paHarness.connects();
    const another = createContainedTurnCurrentEgressOwners(f.input);
    another.dispose();
    assert.equal(f.paHarness.connects(), reads); assert.deepEqual(f.state.calls, []);
    Object.assign(f.input.operation.scope, { tenantId: "mutated-source" });
    Object.assign(f.input.acceptedDispatch.authority!, { authorityHeadDigest: digest("mutated-source") });
    Object.assign(f.input.rule.route.origin, { hostname: "foreign.example" });
    Object.assign(f.input.rule.limits, { requestBytes: 0 });
    Object.assign(f.input.approval, { bindingDigest: digest("mutated-source") });
    Object.assign(f.input.timing, { operationDeadlineMonotonic: 0 });
    Object.assign(f.input, { monotonicNow: () => { throw new Error("replacement clock"); },
      runtimeSecurity: {}, providerAccess: {} });
    f.rs.readAuthority = () => { throw new Error("replacement RS method"); };
    f.pa.readCurrent = () => { throw new Error("replacement PA method"); };
    const decision = await f.provisional();
    const result = await f.binding.runtimeSecurity.authorizeFirstApplicationByte(f.finalInput(decision));
    assert.equal(result.status, "authorized");
    assert.deepEqual([f.state.rsClosed, f.state.paDisposed], [0, 0]);
  } finally { f.dispose(); }
});

test("approval stays explicit: neither request input nor the accepted head silently approves a changed rule", async () => {
  const f = await fixture();
  try {
    assert.throws(() => createContainedTurnCurrentEgressOwners({ ...f.input,
      rule: changed(f.input.rule, "route.origin.hostname", "foreign.example") }));
    assert.throws(() => createContainedTurnCurrentEgressOwners({ ...f.input,
      approval: { ruleRevision: f.input.rule.revision, bindingDigest: digest("unapproved") } }));
    assert.throws(() => createContainedTurnCurrentEgressOwners({ ...f.input, acceptedDispatch: { headVersion: "7" } }));
    assert.deepEqual(f.state.calls, []); assert.equal(f.state.clockReads, 0);
  } finally { f.dispose(); }
});

test("disposal closes only the current owner and preserves borrowed owners and historical signatures", async () => {
  const f = await fixture();
  try {
    const decision = await f.provisional();
    const calls = [...f.state.calls];
    f.owner.dispose(); f.owner.dispose();
    assert.deepEqual(await f.binding.runtimeSecurity.authorizeFirstApplicationByte(f.finalInput(decision)), { status: "denied" });
    assert.deepEqual(f.state.calls, calls);
    assert.equal(f.binding.verifier.verifyProvisionalDecision(decision), true);
    assert.deepEqual([f.state.rsClosed, f.state.paDisposed], [0, 0]);
    assert.deepEqual(await f.paOwner.readCurrent(), f.endorsed);
  } finally { f.dispose(); }
});

test("an in-flight borrowed read cannot publish after current-owner disposal", async () => {
  const f = await fixture();
  let release!: (head: typeof f.state.head) => void;
  let reads = 0;
  const pendingHead = new Promise<typeof f.state.head>(resolve => { release = resolve; });
  const owner = createContainedTurnCurrentEgressOwners({ ...f.input, runtimeSecurity: {
    readAuthority() { reads++; return pendingHead; },
  } });
  try {
    const pending = owner.resolvePolicy({ scope: f.input.operation.scope, authorizationRequestId: "request-1", request: f.request });
    assert.equal(reads, 1);
    owner.dispose();
    assert.notEqual((await pending).status, "current");
    release(f.state.head);
    await Promise.resolve();
    assert.deepEqual(f.state.calls, []);
    assert.deepEqual([f.state.rsClosed, f.state.paDisposed], [0, 0]);
  } finally { release(f.state.head); owner.dispose(); f.dispose(); }
});

for (const malformed of ["envelope-accessor", "head-accessor", "head-proxy", "scope-proxy", "extra-field", "numeric-version"] as const) {
  test(`malformed RS ${malformed} fails closed without executing returned-data hooks`, async () => {
    const f = await fixture();
    let traps = 0;
    try {
      const decision = await f.provisional();
      const head = structuredClone(f.state.head);
      const proxy = new Proxy({}, { getPrototypeOf() { traps++; throw new Error("proxy executed"); } });
      if (malformed === "envelope-accessor") { Object.defineProperty(head, "authority", {
        get() { traps++; throw new Error("getter executed"); } }); }
      else if (malformed === "head-accessor") { Object.defineProperty(head.authority!, "scope", {
        get() { traps++; throw new Error("getter executed"); } }); }
      else if (malformed === "head-proxy") { Object.assign(head, { authority: proxy }); }
      else if (malformed === "scope-proxy") { Object.assign(head.authority!, { scope: proxy }); }
      else if (malformed === "extra-field") { Object.assign(head.authority!, { unownedAuthority: true }); }
      else { Object.assign(head, { headVersion: 7 }); }
      f.state.head = head;
      assert.deepEqual(await f.binding.runtimeSecurity.authorizeFirstApplicationByte(f.finalInput(decision)), { status: "denied" });
      assert.equal(traps, 0);
    } finally { f.dispose(); }
  });
}

test("initial HTTP authorization after the committed claim cutoff uses the operation lifetime", async () => {
  const f = await fixture();
  try {
    f.state.now = 110;
    const decision = await f.provisional();
    const result = await f.binding.runtimeSecurity.authorizeFirstApplicationByte(f.finalInput(decision));
    assert.equal(result.status, "authorized");
  } finally { f.dispose(); }
});
