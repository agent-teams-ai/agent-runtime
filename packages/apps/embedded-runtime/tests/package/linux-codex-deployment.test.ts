import {policy as dockerPolicy} from "../support/external/agent-execution/fixtures/docker-engine-test-fixture.ts";
import assert from "node:assert/strict";
import {createNodeDockerDeploymentRecipe, createContainedTurnRouteEnforcement, readContainedTurnSelectedRouteAdmission,initialHttpEgressState,HTTP_EVIDENCE_FENCE} from "@agent-teams/agent-execution/composition";
import {createContainedTurnLinuxRouteBinding} from "../../dist/composition/contained-turn-linux-route-binding.js";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {createLinuxCodexDeploymentResources, type LinuxCodexDeploymentInfrastructure} from "../../dist/composition/linux-codex-deployment.js";
import {createContainedTurnCurrentEgressOwners} from "../../dist/composition/contained-turn-current-egress-owners.js";
import { createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate, canonicalEgressValue } from "@agent-teams/runtime-security/composition";
import {bindContainedTurnHttpRuntimeSecurity} from "../../dist/composition/contained-turn-http-runtime-security.js";
import {fixture, digest, changed} from "../contained-turn-current-egress-owners.fixture.ts";
import {SYNTHETIC_LOOPBACK_CA} from "../support/external/agent-execution/fixtures/http-egress-tls/synthetic-loopback-certificates.ts";

/** Simulation: acknowledged feature receipts and PG query replies are fixtures.
 * PA route validation, RS current owner/signer, and HTTP adapters are real source.
 * No committed claim, Docker launch, DNS request, provider or live DB is exercised.
 */
const setup = async (dynamicOperations = false, closure = {providerAdapter: "adapter-1", binaryClosure: "binary-1"}, gateOverrides: Record<string, unknown> = {}) => {
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
  const selectionCallbacks: string[] = [];
  const renderingOwners: {closed: boolean; disposals: number; cancel(): void; expire(): void}[] = [];
  const factoryState = {fail: false, malformed: false, reuse: false};
  let previousOwner: ReturnType<LinuxCodexDeploymentInfrastructure["createProviderAccess"]> | undefined;
  const rsReader = dynamicOperations ? {async readAuthority(key: {operationId: string}) {
    assert.equal(this, rsReader); assert.equal(key.operationId, f.state.head.authority!.operationId);
    return f.state.head;
  }} : f.rs;
  const infrastructure: LinuxCodexDeploymentInfrastructure = {imageInitLock: {} as never, cleanupMilliseconds: 1000,
    sourceRevision: "a".repeat(40), deploymentId: "deployment-simulation", pool: pool as never,
    dns: {resolverIdentity: "resolver", resolverEpoch: "epoch-1", timeoutMs: 1000},
    transport: {certificateAuthorities: [SYNTHETIC_LOOPBACK_CA]}, currentAuthority: {runtimeSecurity: rsReader, providerAccess: f.pa},
    currentPolicy(ack) {
      selectionCallbacks.push("policy");
      const {scope: rsScope, operationId, providerId, authorityGeneration, claimBindingDigest, ...facts} = ack.acceptedDispatch.authority!;
      const operation = {scope: {...rsScope, operationId}, providerId, authorityGeneration, claimBindingDigest};
      const acceptedDispatch = {headVersion: ack.acceptedDispatch.headVersion, authority: {...facts, operation}};
      // Explicit synthetic approval, never deployment policy provisioning.
      return {...f.input, approval: {ruleRevision: f.input.rule.revision,
        bindingDigest: digest(canonicalEgressValue({domain: "rs-current-egress-rule/v1", operation, acceptedDispatch, rule: f.input.rule}))}};
    },
    createProviderAccess(selectedInput, acknowledged) {
      selectionCallbacks.push("rendering");
      assert.equal(this, infrastructure);
      assert.equal(selectedInput.kernel.operationId, acknowledged.input.subject.operationId);
      assert.equal(selectedInput.kernel.custodyId, acknowledged.input.subject.custodyId);
      if (factoryState.reuse && previousOwner !== undefined) {return previousOwner;}
      if (factoryState.fail) {throw new Error("factory failure before allocation");}
      const cancellation = new AbortController();
      let now = 0;
      const deadline = 10;
      const state = {closed: false, disposals: 0,
        cancel() {cancellation.abort();}, expire() {now = deadline;}};
      renderingOwners.push(state);
      const owner = {authorization: {}, rendering: {async render() {
        state.closed ||= cancellation.signal.aborted || now >= deadline;
        return {kind: state.closed ? "denied" : "unsupported"};
      }}, dispose() {assert.equal(this, owner); state.disposals++; state.closed = true;}};
      if (factoryState.malformed) {Object.defineProperty(owner, "rendering", {get() {throw new Error("must not invoke accessor");}});}
      previousOwner = owner as never;
      return owner as never;
    },
    authorities: {} as never, signer: {keyRef: "synthetic-key", keyGeneration: "1", signerRevision: "2",
      clock: {read: () => ({authorityId: "control", epoch: "epoch-1", controlTime: 1000})}},
    clock: {now: () => 100, within: async (_deadline, work) => work()},
    recipe({kernel: selectedKernel}) {
      selectionCallbacks.push("recipe");
      recipes++;
      const node = createNodeDockerDeploymentRecipe({enginePolicy: dockerPolicy("/synthetic"),
        routeSubject: {operationId: selectedKernel.operationId, attemptId: selectedKernel.attemptId,
          custodyId: selectedKernel.custodyId, executionGenerationId: selectedKernel.executionGenerationId,
          authorityVectorDigest: selectedKernel.authorityVectorDigest, hostBootId: selectedKernel.hostBootId},
        custodyJournalRoot: "/synthetic/custody", resourceJournalRoot: "/synthetic/resource",
        nsenter: {path: "/synthetic/nsenter", sha256: "a".repeat(64)}, nft: {path: "/synthetic/nft", sha256: "b".repeat(64)},
        consumption: {directory: {path: "/synthetic/consumption", device: "1", inode: "1"},
          readEnvelope() {throw new Error("synthetic deployment never opens consumption");}}});
      return {...node, nativeFiles: {}, connection: {}, hostSession: {}} as never;
    },
  };
  const qualificationTarget = {provider: "codex", ...closure, platform: `${process.platform}-${process.arch}`,
    credentialRoute: "synthetic-endorsed-route", storageTopology: "synthetic-storage", transportTopology: "synthetic-http", failureDomain: "single-host"};
  const gateBinding = await createContainedTurnLinuxRouteBinding({current: f.endorsed, provider: "codex", campaign: {
    operationId: subject.operationId, attemptId: subject.attemptId, custodyId: subject.custodyId,
    hostBootId: subject.hostBootId, executionGenerationId: subject.executionGenerationId, authorityVectorDigest: accepted.acceptedAuthorityVectorDigest, sourceRevision: infrastructure.sourceRevision,
    adapterRevision: closure.providerAdapter, binaryRevision: closure.binaryClosure, capabilityManifestRevision: adapterSnapshot.capabilityManifestRevision,
  } as never});
  const routeEnforcement = createContainedTurnRouteEnforcement({qualificationTarget, enginePolicy: dockerPolicy("/synthetic"), binding: {...gateBinding, ...gateOverrides},
    engine: {inspect: async () => {throw new Error("synthetic gate never opens a route");}} as never,
    nsenter: {path: "/synthetic/nsenter", sha256: "a".repeat(64)}, nft: {path: "/synthetic/nft", sha256: "b".repeat(64)}});
  const deployment = createLinuxCodexDeploymentResources(infrastructure, subject, routeEnforcement);
  const claimed = new Set<string>();
  const store = deployment.bindOperationStore({
    async claimPreparedDispatch(request: {subject: typeof subject}) {
      const key = request.subject.custodyId;
      if (claimed.has(key)) {return {kind: "observed_claim"};}
      claimed.add(key); return {kind: "claimed"};
    },
    async retireDispatchPreparation() {return {kind: "retired"};},
  } as never);
  const claim = () => store.claimPreparedDispatch({subject: input.subject} as never);
  const outcomes = {pa: {kind: "consumed", receipt: receipt("pa")}, rs: {kind: "consumed", receipt: receipt("rs")}};
  const ports = deployment.bindAuthority({providerAccess: {async consumeForDispatch() {return outcomes.pa;}, async settleConsumedGrant() {return {kind: "settled"};}},
    security: {async consumeForDispatch() {return outcomes.rs;}, async settleConsumedGrant() {return {kind: "settled"};}}} as never);
  const pa = () => ports.providerAccess.consumeForDispatch({...input, grantRequestId: "pa-grant"} as never);
  const rs = async () => {const outcome = await ports.security.consumeForDispatch(input as never); await claim(); return outcome;};
  const select = (value = kernel) => deployment.resources.select({kernel: value, record: {}} as never);
  return {selectionCallbacks, renderingOwners, factoryState, f, calls, rows, outcomes, input, kernel, pa, rs, claim, ports, store, infrastructure, deployment, routeEnforcement, select, recipes: () => recipes};
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
    assert.deepEqual(t.selectionCallbacks, ["policy", "recipe", "rendering"]);
    assert.equal(selected.preparation, selected.route.preparation);
    assert.ok(readContainedTurnSelectedRouteAdmission(selected.route));
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
    assert.equal(hash([Buffer.from("abc")]), `sha256:${createHash("sha256").update("abc").digest("hex")}`);
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


test("simulation: 130 completed selections release payloads and old consumed receipts cannot rearm a durable observed claim", async () => {
  const t = await setup(true);
  const first = structuredClone({input: t.input, kernel: t.kernel, outcomes: t.outcomes, head: t.f.state.head});
  try {
    for (let index = 0; index < 130; index++) {
      const operationId = `operation-${index}`; const custodyId = `custody-${index}`;
      Object.assign(t.input.subject, {operationId, custodyId}); Object.assign(t.kernel, {operationId, custodyId});
      t.outcomes.pa.receipt.operationId = operationId; t.outcomes.rs.receipt.operationId = operationId;
      t.f.state.head = {...t.f.state.head, authority: {...t.f.state.head.authority!, operationId}};
      await t.pa(); await t.rs(); t.select();
      assert.throws(() => t.select(), /acknowledged/u);
      if (index === 0) {Object.assign(first, structuredClone({input: t.input, kernel: t.kernel, outcomes: t.outcomes, head: t.f.state.head}));}
    }
    Object.assign(t.input, first.input); Object.assign(t.kernel, first.kernel);
    Object.assign(t.outcomes, first.outcomes); t.f.state.head = first.head;
    await t.pa(); await t.rs();
    assert.throws(() => t.select(), /acknowledged/u);
    assert.equal(t.recipes(), 130);
  } finally {t.deployment.dispose(); t.f.dispose();}
});

test("simulation: abandoned incomplete joins and preparation retirement release capacity", async () => {
  const t = await setup();
  try {
    for (let index = 0; index < 130; index++) {
      t.input.subject.custodyId = `abandoned-${index}`;
      await t.pa();
      if (index % 2 === 0) {
        await t.ports.providerAccess.settleConsumedGrant({receipt: t.outcomes.pa.receipt,
          disposition: "abandoned_without_claim", settlementRequestId: `settlement-${index}`} as never);
      } else {
        await t.store.retireDispatchPreparation({preparationToken: t.input.subject.preparationToken,
          authority: {operationId: t.input.subject.operationId, scope: t.input.subject.scope}} as never);
      }
    }
    t.input.subject.custodyId = t.kernel.custodyId;
    await t.pa(); await t.rs(); t.select();
    assert.equal(t.recipes(), 1);
  } finally {t.deployment.dispose(); t.f.dispose();}
});

test("simulation: disposal clears pending selection and late acknowledgements cannot revive it", async () => {
  const t = await setup();
  try {
    await t.pa(); t.deployment.dispose(); await t.rs();
    assert.throws(() => t.select(), /acknowledged/u);
    await t.pa(); await t.rs(); assert.throws(() => t.select(), /acknowledged/u);
    assert.equal(t.recipes(), 0);
  } finally {t.f.dispose();}
});

test("simulation: construction captures readers, methods, config and borrowed receivers", async () => {
  const t = await setup();
  const originalReaders = t.infrastructure.currentAuthority;
  let replacements = 0;
  const replaced = (): never => {replacements++; throw new Error("replacement owner invoked");};
  try {
    Object.assign(t.infrastructure, {currentAuthority: {runtimeSecurity: {readAuthority: replaced}, providerAccess: {readCurrent: replaced}},
      currentPolicy: replaced, recipe: replaced, createProviderAccess: replaced, pool: {connect: replaced}, deploymentId: "replacement", clock: {now: replaced, within: replaced}});
    Object.assign(t.infrastructure.signer, {keyRef: "replacement"});
    Object.assign(t.infrastructure.dns, {resolverIdentity: "replacement"});
    const originalRead = originalReaders.runtimeSecurity.readAuthority;
    Object.assign(originalReaders.runtimeSecurity, {readAuthority: replaced});
    await t.pa(); await t.rs();
    const selected = t.select();
    assert.equal(selected.signer.keyRef, "synthetic-key");
    assert.equal(selected.broker.clock.now(), 100);
    const head = t.f.state.head.authority!;
    const key = {scope: head.scope, operationId: head.operationId, providerId: head.providerId, authorityGeneration: head.authorityGeneration};
    assert.deepEqual(await selected.currentAuthority.runtimeSecurity.readAuthority(key),
      await originalRead.call(originalReaders.runtimeSecurity, key));
    assert.equal(replacements, 0); assert.equal(t.recipes(), 1);
    // Disposing the composition does not close the borrowed authority owners.
    t.deployment.dispose();
    assert.ok(await selected.currentAuthority.providerAccess.readCurrent());
  } finally {t.f.dispose();}
});

test("simulation: infrastructure accessors and proxies are refused without invocation", async () => {
  const t = await setup();
  let reads = 0;
  try {
    const accessor = {...t.infrastructure};
    Object.defineProperty(accessor, "currentAuthority", {get() {reads++; return t.infrastructure.currentAuthority;}});
    assert.throws(() => createLinuxCodexDeploymentResources(accessor, t.input.subject, t.routeEnforcement), /accessor/u);
    const proxy = new Proxy(t.infrastructure, {ownKeys() {reads++; return [];}, get() {reads++;}});
    assert.throws(() => createLinuxCodexDeploymentResources(proxy, t.input.subject, t.routeEnforcement), /unavailable/u);
    const nested = {...t.infrastructure, currentAuthority: new Proxy(t.infrastructure.currentAuthority, {ownKeys() {reads++; return [];}})};
    assert.throws(() => createLinuxCodexDeploymentResources(nested, t.input.subject, t.routeEnforcement), /unavailable/u);
    assert.equal(reads, 0);
  } finally {t.deployment.dispose(); t.f.dispose();}
});


for (const dimension of ["providerAdapter", "binaryClosure"] as const) {
  test(`simulation: nominal gate for closure A cannot allocate the selected ${dimension} B recipe`, async () => {
    const t = await setup(false, {providerAdapter: "adapter-1", binaryClosure: "binary-1", [dimension]: "foreign-closure"});
    try {
      await t.pa(); await t.rs();
      assert.throws(() => t.select(), /route qualification/u);
      assert.equal(t.recipes(), 0); assert.deepEqual(t.calls, []);
      assert.deepEqual(t.selectionCallbacks, []);
    } finally {t.deployment.dispose(); t.f.dispose();}
  });
}

test("simulation: deployment selection requires an authentic nominal route capability", async () => {
  const t = await setup();
  try {
    for (const candidate of [{...t.routeEnforcement}, new Proxy(t.routeEnforcement, {}), undefined]) {
      assert.throws(() => createLinuxCodexDeploymentResources(t.infrastructure, t.input.subject, candidate as never), /qualification unavailable/u);
    }
    assert.equal(t.recipes(), 0);
  } finally {t.deployment.dispose(); t.f.dispose();}
});


test("simulation: live incomplete joins retain the 64 entry bound and retirement recovers capacity", async () => {
  const t = await setup(true);
  let firstReceipt: typeof t.outcomes.pa.receipt | undefined;
  const operation = (index: number): void => {
    const operationId = `pending-operation-${index}`; const custodyId = `pending-custody-${index}`;
    Object.assign(t.input.subject, {operationId, custodyId}); Object.assign(t.kernel, {operationId, custodyId});
    t.outcomes.pa.receipt.operationId = operationId; t.outcomes.rs.receipt.operationId = operationId;
    t.f.state.head = {...t.f.state.head, authority: {...t.f.state.head.authority!, operationId}};
  };
  try {
    for (let index = 0; index < 64; index++) {
      operation(index); await t.pa();
      if (index === 0) {firstReceipt = structuredClone(t.outcomes.pa.receipt);}
    }
    operation(64); await t.pa(); await t.rs();
    assert.throws(() => t.select(), /acknowledged/u); assert.equal(t.recipes(), 0);
    await t.ports.providerAccess.settleConsumedGrant({receipt: firstReceipt,
      disposition: "abandoned_without_claim", settlementRequestId: "settle-first"} as never);
    operation(65); await t.pa(); await t.rs(); t.select();
    assert.equal(t.recipes(), 1);
  } finally {t.deployment.dispose(); t.f.dispose();}
});

for (const field of ["providerRouteRef", "providerAccountRef", "accessRef", "bindingRevision", "credentialBindingRef",
  "credentialBindingDigest", "credentialGeneration", "routeRevision", "hostBootId", "sourceRevision", "capabilityManifestRevision"] as const) {
  test(`simulation: gated owner ${field} mismatch refuses before allocation`, async () => {
    const t = await setup(false, undefined, {[field]: "foreign"});
    try {
      await t.pa(); await t.rs();
      assert.throws(() => t.select(), /qualification/u);
      assert.equal(t.recipes(), 0); assert.deepEqual(t.calls, []);
      assert.deepEqual(t.selectionCallbacks, []);
    } finally {t.deployment.dispose(); t.f.dispose();}
  });
}

test("simulation: a copied owner cannot authorize a deployment", async () => {
  const t = await setup();
  try {
    assert.throws(() => createLinuxCodexDeploymentResources(t.infrastructure, t.input.subject,
      {...t.routeEnforcement}), /qualification/u);
    assert.equal(t.recipes(), 0); assert.deepEqual(t.calls, []);
  } finally {t.deployment.dispose(); t.f.dispose();}
});

for (const cutoff of ["cancel", "expire"] as const) {
  test(`simulation: operation rendering owners isolate ${cutoff} and dispose once`, async () => {
    const t = await setup(true);
    try {
      await t.pa(); await t.rs(); const first = t.select();
      Object.assign(t.input.subject, {operationId: "second", custodyId: "second-custody"});
      Object.assign(t.kernel, {operationId: "second", custodyId: "second-custody"});
      t.outcomes.pa.receipt.operationId = "second"; t.outcomes.rs.receipt.operationId = "second";
      t.f.state.head = {...t.f.state.head, authority: {...t.f.state.head.authority!, operationId: "second"}};
      await t.pa(); await t.rs(); const second = t.select();
      assert.notEqual(first.authorities.providerAccess, second.authorities.providerAccess);
      if (cutoff === "cancel") {t.renderingOwners[0]!.cancel();}
      else {t.renderingOwners[0]!.expire();}
      assert.equal((await first.authorities.providerAccess.rendering.render({})).kind, "denied");
      assert.equal((await second.authorities.providerAccess.rendering.render({})).kind, "unsupported");
      first.dispose?.(); first.authorities.providerAccess.dispose();
      second.authorities.providerAccess.dispose(); second.dispose?.();
      assert.deepEqual(t.renderingOwners.map(owner => owner.disposals), [1, 1]);
      await t.pa(); await t.rs(); assert.throws(() => t.select(), /acknowledged/u);
      assert.equal(t.renderingOwners.length, 2);
    } finally {t.deployment.dispose(); t.f.dispose();}
  });
}

test("simulation: rendering selection construction failure cleans up and cannot replay", async () => {
  for (const fault of ["fail", "malformed"] as const) {
    const t = await setup();
    try {
      t.factoryState[fault] = true;
      await t.pa(); await t.rs(); assert.throws(() => t.select());
      assert.deepEqual(t.renderingOwners.map(owner => owner.disposals), fault === "fail" ? [] : [1]);
      t.factoryState[fault] = false;
      await t.pa(); await t.rs(); assert.throws(() => t.select(), /acknowledged/u);
      assert.equal(t.renderingOwners.length, fault === "fail" ? 0 : 1);
    } finally {t.deployment.dispose(); t.f.dispose();}
  }
});

test("simulation: factory cannot share a concrete owner with another operation", async () => {
  const t = await setup(true);
  try {
    await t.pa(); await t.rs(); const first = t.select();
    t.factoryState.reuse = true;
    Object.assign(t.input.subject, {operationId: "second", custodyId: "second-custody"});
    Object.assign(t.kernel, {operationId: "second", custodyId: "second-custody"});
    t.outcomes.pa.receipt.operationId = "second"; t.outcomes.rs.receipt.operationId = "second";
    t.f.state.head = {...t.f.state.head, authority: {...t.f.state.head.authority!, operationId: "second"}};
    await t.pa(); await t.rs(); assert.throws(() => t.select(), /already selected/u);
    assert.equal((await first.authorities.providerAccess.rendering.render({})).kind, "unsupported");
    assert.equal(t.renderingOwners[0]!.disposals, 0);
    first.dispose?.(); assert.equal(t.renderingOwners[0]!.disposals, 1);
    assert.throws(() => t.select(), /acknowledged/u);
    assert.equal(t.renderingOwners.length, 1);
  } finally {t.deployment.dispose(); t.f.dispose();}
});
