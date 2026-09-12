import assert from "node:assert/strict";
import test from "node:test";
import {containedTurnCommandFingerprint} from "../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import {ORDINARY_PROFILE, type OrdinaryOperation, type OrdinaryPreparation, type OrdinaryReceipt, type OrdinaryAuthoritySnapshot} from "../../../dist/features/contained-agent-turn/domain/ordinary-model.js";
import {ordinaryPreparationDigest, ordinaryTerminalStatus, validateOrdinaryOperation, validateOrdinaryReceipt} from "../../../dist/features/contained-agent-turn/domain/ordinary-validation.js";
import {encodeOrdinaryState, decodeOrdinaryState} from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/ordinary-state-codec.js";
import {decodeContainedTurnState} from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-state-codec.js";
import {createOrdinaryTurnFeature} from "../../../dist/features/contained-agent-turn/composition/ordinary-feature-factory.js";
import type {OrdinaryTurnDependencies, OrdinaryOperationStore} from "../../../dist/features/contained-agent-turn/application/ordinary-ports.js";

const hash = "a".repeat(64);
const input = {commandId: "test-command", expectedProvider: "codex", intent: {mode: "workspace-write", prompt: "Read TASK.md and write result.txt"}, scope: {projectId: "ordinary-test", tenantId: "test"}} as const;
const binding = {operationId: "ordinary:test", attemptId: "attempt:test", executionProfile: ORDINARY_PROFILE.executionProfile, capabilityManifestRevision: ORDINARY_PROFILE.capabilityManifestRevision};
const initial = (): OrdinaryOperation => ({...binding, ...ORDINARY_PROFILE, schemaVersion: 3, effectId: "effect:test", commandId: input.commandId, fingerprint: containedTurnCommandFingerprint({scope: input.scope, intent: input.intent, provider: input.expectedProvider}), scope: input.scope, input, preparation: null, revision: 0, status: "accepted", cancellationRequested: false, output: [], receipts: []});
const authority = (owner: OrdinaryAuthoritySnapshot["owner"]): OrdinaryAuthoritySnapshot => ({...binding, owner, grantId: owner, ownerReceiptId: `receipt:${owner}`, consumptionDigest: hash, consumptionRevision: 1, authorityDigest: hash, expiresAt: Date.now() + 55000, scope: input.scope, provider: "codex"});
const preparation = (): OrdinaryPreparation => ({providerAccess: authority("provider_access"), security: authority("runtime_security"), reservationId: "reservation:test", workspaceId: "workspace:test", materializationId: "material:test", credentialGeneration: 1});
const closure = (prepared: OrdinaryPreparation): readonly OrdinaryReceipt[] => [
  {...binding, kind: "dispatch_claim", claimId: "claim:test", committedRevision: 2, reservationId: prepared.reservationId, preparationDigest: ordinaryPreparationDigest(prepared)},
  {...binding, kind: "provider_terminal", terminalStatus: "completed", threadId: "thread:test", turnId: "turn:test"},
  {...binding, kind: "output_drain", finalSequence: 0, stdoutClosed: true, stderrClosed: true},
  {...binding, kind: "process_group_closed", reservationId: prepared.reservationId, pid: 200, processGroupId: 200, ownershipToken: "owner:test", exitObserved: true, groupEmptyObserved: true},
  {...binding, kind: "workspace_snapshot", workspaceId: prepared.workspaceId, snapshotDigest: hash, sourceDigest: hash, inventoryDigest: hash, stable: true},
  {...binding, kind: "artifact_published", workspaceId: prepared.workspaceId, snapshotDigest: hash, artifactDigest: hash, artifactManifestRef: "artifact:manifest", resultRef: "artifact:result", byteLength: 3},
  {...binding, kind: "credential_retired", materializationId: prepared.materializationId, generation: 1, retiredAt: new Date().toISOString()},
  {...binding, kind: "provider_grant_settled", grantId: prepared.providerAccess.grantId, ownerReceiptId: prepared.providerAccess.ownerReceiptId, settlementReceiptId: "settled:provider", disposition: "claim_committed"},
  {...binding, kind: "security_grant_settled", grantId: prepared.security.grantId, ownerReceiptId: prepared.security.ownerReceiptId, settlementReceiptId: "settled:security", disposition: "claim_committed"},
];
const succeeded = (): OrdinaryOperation => {const prepared = preparation(); return {...initial(), revision: 3, preparation: prepared, status: "succeeded", receipts: closure(prepared)};};

test("ordinary codec exact roundtrip and old codec rejection before dispatch", () => {
  const operation = succeeded(); assert.deepEqual(decodeOrdinaryState(encodeOrdinaryState(operation)), operation);
  const envelope = JSON.parse(encodeOrdinaryState(operation));
  assert.throws(() => decodeContainedTurnState(envelope, envelope.digest, 3), /unsupported_version/u);
  assert.throws(() => decodeOrdinaryState(JSON.stringify({...envelope, extra: true})), /exact closed record/u);
  assert.throws(() => decodeOrdinaryState(JSON.stringify({...envelope, executionProfile: "host-custody-v1"})), /profile invalid/u);
});
test("every closure receipt is mandatory and rejects cross-attempt/profile/reservation or owner mixing", () => {
  const operation = succeeded();
  for (const receipt of operation.receipts) {
    assert.throws(() => validateOrdinaryOperation({...operation, receipts: operation.receipts.filter(item => item !== receipt)}));
    assert.throws(() => validateOrdinaryOperation({...operation, receipts: operation.receipts.map(item => item === receipt ? {...item, attemptId: "attempt:foreign"} : item)}));
    assert.throws(() => validateOrdinaryOperation({...operation, receipts: operation.receipts.map(item => item === receipt ? {...item, executionProfile: "host-custody-v1"} : item)}));
  }
  assert.throws(() => validateOrdinaryOperation({...operation, receipts: operation.receipts.map(item => item.kind === "process_group_closed" ? {...item, reservationId: "other"} : item)}));
  assert.throws(() => validateOrdinaryOperation({...operation, receipts: operation.receipts.map(item => item.kind === "provider_grant_settled" ? {...item, ownerReceiptId: "other"} : item)}));
});
test("terminal output drain and canonical artifact must match durable state", () => {
  const operation = succeeded();
  assert.throws(() => validateOrdinaryOperation({...operation, output: [{cursor: 1, kind: "assistant", text: "late"}]}));
  assert.throws(() => validateOrdinaryOperation({...operation, receipts: operation.receipts.map(item => item.kind === "artifact_published" ? {...item, snapshotDigest: "b".repeat(64)} : item)}));
});

const fixture = (options: {unknownClaim?: boolean; missingClosure?: boolean; cancelBeforeClaim?: boolean} = {}) => {
  let operation: OrdinaryOperation | undefined; let starts = 0; let providerCalls = 0; let closedWorkspaces = 0;
  let prepared = preparation();
  const state = (): OrdinaryOperation => {assert.ok(operation); return operation;};
  const store: OrdinaryOperationStore = {
    accept: async submitted => {if (operation !== undefined) {return submitted.intent.prompt === operation.input.intent.prompt ? {kind: "duplicate", operation} : {kind: "conflict"};} operation = initial(); return {kind: "accepted", operation};},
    read: async () => operation,
    prepare: async (current, value) => {prepared = value; operation = {...current, preparation: value, revision: current.revision + 1}; return operation;},
    claim: async current => {
      if (options.cancelBeforeClaim) {operation = {...current, cancellationRequested: true}; return {kind: "not_claimed"};}
      const receipt = closure(prepared).find(item => item.kind === "dispatch_claim"); assert.ok(receipt);
      operation = {...current, revision: 2, status: "running", receipts: [receipt]};
      return options.unknownClaim ? {kind: "unknown"} : {kind: "claimed", operation, receipt};
    },
    cancel: async () => {if (operation !== undefined) {operation = {...operation, cancellationRequested: true, revision: operation.revision + 1};} return operation;},
    append: async (_current, output) => {operation = {...state(), revision: state().revision + 1, output: [...state().output, {...output, cursor: state().output.length + 1}]}; return operation;},
    finish: async (_current, receipts) => {operation = {...state(), receipts, revision: state().revision + 1}; operation = {...operation, status: ordinaryTerminalStatus(operation, receipts)}; return operation;},
    reconcile: async (_current, receipts) => {const merged = [...state().receipts, ...receipts.filter(item => !state().receipts.some(prior => prior.kind === item.kind))]; operation = {...state(), receipts: merged, revision: state().revision + 1, status: "reconcile_required"}; return operation;},
  };
  const receipt = <K extends OrdinaryReceipt["kind"]>(kind: K): Extract<OrdinaryReceipt, {kind: K}> => {const found = closure(prepared).find(item => item.kind === kind); assert.ok(found); return found as Extract<OrdinaryReceipt, {kind: K}>;};
  const dependencies: OrdinaryTurnDependencies = {
    operationStore: store,
    providerAccess: {resolveAndConsume: async () => {const snapshot = authority("provider_access"); return {grantId: snapshot.grantId, expiresAt: snapshot.expiresAt, authority: snapshot, materialize: async () => ({brokerEndpoint: "http://127.0.0.1:1234", materializationId: "material:test", generation: 1, environment: {}}), retire: async () => receipt("credential_retired"), settle: async disposition => ({...receipt("provider_grant_settled"), disposition})};}},
    security: {resolveAndConsume: async () => {const snapshot = authority("runtime_security"); return {grantId: snapshot.grantId, expiresAt: snapshot.expiresAt, authority: snapshot, admitOutput: async () => true, admitArtifact: async () => true, settle: async disposition => ({...receipt("security_grant_settled"), disposition})};}},
    workspace: {prepare: async () => ({workspaceId: "workspace:test", cwd: "/test", homeDirectory: "/test/home"}), snapshot: async () => ({receipt: receipt("workspace_snapshot"), resultBytes: new Uint8Array([1, 2, 3])}), close: async () => {closedWorkspaces += 1;}},
    artifacts: {publish: async () => receipt("artifact_published")},
    process: {reserve: async (request) => {assert.ok(request.deadline > performance.now() && request.deadline <= performance.now() + 45000); return ({reservationId: "reservation:test", start: async () => {starts += 1; assert.equal(state().status, "running"); return {lines: (async function* () {})(), write: async () => {}, closeInput: async () => {}};}, close: async (finalSequence) => {if (!starts) {return {kind: "not_started", reservationId: "reservation:test"};} if (options.missingClosure) {throw new Error("unclosed group");} return [{...receipt("output_drain"), finalSequence}, receipt("process_group_closed")];}});}},
    provider: {supported: {provider: "codex", mode: "workspace-write", executionProfile: ORDINARY_PROFILE.executionProfile, capabilityManifestRevision: ORDINARY_PROFILE.capabilityManifestRevision}, execute: async () => {providerCalls += 1; return receipt("provider_terminal");}},
  };
  return {dependencies, state, counts: () => ({starts, providerCalls, closedWorkspaces})};
};
test("concurrent duplicate submission runs one provider; conflicting payload never redispatches", async () => {
  const f = fixture(); const feature = createOrdinaryTurnFeature(f.dependencies);
  const outcomes = await Promise.all([feature.submit.execute(input), feature.submit.execute(input)]);
  assert.equal(f.counts().starts, 1); assert.equal(f.state().status, "succeeded");
  assert.ok(outcomes.every(item => item.status === "observed"));
  assert.deepEqual(await feature.submit.execute({...input, intent: {...input.intent, prompt: "different"}}), {status: "conflict", code: "command_fingerprint_conflict"});
  await feature.dispose();
});
test("unknown acknowledged-lost claim never launches even when readback shows claim", async () => {
  const f = fixture({unknownClaim: true}); const feature = createOrdinaryTurnFeature(f.dependencies);
  await feature.submit.execute(input); assert.equal(f.counts().starts, 0); assert.equal(f.state().status, "reconcile_required");
  await feature.submit.execute(input); assert.equal(f.counts().starts, 0);
});
test("restart observation remains read-only; missing physical closure retains recovery workspace", async () => {
  const f = fixture({missingClosure: true}); await createOrdinaryTurnFeature(f.dependencies).submit.execute(input);
  assert.equal(f.state().status, "reconcile_required"); assert.equal(f.counts().closedWorkspaces, 0);
  const restarted = createOrdinaryTurnFeature(f.dependencies);
  await restarted.observe.execute({operationId: binding.operationId, scope: input.scope});
  assert.equal(f.counts().providerCalls, 1);
});
test("durable cancellation before claim starts no provider and settles abandoned grants", async () => {
  const f = fixture({cancelBeforeClaim: true}); await createOrdinaryTurnFeature(f.dependencies).submit.execute(input);
  assert.equal(f.counts().starts, 0); assert.equal(f.state().status, "cancelled");
  // No cancellation proof is synthesized from a process exit or timeout.
  assert.equal(f.state().receipts.some(item => item.kind === "provider_terminal"), false);
});


test("cancellation from another host instance is read durably and terminal cancellation remains provider-owned", async () => {
  const f = fixture(); let started!: () => void;
  const ready = new Promise<void>(resolve => {started = resolve;});
  const provider = {...f.dependencies.provider, execute: async ({signal}: Parameters<OrdinaryTurnDependencies["provider"]["execute"]>[0]) => {
    started();
    await new Promise<void>(resolve => {if (signal.aborted) {resolve();} else {signal.addEventListener("abort", () => resolve(), {once: true});}});
    return {...binding, kind: "provider_terminal", terminalStatus: "cancelled", threadId: "thread:test", turnId: "turn:test"} as const;
  }};
  const feature = createOrdinaryTurnFeature({...f.dependencies, provider});
  const submitted = feature.submit.execute(input); await ready;
  await createOrdinaryTurnFeature(f.dependencies).cancel.execute({operationId: binding.operationId, scope: input.scope});
  const outcome = await submitted;
  assert.equal(outcome.status, "observed"); assert.equal(f.state().status, "cancelled");
});
test("dispose persists cancellation, joins the active provider and closes admission", async () => {
  const f = fixture(); let started!: () => void; let providerJoined = false;
  const ready = new Promise<void>(resolve => {started = resolve;});
  const provider = {...f.dependencies.provider, execute: async ({signal}: Parameters<OrdinaryTurnDependencies["provider"]["execute"]>[0]) => {
    started(); await new Promise<void>(resolve => {signal.addEventListener("abort", () => resolve(), {once: true});});
    providerJoined = true;
    return {...binding, kind: "provider_terminal", terminalStatus: "cancelled", threadId: "thread:test", turnId: "turn:test"} as const;
  }};
  const feature = createOrdinaryTurnFeature({...f.dependencies, provider});
  const submitted = feature.submit.execute(input); await ready; await feature.dispose(); await submitted;
  assert.equal(providerJoined, true); assert.equal(f.state().cancellationRequested, true);
  assert.deepEqual(await feature.submit.execute(input), {status: "denied"});
});

test("receipt discrimination rejects accessor data without invoking the getter", () => {
  let reads = 0;
  const invalid = {...binding, get kind() {reads += 1; return "provider_terminal";}};
  assert.throws(() => validateOrdinaryReceipt(invalid, binding)); assert.equal(reads, 0);
});


test("foreign tenant not_found cancellation cannot abort the local owned flight", async () => {
  const f = fixture(); const cancel = f.dependencies.operationStore.cancel;
  f.dependencies.operationStore.cancel = async ref => ref.scope.tenantId === input.scope.tenantId ? cancel(ref) : undefined;
  let started!: () => void; let finish!: () => void; let observedSignal: AbortSignal | undefined;
  const ready = new Promise<void>(resolve => {started = resolve;}); const done = new Promise<void>(resolve => {finish = resolve;});
  const provider = {...f.dependencies.provider, execute: async ({signal}: Parameters<OrdinaryTurnDependencies["provider"]["execute"]>[0]) => {
    observedSignal = signal; started(); await done;
    return {...binding, kind: "provider_terminal", terminalStatus: "completed", threadId: "thread:test", turnId: "turn:test"} as const;
  }};
  const feature = createOrdinaryTurnFeature({...f.dependencies, provider}); const submitted = feature.submit.execute(input); await ready;
  assert.deepEqual(await feature.cancel.execute({operationId: binding.operationId, scope: {...input.scope, tenantId: "foreign"}}), {status: "not_found"});
  assert.equal(observedSignal?.aborted, false); finish(); await submitted;
});
test("dispose waits for in-flight durable acceptance and cancels it before launch", async () => {
  const f = fixture(); const accept = f.dependencies.operationStore.accept;
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => {entered = resolve;}); const wait = new Promise<void>(resolve => {release = resolve;});
  f.dependencies.operationStore.accept = async value => {entered(); await wait; return accept(value);};
  const feature = createOrdinaryTurnFeature(f.dependencies); const submitted = feature.submit.execute(input); await ready;
  let disposed = false; const closing = feature.dispose().then(() => {disposed = true;});
  await Promise.resolve(); assert.equal(disposed, false); release(); await closing; await submitted;
  assert.equal(f.counts().starts, 0); assert.equal(f.state().cancellationRequested, true);
});
test("lost output commit acknowledgement reads durable cursor before drain and reconciles", async () => {
  const f = fixture(); const append = f.dependencies.operationStore.append;
  f.dependencies.operationStore.append = async (operation, output) => {await append(operation, output); throw new Error("synthetic commit acknowledgement lost");};
  const provider = {...f.dependencies.provider, execute: async ({emit}: Parameters<OrdinaryTurnDependencies["provider"]["execute"]>[0]) => {
    await emit({kind: "assistant", text: "durable output"});
    return {...binding, kind: "provider_terminal", terminalStatus: "completed", threadId: "thread:test", turnId: "turn:test"} as const;
  }};
  const result = await createOrdinaryTurnFeature({...f.dependencies, provider}).submit.execute(input);
  assert.equal(result.status, "observed"); assert.equal(f.state().status, "reconcile_required");
  assert.equal(f.state().output.length, 1); assert.equal(f.state().receipts.find(receipt => receipt.kind === "output_drain")?.finalSequence, 1);
});
test("signal cancellation persistence is joined before submit and dispose settle", async () => {
  const f = fixture(); const cancel = f.dependencies.operationStore.cancel;
  let entered!: () => void; let release!: () => void; let ready!: () => void;
  const pendingCancel = new Promise<void>(resolve => {entered = resolve;}); const waitCancel = new Promise<void>(resolve => {release = resolve;}); const providerReady = new Promise<void>(resolve => {ready = resolve;});
  f.dependencies.operationStore.cancel = async ref => {entered(); await waitCancel; return cancel(ref);};
  const signal = new AbortController();
  const provider = {...f.dependencies.provider, execute: async () => {ready(); await pendingCancel; return {...binding, kind: "provider_terminal", terminalStatus: "completed", threadId: "thread:test", turnId: "turn:test"} as const;}};
  const feature = createOrdinaryTurnFeature({...f.dependencies, provider});
  let submitted = false; const submission = feature.submit.execute(input, {signal: signal.signal}).then(() => {submitted = true;});
  await providerReady; signal.abort(); await pendingCancel; await Promise.resolve(); assert.equal(submitted, false);
  let disposed = false; const closing = feature.dispose().then(() => {disposed = true;}); await Promise.resolve(); assert.equal(disposed, false);
  release(); await submission; await closing; assert.equal(submitted, true);
});

test("failed before-close readback retains process cleanup but never invents output drain evidence", async () => {
  const f = fixture(); const append = f.dependencies.operationStore.append; const read = f.dependencies.operationStore.read; let failRead = false;
  f.dependencies.operationStore.append = async (operation, output) => {await append(operation, output); failRead = true; throw new Error("unknown commit");};
  f.dependencies.operationStore.read = async ref => {if (failRead) {failRead = false; throw new Error("readback unavailable");} return read(ref);};
  const provider = {...f.dependencies.provider, execute: async ({emit}: Parameters<OrdinaryTurnDependencies["provider"]["execute"]>[0]) => {
    await emit({kind: "assistant", text: "durable output"});
    return {...binding, kind: "provider_terminal", terminalStatus: "completed", threadId: "thread:test", turnId: "turn:test"} as const;
  }};
  await createOrdinaryTurnFeature({...f.dependencies, provider}).submit.execute(input);
  assert.equal(f.state().status, "reconcile_required"); assert.equal(f.state().receipts.some(receipt => receipt.kind === "output_drain"), false);
  assert.equal(f.state().receipts.some(receipt => receipt.kind === "process_group_closed"), true);
});
