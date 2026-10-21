import assert from "node:assert/strict";
import test from "node:test";
import type {Event, Reply} from "../../../dist/interactive-contracts.js";
import {createInteractiveSessionFeature} from "../../../dist/features/interactive-agent-session/composition/interactive-session-factory.js";
import {deferred, fixture, ref} from "./support.ts";

test("scope-bound factory drives multiple inputs, snapshot identities and independent interaction replies through canonical SPI", async () => {
  const f = fixture(); const feature = createInteractiveSessionFeature(f.deps);
  assert.equal((await feature.session.open(ref, "open", "config-1", ["mcp"])).status, "accepted");
  const first = await feature.session.submit(ref, {commandId: "first", inputId: "first", content: "TEST first"});
  const second = await feature.session.submit(ref, {commandId: "second", inputId: "second", content: "TEST second"});
  await feature.control.dispatch(ref);
  const events: Event[] = [
    {sessionRef: f.driver.sessionRef, operationRef: first.receipt!.operationId, inputId: "first", kind: "text", messageRef: "message-1", block: 0, text: "partial", phase: "snapshot"},
    {sessionRef: f.driver.sessionRef, operationRef: first.receipt!.operationId, inputId: "first", kind: "interaction", interactionRef: "approval", request: {kind: "permission", tool: "TEST-mcp", input: {value: 1}}},
    {sessionRef: f.driver.sessionRef, operationRef: first.receipt!.operationId, inputId: "first", kind: "result", outcome: "succeeded"},
  ];
  f.driver.observe = async function* () {yield* events;};
  await feature.control.pumpOutput(ref); await feature.control.pumpOutput(ref);
  assert.equal((await feature.session.reply(ref, "answer", "approval", {kind: "permission", decision: "allow"})).status, "accepted");
  await feature.control.pumpOutput(ref); await feature.control.dispatch(ref);
  assert.deepEqual(f.calls.handoffs, [first.receipt!.operationId, second.receipt!.operationId]);
  const snapshot = (await feature.session.read(ref))!;
  assert.deepEqual(snapshot.events[0]!.data, {kind: "text", messageRef: "message-1", block: 0, text: "partial", phase: "snapshot"});
  assert.equal(JSON.stringify(snapshot).includes("TEST first"), false);
  assert.equal(JSON.stringify(snapshot).includes(f.driver.sessionRef), false);
  assert.equal((await feature.session.open({...ref, tenantId: "foreign"}, "open", "config-1", [])).status, "denied");
  await feature.session.close(ref);
});

test("canonical handoff mismatched CID is uncertain; explicit known-not-sent remains distinguishable", async () => {
  const f = fixture(); const feature = createInteractiveSessionFeature(f.deps);
  await feature.session.open(ref, "open", "config", []);
  const admitted = await feature.session.submit(ref, {commandId: "first", inputId: "first", content: "TEST"});
  f.driver.submit = async () => ({ok: false, code: "backpressure", delivery: "known-not-sent"});
  assert.equal((await feature.control.dispatch(ref)).status, "accepted");
  assert.equal((await feature.session.read(ref))!.inputs[0]!.delivery, "known_not_sent");
  f.driver.submit = async () => ({ok: true, value: {inputId: "foreign", operationRef: admitted.receipt!.operationId, delivery: "client-consumed", providerAcceptance: "unknown"}});
  assert.equal((await feature.control.dispatch(ref)).status, "unknown");
  assert.equal((await feature.session.read(ref))!.status, "reconcile_required");
});

test("factory result arriving after close remains owned for bounded cleanup reconciliation", async () => {
  const f = fixture(); const opened = deferred<{driver: typeof f.driver; capabilities: string[]}>(); const entered = deferred<void>();
  const feature = createInteractiveSessionFeature({...f.deps, drivers: {open: async () => {entered.resolve(); return opened.promise;}}});
  const opening = feature.session.open(ref, "open", "config", []); await entered.promise;
  assert.equal((await feature.session.close(ref)).status, "unknown");
  opened.resolve({driver: f.driver, capabilities: []}); await opening;
  assert.equal((await feature.session.close(ref)).status, "duplicate"); assert.equal(f.calls.closes, 1);
});

test("unsupported capability closes the concrete session instead of admitting a partial runtime", async () => {
  const f = fixture(); const feature = createInteractiveSessionFeature(f.deps);
  assert.equal((await feature.session.open(ref, "open", "config", ["not-supported"])).status, "unsupported");
  assert.equal((await feature.session.read(ref))!.status, "closed"); assert.equal(f.calls.closes, 1);
});

test("failed construction has owner teardown authority even when public close is denied", async () => {
  for (const failure of ["capability", "readiness", "readiness-throw"] as const) {
    const f = fixture(undefined, {authorize: async action => action !== "close"});
    if (failure === "readiness") {f.driver.checkReadiness = async () => ({ok: false, code: "unavailable"});}
    if (failure === "readiness-throw") {f.driver.checkReadiness = async () => {throw new Error("TEST construction failure");};}
    const feature = createInteractiveSessionFeature(f.deps);
    const opened = await feature.session.open(ref, "open", "config", failure === "capability" ? ["missing-mcp"] : []);
    assert.notEqual(opened.status, "accepted");
    assert.equal(f.calls.closes, 1, failure); assert.equal(f.calls.custody, 1, failure);
    assert.equal((await feature.session.read(ref))!.status, "closed", failure);
    assert.equal((await feature.session.close(ref)).status, "denied");
  }
});

test("timed-out construction retains and tears down a late handle without requiring caller close permission", async () => {
  const f = fixture(); const pending = deferred<{driver: typeof f.driver; capabilities: string[]}>();
  const factoryEntered = deferred<void>(); const cleanupEntered = deferred<void>();
  const feature = createInteractiveSessionFeature({...f.deps,
    authorize: async action => action !== "close",
    drivers: {open: async () => {factoryEntered.resolve(); return pending.promise;}},
    withinDeadline: async (phase, work) => {if (phase === "handoff") {throw new Error("TEST deadline");} return work();},
    custody: {close: async () => {cleanupEntered.resolve(); return {outputDrained: true, resourcesStopped: true};}},
  });
  const opening = feature.session.open(ref, "open", "config", []); await factoryEntered.promise;
  assert.equal((await opening).status, "unknown"); await cleanupEntered.promise;
  const closed = deferred<void>(); f.driver.close = async () => {f.calls.closes++; closed.resolve(); return {logicallyClosed: true, cleanup: "confirmed"};};
  pending.resolve({driver: f.driver, capabilities: []}); await closed.promise;
  // The provider handle is closed by the owner independently from a public denied close.
  assert.equal(f.calls.closes, 1); assert.equal((await feature.session.close(ref)).status, "denied");
});

test("an asynchronous interaction response stays pending independently of the full prompt queue", async () => {
  const f = fixture(); const feature = createInteractiveSessionFeature(f.deps);
  await feature.session.open(ref, "open", "config", []);
  const input = await feature.session.submit(ref, {commandId: "first", inputId: "first", content: "TEST"});
  await feature.session.submit(ref, {commandId: "second", inputId: "second", content: "TEST queued"}); await feature.control.dispatch(ref);
  f.driver.observe = async function* () {yield {sessionRef: f.driver.sessionRef, operationRef: input.receipt!.operationId, inputId: "first",
    kind: "interaction", interactionRef: "async-permission", request: {kind: "permission", tool: "TEST", input: {}}};};
  await feature.control.pumpOutput(ref);
  const response = deferred<Reply<void>>(); const entered = deferred<void>();
  f.driver.respondToInteraction = async id => {f.calls.replies.push(id); entered.resolve(); return response.promise;};
  const replying = feature.session.reply(ref, "async-answer", "async-permission", {kind: "permission", decision: "allow"});
  await entered.promise; assert.equal((await f.store.read(ref))!.interactions[0]!.state, "replying");
  response.resolve({ok: true, value: undefined}); assert.equal((await replying).status, "accepted");
  assert.equal((await f.store.read(ref))!.interactions[0]!.state, "replied");
  assert.deepEqual(f.calls.replies, ["async-permission"]); await feature.session.close(ref);
});

for (const result of ["rejected", "unknown"] as const) {
  test(`asynchronous ${result} interaction response stays uncertain and is never replayed`, async () => {
    const f = fixture(); const feature = createInteractiveSessionFeature(f.deps); await feature.session.open(ref, "open", "config", []);
    f.driver.observe = async function* () {yield {sessionRef: f.driver.sessionRef, kind: "interaction", interactionRef: "async-permission",
      request: {kind: "permission", tool: "TEST", input: {}}};}; await feature.control.pumpOutput(ref);
    f.driver.respondToInteraction = async id => {f.calls.replies.push(id);
      if (result === "rejected") {throw new Error("TEST uncertain HTTP response");} return {ok: false, code: "unknown"};};
    const answer = {kind: "permission" as const, decision: "allow" as const};
    assert.equal((await feature.session.reply(ref, "async-answer", "async-permission", answer)).status, "unknown");
    assert.equal((await feature.session.reply(ref, "async-answer", "async-permission", answer)).status, "unknown");
    const stored = (await f.store.read(ref))!; assert.equal(stored.status, "reconcile_required");
    assert.equal(stored.interactions[0]!.state, "unknown"); assert.deepEqual(f.calls.replies, ["async-permission"]);
    await feature.session.close(ref);
  });
}

test("native cancelled result is terminal only after output normalization and admits the next sequential input", async () => {
  const f = fixture(); const feature = createInteractiveSessionFeature(f.deps); await feature.session.open(ref, "open", "config", []);
  const first = await feature.session.submit(ref, {commandId: "first", inputId: "first", content: "TEST"});
  const second = await feature.session.submit(ref, {commandId: "second", inputId: "second", content: "TEST queued"});
  await feature.control.dispatch(ref);
  assert.equal((await feature.session.read(ref))!.inputs[0]!.delivery, "client_consumed");
  assert.equal((await feature.session.interrupt(ref, "cancel-first", first.receipt!.operationId)).status, "accepted");
  assert.equal((await feature.control.dispatch(ref)).status, "unavailable"); // ACK alone is not terminal.
  f.driver.observe = async function* () {yield {sessionRef: f.driver.sessionRef, operationRef: first.receipt!.operationId, inputId: "first", kind: "result", outcome: "cancelled"};};
  assert.equal((await feature.control.pumpOutput(ref)).status, "accepted");
  const terminal = (await feature.session.read(ref))!;
  assert.equal(terminal.inputs[0]!.status, "cancelled"); assert.deepEqual(terminal.events.at(-1)!.data, {outcome: "cancelled"});
  assert.equal((await feature.control.dispatch(ref)).status, "accepted");
  assert.deepEqual(f.calls.handoffs, [first.receipt!.operationId, second.receipt!.operationId]); await feature.session.close(ref);
});
