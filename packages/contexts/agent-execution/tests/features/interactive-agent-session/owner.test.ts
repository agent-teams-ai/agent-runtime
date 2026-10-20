import assert from "node:assert/strict";
import test from "node:test";
import {InteractiveSessionOwner} from "../../../dist/features/interactive-agent-session/application/use-cases/interactive-session-owner.js";
import {utf8Bytes} from "../../../dist/features/interactive-agent-session/domain/session.js";
import {deferred, fixture, MemorySessionStore, open, ref, submit} from "./support.ts";

test("durable admission replay returns its original runtime-generated operation; conflicting payload cannot dispatch", async () => {
  const f = fixture(); await open(f);
  const input = {commandId: "command-1", inputId: "input-1", content: "secret TEST prompt"};
  const [first, second] = await Promise.all([f.owner.submit(ref, input), f.owner.submit(ref, input)]);
  assert.deepEqual(first.receipt, second.receipt); assert.equal(second.status, "duplicate");
  assert.equal((await f.owner.submit(ref, {...input, content: "other"})).status, "conflict");
  assert.equal(f.calls.handoffs.length, 0);
  await f.owner.dispatch(ref); await f.owner.dispatch(ref);
  assert.deepEqual(f.calls.handoffs, [first.receipt!.operationId]);
  assert.equal(JSON.stringify(await f.owner.read(ref)).includes("secret TEST prompt"), false);
});

test("unknown create/claim commits never authorize open or handoff; restart recovers without replay", async () => {
  const store = new MemorySessionStore(); store.unknownNext = true;
  const creation = fixture(store);
  assert.equal((await creation.owner.open(ref, "open", "config-1", [])).status, "unknown");
  assert.equal(creation.calls.opened, 0);
  const f = fixture(); await open(f); await submit(f);
  (f.store as MemorySessionStore).unknownNext = true;
  assert.equal((await f.owner.dispatch(ref)).status, "unknown"); assert.equal(f.calls.handoffs.length, 0);
  const restarted = new InteractiveSessionOwner(f.deps);
  assert.equal((await restarted.recover(ref)).status, "unknown");
  assert.equal((await restarted.dispatch(ref)).status, "unavailable"); assert.equal(f.calls.handoffs.length, 0);
  assert.equal((await restarted.read(ref))!.status, "reconcile_required");
});

test("unknown handoff fences queued input and is never resent", async () => {
  const f = fixture(); await open(f); await submit(f); await submit(f, 2);
  f.driver.submit = async input => {f.calls.handoffs.push(input.operationRef); return {ok: false, code: "unknown"};};
  assert.equal((await f.owner.dispatch(ref)).status, "unknown");
  assert.equal((await f.owner.dispatch(ref)).status, "unavailable");
  assert.equal(f.calls.handoffs.length, 1);
});

test("known-not-sent is explicit; successful terminal receipt releases exactly the next admitted input", async () => {
  const f = fixture(); await open(f); const first = await submit(f); const second = await submit(f, 2);
  await f.owner.dispatch(ref);
  await f.owner.record(ref, {kind: "result", ...first, outcome: "succeeded"});
  await f.owner.dispatch(ref);
  assert.deepEqual(f.calls.handoffs, [first.operationId, second.operationId]);
  assert.equal((await f.owner.record(ref, {kind: "result", ...first, outcome: "succeeded"})).status, "stale");
});

test("interaction reply is independent of full prompt queue; revoked and expired callbacks cannot receive a grant", async () => {
  const f = fixture(); await open(f); const first = await submit(f); await submit(f, 2); await f.owner.dispatch(ref);
  await f.owner.record(ref, {kind: "interaction", ...first, interactionId: "approval-1", requestKind: "permission", expiresAt: 200});
  assert.equal((await f.owner.reply(ref, "reply-1", "approval-1", {kind: "question", answers: {}})).status, "stale");
  assert.equal((await f.owner.reply(ref, "reply-1", "approval-1", {kind: "permission", decision: "allow"})).status, "accepted");
  assert.equal((await f.owner.reply(ref, "reply-1", "approval-1", {kind: "permission", decision: "allow"})).status, "duplicate");
  assert.deepEqual(f.calls.replies, ["approval-1"]);
  await f.owner.record(ref, {kind: "interaction", ...first, interactionId: "approval-2", requestKind: "permission", expiresAt: 200});
  await f.owner.interrupt(ref, "interrupt-1", first.operationId);
  assert.equal((await f.owner.reply(ref, "reply-2", "approval-2", {kind: "permission", decision: "allow"})).status, "stale");
  assert.equal((await f.owner.record(ref, {kind: "interaction", ...first, interactionId: "approval-after-ack", requestKind: "permission", expiresAt: 200})).status, "stale");
});

test("result racing an interrupt acknowledgement cannot release the next handoff", async () => {
  const f = fixture(); await open(f); const first = await submit(f); const second = await submit(f, 2); await f.owner.dispatch(ref);
  const acknowledgement = deferred<{ok: true; value: {requested: true; terminal: "unconfirmed"}}>();
  const entered = deferred<void>();
  f.driver.interrupt = async () => {entered.resolve(); return acknowledgement.promise;};
  const interrupt = f.owner.interrupt(ref, "interrupt-1", first.operationId); await entered.promise;
  await f.owner.record(ref, {kind: "result", ...first, outcome: "failed"});
  assert.equal((await f.owner.dispatch(ref)).status, "unavailable");
  acknowledgement.resolve({ok: true, value: {requested: true, terminal: "unconfirmed"}}); await interrupt;
  await f.owner.dispatch(ref);
  assert.deepEqual(f.calls.handoffs, [first.operationId, second.operationId]);
  assert.equal((await f.owner.interrupt(ref, "late-control", first.operationId)).status, "stale");
});

test("unknown control acknowledgement keeps future handoff fenced", async () => {
  const f = fixture(); await open(f); const first = await submit(f); await submit(f, 2); await f.owner.dispatch(ref);
  f.driver.interrupt = async () => ({ok: false, code: "unknown"});
  assert.equal((await f.owner.interrupt(ref, "interrupt-1", first.operationId)).status, "unknown");
  assert.equal((await f.owner.record(ref, {kind: "result", ...first, outcome: "failed"})).status, "unavailable");
  assert.equal((await f.owner.dispatch(ref)).status, "unavailable");
});

test("close seals immediately, joins callers and requires both driver close and custody proof", async () => {
  const f = fixture(); await open(f); await submit(f);
  const cleanup = deferred<{logicallyClosed: true; cleanup: "confirmed"}>(); f.driver.close = () => cleanup.promise;
  const first = f.owner.close(ref); const second = f.owner.close(ref); assert.equal(first, second);
  assert.equal((await f.owner.submit(ref, {commandId: "late", inputId: "late", content: "late"})).status, "unavailable");
  cleanup.resolve({logicallyClosed: true, cleanup: "confirmed"}); assert.equal((await first).status, "accepted");
  assert.equal(f.calls.custody, 1); assert.equal((await f.owner.read(ref))!.status, "closed");
  const uncertain = fixture(); await open(uncertain);
  uncertain.deps.custody.close = async () => ({outputDrained: true, resourcesStopped: false});
  assert.equal((await uncertain.owner.close(ref)).status, "unknown");
  assert.equal((await uncertain.owner.read(ref))!.status, "reconcile_required");
});

test("host deadline failure preserves cleanup uncertainty and still invokes custody", async () => {
  const f = fixture(new MemorySessionStore(), {withinDeadline: async (phase, work) => {if (phase === "close") {throw new Error("TEST deadline");} return work();}}); await open(f);
  assert.equal((await f.owner.close(ref)).status, "unknown");
  assert.equal((await f.owner.read(ref))!.status, "reconcile_required");
});

test("selected checkpoint restore advances generation and never restores an old callback or accepts an old ref", async () => {
  const f = fixture(); await open(f);
  assert.equal((await f.owner.checkpoint(ref)).status, "accepted");
  await f.owner.close(ref);
  assert.equal((await f.owner.restore(ref, "restore", "wrong-config")).status, "unsupported");
  assert.equal((await f.owner.restore(ref, "restore", "config-1")).status, "accepted");
  assert.equal((await f.owner.submit(ref, {commandId: "old", inputId: "old", content: "old"})).status, "unavailable");
  assert.equal(await f.owner.read(ref), undefined);
  assert.equal((await f.owner.read({...ref, generation: 2}))!.status, "ready");
  assert.equal(f.calls.opened, 2);
});

test("unattributed background facts retain no operation; bounds stop admission without trimming cursor history", async () => {
  const f = fixture(new MemorySessionStore(), {limits: {queuedInputs: 2, inputBytes: 1024, events: 1, eventBytes: 2048, interactions: 4, commands: 30}}); await open(f);
  await f.owner.record(ref, {kind: "text", data: "background"});
  const view = (await f.owner.read(ref))!;
  assert.equal(view.events[0]!.sequence, 1); assert.equal(view.events[0]!.operationId, undefined);
  assert.equal((await f.owner.record(ref, {kind: "text", data: "overflow"})).status, "backpressure");
  assert.equal((await f.owner.read(ref))!.status, "reconcile_required");
  assert.equal((await f.owner.read({...ref, tenantId: "foreign"})), undefined);
  for (const text of ["a", "😀", "\ud800", "\udc00"]) {assert.equal(utf8Bytes(text), new TextEncoder().encode(text).byteLength);}
});

test("denied close neither seals admission nor caches a denial against a later authorized close", async () => {
  let permitted = true;
  const f = fixture(new MemorySessionStore(), {authorize: async action => action !== "close" || permitted}); await open(f);
  permitted = false; assert.equal((await f.owner.close(ref)).status, "denied");
  assert.equal((await f.owner.submit(ref, {commandId: "after-denial", inputId: "after-denial", content: "TEST"})).status, "accepted");
  permitted = true; assert.equal((await f.owner.close(ref)).status, "accepted");
  assert.equal(f.calls.closes, 1);
});

test("dispatch suspended at authorization cannot begin handoff after an authorized close cutoff", async () => {
  const authorized = deferred<boolean>(); const entered = deferred<void>();
  const f = fixture(new MemorySessionStore(), {authorize: async action => {
    if (action === "dispatch") {entered.resolve(); return authorized.promise;}
    return true;
  }});
  await open(f); await submit(f);
  const dispatch = f.owner.dispatch(ref); await entered.promise;
  assert.equal((await f.owner.close(ref)).status, "accepted");
  authorized.resolve(true); assert.equal((await dispatch).status, "unavailable");
  assert.deepEqual(f.calls.handoffs, []);
});

test("reply suspended at authorization never invokes a callback revoked by interrupt", async () => {
  const authorized = deferred<boolean>(); const entered = deferred<void>();
  const f = fixture(new MemorySessionStore(), {authorize: async action => {
    if (action === "reply") {entered.resolve(); return authorized.promise;}
    return true;
  }});
  await open(f); const input = await submit(f); await f.owner.dispatch(ref);
  await f.owner.record(ref, {kind: "interaction", ...input, interactionId: "approval", requestKind: "permission", expiresAt: 200});
  const reply = f.owner.reply(ref, "reply", "approval", {kind: "permission", decision: "allow"}); await entered.promise;
  await f.owner.interrupt(ref, "interrupt", input.operationId);
  authorized.resolve(true); assert.equal((await reply).status, "stale"); assert.deepEqual(f.calls.replies, []);
});

test("late effect completions preserve closed state and canceled callback facts", async () => {
  for (const effect of ["handoff", "interrupt"] as const) {
    const f = fixture(); await open(f); const input = await submit(f);
    const pending = deferred<{ok: false; code: "unknown"}>(); const entered = deferred<void>();
    let completion: Promise<unknown>;
    if (effect === "handoff") {
      f.driver.submit = async () => {entered.resolve(); return pending.promise;};
      completion = f.owner.dispatch(ref);
    } else {
      await f.owner.dispatch(ref);
      await f.owner.record(ref, {kind: "interaction", ...input, interactionId: "approval", requestKind: "permission", expiresAt: 200});
      f.driver.interrupt = async () => {entered.resolve(); return pending.promise;};
      completion = f.owner.interrupt(ref, "interrupt", input.operationId);
    }
    await entered.promise;
    assert.equal((await f.owner.close(ref)).status, "accepted");
    pending.resolve({ok: false, code: "unknown"}); await completion;
    const stored = (await f.store.read(ref))!;
    assert.equal(stored.status, "closed", effect);
    assert.ok(stored.interactions.every(item => item.state === "cancelled"), effect);
    assert.equal(stored.controlPending, false, effect);
  }
});

test("unknown cleanup retains the owner handle and can reconcile without reissuing logical close", async () => {
  let stopped = false;
  const f = fixture(new MemorySessionStore(), {custody: {async close() {return {outputDrained: true, resourcesStopped: stopped};}}});
  await open(f); assert.equal((await f.owner.close(ref)).status, "unknown");
  stopped = true; assert.equal((await f.owner.close(ref)).status, "accepted");
  assert.equal(f.calls.closes, 1); assert.equal((await f.owner.read(ref))!.status, "closed");
});

test("invalid interaction answers cannot persist a decision or grant a provider callback", async () => {
  const f = fixture(); await open(f); const input = await submit(f); await f.owner.dispatch(ref);
  await f.owner.record(ref, {kind: "interaction", ...input, interactionId: "approval", requestKind: "permission", expiresAt: 200});
  const before = (await f.store.read(ref))!.commands.length;
  for (const answer of [
    {kind: "permission", decision: "not-a-valid-decision"}, {kind: "permission"},
    {kind: "permission", decision: "allow", extra: true}, {kind: "question", answers: {one: 1}},
    {kind: "question", answers: []}, {kind: "question", answers: null},
  ]) {assert.equal((await f.owner.reply(ref, "invalid", "approval", answer as never)).status, "unsupported");}
  assert.equal((await f.owner.reply(ref, "", "approval", {kind: "permission", decision: "allow"})).status, "unsupported");
  assert.equal((await f.store.read(ref))!.commands.length, before); assert.deepEqual(f.calls.replies, []);
  assert.equal((await f.owner.reply(ref, "valid", "approval", {kind: "permission", decision: "allow"})).status, "accepted");
  assert.equal((await f.owner.reply(ref, "valid", "approval", {decision: "allow", kind: "permission"})).status, "duplicate");
});

test("question reply fingerprint is independent of dictionary insertion order and oversized answers cannot claim", async () => {
  const f = fixture(); await open(f); const input = await submit(f); await f.owner.dispatch(ref);
  await f.owner.record(ref, {kind: "interaction", ...input, interactionId: "question", requestKind: "question", expiresAt: 200});
  assert.equal((await f.owner.reply(ref, "too-big", "question", {kind: "question", answers: {a: "x".repeat(1025)}})).status, "backpressure");
  assert.equal((await f.owner.reply(ref, "answer", "question", {kind: "question", answers: {b: "two", a: "one"}})).status, "accepted");
  assert.equal((await f.owner.reply(ref, "answer", "question", {answers: {a: "one", b: "two"}, kind: "question"})).status, "duplicate");
  assert.deepEqual(f.calls.replies, ["question"]);
});
