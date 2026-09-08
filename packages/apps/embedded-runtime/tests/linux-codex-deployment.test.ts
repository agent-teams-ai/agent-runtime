import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {createLinuxCodexDeploymentResources} from "../dist/composition/linux-codex-deployment.js";
import {createContainedTurnCurrentEgressOwners} from "../dist/composition/contained-turn-current-egress-owners.js";
import {createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate} from "@agent-teams/runtime-security/composition";
import {bindContainedTurnHttpRuntimeSecurity} from "../dist/composition/contained-turn-http-runtime-security.js";
import {fixture, digest, changed} from "./contained-turn-current-egress-owners.fixture.ts";
import {canonicalEgressValue} from "../../../contexts/runtime-security/dist/features/provider-process-egress-authorization/application/egress-canonical.js";
import {initialHttpEgressState} from "../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-settlement.js";
import {HTTP_EVIDENCE_FENCE} from "../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/postgres-http-egress-evidence-transactions.js";
import {SYNTHETIC_LOOPBACK_CA} from "../../../contexts/agent-execution/tests/fixtures/http-egress-tls/synthetic-loopback-certificates.ts";

/** Simulation: acknowledged feature receipts and PG query replies are fixtures.
 * PA route validation, RS current owner/signer, and HTTP adapters are real source.
 * No committed claim, Docker launch, DNS request, provider or live DB is exercised.
 */
const setup = async () => {
  const f = await fixture();
  f.state.head = {...f.state.head, headVersion: "1"};
  const head = f.state.head.authority!;
  const scope = head.scope;
  const adapterSnapshot = {provider: "codex", adapterRevision: "adapter-1", binaryRevision: "binary-1", capabilityManifestRevision: "manifest-1"};
  const b = f.endorsed.binding;
  const paFacts = {acceptedAuthorityDigest: digest("vector"), accessRef: b.accessRef, authorityHeadDigest: b.credentialBindingDigest,
    bindingDigest: head.providerBindingDigest, bindingRevision: b.bindingRevision, credentialBindingDigest: digest(JSON.stringify({ownerDigest: b.credentialBindingDigest})),
    credentialBindingRef: b.credentialBindingRef, credentialGeneration: b.credentialGeneration,
    providerAccountRef: b.providerAccountRef, providerRouteRef: b.providerRouteRef};
  const rsFacts = Object.fromEntries(["acceptedAuthorityDigest", "authorityGeneration", "authorityHeadDigest", "authorityRevision",
    "constraintsDigest", "containmentPolicyDigest", "providerBindingDigest", "providerId"].map(key => [key, head[key as keyof typeof head]]));
  const providerAccessSnapshot = {...b, revision: b.bindingRevision};
  const subject = {operationId: head.operationId, attemptId: "attempt-1", custodyId: "custody-1", effectId: "effect-1", workspaceId: "workspace-1",
    preparationToken: "preparation-1", hostBootId: "host-boot-1", hostInstanceId: "host-instance-1", executionGenerationId: "execution-1",
    operationCutoffRevision: 0, scope: {tenantId: scope.tenantId, projectId: scope.projectId}, scopeDigest: scope.scopeDigest,
    providerAccessExpectation: paFacts, runtimeSecurityExpectation: rsFacts,
    providerAccessRequest: {requestDigest: digest("pa-request"), claimBindingDigest: digest("pa-claim"), grantRequestId: "pa-grant"},
    runtimeSecurityRequest: {requestDigest: head.requestDigest, claimBindingDigest: head.claimBindingDigest, grantRequestId: "rs-grant"}};
  const accepted = {acceptedAuthorityVectorDigest: digest("vector"), acceptedAuthorityVector: {adapterSnapshot, providerAccessSnapshot}};
  const receipt = (owner: "pa" | "rs") => ({operationId: head.operationId, scope, provider: "codex", purpose: head.purpose,
    ...(owner === "pa" ? subject.providerAccessRequest : subject.runtimeSecurityRequest),
    authorityFacts: owner === "pa" ? paFacts : rsFacts, claimBeforeControlTime: head.claimBeforeControlTime, ownerEvidenceRef: head.ownerEvidenceRef});
  const input = {accepted, subject};
  const kernel = {...subject, authorityVectorDigest: digest("vector"), adapterSnapshot, providerAccessSnapshot};
  const calls: string[] = []; const rows = new Map<string, string>();
  const pool = {async connect() {calls.push("connect"); return {async query(sql: string, values: unknown[] = []) {
    calls.push(sql);
    if (sql.includes("SELECT version")) {return {rows: [{version: 1, format: HTTP_EVIDENCE_FENCE}]};}
    const key = JSON.stringify(values.slice(0, 6));
    if (sql.includes("INSERT INTO host_http_egress.receipt")) {rows.set(key, values[6] as string);}
    if (sql.includes("SELECT canonical_receipt")) {return {rows: [{canonical_receipt: rows.get(key)}]};}
    return {rows: []};
  }, release() {calls.push("release");}};}};
  let recipes = 0;
  const deployment = createLinuxCodexDeploymentResources({imageInitLock: {} as never, cleanupMilliseconds: 1000,
    sourceRevision: "a".repeat(40), deploymentId: "deployment-simulation", pool: pool as never,
    dns: {resolverIdentity: "resolver", resolverEpoch: "epoch-1", timeoutMs: 1000},
    transport: {certificateAuthorities: [SYNTHETIC_LOOPBACK_CA]}, currentAuthority: {runtimeSecurity: f.rs, providerAccess: f.pa},
    currentPolicy(ack) {
      const {scope: rsScope, operationId, providerId, authorityGeneration, claimBindingDigest, ...facts} = ack.acceptedDispatch.authority!;
      const operation = {scope: {...rsScope, operationId}, providerId, authorityGeneration, claimBindingDigest};
      const acceptedDispatch = {headVersion: ack.acceptedDispatch.headVersion, authority: {...facts, operation}};
      // Explicit synthetic approval, never deployment policy provisioning.
      return {...f.input, approval: {ruleRevision: f.input.rule.revision,
        bindingDigest: digest(canonicalEgressValue({domain: "rs-current-egress-rule/v1", operation, acceptedDispatch, rule: f.input.rule}))}};
    },
    authorities: {} as never, signer: {keyRef: "synthetic-key", keyGeneration: "1", signerRevision: "2",
      clock: {read: () => ({authorityId: "control", epoch: "epoch-1", controlTime: 1000})}},
    clock: {now: () => 100, within: async (_deadline, work) => work()},
    recipe() {recipes++; return {preparation: {}, route: {}, nativeFiles: {}, connection: {}, hostSession: {}} as never;},
  }, subject);
  const outcomes = {pa: {kind: "consumed", receipt: receipt("pa")}, rs: {kind: "consumed", receipt: receipt("rs")}};
  const ports = deployment.bindAuthority({providerAccess: {async consumeForDispatch() {return outcomes.pa;}},
    security: {async consumeForDispatch() {return outcomes.rs;}}} as never);
  const pa = () => ports.providerAccess.consumeForDispatch({...input, grantRequestId: "pa-grant"} as never);
  const rs = () => ports.security.consumeForDispatch(input as never);
  const select = (value = kernel) => deployment.resources.select({kernel: value, record: {}} as never);
  return {f, calls, rows, outcomes, input, kernel, pa, rs, select, recipes: () => recipes};
};

test("simulation: selection needs both acknowledgements before any recipe and binds concrete HTTP owners", async () => {
  const t = await setup();
  try {
    assert.throws(() => t.select(), /acknowledged/u);
    await t.pa(); assert.throws(() => t.select(), /acknowledged/u);
    assert.equal(t.recipes(), 0); assert.deepEqual(t.calls, []);
    await t.rs();
    const selected = t.select();
    assert.equal(t.recipes(), 1);
    assert.equal(selected.route.binding.operationId, t.kernel.operationId);
    assert.equal(selected.route.binding.attemptId, t.kernel.attemptId);
    assert.equal(selected.route.binding.custodyId, t.kernel.custodyId);
    assert.equal(selected.route.binding.authorityVectorDigest, t.kernel.authorityVectorDigest);
    assert.equal(selected.route.binding.routeRevision, t.f.endorsed.routeAuthorityDigest);
    assert.equal(selected.signer.hostReservationId, t.kernel.custodyId);
    assert.notEqual(t.input.subject.providerAccessExpectation.credentialBindingDigest, selected.broker.providerAccessSnapshot.ownerAuthorityDigest);
    for (const name of ["ids", "resolver", "evidence", "transport"] as const) {
      assert.equal(Object.getPrototypeOf(selected.broker[name]), Object.prototype);
      assert.ok(Object.isFrozen(selected.broker[name]));
    }
    const {fresh} = selected.broker.ids;
    assert.notDeepEqual(fresh(), fresh());
    const {resolve} = selected.broker.resolver;
    await assert.rejects(resolve("invalid host")); // Refused before DNS allocation.
    const {beginOpen} = selected.broker.transport;
    assert.throws(() => beginOpen({originHost: "bad host", originPort: 443, selectedAddress: "bad address", sni: "bad", alpn: "http/1.1"}));
    const {record, digest: hash} = selected.broker.evidence;
    assert.equal(hash([Buffer.from("abc")]), createHash("sha256").update("abc").digest("hex"));
    const receipt = {schema: "agent-runtime.host-http-egress-receipt/v1" as const, operationId: t.kernel.operationId,
      attemptId: t.kernel.attemptId, requestId: "request-1", ...initialHttpEgressState()};
    assert.throws(() => record({...receipt, attemptId: "foreign"}), /binding/u);
    assert.deepEqual(t.calls, []);
    assert.equal(await record(receipt), "recorded");
    assert.ok(t.calls.includes("COMMIT"));
    assert.equal(JSON.parse([...t.rows.keys()][0]!)[2], "deployment-simulation");
    const current = createContainedTurnCurrentEgressOwners(selected.currentAuthority);
    const signer = createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate({...selected.signer, authorityOwner: current});
    try {
      const result = await bindContainedTurnHttpRuntimeSecurity(signer).runtimeSecurity.requestProvisional({
        contractVersion: "provider-process-egress-provisional/v2", authorizationRequestId: "request-1", request: t.f.request});
      assert.equal(result.status, "authorized");
    } finally {signer.dispose(); current.dispose();}
    assert.throws(() => t.select(), /acknowledged/u);
  } finally {t.f.dispose();}
});

for (const drift of ["operationId", "attemptId", "custodyId", "authorityVectorDigest", "preparationToken", "effectId", "workspaceId"] as const) {
  test(`simulation: acknowledged authority cannot select a different ${drift}`, async () => {
    const t = await setup();
    try {await t.pa(); await t.rs(); assert.throws(() => t.select({...t.kernel, [drift]: "foreign"}), /acknowledged/u); assert.equal(t.recipes(), 0);}
    finally {t.f.dispose();}
  });
}
for (const drift of ["authorityHeadDigest", "claimBindingDigest", "requestDigest", "authorityGeneration", "providerBindingDigest", "ownerEvidenceRef"] as const) {
  test(`simulation: mismatched published RS ${drift} preserves consumed outcome and refuses selection`, async () => {
    const t = await setup();
    try {
      await t.pa(); t.f.state.head = changed(t.f.state.head, `authority.${drift}`, digest("foreign"));
      assert.equal((await t.rs()).kind, "consumed");
      assert.throws(() => t.select(), /acknowledged/u); assert.equal(t.recipes(), 0);
    } finally {t.f.dispose();}
  });
}
test("simulation: unknown publication, PA drift and RS/PA/RS races never activate resources", async () => {
  for (const fault of ["unknown", "pa-drift", "race"] as const) {
    const t = await setup();
    try {
      await t.pa();
      if (fault === "unknown") {t.outcomes.rs = {kind: "indeterminate"} as never;}
      if (fault === "pa-drift") {t.f.paHarness.state.binding = {...t.f.endorsed.binding, credentialGeneration: 99};}
      if (fault === "race") {t.f.state.afterPa = () => {t.f.state.head = {...t.f.state.head, headVersion: "2"};};}
      await t.rs(); assert.throws(() => t.select(), /acknowledged/u); assert.equal(t.recipes(), 0);
    } finally {t.f.dispose();}
  }
});

for (const path of ["adapterSnapshot.binaryRevision", "providerAccessSnapshot.credentialGeneration", "operationCutoffRevision"] as const) {
  test(`simulation: acknowledged authority rejects changed ${path}`, async () => {
    const t = await setup();
    try {
      await t.pa(); await t.rs();
      assert.throws(() => t.select(changed(t.kernel, path, path.endsWith("Revision") && path.startsWith("adapter") ? "foreign" : 999)), /acknowledged/u);
      assert.equal(t.recipes(), 0);
    } finally {t.f.dispose();}
  });
}
