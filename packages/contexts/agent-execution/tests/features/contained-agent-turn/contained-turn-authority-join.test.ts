import assert from "node:assert/strict";
import test from "node:test";
import { createContainedTurnOperationProviderAccessPort, createContainedTurnSecurityAcceptancePort } from "../../../dist/composition.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { acceptedProviderPreparation } from "../../../dist/features/contained-agent-turn/composition/accepted-authority-anti-corruption.js";
import { operationHarness, fixtureHash } from "../../../../provider-access/tests/features/contained-turn-access/operation-dispatch-test-fixture.ts";
import { createHarness } from "../../../../runtime-security/tests/postgres-dispatch.fixtures.ts";
import { createDispatchAcceptanceFeature, createNodeSha256DispatchDigest, createPostgresDispatchAcceptanceStore } from "../../../../runtime-security/dist/composition.js";
import { joinedAeSubmit } from "./support/joined-authority-fixture.ts";
import { adapterSnapshot, manifest } from "./support/contained-turn-fixture-snapshots.ts";

const intent = Object.freeze({mode: "analysis" as const, prompt: "Independently approved synthetic joined turn"});
const fixture = async (policyConstraints?: string) => {
  const pa = operationHarness();
  const dispatch = pa.rebuild();
  const rs = createHarness(); rs.setTime(100);
  const decisions = createPostgresDispatchAcceptanceStore({pool: rs.db, connectTimeoutMs: 1000, queryTimeoutMs: 1000, transactionTimeoutMs: 5000});
  await rs.repository.migrate(); await decisions.migrate();
  const scope = Object.freeze({projectId: pa.selection.binding.projectId, tenantId: pa.selection.binding.tenantId});
  // Provisioned before submission; the policy reader never manufactures permission from its argument.
  const rule = Object.freeze({scope: Object.freeze({...scope, scopeDigest: pa.selection.binding.scopeDigest}), providerId: "codex",
    intentDigest: fixtureHash({purpose: "contained_turn_acceptance_intent_v1", intent, version: 1}), policyRevision: "security-authority:joined:7",
    constraintsDigest: policyConstraints ?? fixtureHash({adapterSnapshot, capabilityManifest: manifest, intentMode: intent.mode}),
    containmentPolicyDigest: fixtureHash({policy: "independent containment 7"}), enabled: true, revoked: false,
    validFromControlTime: 50, claimBeforeControlTime: 120100});
  let policy: typeof rule | undefined = rule;
  const owner = createDispatchAcceptanceFeature({repository: rs.repository, decisions,
    policy: {async read() {return policy;}}, clock: {now: () => 100}, digest: createNodeSha256DispatchDigest()});
  const security = createContainedTurnSecurityAcceptancePort(owner, Object.freeze({policyRevision: rule.policyRevision}));
  const providerAccess = createContainedTurnOperationProviderAccessPort(Object.freeze({...pa.current, dispatchConsumption: dispatch.dispatchConsumption}));
  assert.equal(pa.records("publication").length, 0);
  assert.equal(rs.db.tables.decisions.size, 0, "ACL construction performs no evaluation");
  await dispatch.control.provisionIssuance();
  const submit = joinedAeSubmit(providerAccess, security, scope, intent);
  return {pa, dispatch, rs, owner, providerAccess, security, scope, rule, submit,
    revokePolicy: () => {policy = undefined;}};
};

test("actual AE/PA v2/RS acceptance join consumes two operations independently and replays each once", async () => {
  const h = await fixture();
  const original = structuredClone(h.pa.state.binding);
  const [a, b] = await Promise.all([h.submit("joined-A"), h.submit("joined-B")]);
  assert.ok(a.handoff); assert.ok(b.handoff);
  assert.equal(h.pa.records("consumption").length, 2);
  assert.equal(h.rs.db.tables.consumptions.size, 2);
  assert.equal(a.ae.providerCalls.value, 1); assert.equal(b.ae.providerCalls.value, 1);
  assert.deepEqual(h.pa.state.binding, original); assert.equal(h.pa.state.version, 1);
  const ar = await h.providerAccess.consumeForDispatch(a.handoff);
  const br = await h.providerAccess.consumeForDispatch(b.handoff);
  assert.equal(ar.kind, "consumed"); assert.equal(br.kind, "consumed");
  assert.deepEqual(await h.providerAccess.consumeForDispatch(a.handoff), ar);
  assert.equal((await h.security.consumeForDispatch(a.handoff)).kind, "consumed");
  assert.equal(h.pa.records("consumption").length, 2); assert.equal(h.rs.db.tables.consumptions.size, 2);
  const prepared = acceptedProviderPreparation(a.handoff);
  assert.equal(prepared.acceptedBinding.credentialBindingDigest, original.credentialBindingDigest);
  assert.notEqual(prepared.acceptedBinding.credentialBindingDigest, a.handoff.subject.providerAccessExpectation.credentialBindingDigest);
  assert.equal(prepared.acceptedAuthorityDigest, a.handoff.accepted.acceptedAuthorityVectorDigest);
  h.rs.db.assertReleased();
});

test("PA publication lost acknowledgement blocks consumption and provider start without retry", async () => {
  const h = await fixture(); h.pa.state.loseCommit = "publication";
  const a = await h.submit("lost-ack");
  assert.ok(a.handoff); assert.equal(a.ae.providerCalls.value, 0);
  assert.equal(h.pa.records("publication").length, 1); assert.equal(h.pa.records("consumption").length, 0);
  assert.equal((await a.feature.observe.execute({operationId: a.handoff.subject.operationId, scope: h.scope})).status, "observed");
  assert.equal(h.pa.records("consumption").length, 0, "observation never retries publication");
});

test("independently revoked/rotated PA materialization fails closed at the late join", async () => {
  for (const rotated of [false, true]) {
    const h = await fixture();
    const a = await h.submit(`changed-${rotated}`, async () => {
      await h.pa.changeBinding(rotated ? {...h.pa.state.binding, credentialGeneration: 4, bindingRevision: 8, credentialBindingDigest: fixtureHash({rotated: true})} : {...h.pa.state.binding, revocation: "revoked"});
    });
    assert.ok(a.handoff); assert.equal(a.ae.providerCalls.value, 0);
    assert.equal(h.pa.records("consumption").length, 0); assert.equal(h.pa.records("publication").length, 0);
    assert.equal(h.pa.state.version, 2);
  }
});

test("potential AE acceptance cannot publish; genuine current RS policy revocation prevents dispatch", async () => {
  const h = await fixture(); const potential = await h.submit("potential", undefined, true);
  assert.equal(potential.result.status, "potential_acceptance"); assert.equal(potential.handoff, undefined);
  assert.equal(h.pa.records("publication").length, 0); assert.equal(h.rs.db.tables.authority_heads.size, 0);
  h.revokePolicy(); const denied = await h.submit("denied");
  assert.equal(denied.result.status, "denied"); assert.equal(denied.ae.providerCalls.value, 0);
});

test("malformed accepted owner facts and substituted request identities cannot publish", async () => {
  const h = await fixture(); const a = await h.submit("malformed-source"); assert.ok(a.handoff);
  const before = h.pa.records("publication");
  const changes = [
    {...a.handoff, accepted: {...a.handoff.accepted, acceptanceProof: {...a.handoff.accepted.acceptanceProof, binding: {...a.handoff.accepted.acceptanceProof.binding, commandFingerprint: fixtureHash({wrong: true})}}}},
    {...a.handoff, accepted: {...a.handoff.accepted, acceptedAuthorityVector: {...a.handoff.accepted.acceptedAuthorityVector, providerAccessSnapshot: {...a.handoff.accepted.acceptedAuthorityVector.providerAccessSnapshot, ownerAuthorityDigest: fixtureHash({wrong: true})}}}},
    {...a.handoff, accepted: {...a.handoff.accepted, operationId: "operation:substituted"}},
    {...a.handoff, accepted: {...a.handoff.accepted, constraintsDigest: fixtureHash({wrong: true})}},
    {...a.handoff, subject: {...a.handoff.subject, providerAccessRequest: {...a.handoff.subject.providerAccessRequest, requestDigest: fixtureHash({wrong: true})}}},
  ];
  for (const input of changes) {
    assert.equal((await h.providerAccess.consumeForDispatch(input as typeof a.handoff)).kind, "indeterminate");
    assert.equal((await h.security.consumeForDispatch(input as typeof a.handoff)).kind, "indeterminate");
  }
  assert.deepEqual(h.pa.records("publication"), before);
});

test("negative PA request history cannot become permission through late publication", async () => {
  const h = await fixture();
  const a = await h.submit("negative-history", async input => {
    const subject = input.subject;
    const absent = await h.dispatch.dispatchConsumption.consumeForDispatch({binding: subject.providerAccessExpectation,
      ...subject.providerAccessRequest, operationId: subject.operationId, provider: "codex", purpose: "contained-turn.provider-dispatch/v1",
      scope: {...subject.scope, scopeDigest: subject.scopeDigest}});
    assert.equal(absent.kind, "not_found");
  });
  assert.ok(a.handoff); assert.equal(a.ae.providerCalls.value, 0);
  assert.equal(h.pa.records("consumption").length, 0);
  assert.equal((await h.providerAccess.consumeForDispatch(a.handoff)).kind, "indeterminate");
  assert.equal(h.pa.records("consumption").length, 0);
});

test("revalidation reads genuine current PA materialization and RS policy", async () => {
  const h = await fixture(); const a = await h.submit("current-owner"); assert.ok(a.handoff);
  const accepted = a.handoff.accepted;
  const request = {operationId: accepted.operationId, scope: accepted.scope,
    decisionDigest: accepted.acceptedAuthorityVector.securityDecisionDigest, securityAuthorityRevision: accepted.acceptedAuthorityVector.securityAuthorityRevision};
  assert.equal((await h.security.revalidateForDispatch(request)).kind, "current");
  const paRequest = {operationId: accepted.operationId, scope: accepted.scope, acceptedSnapshot: accepted.acceptedAuthorityVector.providerAccessSnapshot};
  assert.equal((await h.providerAccess.revalidateForDispatch(paRequest)).kind, "current");
  h.revokePolicy(); await h.pa.changeBinding({...h.pa.state.binding, revocation: "revoked"});
  assert.equal((await h.security.revalidateForDispatch(request)).kind, "prevented");
  assert.equal((await h.providerAccess.revalidateForDispatch(paRequest)).kind, "prevented");
});

test("RS publication lost acknowledgement with unavailable readback cannot start the provider", async () => {
  const h = await fixture(); const publishing = new Set<number>(); let lost = false;
  h.rs.db.hook = async (client, sql, _values, execute) => {
    if (sql.includes("INSERT INTO runtime_security_dispatch_v1.authority_heads")) {publishing.add(client.id);}
    if (lost && sql.includes("runtime_security_dispatch_v1.authority_heads")) {throw new Error("synthetic readback unavailable");}
    const result = await execute();
    if (sql === "COMMIT" && publishing.has(client.id)) {lost = true; throw new Error("synthetic publication acknowledgement lost");}
    return result;
  };
  const a = await h.submit("rs-lost-ack");
  assert.ok(lost); assert.ok(a.handoff); assert.equal(a.ae.providerCalls.value, 0);
  assert.equal(h.rs.db.tables.consumptions.size, 0);
  assert.equal(h.pa.records("consumption").length, 1, "partial owner success remains recorded");
});

test("owner capture preserves original receivers and excludes accessor/proxy/then adoption", async () => {
  const h = await fixture(); let calls = 0;
  const resolve = Object.freeze({async execute(input: Parameters<typeof h.pa.current.resolve.execute>[0]) {
    assert.equal(this, resolve); calls++; return h.pa.current.resolve.execute(input);
  }});
  const dispatch = Object.freeze({...h.dispatch.dispatchConsumption,
    async publishAndConsumeForDispatch(prepared: Parameters<typeof h.dispatch.dispatchConsumption.publishAndConsumeForDispatch>[0], request: Parameters<typeof h.dispatch.dispatchConsumption.publishAndConsumeForDispatch>[1]) {
      assert.equal(this, dispatch); calls++; return h.dispatch.dispatchConsumption.publishAndConsumeForDispatch(prepared, request);
    }});
  const port = createContainedTurnOperationProviderAccessPort(Object.freeze({resolve, revalidate: h.pa.current.revalidate, dispatchConsumption: dispatch}));
  assert.equal(calls, 0);
  assert.equal((await port.resolveForAcceptance({operationId: containedTurnIdentity("operation", "operation:capture"), intent, provider: "codex", scope: h.scope})).kind, "resolved");
  const a = await h.submit("captured-receiver"); assert.ok(a.handoff);
  assert.equal((await port.consumeForDispatch(a.handoff)).kind, "consumed"); assert.equal(calls, 2);
  let touched = 0;
  const hostile = Object.freeze({get resolve() {touched++; return resolve;}, revalidate: h.pa.current.revalidate, dispatchConsumption: dispatch});
  assert.throws(() => createContainedTurnOperationProviderAccessPort(hostile));
  assert.throws(() => createContainedTurnSecurityAcceptancePort(new Proxy(h.owner, {ownKeys() {touched++; return [];}}), Object.freeze({policyRevision: h.rule.policyRevision})));
  const pending = Promise.resolve(Object.freeze({kind: "not_found" as const}));
  // oxlint-disable-next-line unicorn/no-thenable -- Adversarial fixture proves no then adoption.
  Object.defineProperty(pending, "then", {get() {touched++; throw new Error("must not execute");}});
  const malformed = createContainedTurnOperationProviderAccessPort(Object.freeze({...h.pa.current,
    dispatchConsumption: Object.freeze({...dispatch, publishAndConsumeForDispatch: (() => pending) as typeof dispatch.publishAndConsumeForDispatch})}));
  assert.equal((await malformed.consumeForDispatch(a.handoff)).kind, "indeterminate");
  assert.equal(touched, 0);
});

test("malformed current owner output is rejected before accessing its properties", async () => {
  const h = await fixture(); let touched = 0;
  const outcome = Object.freeze({kind: "resolved", get binding() {touched++; throw new Error("must not execute");}, evidence: {}});
  const port = createContainedTurnOperationProviderAccessPort(Object.freeze({resolve: Object.freeze({execute: (() => Promise.resolve(outcome)) as unknown as typeof h.pa.current.resolve.execute}),
    revalidate: h.pa.current.revalidate, dispatchConsumption: h.dispatch.dispatchConsumption}));
  assert.equal((await port.resolveForAcceptance({operationId: containedTurnIdentity("operation", "operation:malformed-current"), intent, provider: "codex", scope: h.scope})).kind, "indeterminate");
  assert.equal(touched, 0);
  const owner = Object.freeze({...h.owner, evaluateForAcceptance: (() => Promise.resolve(Object.freeze({status: "allowed", get decision() {touched++; throw new Error("must not execute");}}))) as unknown as typeof h.owner.evaluateForAcceptance});
  const security = createContainedTurnSecurityAcceptancePort(owner, Object.freeze({policyRevision: h.rule.policyRevision}));
  assert.equal((await security.authorizeForAcceptance({operationId: containedTurnIdentity("operation", "operation:malformed-security"), constraintsDigest: h.rule.constraintsDigest as never, intent, provider: "codex", scope: h.scope})).kind, "indeterminate");
  assert.equal(touched, 0);
});

test("RS independently issued constraints must equal the actual AE constraints", async () => {
  const h = await fixture(fixtureHash({independentButDifferentConstraints: true}));
  const a = await h.submit("wrong-constraints");
  assert.equal(a.handoff, undefined); assert.equal(a.ae.providerCalls.value, 0);
  assert.equal(h.pa.records("publication").length, 0);
  assert.equal(h.rs.db.tables.authority_heads.size, 0);
});
