import assert from "node:assert/strict";
import test from "node:test";
import { createContainedTurnOperationProviderAccessPort, createContainedTurnSecurityAcceptancePort } from "../../../dist/composition.js";
import { createPostgresCurrentProviderAccess, createPostgresOperationDispatchConsumption } from "../../../../provider-access/dist/composition.js";
import { createPostgresMaterializationRepository } from "../../../../provider-access/dist/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-repository.js";
import { issuanceFixture, fixtureHash } from "../../../../provider-access/tests/features/contained-turn-access/operation-dispatch-test-fixture.ts";
import { validateDisposablePostgresUrl } from "../../../../provider-access/tests/features/contained-turn-access/postgres-materialization-url.fixtures.ts";
import { createDispatchAcceptanceFeature, createNodeSha256DispatchDigest, createPostgresDispatchAcceptanceStore } from "../../../../runtime-security/dist/composition.js";
import { createPostgresDispatchConsumptionRepository } from "../../../../runtime-security/dist/features/contained-turn-dispatch-authority/adapters/outbound/postgres/dispatch-consumption-repository.js";
import { adapterSnapshot, manifest } from "./support/contained-turn-fixture-snapshots.ts";
import { joinedAeSubmit } from "./support/joined-authority-fixture.ts";

const databaseUrl = process.env.AE_ACL_POSTGRES_DISPOSABLE_URL;
// A skip only checks loading/type definitions. Orchestrator owns execution on a new disposable database.
test("joined AE feature with actual PostgreSQL PA current/v2 and RS acceptance/publication owners", {skip: !databaseUrl, timeout: 60_000}, async t => {
  const {Pool} = await import("pg");
  const pool = new Pool({connectionString: validateDisposablePostgresUrl(databaseUrl!), max: 8, connectionTimeoutMillis: 2000,
    query_timeout: 5000, idleTimeoutMillis: 1000, application_name: "ar69-authority-acl-disposable"});
  t.after(() => pool.end());
  assert.equal((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('provider_access','runtime_security_dispatch_v1','runtime_security_dispatch_acceptance_v1')")).rowCount, 0, "Requires a new disposable owner database");
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
  enabled = false;
  assert.equal((await submit("pg-policy-revoked")).ae.providerCalls.value, 0);
  assert.equal(await material.replaceBinding({...issuance.binding, revocation: "revoked"}, 1), 2);
  assert.deepEqual(await reconstructed.consumeForDispatch(a.handoff), historical, "historical consumption survives revocation without another start");
});
