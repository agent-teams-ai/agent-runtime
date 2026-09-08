import assert from "node:assert/strict";
import test from "node:test";
import { createContainedTurnFeatureFromProviderAccess, composeHostCustodiedContainedTurn } from "../dist/composition/contained-turn-feature-composition.js";
import { ContainedTurnConstructionCleanupError } from "../dist/composition/contained-turn-construction-failure.js";
import { createDependencies } from "../../../contexts/agent-execution/tests/features/contained-agent-turn/support/contained-agent-turn-fixture.ts";
import { createContainedTurnOperationProviderAccessPort, createContainedTurnSecurityAcceptancePort } from "../../../contexts/agent-execution/dist/composition.js";
import { containedTurnIdentity } from "../../../contexts/agent-execution/dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { acceptedProviderPreparation } from "../../../contexts/agent-execution/dist/features/contained-agent-turn/composition/accepted-authority-anti-corruption.js";
import { operationHarness, fixtureHash } from "../../../contexts/provider-access/tests/features/contained-turn-access/operation-dispatch-test-fixture.ts";
import { createHarness } from "../../../contexts/runtime-security/tests/postgres-dispatch.fixtures.ts";
import { createDispatchAcceptanceFeature, createNodeSha256DispatchDigest, createPostgresDispatchAcceptanceStore } from "../../../contexts/runtime-security/dist/composition.js";
import { joinedAeSubmit } from "./support/joined-authority-fixture.ts";
import { adapterSnapshot, manifest } from "../../../contexts/agent-execution/tests/features/contained-agent-turn/support/contained-turn-fixture-snapshots.ts";

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

for (const metadata of ["name", "length"] as const) {
  for (const freezeBeforeCapture of [true, false]) {
    test(`PA/RS capture ignores ${metadata} accessors with methods frozen ${freezeBeforeCapture ? "before" : "after"} construction`, async () => {
      const h = await fixture();
      let touched = 0;
      const calls: string[] = [];
      const mutations: (() => void)[] = [];
      const instrument = <Owner extends object>(original: Owner, label: string): Owner => {
        const owner: Record<string, unknown> = {};
        for (const [key, method] of Object.entries(original)) {
          const forwarded = function(this: unknown, ...args: unknown[]) {
            assert.equal(this, owner, `${label}.${key} receiver`);
            calls.push(`${label}.${key}`);
            return Reflect.apply(method, original, args);
          };
          const accessor = {configurable: true, get() {touched++; throw new Error("callable metadata must be inert");}};
          Object.defineProperty(forwarded, metadata, accessor);
          if (freezeBeforeCapture) {Object.freeze(forwarded);}
          owner[key] = forwarded;
          mutations.push(() => {
            if (!freezeBeforeCapture) {
              Object.defineProperties(forwarded, {name: accessor, length: accessor, apply: accessor, bind: accessor});
              Object.freeze(forwarded);
              owner[key] = () => {throw new Error("replacement method must not be captured");};
            }
          });
        }
        return (freezeBeforeCapture ? Object.freeze(owner) : Object.seal(owner)) as Owner;
      };
      const providerAccess = createContainedTurnOperationProviderAccessPort(Object.freeze({
        resolve: instrument(h.pa.current.resolve, "pa.resolve"),
        revalidate: instrument(h.pa.current.revalidate, "pa.revalidate"),
        dispatchConsumption: instrument(h.dispatch.dispatchConsumption, "pa.dispatch"),
      }));
      const security = createContainedTurnSecurityAcceptancePort(instrument(h.owner, "rs"), Object.freeze({policyRevision: h.rule.policyRevision}));
      assert.ok(Object.isFrozen(providerAccess)); assert.ok(Object.isFrozen(security));
      assert.equal(providerAccess instanceof Promise, false); assert.equal(security instanceof Promise, false);
      assert.equal(touched, 0); assert.equal(calls.length, 0, "construction invokes no owner methods");
      for (const mutate of mutations) {mutate();}
      const submit = joinedAeSubmit(providerAccess, security, h.scope, intent);
      const a = await submit(`metadata-${metadata}-${freezeBeforeCapture}`);
      assert.ok(a.handoff); assert.equal(a.ae.providerCalls.value, 1);
      assert.equal((await providerAccess.consumeForDispatch(a.handoff)).kind, "consumed");
      assert.equal((await security.consumeForDispatch(a.handoff)).kind, "consumed");
      const accepted = a.handoff.accepted;
      assert.equal((await providerAccess.revalidateForDispatch({operationId: accepted.operationId, scope: accepted.scope,
        acceptedSnapshot: accepted.acceptedAuthorityVector.providerAccessSnapshot})).kind, "current");
      assert.equal((await security.revalidateForDispatch({operationId: accepted.operationId, scope: accepted.scope,
        decisionDigest: accepted.acceptedAuthorityVector.securityDecisionDigest,
        securityAuthorityRevision: accepted.acceptedAuthorityVector.securityAuthorityRevision})).kind, "current");
      assert.equal(h.pa.records("consumption").length, 1); assert.equal(h.rs.db.tables.consumptions.size, 1);
      for (const method of ["pa.resolve.execute", "pa.revalidate.execute", "pa.dispatch.publishAndConsumeForDispatch", "rs.evaluateForAcceptance", "rs.publishAndConsumeForDispatch"]) {
        assert.ok(calls.includes(method), method);
      }
      assert.equal(touched, 0, "operation and replay never read callable metadata");
      h.rs.db.assertReleased();
    });
  }

  test(`RS acceptance independently ignores a frozen method's ${metadata} accessor`, async () => {
    const h = await fixture(); let touched = 0; let calls = 0;
    const owner = Object.freeze({...h.owner, async evaluateForAcceptance(input: Parameters<typeof h.owner.evaluateForAcceptance>[0]) {
      assert.equal(this, owner); calls++; return h.owner.evaluateForAcceptance(input);
    }});
    Object.defineProperty(owner.evaluateForAcceptance, metadata, {get() {touched++; throw new Error("must not read metadata");}});
    Object.freeze(owner.evaluateForAcceptance);
    const port = createContainedTurnSecurityAcceptancePort(owner, Object.freeze({policyRevision: h.rule.policyRevision}));
    assert.ok(Object.isFrozen(port)); assert.equal(port instanceof Promise, false);
    assert.equal(touched, 0); assert.equal(calls, 0);
    assert.equal((await port.authorizeForAcceptance({operationId: containedTurnIdentity("operation", "operation:rs-metadata"),
      constraintsDigest: h.rule.constraintsDigest as never, intent, provider: "codex", scope: h.scope})).kind, "allowed");
    assert.equal(calls, 1); assert.equal(touched, 0);
    h.rs.db.assertReleased();
  });

  test(`both new factories reject callable proxies without ${metadata}, get or prototype traps`, async () => {
    const h = await fixture(); let touched = 0;
    const hostile = <Method extends object>(method: Method): Method => new Proxy(method, {
      get() {touched++; throw new Error("must not get callable metadata");},
      getOwnPropertyDescriptor() {touched++; throw new Error("must not inspect callable metadata");},
      getPrototypeOf() {touched++; throw new Error("must not get callable prototype");},
      apply() {touched++; throw new Error("must not invoke owner");},
    });
    const paMethod = h.dispatch.dispatchConsumption.publishAndConsumeForDispatch;
    const rsMethod = h.owner.evaluateForAcceptance;
    for (const method of [paMethod, rsMethod]) {
      Object.defineProperty(method, metadata, {get() {touched++; throw new Error("must not read metadata");}});
      Object.freeze(method);
    }
    assert.throws(() => createContainedTurnOperationProviderAccessPort(Object.freeze({...h.pa.current,
      dispatchConsumption: Object.freeze({...h.dispatch.dispatchConsumption, publishAndConsumeForDispatch: hostile(paMethod)})})),
    {code: "ERR_PROVIDER_ACCESS_ROUTE_C_OWNER", diagnostic: "invalid_method"});
    assert.throws(() => createContainedTurnSecurityAcceptancePort(Object.freeze({...h.owner,
      evaluateForAcceptance: hostile(rsMethod)}), Object.freeze({policyRevision: h.rule.policyRevision})),
    {code: "ERR_PROVIDER_ACCESS_ROUTE_C_OWNER", diagnostic: "invalid_method"});
    assert.equal(touched, 0);
  });
}

// The same actual PA/RS owners now enter through private product composition.
// Persistence here remains synthetic; no deployment or live qualification is implied.
const productFixture = async (potentialAcceptance = false) => {
  const h = await fixture();
  const ae = createDependencies({potentialAcceptance});
  const calls: string[] = [];
  const preparedValues: unknown[] = [];
  const dispatch = Object.seal({...h.dispatch.dispatchConsumption,
    async publishAndConsumeForDispatch(prepared: Parameters<typeof h.dispatch.dispatchConsumption.publishAndConsumeForDispatch>[0], request: Parameters<typeof h.dispatch.dispatchConsumption.publishAndConsumeForDispatch>[1]) {
      assert.equal(this, dispatch);
      const accepted = ae.current(); assert.ok(accepted);
      assert.equal(prepared.operationId, accepted.operationId);
      assert.equal(prepared.acceptedAuthorityDigest, accepted.acceptedAuthorityVectorDigest);
      assert.equal(prepared.acceptedBinding.credentialBindingDigest, h.pa.state.binding.credentialBindingDigest);
      assert.equal(request.operationId, accepted.operationId);
      assert.equal(prepared.grantRequestId, request.grantRequestId);
      calls.push("pa.publish-and-consume"); preparedValues.push(prepared);
      return h.dispatch.dispatchConsumption.publishAndConsumeForDispatch(prepared, request);
    },
  });
  const security = Object.seal({...h.owner,
    async evaluateForAcceptance(input: Parameters<typeof h.owner.evaluateForAcceptance>[0]) {
      assert.equal(this, security);
      assert.equal(input.operationId, "operation:one");
      assert.equal(input.intentDigest, h.rule.intentDigest);
      calls.push("rs.evaluate");
      return h.owner.evaluateForAcceptance(input);
    },
    async publishAndConsumeForDispatch(prepared: Parameters<typeof h.owner.publishAndConsumeForDispatch>[0], request: Parameters<typeof h.owner.publishAndConsumeForDispatch>[1]) {
      assert.equal(this, security);
      const accepted = ae.current(); assert.ok(accepted);
      assert.equal(prepared.acceptance.operationId, accepted.operationId);
      assert.equal(prepared.acceptance.intentDigest, fixtureHash({purpose: "contained_turn_acceptance_intent_v1", intent: accepted.intent, version: 1}));
      assert.equal(prepared.decisionDigest, accepted.acceptedAuthorityVector.securityDecisionDigest);
      assert.equal(prepared.authorityGeneration, accepted.acceptedAuthorityVector.operationAuthorityRevision);
      assert.equal(prepared.grantRequestId, request.grantRequestId);
      assert.equal(prepared.requestDigest, request.requestDigest);
      calls.push("rs.publish-and-consume"); preparedValues.push(prepared);
      return h.owner.publishAndConsumeForDispatch(prepared, request);
    },
  });
  const input = Object.freeze({...ae.dependencies, authority: "current" as const,
    operationStore: {...ae.dependencies.operationStore, async read(request: Parameters<typeof ae.dependencies.operationStore.read>[0]) {
      const current = ae.current();
      return current?.operationId === request.operationId && current.scope.tenantId === request.scope.tenantId && current.scope.projectId === request.scope.projectId ? current : undefined;
    }},
    providerAccess: Object.freeze({...h.pa.current, dispatchConsumption: dispatch}),
    security: Object.freeze({acceptance: security, profile: Object.freeze({policyRevision: h.rule.policyRevision})}),
  });
  return {...h, ae, input, calls, preparedValues, dispatchOwner: dispatch, securityOwner: security};
};

test("private current selection binds actual owners through accepted engine preparation and dispatch", async () => {
  const h = await productFixture();
  const hostCustody = Object.freeze({}); let disposed = 0; let constructed = 0;
  const product = composeHostCustodiedContainedTurn(Object.freeze({...h.input, hostCustody,
    selectedProvider: Object.freeze({kind: "codex", owner: Object.freeze({})}),
  }) as never, Object.freeze({
    codex: ((options: {hostCustody: unknown}) => {
      constructed++; assert.equal(options.hostCustody, hostCustody);
      return Object.freeze({custody: h.ae.dependencies.custody, provider: h.ae.dependencies.provider, dispose() {disposed++;}});
    }) as never,
    claude: (() => {throw new Error("unselected provider");}) as never,
  }), createContainedTurnFeatureFromProviderAccess);
  const feature = product.feature;
  assert.equal(constructed, 1);
  assert.equal(h.calls.length, 0, "construction is inert");
  assert.equal(h.pa.records("publication").length, 0);
  // Sealed owner methods may change, but construction captured the original methods and receivers.
  h.dispatchOwner.publishAndConsumeForDispatch = async () => {throw new Error("replacement PA method");};
  h.securityOwner.evaluateForAcceptance = async () => {throw new Error("replacement RS method");};
  h.securityOwner.publishAndConsumeForDispatch = async () => {throw new Error("replacement RS publication");};
  await feature.submit.execute({commandId: "command:product-current", expectedProvider: "codex", intent, scope: h.scope});
  assert.equal(h.ae.providerCalls.value, 1);
  assert.equal(h.preparedValues.length, 2);
  assert.equal(h.pa.records("publication").length, 1);
  assert.equal(h.pa.records("consumption").length, 1);
  assert.equal(h.rs.db.tables.consumptions.size, 1);
  assert.ok(h.calls.includes("rs.evaluate"));
  product.dispose(); product.dispose(); assert.equal(disposed, 1);
  h.rs.db.assertReleased();
});

test("private current selection cannot publish from potential acceptance or publication uncertainty", async () => {
  for (const potential of [true, false]) {
    const h = await productFixture(potential);
    if (!potential) {h.pa.state.loseCommit = "publication";}
    const feature = createContainedTurnFeatureFromProviderAccess(h.input);
    const result = await feature.submit.execute({commandId: `command:product-${potential}`, expectedProvider: "codex", intent, scope: h.scope});
    if (potential) {assert.equal(result.status, "potential_acceptance");}
    assert.equal(h.ae.providerCalls.value, 0);
    assert.equal(h.pa.records("publication").length, potential ? 0 : 1);
    assert.equal(h.pa.records("consumption").length, 0);
    // Grant owners run concurrently; RS may acknowledge even when PA publication is uncertain.
    assert.equal(h.rs.db.tables.consumptions.size, potential ? 0 : 1);
    if (!potential) {
      const operation = h.ae.current(); assert.ok(operation);
      await feature.observe.execute({operationId: operation.operationId, scope: h.scope});
      assert.equal(h.pa.records("publication").length, 1);
      assert.equal(h.pa.records("consumption").length, 0);
      assert.equal(h.ae.providerCalls.value, 0);
    }
    h.rs.db.assertReleased();
  }
});

test("private current selection honors the actual security owner's denial without fallback", async () => {
  const h = await productFixture();
  const feature = createContainedTurnFeatureFromProviderAccess(h.input);
  h.revokePolicy();
  const result = await feature.submit.execute({commandId: "command:product-revoked", expectedProvider: "codex", intent, scope: h.scope});
  assert.equal(result.status, "denied");
  assert.equal(h.ae.providerCalls.value, 0);
  assert.equal(h.pa.records("publication").length, 0);
  assert.equal(h.rs.db.tables.consumptions.size, 0);
  assert.deepEqual(h.calls, ["rs.evaluate"]);
  h.rs.db.assertReleased();
});

test("private current selection rejects missing, mixed, mutable and hostile configuration without execution", async () => {
  const h = await productFixture(); let touched = 0;
  const trap = () => {touched++; throw new Error("configuration must remain inert");};
  const hostile = <Value extends object>(value: Value): Value => new Proxy(value, {
    get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap, ownKeys: trap, isExtensible: trap,
  });
  const input = h.input;
  const legacySecurity = Object.freeze({legacy: h.ae.dependencies.security, dispatchAuthorityV1: Object.freeze({})});
  const cases: unknown[] = [
    {...input, authority: undefined}, {...input, authority: "unknown"}, {...input, authority: "legacy"},
    {...input, providerAccess: undefined}, {...input, security: undefined},
    {...input, security: legacySecurity},
    {...input, providerAccess: Object.freeze({resolve: input.providerAccess.resolve, revalidate: input.providerAccess.revalidate,
      dispatchConsumptionV1: h.dispatchOwner})},
    {...input, security: Object.freeze({...input.security, acceptance: undefined})},
    {...input, security: Object.freeze({...input.security, profile: undefined})},
    {...input, security: Object.freeze({...input.security, ...legacySecurity})},
    {...input, providerAccess: Object.freeze({...input.providerAccess, dispatchConsumptionV1: h.dispatchOwner})},
    {...input, security: {...input.security}},
    {...input, security: Object.freeze({...input.security, profile: {policyRevision: h.rule.policyRevision}})},
    {...input, security: Object.freeze({...input.security, profile: Object.freeze({policyRevision: "bad"})})},
    hostile(input), {...input, security: hostile(input.security)},
    {...input, providerAccess: hostile(input.providerAccess)},
    {...input, security: Object.freeze({...input.security, acceptance: hostile(h.securityOwner)})},
    {...input, security: Object.freeze({...input.security, profile: hostile(input.security.profile)})},
    Object.freeze({...input, get authority() {return trap();}}),
    Object.freeze({...input, get providerAccess() {return trap();}}),
    Object.freeze({...input, get security() {return trap();}}),
    {...input, security: Object.freeze({get acceptance() {return trap();}, profile: input.security.profile})},
    {...input, security: Object.freeze({...input.security, get profile() {return trap();}})},
    {...input, security: Object.freeze({...input.security, acceptance: Object.freeze({...h.securityOwner,
      get evaluateForAcceptance() {return trap();}})})},
    {...input, security: Object.freeze({...input.security, acceptance: Object.freeze({...h.securityOwner,
      evaluateForAcceptance: hostile(h.securityOwner.evaluateForAcceptance)})})},
    {...input, providerAccess: Object.freeze({...input.providerAccess, dispatchConsumption: Object.freeze({...h.dispatchOwner,
      publishAndConsumeForDispatch: hostile(h.dispatchOwner.publishAndConsumeForDispatch)})})},
  ];
  const {authority: _authority, ...unselected} = input;
  cases.push(unselected);
  for (const value of cases) {
    assert.throws(() => createContainedTurnFeatureFromProviderAccess(value as typeof input), TypeError);
  }
  assert.equal(touched, 0); assert.equal(h.calls.length, 0);
  assert.equal(h.pa.records("publication").length, 0);
});

test("current host composition preserves selection and construction cleanup failure semantics", async () => {
  const h = await productFixture(); let disposed = 0;
  const owner = Object.freeze({custody: h.ae.dependencies.custody, provider: h.ae.dependencies.provider,
    dispose() {disposed++; throw new Error("synthetic cleanup failure");}});
  const factories = Object.freeze({codex: (() => owner) as never, claude: (() => {throw new Error("wrong provider");}) as never});
  const input = Object.freeze({...h.input, hostCustody: Object.freeze({}),
    selectedProvider: Object.freeze({kind: "codex" as const, owner: Object.freeze({})}),
  });
  assert.throws(() => composeHostCustodiedContainedTurn(input as never, factories, dependencies => {
    assert.equal(dependencies.authority, "current");
    assert.equal(dependencies.providerAccess, h.input.providerAccess);
    assert.deepEqual(Object.keys(dependencies).toSorted(), ["artifacts", "authority", "custody", "operationStore", "provider", "providerAccess", "security", "workspace"]);
    return createContainedTurnFeatureFromProviderAccess({...dependencies,
      security: Object.freeze({...h.input.security, profile: Object.freeze({policyRevision: "invalid"})}),
    } as never);
  }), ContainedTurnConstructionCleanupError);
  assert.equal(disposed, 1); assert.equal(h.calls.length, 0);
});
