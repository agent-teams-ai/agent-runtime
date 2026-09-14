import assert from "node:assert/strict";
import {createOrdinaryTurnFeature, containedTurnCommandFingerprint, digestContainedTurnCanonicalValue, ORDINARY_PROFILE, type OrdinaryOperation, type OrdinaryAuthoritySnapshot, type OrdinaryReceipt, type OrdinaryTurnDependencies, type OrdinaryOperationStore} from "@agent-teams/agent-execution/composition";
import {createAgentRuntimeHost} from "../../dist/composition/agent-runtime-host.js";
import {bindContainedTurnCapabilityAuthority} from "../../dist/composition/contained-turn-authority-capability.js";

type OrdinaryPreparation = NonNullable<OrdinaryOperation["preparation"]>;
function unavailable(): never {throw new Error("TEST setup must not execute", {cause: "synthetic setup"});}

const hash = "a".repeat(64);
const input = {commandId: "test-command", expectedProvider: "codex", intent: {mode: "workspace-write", prompt: "Read TASK.md and write result.txt"}, scope: {projectId: "ordinary-test", tenantId: "test"}} as const;
const binding = {operationId: "ordinary:test", attemptId: "attempt:test", executionProfile: ORDINARY_PROFILE.executionProfile, capabilityManifestRevision: ORDINARY_PROFILE.capabilityManifestRevision};
const initial = (): OrdinaryOperation => ({...binding, ...ORDINARY_PROFILE, schemaVersion: 3, effectId: "effect:test", commandId: input.commandId, fingerprint: containedTurnCommandFingerprint({scope: input.scope, intent: input.intent, provider: input.expectedProvider}), scope: input.scope, input, preparation: null, revision: 0, status: "accepted", cancellationRequested: false, output: [], receipts: []});
const authority = (owner: OrdinaryAuthoritySnapshot["owner"]): OrdinaryAuthoritySnapshot => ({...binding, owner, grantId: owner, ownerReceiptId: `receipt:${owner}`, consumptionDigest: hash, consumptionRevision: 1, authorityDigest: hash, expiresAt: Date.now() + 55000, scope: input.scope, provider: "codex"});
const preparation = (): OrdinaryPreparation => ({providerAccess: authority("provider_access"), security: authority("runtime_security"), reservationId: "reservation:test", workspaceId: "workspace:test", materializationId: "material:test", credentialGeneration: 1});
const closure = (prepared: OrdinaryPreparation): readonly OrdinaryReceipt[] => [
  {...binding, kind: "dispatch_claim", claimId: "claim:test", committedRevision: 2, reservationId: prepared.reservationId, preparationDigest: digestContainedTurnCanonicalValue(prepared)},
  {...binding, kind: "provider_terminal", terminalStatus: "completed", threadId: "thread:test", turnId: "turn:test"},
  {...binding, kind: "output_drain", finalSequence: 0, stdoutClosed: true, stderrClosed: true},
  {...binding, kind: "process_group_closed", reservationId: prepared.reservationId, pid: 200, processGroupId: 200, ownershipToken: "owner:test", exitObserved: true, groupEmptyObserved: true},
  {...binding, kind: "workspace_snapshot", workspaceId: prepared.workspaceId, snapshotDigest: hash, sourceDigest: hash, inventoryDigest: hash, stable: true},
  {...binding, kind: "artifact_published", workspaceId: prepared.workspaceId, snapshotDigest: hash, artifactDigest: hash, artifactManifestRef: "artifact:manifest", resultRef: "artifact:result", byteLength: 3},
  {...binding, kind: "credential_retired", materializationId: prepared.materializationId, generation: 1, retiredAt: new Date().toISOString()},
  {...binding, kind: "provider_grant_settled", grantId: prepared.providerAccess.grantId, ownerReceiptId: prepared.providerAccess.ownerReceiptId, settlementReceiptId: "settled:provider", disposition: "claim_committed"},
  {...binding, kind: "security_grant_settled", grantId: prepared.security.grantId, ownerReceiptId: prepared.security.ownerReceiptId, settlementReceiptId: "settled:security", disposition: "claim_committed"},
];

// App-owned synthetic ports exercise the real feature and Host lifecycle.
const fixture = () => {
  let operation: OrdinaryOperation | undefined; let starts = 0; let providerCalls = 0; let closedWorkspaces = 0;
  let prepared = preparation();
  const state = (): OrdinaryOperation => {assert.ok(operation); return operation;};
  const store: OrdinaryOperationStore = {
    accept: async submitted => {if (operation !== undefined) {return submitted.intent.prompt === operation.input.intent.prompt ? {kind: "duplicate", operation} : {kind: "conflict"};} operation = initial(); return {kind: "accepted", operation};},
    read: async () => operation,
    prepare: async (current, value) => {prepared = value; operation = {...current, preparation: value, revision: current.revision + 1}; return operation;},
    claim: async current => {
      const receipt = closure(prepared).find(item => item.kind === "dispatch_claim"); assert.ok(receipt);
      operation = {...current, revision: 2, status: "running", receipts: [receipt]};
      return {kind: "claimed", operation, receipt};
    },
    cancel: async () => {if (operation !== undefined) {operation = {...operation, cancellationRequested: true, revision: operation.revision + 1};} return operation;},
    append: async (_current, output) => {operation = {...state(), revision: state().revision + 1, output: [...state().output, {...output, cursor: state().output.length + 1}]}; return operation;},
    finish: async () => {assert.fail("incomplete physical closure must reconcile instead of finishing");},
    reconcile: async (_current, receipts) => {const merged = [...state().receipts, ...receipts.filter(item => !state().receipts.some(prior => prior.kind === item.kind))]; operation = {...state(), receipts: merged, revision: state().revision + 1, status: "reconcile_required"}; return operation;},
  };
  const receipt = <K extends OrdinaryReceipt["kind"]>(kind: K): Extract<OrdinaryReceipt, {kind: K}> => {const found = closure(prepared).find(item => item.kind === kind); assert.ok(found); return found as Extract<OrdinaryReceipt, {kind: K}>;};
  const dependencies: OrdinaryTurnDependencies = {
    operationStore: store,
    providerAccess: {resolveAndConsume: async () => {const snapshot = authority("provider_access"); return {grantId: snapshot.grantId, expiresAt: snapshot.expiresAt, authority: snapshot, materialize: async () => ({brokerEndpoint: "http://127.0.0.1:1234", materializationId: "material:test", generation: 1, environment: {}}), retire: async () => receipt("credential_retired"), settle: async disposition => ({...receipt("provider_grant_settled"), disposition})};}},
    security: {resolveAndConsume: async () => {const snapshot = authority("runtime_security"); return {grantId: snapshot.grantId, expiresAt: snapshot.expiresAt, authority: snapshot, admitOutput: async () => true, admitArtifact: async () => true, settle: async disposition => ({...receipt("security_grant_settled"), disposition})};}},
    workspace: {prepare: async () => ({workspaceId: "workspace:test", cwd: "/test", homeDirectory: "/test/home"}), snapshot: async () => ({receipt: receipt("workspace_snapshot"), resultBytes: new Uint8Array([1, 2, 3])}), close: async () => {closedWorkspaces += 1;}},
    artifacts: {publish: async () => receipt("artifact_published")},
    process: {reserve: async (request) => {assert.ok(request.deadline > performance.now() && request.deadline <= performance.now() + 45000); return ({reservationId: "reservation:test", start: async () => {starts += 1; assert.equal(state().status, "running"); return {lines: (async function* () {})(), write: async () => {}, closeInput: async () => {}};}, close: async (finalSequence) => {if (!starts) {return {kind: "not_started", reservationId: "reservation:test"};} return [{...receipt("output_drain"), finalSequence}, receipt("process_group_closed")];}});}},
    provider: {supported: {provider: "codex", mode: "workspace-write", executionProfile: ORDINARY_PROFILE.executionProfile, capabilityManifestRevision: ORDINARY_PROFILE.capabilityManifestRevision}, execute: async () => {providerCalls += 1; return receipt("provider_terminal");}},
  };
  return {dependencies, state, counts: () => ({starts, providerCalls, closedWorkspaces})};
};

export async function ordinaryHostOwnershipRetry() {
  const f = fixture(); const reserve = f.dependencies.process.reserve; let closes = 0;
  f.dependencies.process.reserve = async request => {
    const reservation = await reserve(request);
    return {...reservation, close: sequence => {closes += 1; if (closes <= 2) {return Promise.reject(new Error("TEST physical closure unavailable"));} return reservation.close(sequence);}};
  };
  const feature = createOrdinaryTurnFeature(f.dependencies);
  let submission: ReturnType<typeof feature.submit.execute> | undefined;
  const capability = {...feature, submit: {execute: (...args: Parameters<typeof feature.submit.execute>) => {submission = feature.submit.execute(...args); return submission;}}};
  const host = createAgentRuntimeHost({
    codexSetup: {authorizeSetupInspection: {execute: unavailable}, discoverCodexInstallations: {execute: unavailable}, inspectCodexConfiguration: {execute: unavailable}, planCodexSetupInspection: {plan: unavailable}},
    claudeCodeSetup: {authorizeClaudeCodeSetupInspection: {execute: unavailable}, discoverClaudeCodeInstallations: {execute: unavailable}, inspectClaudeCodeConfiguration: {execute: unavailable}, planClaudeCodeSetupInspection: {plan: unavailable}},
    containedTurn: bindContainedTurnCapabilityAuthority(capability, "runtime-access-authority:ordinary-user-session-v1"),
  }, feature);
  const access = host.bindAccess({containedTurn: input.scope});
  const result = await access.containedTurn.submit({commandId: input.commandId, expectedProvider: input.expectedProvider, intent: input.intent});
  assert.equal(result.status, "accepted"); await submission;
  assert.equal(f.state().status, "reconcile_required");
  assert.deepEqual(f.counts(), {starts: 1, providerCalls: 1, closedWorkspaces: 0});
  assert.equal(f.state().receipts.some(receipt => receipt.kind === "process_group_closed"), false);
  await assert.rejects(host.dispose(), AggregateError);
  assert.equal(closes, 2);
  assert.equal(f.state().status, "reconcile_required");
  await host.dispose(); await host.dispose();
  assert.equal(closes, 3); assert.equal(f.state().status, "reconcile_required");
  assert.equal(f.state().receipts.some(receipt => receipt.kind === "process_group_closed"), true);
}
