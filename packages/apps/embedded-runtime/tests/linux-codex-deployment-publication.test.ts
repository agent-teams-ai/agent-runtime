import { workspacePackageSourceHref } from "./support/workspace-package-source.mjs";
import assert from "node:assert/strict";
import {test} from "node:test";
import {createHostCustodiedContainedTurn, ProviderRouteEnforcementUnsupportedError} from "../dist/composition/contained-turn-feature-composition.js";
import {createLinuxCodexDeploymentAuthority} from "../dist/composition/linux-codex-deployment-authority.js";
import {createContainedTurnOperationProviderAccessPort, createContainedTurnSecurityAcceptancePort, nativeHttpRequestProfile, createContainedTurnFeature, type ContainedTurnFeatureDependencies} from "@agent-teams/agent-execution/composition";
const { operationHarness, fixtureHash } = await import(workspacePackageSourceHref("@agent-teams/provider-access", "tests/features/contained-turn-access/operation-dispatch-test-fixture.ts"));
const { harness, selection } = await import(workspacePackageSourceHref("@agent-teams/provider-access", "tests/features/contained-turn-access/route-selection-fixture.ts"));
const { createHarness } = await import(workspacePackageSourceHref("@agent-teams/runtime-security", "tests/postgres-dispatch.fixtures.ts"));
import {createDispatchAcceptanceFeature, createNodeSha256DispatchDigest, createPostgresDispatchAcceptanceStore} from "@agent-teams/runtime-security/composition";
const { containedTurnIdentity } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "dist/features/contained-agent-turn/domain/contained-turn-identities.js"));
const { createDependencies } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/features/contained-agent-turn/support/contained-agent-turn-fixture.ts"));
const { adapterSnapshot, manifest } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/features/contained-agent-turn/support/contained-turn-fixture-snapshots.ts"));

// Local assembly retains the existing synthetic AE store and observes its real
// one-shot claim through the deployment lifecycle. No shared fixture is edited.
const joinedAeSubmit = (providerAccess: ContainedTurnFeatureDependencies["providerAccess"],
  security: ContainedTurnFeatureDependencies["security"], scope: {projectId: string; tenantId: string},
  intent: {mode: "analysis"; prompt: string}, authority: ReturnType<typeof createLinuxCodexDeploymentAuthority>) =>
  async (id: string, beforeConsume?: (input: Parameters<typeof providerAccess.consumeForDispatch>[0]) => Promise<void>) => {
    const ae = createDependencies();
    let handoff: Parameters<typeof providerAccess.consumeForDispatch>[0] | undefined;
    const operationStore = authority.bindStore({...ae.dependencies.operationStore,
      async read(request) {
        const current = ae.current();
        return current?.operationId === request.operationId && current.scope.tenantId === request.scope.tenantId &&
          current.scope.projectId === request.scope.projectId ? current : undefined;
      },
      async identifyAcceptance() {
        return {kind: "available", operationId: containedTurnIdentity("operation", `operation:${id}`),
          effectId: containedTurnIdentity("effect", `effect:${id}`), acceptanceProofId: containedTurnIdentity("proof", `proof:acceptance:${id}`),
          operationAuthorityRevision: "operation-authority:one"};
      },
    });
    const feature = createContainedTurnFeature({...ae.dependencies, operationStore, security,
      custody: {...ae.dependencies.custody, async open(input) {
        const custody = await ae.dependencies.custody.open(input);
        return {...custody, hostCustodyProof: {...custody.hostCustodyProof,
          binding: {...custody.hostCustodyProof.binding, effectId: containedTurnIdentity("effect", `effect:${id}`)}}};
      }},
      providerAccess: {...providerAccess, async consumeForDispatch(input) {
        handoff = input; await beforeConsume?.(input); return providerAccess.consumeForDispatch(input);
      }},
    });
    const result = await feature.submit.execute({commandId: `command:${id}`, expectedProvider: "codex", intent, scope});
    return {ae, handoff, result, feature};
  };

test("simulation: real AE/PA/RS publication acknowledgements supply the deployment selection, including opaque PA digest", async () => {
  // All stores, custody and provider execution are synthetic. This runs the real
  // owner algorithms; it is not a live committed-claim or PostgreSQL claim.
  const pa = operationHarness(); const dispatch = pa.rebuild();
  const rs = createHarness(); rs.setTime(100);
  const decisions = createPostgresDispatchAcceptanceStore({pool: rs.db, connectTimeoutMs: 1000, queryTimeoutMs: 1000, transactionTimeoutMs: 5000});
  await rs.repository.migrate(); await decisions.migrate();
  const scope = {projectId: pa.selection.binding.projectId, tenantId: pa.selection.binding.tenantId};
  const intent = {mode: "analysis" as const, prompt: "Synthetic deployment publication"};
  const policy = {scope: {...scope, scopeDigest: pa.selection.binding.scopeDigest}, providerId: "codex",
    intentDigest: fixtureHash({purpose: "contained_turn_acceptance_intent_v1", intent, version: 1}), policyRevision: "security-authority:joined:7",
    constraintsDigest: fixtureHash({adapterSnapshot, capabilityManifest: manifest, intentMode: intent.mode}),
    containmentPolicyDigest: fixtureHash({policy: "independent containment 7"}), enabled: true, revoked: false,
    validFromControlTime: 50, claimBeforeControlTime: 120100};
  const owner = createDispatchAcceptanceFeature({repository: rs.repository, decisions, policy: {async read() {return policy;}},
    clock: {now: () => 100}, digest: createNodeSha256DispatchDigest()});
  const routeHarness = await harness({...selection(), binding: pa.selection.binding,
    descriptor: nativeHttpRequestProfile("codex-chatgpt-responses/v1")!});
  const routeOwner = routeHarness.owner(); await routeOwner.control.endorse(1);
  assert.throws(() => createHostCustodiedContainedTurn({authority: "current",
    providerAccess: Object.freeze({...pa.current, dispatchConsumption: dispatch.dispatchConsumption}),
    security: Object.freeze({acceptance: owner, profile: Object.freeze({policyRevision: policy.policyRevision})}),
    selectedProvider: Object.freeze({kind: "codex", owner: Object.freeze({platformTarget: {platform: "linux"},
      hostBootId: "boot-simulation", hostInstanceId: "host-simulation"})}),
    linuxCodexDeployment: {sourceRevision: "a".repeat(40), cleanupMilliseconds: 1000, imageInitLock: {},
      currentAuthority: {runtimeSecurity: rs.repository, providerAccess: routeOwner},
      recipe() {throw new Error("qualification must precede recipes");}},
  } as never), ProviderRouteEnforcementUnsupportedError);
  assert.equal(pa.records("publication").length, 0);
  const authority = createLinuxCodexDeploymentAuthority({runtimeSecurity: rs.repository, providerAccess: routeOwner}, "a".repeat(40));
  const ports = authority.bind({providerAccess: createContainedTurnOperationProviderAccessPort(Object.freeze({...pa.current, dispatchConsumption: dispatch.dispatchConsumption})),
    security: createContainedTurnSecurityAcceptancePort(owner, Object.freeze({policyRevision: policy.policyRevision}))});
  await dispatch.control.provisionIssuance();
  let early = false;
  const submit = joinedAeSubmit(ports.providerAccess, ports.security, scope, intent, authority);
  const beforeConsume: NonNullable<Parameters<typeof submit>[1]> = async handoff => {
    early = true;
    assert.equal(pa.records("publication").length, 0);
    assert.throws(() => authority.take({custodyId: handoff.subject.custodyId} as never), /acknowledged/u);
  };
  try {
    const result = await submit("deployment-publication", beforeConsume);
    assert.ok(early); assert.ok(result.handoff);
    const {subject, accepted} = result.handoff;
    assert.equal(pa.records("publication").length, 1);
    assert.equal(rs.db.tables.consumptions.size, 1);
    const selected = authority.take({...subject, authorityVectorDigest: accepted.acceptedAuthorityVectorDigest,
      adapterSnapshot: accepted.acceptedAuthorityVector.adapterSnapshot,
      providerAccessSnapshot: accepted.acceptedAuthorityVector.providerAccessSnapshot} as never);
    assert.equal(selected.acceptedDispatch.headVersion, "1");
    assert.equal(selected.acceptedDispatch.authority!.operationId, subject.operationId);
    assert.equal(selected.acceptedDispatch.authority!.requestDigest, subject.runtimeSecurityRequest.requestDigest);
    assert.equal(selected.providerAccessReceipt.authorityFacts.authorityHeadDigest, pa.selection.binding.credentialBindingDigest);
    assert.notEqual(selected.providerAccessReceipt.authorityFacts.credentialBindingDigest, pa.selection.binding.credentialBindingDigest);
    assert.equal(selected.upstream.providerAccessSnapshot.ownerAuthorityDigest, pa.selection.binding.credentialBindingDigest);
    assert.equal(selected.binding.authorityVectorDigest, accepted.acceptedAuthorityVectorDigest);
    rs.db.assertReleased();
  } finally {routeOwner.dispose();}
});
