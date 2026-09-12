import assert from "node:assert/strict";
import test from "node:test";
import { createContainedTurnOperationProviderAccessPort, createContainedTurnSecurityAcceptancePort, createContainedTurnFeature, nativeHttpRequestProfile,applyContainedTurnPostgresSchema,containedTurnIdentity } from "@agent-teams/agent-execution/composition";
import { createPostgresRouteSelectionOwner, createPostgresCurrentProviderAccess, createPostgresOperationDispatchConsumption, createPostgresMaterializationRepository } from "@agent-teams/provider-access/composition";
import { issuanceFixture, fixtureHash } from "./support/external/provider-access/features/contained-turn-access/operation-dispatch-test-fixture.ts";
import { validateDisposablePostgresUrl } from "./support/external/provider-access/features/contained-turn-access/postgres-materialization-url.fixtures.ts";
import { createDispatchAcceptanceFeature, createNodeSha256DispatchDigest, createPostgresDispatchAcceptanceStore, createPostgresDispatchConsumptionRepository } from "@agent-teams/runtime-security/composition";
import { adapterSnapshot, manifest } from "./support/external/agent-execution/features/contained-agent-turn/support/contained-turn-fixture-snapshots.ts";
import { joinedAeSubmit } from "./support/joined-authority-fixture.ts";

import {createContainedTurnFeatureFromProviderAccess} from "../dist/composition/contained-turn-feature-composition.js";
import type {OwnerSubmitOutcome, OwnerObservationOutcome} from "../dist/composition/contained-turn-composition-types.js";
import {createPostgresCurrentAuthorityFixture} from "./support/postgres-current-authority-fixture.ts";

import {selection as routeSelection} from "./support/external/provider-access/features/contained-turn-access/route-selection-fixture.ts";
import {postgresDeploymentSelection} from "./support/postgres-deployment-selection-fixture.ts";
import {captureContainedTurnCurrentAuthority, snapshotContainedTurnAuthority} from "../dist/composition/contained-turn-current-authority.js";

const databaseUrl = process.env.AE_ACL_POSTGRES_DISPOSABLE_URL;
// A skip only checks loading/type definitions. Orchestrator owns execution on a new disposable database.
test("joined AE feature with actual PostgreSQL PA current/v2 and RS acceptance/publication owners", {skip: process.platform !== "linux" ? "descriptor-relative custody requires Linux" : !databaseUrl, timeout: 60_000}, async t => {
  const {Pool} = await import("pg");
  const pool = new Pool({connectionString: validateDisposablePostgresUrl(databaseUrl!), max: 8, connectionTimeoutMillis: 2000,
    query_timeout: 5000, idleTimeoutMillis: 1000, application_name: "ar69-authority-acl-disposable"});
  t.after(() => pool.end());
  assert.equal((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('agent_execution','provider_access','runtime_security_dispatch_v1','runtime_security_dispatch_acceptance_v1')")).rowCount, 0, "Requires a new disposable owner database");
  await applyContainedTurnPostgresSchema(pool);
  const now = Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0].now);
  const issuance = issuanceFixture(now);
  const pa = createPostgresOperationDispatchConsumption(pool, issuance); t.after(pa.dispose);
  await pa.control.migrate();
  const material = createPostgresMaterializationRepository(pool); t.after(material.dispose);
  assert.equal(await material.replaceBinding(issuance.binding, 0), 1);
  await pa.control.provisionIssuance();
  const scope = Object.freeze({projectId: issuance.binding.projectId, tenantId: issuance.binding.tenantId});
  const current = createPostgresCurrentProviderAccess(pool, {...scope, provider: "codex", scopeDigest: issuance.binding.scopeDigest}); t.after(current.dispose);
  const providerAccess = createContainedTurnOperationProviderAccessPort(Object.freeze({...current.providerAccess, dispatchConsumption: pa.dispatchConsumption}));
  const digest = createNodeSha256DispatchDigest();
  const options = {pool, connectTimeoutMs: 2000, queryTimeoutMs: 5000, transactionTimeoutMs: 10000};
  const repository = createPostgresDispatchConsumptionRepository({...options, digest}); t.after(repository.close);
  const decisions = createPostgresDispatchAcceptanceStore(options); t.after(decisions.close);
  await repository.migrate(); await decisions.migrate();
  const intent = Object.freeze({mode: "analysis" as const, prompt: "Independently provisioned disposable PostgreSQL joined turn"});
  const rule = Object.freeze({scope: Object.freeze({...scope, scopeDigest: issuance.binding.scopeDigest}), providerId: "codex",
    intentDigest: fixtureHash({purpose: "contained_turn_acceptance_intent_v1", intent, version: 1}), policyRevision: "security-authority:pg-joined:7",
    constraintsDigest: fixtureHash({adapterSnapshot, capabilityManifest: manifest, intentMode: intent.mode}),
    containmentPolicyDigest: fixtureHash({policy: "independent PG containment 7"}), enabled: true, revoked: false,
    validFromControlTime: now, claimBeforeControlTime: now + 120000});
  let enabled = true;
  const owner = createDispatchAcceptanceFeature({repository, decisions, policy: {async read() {return enabled ? rule : undefined;}}, clock: {now: () => Date.now()}, digest});
  const security = createContainedTurnSecurityAcceptancePort(owner, Object.freeze({policyRevision: rule.policyRevision}));
  const submit = joinedAeSubmit(providerAccess, security, scope, intent);
  const before = (await pool.query("SELECT binding,head_version FROM provider_access.materialization_owner")).rows;
  const [a, b] = await Promise.all([submit("pg-A"), submit("pg-B")]);
  assert.ok(a.handoff); assert.ok(b.handoff);
  assert.equal(a.ae.providerCalls.value, 1); assert.equal(b.ae.providerCalls.value, 1);
  assert.equal((await pool.query("SELECT count(*) AS n FROM provider_access.dispatch_operation_record_v2 WHERE kind='consumption'")).rows[0].n, "2");
  assert.equal((await pool.query("SELECT count(*) AS n FROM runtime_security_dispatch_v1.consumptions")).rows[0].n, "2");
  assert.deepEqual((await pool.query("SELECT binding,head_version FROM provider_access.materialization_owner")).rows, before);
  const rebuilt = createPostgresOperationDispatchConsumption(pool, issuance); t.after(rebuilt.dispose);
  const reconstructed = createContainedTurnOperationProviderAccessPort(Object.freeze({...current.providerAccess, dispatchConsumption: rebuilt.dispatchConsumption}));
  const historical = await providerAccess.consumeForDispatch(a.handoff);
  assert.deepEqual(await reconstructed.consumeForDispatch(a.handoff), historical);
  // Exercise the current product composition with actual AE acceptance and final claim.
  // The provider/custody boundary is explicitly synthetic and returns unknown, never live success.
  const routeOwner = createPostgresRouteSelectionOwner(pool, {...routeSelection(), binding: issuance.binding,
    descriptor: nativeHttpRequestProfile("codex-chatgpt-responses/v1")!});
  t.after(routeOwner.dispose);
  await routeOwner.control.migrate();
  await routeOwner.control.endorse(1);
  const otherKey = {scope: {...scope, scopeDigest: issuance.binding.scopeDigest}, providerId: "codex",
    operationId: a.handoff.subject.operationId,
    authorityGeneration: a.handoff.subject.runtimeSecurityExpectation.authorityGeneration};
  assert.equal((await repository.readAuthority(otherKey)).authority!.operationId, otherKey.operationId);
  const currentRuns = [];
  for (const id of ["current-pg-A", "current-pg-B"]) {
    let deployment!: ReturnType<typeof postgresDeploymentSelection>;
    let revokedChecks = 0;
    const harness = await createPostgresCurrentAuthorityFixture(pool, scope, undefined, async operation => {
      const {kernel, acknowledged, create} = await deployment.checkClaim(operation);
      // Revoke a genuinely published head through the RS owner, then replay
      // the historical consumptions into a fresh acknowledgement join.
      const key = {scope: {...scope, scopeDigest: issuance.binding.scopeDigest}, providerId: "codex",
        operationId: acknowledged.subject.operationId,
        authorityGeneration: acknowledged.subject.runtimeSecurityExpectation.authorityGeneration};
      await repository.revokeAuthority(key, "1");
      assert.equal((await repository.readAuthority(key)).authority!.revoked, true);
      const revoked = create();
      const ports = revoked.bind({providerAccess, security});
      assert.equal((await ports.providerAccess.consumeForDispatch({...acknowledged, grantRequestId: acknowledged.subject.providerAccessRequest.grantRequestId})).kind, "consumed");
      assert.equal((await ports.security.consumeForDispatch(acknowledged)).kind, "consumed");
      assert.throws(() => revoked.take(kernel), /acknowledged/u);
      revokedChecks++;
    });
    t.after(harness.cleanup);
    const dependencies = {...harness.dependencies, authority: "current" as const,
      providerAccess: Object.freeze({...current.providerAccess, dispatchConsumption: pa.dispatchConsumption}),
      security: Object.freeze({acceptance: owner, profile: Object.freeze({policyRevision: rule.policyRevision})})};
    const captured = snapshotContainedTurnAuthority(dependencies);
    assert.equal(captured.selection.authority, "current");
    assert.ok(captured.selection.authority === "current");
    deployment = postgresDeploymentSelection(captureContainedTurnCurrentAuthority(captured.selection, captured.providerAccess),
      {runtimeSecurity: repository, providerAccess: routeOwner}, otherKey);
    const feature = createContainedTurnFeature(Object.freeze({...harness.dependencies, ...deployment.ports,
      operationStore: deployment.bindStore(harness.dependencies.operationStore)}));
    const request = {commandId: `command:${id}`, expectedProvider: "codex", scope, intent};
    const result = await feature.submit.execute(request) as OwnerSubmitOutcome;
    assert.equal(result.status, "observed");
    assert.ok(result.status === "observed");
    assert.equal(result.turn.status, "reconcile_required");
    assert.equal(deployment.checks, 1, "deployment selection assertions ran after the durable claim");
    assert.equal(revokedChecks, 1, "revoked current head remained unavailable despite historical receipts");
    assert.deepEqual([harness.counts.provider, harness.counts.starts, harness.counts.boundaries], [1, 1, 0]);
    const rebuiltStore = harness.rebuildStore();
    const persisted = await rebuiltStore.durable.read({operationId: containedTurnIdentity("operation", result.turn.operationId), scope});
    assert.ok(persisted);
    assert.equal(persisted.dispatch.kind, "claimed");
    assert.equal(persisted.reconciliation.kind, "required", "unknown provider outcome remains durable debt");
    assert.notEqual(persisted.terminal.kind, "final", "synthetic custody supplies no terminal truth");
    const replay = createContainedTurnFeatureFromProviderAccess({...dependencies, operationStore: rebuiltStore.operationStore,
      providerAccess: Object.freeze({...current.providerAccess, dispatchConsumption: rebuilt.dispatchConsumption})});
    assert.equal((await replay.observe.execute({operationId: result.turn.operationId, scope}) as OwnerObservationOutcome).status, "observed");
    assert.equal((await replay.submit.execute(request) as OwnerSubmitOutcome).status, "observed");
    assert.deepEqual([harness.counts.provider, harness.counts.starts, harness.counts.boundaries], [1, 1, 0]);
    currentRuns.push(result.turn.operationId);
  }
  assert.notEqual(currentRuns[0], currentRuns[1]);
  assert.equal((await pool.query("SELECT count(*) AS n FROM agent_execution.contained_turn_operation_v1")).rows[0].n, "2");
  assert.equal((await pool.query("SELECT count(*) AS n FROM provider_access.dispatch_operation_record_v2 WHERE kind='publication'")).rows[0].n, "4");
  assert.equal((await pool.query("SELECT count(*) AS n FROM provider_access.dispatch_operation_record_v2 WHERE kind='consumption'")).rows[0].n, "4");
  assert.equal((await pool.query("SELECT count(*) AS n FROM runtime_security_dispatch_v1.consumptions")).rows[0].n, "4");
  assert.deepEqual((await pool.query("SELECT binding,head_version FROM provider_access.materialization_owner")).rows, before);
  const negative = async (id: string, expectedConsumptions: readonly [string, string], afterReservation?: () => Promise<void>) => {
    const harness = await createPostgresCurrentAuthorityFixture(pool, scope, afterReservation);
    t.after(harness.cleanup);
    const feature = createContainedTurnFeatureFromProviderAccess({...harness.dependencies, authority: "current",
      providerAccess: Object.freeze({...current.providerAccess, dispatchConsumption: pa.dispatchConsumption}),
      security: Object.freeze({acceptance: owner, profile: Object.freeze({policyRevision: rule.policyRevision})})});
    const request = {commandId: `command:${id}`, expectedProvider: "codex", scope, intent};
    const result = await feature.submit.execute(request) as OwnerSubmitOutcome;
    if (afterReservation === undefined) {assert.equal(result.status, "denied");}
    else {
      assert.ok(result.status === "observed");
      assert.ok(harness.counts.released > 0, "revoked reservation must be cleaned up");
      const persisted = await harness.durable.read({operationId: containedTurnIdentity("operation", result.turn.operationId), scope});
      assert.ok(persisted);
      assert.notEqual(persisted.dispatch.kind, "claimed");
      await feature.observe.execute({operationId: result.turn.operationId, scope});
      await feature.submit.execute(request);
    }
    assert.deepEqual([harness.counts.provider, harness.counts.starts, harness.counts.boundaries], [0, 0, 0]);
    assert.equal((await pool.query("SELECT count(*) AS n FROM provider_access.dispatch_operation_record_v2 WHERE kind='consumption'")).rows[0].n, expectedConsumptions[0]);
    assert.equal((await pool.query("SELECT count(*) AS n FROM runtime_security_dispatch_v1.consumptions")).rows[0].n, expectedConsumptions[1]);
  };
  enabled = false;
  await negative("current-pg-policy-denied", ["4", "4"]);
  assert.equal((await submit("pg-policy-revoked")).ae.providerCalls.value, 0);
  // Owners consume independently: retain the other owner's partial success on revocation.
  enabled = true;
  await negative("current-pg-late-policy-revocation", ["5", "4"], async () => {enabled = false;});
  enabled = true;
  await negative("current-pg-late-revocation", ["5", "5"], async () => {
    assert.equal(await material.replaceBinding({...issuance.binding, revocation: "revoked"}, 1), 2);
  });
  assert.deepEqual(await reconstructed.consumeForDispatch(a.handoff), historical, "historical consumption survives revocation without another start");
});
