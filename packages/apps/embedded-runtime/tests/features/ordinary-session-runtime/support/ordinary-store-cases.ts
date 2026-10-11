// Port-level contract cases for the ordinary operation store. The ordinary feature wraps them with
// `contractSuite`. STORE-2-core moves this file unchanged into the private storage compatibility package and Embedded
// Runtime then imports it from there; never copy it. Import only `node:assert/strict`, `node:crypto` and port types
// or constants from `@agent-teams/agent-execution/composition`: no Get Modular, no `node:test`, no embedded-runtime
// code.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import type {OrdinaryAuthoritySnapshot, OrdinaryOperation, OrdinaryOperationStore, OrdinaryReceipt, OrdinaryReceiptOf} from "@agent-teams/agent-execution/composition";

export type StoreCase = (store: OrdinaryOperationStore) => Promise<void>;
type StoreInput = Parameters<OrdinaryOperationStore["accept"]>[0];
type StorePreparation = Parameters<OrdinaryOperationStore["prepare"]>[1];
type StoreScope = StoreInput["scope"];

const hash = "a".repeat(64);
const defaultScope: StoreScope = {tenantId: "suite", projectId: "suite"};
const input = (commandId: string, scope: StoreScope = defaultScope, prompt = "Read TASK.md and write result.txt"): StoreInput =>
  ({commandId, expectedProvider: "codex", intent: {mode: "workspace-write", prompt}, scope});
const refOf = (operation: OrdinaryOperation) => ({operationId: operation.operationId, scope: operation.scope});
const bindingOf = (operation: OrdinaryOperation) => ({operationId: operation.operationId, attemptId: operation.attemptId,
  executionProfile: operation.executionProfile, capabilityManifestRevision: operation.capabilityManifestRevision});
const authority = (operation: OrdinaryOperation, owner: OrdinaryAuthoritySnapshot["owner"], expiresInMs: number): OrdinaryAuthoritySnapshot =>
  ({...bindingOf(operation), owner, grantId: `grant:${owner}`, ownerReceiptId: `receipt:${owner}`, consumptionDigest: hash,
    consumptionRevision: 1, authorityDigest: hash, expiresAt: Date.now() + expiresInMs, scope: operation.scope, provider: "codex"});
const preparationFor = (operation: OrdinaryOperation, expiresInMs = 55000): StorePreparation =>
  ({providerAccess: authority(operation, "provider_access", expiresInMs), security: authority(operation, "runtime_security", expiresInMs),
    reservationId: "reservation:suite", workspaceId: "workspace:suite", materializationId: "material:suite", credentialGeneration: 1});
/** The eight receipts other than `dispatch_claim`; the claim itself always comes from the store. */
const closureFor = (operation: OrdinaryOperation): readonly OrdinaryReceipt[] => {
  const {preparation} = operation;
  assert.ok(preparation !== null);
  const binding = bindingOf(operation);
  return [
    {...binding, kind: "provider_terminal", terminalStatus: "completed", threadId: "thread:suite", turnId: "turn:suite"},
    {...binding, kind: "output_drain", finalSequence: operation.output.length, stdoutClosed: true, stderrClosed: true},
    {...binding, kind: "process_group_closed", reservationId: preparation.reservationId, pid: 200, processGroupId: 200, ownershipToken: "owner:suite", exitObserved: true, groupEmptyObserved: true},
    {...binding, kind: "workspace_snapshot", workspaceId: preparation.workspaceId, snapshotDigest: hash, sourceDigest: hash, inventoryDigest: hash, stable: true},
    {...binding, kind: "artifact_published", workspaceId: preparation.workspaceId, snapshotDigest: hash, artifactDigest: hash, artifactManifestRef: "artifact:manifest", resultRef: "artifact:result", byteLength: 3},
    {...binding, kind: "credential_retired", materializationId: preparation.materializationId, generation: preparation.credentialGeneration, retiredAt: new Date().toISOString()},
    {...binding, kind: "provider_grant_settled", grantId: preparation.providerAccess.grantId, ownerReceiptId: preparation.providerAccess.ownerReceiptId, settlementReceiptId: "settled:provider", disposition: "claim_committed"},
    {...binding, kind: "security_grant_settled", grantId: preparation.security.grantId, ownerReceiptId: preparation.security.ownerReceiptId, settlementReceiptId: "settled:security", disposition: "claim_committed"},
  ];
};
const providerTerminalCompleted = (operation: OrdinaryOperation): OrdinaryReceiptOf<"provider_terminal"> => {
  const receipt = closureFor(operation).find(item => item.kind === "provider_terminal");
  assert.ok(receipt?.kind === "provider_terminal");
  return receipt;
};

const accepted = async (store: OrdinaryOperationStore, scope: StoreScope = defaultScope): Promise<OrdinaryOperation> => {
  const result = await store.accept(input(`command:${randomUUID()}`, scope));
  assert.ok(result.kind === "accepted");
  return result.operation;
};
const prepared = async (store: OrdinaryOperationStore): Promise<OrdinaryOperation> => {
  const operation = await accepted(store);
  return store.prepare(operation, preparationFor(operation));
};
const claimed = async (store: OrdinaryOperationStore): Promise<{readonly operation: OrdinaryOperation; readonly receipt: OrdinaryReceiptOf<"dispatch_claim">; readonly preparedRevision: number}> => {
  const operation = await prepared(store);
  const result = await store.claim(operation);
  assert.ok(result.kind === "claimed");
  return {operation: result.operation, receipt: result.receipt, preparedRevision: operation.revision};
};
const unprepared = async (store: OrdinaryOperationStore, operation: OrdinaryOperation): Promise<void> => {
  assert.equal((await store.read(refOf(operation)))?.preparation, null);
};

export const ordinaryStoreCases: Readonly<Record<string, StoreCase>> = Object.freeze({
  "accepts a command once and returns it as a duplicate": async store => {
    const command = input(`command:${randomUUID()}`);
    const first = await store.accept(command);
    assert.ok(first.kind === "accepted");
    assert.equal(first.operation.revision, 0);
    assert.equal(first.operation.status, "accepted");
    const second = await store.accept(command);
    assert.ok(second.kind === "duplicate");
    assert.equal(second.operation.operationId, first.operation.operationId);
  },
  "reports a conflict for the same command with another intent": async store => {
    const commandId = `command:${randomUUID()}`;
    assert.equal((await store.accept(input(commandId))).kind, "accepted");
    assert.equal((await store.accept(input(commandId, defaultScope, "Another intent"))).kind, "conflict");
  },
  "keeps scopes apart": async store => {
    const commandId = `command:${randomUUID()}`;
    const first = await store.accept(input(commandId, {tenantId: "tenant-a", projectId: "suite"}));
    const second = await store.accept(input(commandId, {tenantId: "tenant-b", projectId: "suite"}));
    assert.ok(first.kind === "accepted" && second.kind === "accepted");
    assert.notEqual(first.operation.operationId, second.operation.operationId);
    assert.equal(await store.read({operationId: first.operation.operationId, scope: second.operation.scope}), undefined);
  },
  "accepts exactly once under concurrent submissions": async store => {
    const command = input(`command:${randomUUID()}`);
    const results = await Promise.all(Array.from({length: 8}, () => store.accept(command)));
    assert.equal(results.filter(item => item.kind === "accepted").length, 1);
    assert.equal(results.filter(item => item.kind === "duplicate").length, 7);
    const ids = results.flatMap(item => item.kind === "accepted" || item.kind === "duplicate" ? [item.operation.operationId] : []);
    assert.equal(new Set(ids).size, 1);
  },
  "reads back the accepted operation": async store => {
    const operation = await accepted(store);
    assert.deepEqual(await store.read(refOf(operation)), operation);
  },
  "prepares once and rejects a stale revision": async store => {
    const operation = await accepted(store);
    await assert.rejects(store.prepare({...operation, revision: operation.revision + 1}, preparationFor(operation)));
    await unprepared(store, operation);
    const preparation = preparationFor(operation);
    const result = await store.prepare(operation, preparation);
    assert.equal(result.revision, operation.revision + 1);
    assert.deepEqual(result.preparation, preparation);
    await assert.rejects(store.prepare(operation, preparationFor(operation)));
  },
  "rejects a preparation whose authority expires too soon or too late": async store => {
    const operation = await accepted(store);
    for (const expiresInMs of [5000, 120000]) {
      await assert.rejects(store.prepare(operation, preparationFor(operation, expiresInMs)));
      await unprepared(store, operation);
    }
  },
  "claims exactly once under concurrent claims": async store => {
    const operation = await prepared(store);
    const results = await Promise.all(Array.from({length: 8}, () => store.claim(operation)));
    const winners = results.filter(item => item.kind === "claimed");
    assert.equal(winners.length, 1);
    assert.equal(results.filter(item => item.kind === "not_claimed").length, 7);
    const [winner] = winners;
    assert.ok(winner?.kind === "claimed");
    assert.equal(winner.operation.status, "running");
    assert.equal(winner.operation.revision, operation.revision + 1);
    assert.deepEqual(winner.operation.receipts, [winner.receipt]);
    assert.equal(winner.receipt.kind, "dispatch_claim");
    assert.equal(winner.receipt.reservationId, operation.preparation?.reservationId);
  },
  "does not claim an unprepared or cancelled operation": async store => {
    const operation = await accepted(store);
    assert.equal((await store.claim(operation)).kind, "not_claimed");
    const preparedOperation = await store.prepare(operation, preparationFor(operation));
    const cancelled = await store.cancel(refOf(preparedOperation));
    assert.ok(cancelled !== undefined);
    assert.equal(cancelled.cancellationRequested, true);
    assert.equal((await store.claim(cancelled)).kind, "not_claimed");
  },
  "cancels once and ignores unknown operations": async store => {
    const operation = await accepted(store);
    const cancelled = await store.cancel(refOf(operation));
    assert.ok(cancelled !== undefined);
    assert.equal(cancelled.cancellationRequested, true);
    assert.equal(cancelled.revision, operation.revision + 1);
    assert.equal((await store.cancel(refOf(operation)))?.revision, cancelled.revision);
    assert.equal(await store.cancel({operationId: `ordinary:${randomUUID()}`, scope: operation.scope}), undefined);
  },
  "appends output only to the running attempt": async store => {
    const operation = await prepared(store);
    await assert.rejects(store.append(operation, {kind: "assistant", text: "too early"}));
    const claim = await store.claim(operation);
    assert.ok(claim.kind === "claimed");
    const first = await store.append(claim.operation, {kind: "assistant", text: "one"});
    const second = await store.append(first, {kind: "progress", text: "two"});
    assert.deepEqual(first.output.map(item => item.cursor), [1]);
    assert.deepEqual(second.output.map(item => item.cursor), [1, 2]);
    assert.deepEqual(second.output.map(item => item.text), ["one", "two"]);
  },
  "finishes with the merged closure and keeps a terminal operation unchanged": async store => {
    const {operation, receipt} = await claimed(store);
    const finished = await store.finish(operation, [receipt, ...closureFor(operation)]);
    assert.equal(finished.status, "succeeded");
    assert.equal(new Set(finished.receipts.map(item => item.kind)).size, 9);
    assert.equal(finished.receipts.length, 9);
    const again = await store.finish(operation, [receipt, ...closureFor(operation)]);
    assert.equal(again.revision, finished.revision);
    assert.equal(again.status, "succeeded");
  },
  "keeps an incomplete closure in reconciliation": async store => {
    const {operation, receipt} = await claimed(store);
    const finished = await store.finish(operation, [receipt, providerTerminalCompleted(operation)]);
    assert.equal(finished.status, "reconcile_required");
  },
  "rejects a receipt that contradicts a recorded one": async store => {
    const {operation, receipt} = await claimed(store);
    await assert.rejects(store.finish(operation, [{...receipt, claimId: `claim:${randomUUID()}`}]));
    assert.equal((await store.read(refOf(operation)))?.revision, operation.revision);
  },
  "reconciles and completes the closure later": async store => {
    const {operation, receipt} = await claimed(store);
    const reconciling = await store.reconcile(operation, [receipt]);
    assert.equal(reconciling.status, "reconcile_required");
    const finished = await store.finish(operation, [receipt, ...closureFor(operation)]);
    assert.equal(finished.status, "succeeded");
  },
});
