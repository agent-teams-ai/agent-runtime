import assert from "node:assert/strict";
import test from "node:test";
import { operationHarness, acceptedFixture, fixtureHash } from "./operation-dispatch-test-fixture.ts";
import { createOperationDispatchRepository } from "../../../dist/features/contained-turn-access/adapters/outbound/dispatch-operation-repository.js";
import type { DispatchConsumptionTransaction } from "../../../dist/features/contained-turn-access/application/ports/outbound/dispatch-consumption-repository.js";
import { settlementFor } from "./dispatch-consumption-test-fixture.ts";

test("PA v2 actual current resolution gives independent A/B publications and one consumption each", async () => {
  const h = operationHarness(); const one = h.rebuild(); const two = h.rebuild();
  assert.equal(h.records("issuance").length, 0, "Construction has no effects");
  const [a, b] = await Promise.all([h.accept("operation:A"), h.accept("operation:B")]);
  assert.deepEqual(await one.dispatchConsumption.publishAndConsumeForDispatch(a.prepared, a.request), {kind: "indeterminate"}, "Projection cannot provision authority");
  assert.equal(h.records("publication").length, 0);
  await one.control.provisionIssuance();
  const before = structuredClone({binding: h.state.binding, version: h.state.version});
  const [first, second] = await Promise.all([one.dispatchConsumption.publishAndConsumeForDispatch(a.prepared, a.request),
    two.dispatchConsumption.publishAndConsumeForDispatch(b.prepared, b.request)]);
  assert.equal(first.kind, "consumed"); assert.equal(second.kind, "consumed");
  assert.equal(h.records("publication").length, 2); assert.equal(h.records("consumption").length, 2);
  assert.deepEqual({binding: h.state.binding, version: h.state.version}, before);
  if (first.kind !== "consumed" || second.kind !== "consumed") {throw new Error("Expected A and B receipts");}
  assert.equal(first.receipt.authorityHeadDigestAtConsumption, h.selection.binding.credentialBindingDigest);
  assert.equal(first.receipt.credentialBindingDigest, fixtureHash({ownerDigest: h.selection.binding.credentialBindingDigest}));
  assert.notEqual(first.receipt.bindingDigest, first.receipt.credentialBindingDigest);
  assert.equal(first.receipt.bindingRevision, second.receipt.bindingRevision);
  assert.equal(first.receipt.credentialGeneration, second.receipt.credentialGeneration);
  assert.equal(first.receipt.opaqueOwnerEvidenceRef, h.selection.issuanceRef);
  await h.changeBinding({...h.state.binding, revocation: "revoked"});
  const rebuilt = h.rebuild();
  assert.deepEqual(await rebuilt.dispatchConsumption.publishAndConsumeForDispatch(a.prepared, a.request), first);
  const settled = await Promise.all([rebuilt.dispatchConsumption.settleDispatchConsumption(settlementFor(first.receipt)),
    two.dispatchConsumption.settleDispatchConsumption(settlementFor(second.receipt))]);
  assert.deepEqual(settled.map(value => value.kind), ["settled", "settled"]);
  assert.deepEqual(await h.rebuild().dispatchConsumption.settleDispatchConsumption(settlementFor(first.receipt)), settled[0]);
});

test("same-operation racing/replay preserves exact evidence, deadlines and sole consumption after rotation", async () => {
  const h = operationHarness(); await h.rebuild().control.provisionIssuance(); const a = await h.accept("operation:race");
  const results = await Promise.all(Array.from({length: 12}, () => h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(a.prepared, a.request)));
  assert.equal(results[0]?.kind, "consumed"); for (const result of results) {assert.deepEqual(result, results[0]);}
  const original = h.records("publication");
  const changed = await h.accept("operation:race", "grant:changed");
  assert.equal((await h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(changed.prepared, changed.request)).kind, "conflict");
  await h.changeBinding({...h.state.binding, bindingRevision: 8, credentialGeneration: 4, credentialBindingDigest: fixtureHash({material: "rotated-C"})});
  const rotatedSelection = {...h.selection, binding: h.state.binding, materializationHeadVersion: 2, issuanceRef: "issuance:rotation"};
  const rotated = h.rebuild(rotatedSelection); await rotated.control.provisionIssuance();
  const {bindingRevision: revision, availability: _availability, revocation: _revocation, scopeDigest: _scopeDigest, ...binding} = h.state.binding;
  const replacement = await acceptedFixture({...binding, revision}, "operation:race", "grant:rotation");
  assert.equal((await rotated.dispatchConsumption.publishAndConsumeForDispatch(replacement.prepared, replacement.request)).kind, "conflict");
  h.state.now = h.selection.expiresAtControlTime + 1;
  assert.deepEqual(await rotated.dispatchConsumption.publishAndConsumeForDispatch(a.prepared, a.request), results[0]);
  assert.deepEqual(h.records("publication"), original); assert.equal(h.records("consumption").length, 1);
  await assert.rejects(h.rebuild({...h.selection, claimBeforeControlTime: h.selection.claimBeforeControlTime + 1}).control.provisionIssuance(), /rebound/u);
});

test("absent outcome is immutable and a new request cannot turn the same operation into permission", async () => {
  const h = operationHarness(); const owner = h.rebuild(); const absent = await h.accept("operation:absent");
  assert.deepEqual(await owner.dispatchConsumption.consumeForDispatch(absent.request), {kind: "not_found"});
  await owner.control.provisionIssuance();
  assert.deepEqual(await owner.dispatchConsumption.publishAndConsumeForDispatch(absent.prepared, absent.request), {kind: "not_found"});
  const changed = await h.accept("operation:absent", "grant:escape");
  assert.equal((await owner.dispatchConsumption.publishAndConsumeForDispatch(changed.prepared, changed.request)).kind, "conflict");
  assert.equal(h.records("consumption").length, 0);
});

test("materialization revocation between publication and consumption wins without head restoration", async () => {
  const h = operationHarness(); await h.rebuild().control.provisionIssuance(); const a = await h.accept("operation:revoked");
  h.state.beforeCommit = async kinds => {
    if (kinds.includes("publication")) {h.state.binding = {...h.state.binding, revocation: "revoked"}; h.state.version++;}
  };
  assert.deepEqual(await h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(a.prepared, a.request), {kind: "indeterminate"});
  assert.equal(h.records("publication").length, 1); assert.equal(h.records("consumption").length, 0);
  assert.equal(h.state.binding.revocation, "revoked"); assert.equal(h.state.version, 2);
  h.state.beforeCommit = undefined;
  assert.deepEqual(await h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(a.prepared, a.request), {kind: "indeterminate"});
  assert.equal(h.records("consumption").length, 0);
});

test("publication acknowledgement is a barrier; rollback and lost acknowledgement confer no consumption", async () => {
  const h = operationHarness(); await h.rebuild().control.provisionIssuance(); const a = await h.accept("operation:barrier");
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;}); const gate = new Promise<void>(resolve => {release = resolve;});
  h.state.beforeCommit = async kinds => {if (kinds.includes("publication")) {entered(); await gate;}};
  const pending = h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(a.prepared, a.request);
  await started; assert.equal(h.records("consumption").length, 0); assert.equal(h.records("publication").length, 0);
  h.state.failBeforeCommit = true; release(); assert.deepEqual(await pending, {kind: "indeterminate"});
  assert.equal(h.records("publication").length, 0); h.state.failBeforeCommit = false; h.state.beforeCommit = undefined;
  h.state.loseCommit = "publication";
  assert.deepEqual(await h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(a.prepared, a.request), {kind: "indeterminate"});
  assert.equal(h.records("publication").length, 1); assert.equal(h.records("consumption").length, 0);
  const historical = h.records("publication");
  h.state.unavailable = true;
  assert.deepEqual(await h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(a.prepared, a.request), {kind: "indeterminate"});
  assert.equal(h.records("consumption").length, 0);
  h.state.unavailable = false;
  const replay = await h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(a.prepared, a.request);
  assert.equal(replay.kind, "consumed"); assert.deepEqual(h.records("publication"), historical);
});

test("unknown/malformed joins, changed request bindings and fixed windows fail closed", async () => {
  const h = operationHarness(); await h.rebuild().control.provisionIssuance(); const a = await h.accept("operation:mapping");
  for (const change of [{providerBindingDigest: fixtureHash({wrong: true})}, {acceptedAuthorityDigest: fixtureHash({wrong: true})},
    {scope: {...a.prepared.scope, scopeDigest: fixtureHash({wrong: true})}}, {claimBindingDigest: fixtureHash({wrong: true})},
    {requestDigest: fixtureHash({wrong: true})}, {acceptedBinding: {...a.prepared.acceptedBinding, credentialGeneration: 4}}]) {
    const outcome = await h.rebuild().dispatchConsumption.publishAndConsumeForDispatch({...a.prepared, ...change}, a.request);
    assert.ok(outcome.kind === "invalid" || outcome.kind === "conflict");
  }
  for (const now of [99, h.selection.claimBeforeControlTime]) {
    h.state.now = now;
    assert.deepEqual(await h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(a.prepared, a.request), {kind: "indeterminate"});
  }
  assert.equal(h.records("publication").length, 0); assert.equal(h.records("consumption").length, 0);
});

test("lost consumption/settlement acknowledgement replays durable evidence without new use", async () => {
  const h = operationHarness(); const owner = h.rebuild(); await owner.control.provisionIssuance();
  const op = await h.accept("operation:lost-consumption");
  h.state.loseCommit = "consumption";
  assert.deepEqual(await owner.dispatchConsumption.publishAndConsumeForDispatch(op.prepared, op.request), {kind: "indeterminate"});
  assert.equal(h.records("consumption").length, 1);
  const observed = await h.rebuild().dispatchConsumption.observeDispatchConsumption({grantRequestId: op.request.grantRequestId,
    requestDigest: op.request.requestDigest, provider: op.request.provider, scope: op.request.scope});
  assert.equal(observed.kind, "consumed"); if (observed.kind !== "consumed") {throw new Error("Expected retained receipt");}
  assert.deepEqual(await h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(op.prepared, op.request), observed);
  h.state.loseCommit = "settlement";
  assert.deepEqual(await owner.dispatchConsumption.settleDispatchConsumption(settlementFor(observed.receipt)), {kind: "indeterminate"});
  assert.equal((await h.rebuild().dispatchConsumption.settleDispatchConsumption(settlementFor(observed.receipt))).kind, "settled");
  assert.equal(h.records("settlement").length, 1); assert.equal(h.records("consumption").length, 1);
});

test("independent materialization version changes before publication cannot be hidden by identical binding payload", async () => {
  const h = operationHarness(); await h.rebuild().control.provisionIssuance(); const op = await h.accept("operation:version");
  await h.changeBinding(h.state.binding);
  assert.deepEqual(await h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(op.prepared, op.request), {kind: "indeterminate"});
  assert.equal(h.records("publication").length, 0); assert.equal(h.records("consumption").length, 0);
  assert.equal(h.state.version, 2);
});

test("every independently issued binding field is checked even when both handoff and request recompute consistently", async () => {
  const changes = [{accessRef: "access:foreign"}, {credentialBindingDigest: fixtureHash({different: "C"})},
    {credentialBindingRef: "credential:foreign"}, {credentialGeneration: 9}, {providerAccountRef: "account:foreign"},
    {providerRouteRef: "route:foreign"}, {revision: 9}, {tenantId: "tenant:foreign"}, {projectId: "project:foreign"}, {provider: "claude" as const}];
  for (const change of changes) {
    const h = operationHarness(); await h.rebuild().control.provisionIssuance(); const op = await h.accept("operation:binding-substitution");
    const changed = await acceptedFixture({...op.prepared.acceptedBinding, ...change}, op.request.operationId);
    const result = await h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(changed.prepared, changed.request);
    assert.ok(result.kind === "conflict" || result.kind === "indeterminate");
    assert.equal(h.records("publication").length, 0); assert.equal(h.records("consumption").length, 0);
  }
});

test("retained operation transaction cannot return cached head or control time after close", async () => {
  const h = operationHarness(); await h.rebuild().control.provisionIssuance(); const op = await h.accept("operation:closed");
  assert.equal((await h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(op.prepared, op.request)).kind, "consumed");
  const owner = {scope: op.request.scope, provider: op.request.provider};
  const repository = createOperationDispatchRepository(h.store, owner, op.request.operationId, op.request);
  let retained: DispatchConsumptionTransaction | undefined;
  await repository.transact({...owner, kind: "consume", grantRequestId: op.request.grantRequestId}, async tx => {retained = tx;});
  assert.ok(retained);
  await assert.rejects(retained.controlTime()); await assert.rejects(retained.findBindingHead());
});

test("competing historical settlements serialize once and never reopen the consumed operation", async () => {
  const h = operationHarness(); await h.rebuild().control.provisionIssuance(); const op = await h.accept("operation:settlement-race");
  const consumed = await h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(op.prepared, op.request);
  assert.equal(consumed.kind, "consumed"); if (consumed.kind !== "consumed") {throw new Error("Expected consumption");}
  await h.changeBinding({...h.state.binding, revocation: "revoked"});
  const results = await Promise.all(Array.from({length: 8}, (_, index) => h.rebuild().dispatchConsumption.settleDispatchConsumption(
    settlementFor(consumed.receipt, {settlementRequestId: `settlement:${index}`, disposition: index % 2 ? "claim_committed" : "abandoned_without_claim"}))));
  assert.equal(results.filter(result => result.kind === "settled").length, 1);
  assert.equal(results.filter(result => result.kind === "conflict").length, 7);
  assert.deepEqual(await h.rebuild().dispatchConsumption.publishAndConsumeForDispatch(op.prepared, op.request), consumed);
  assert.equal(h.records("consumption").length, 1);
});
