import assert from "node:assert/strict";
import {getEventListeners} from "node:events";
import test from "node:test";
import {createHostHttpLocalCutOwner} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-local-cut-owner.js";
import {localCutFixture, tick} from "./support/host-http-local-cut-fixture.ts";

test("construction is inert; explicit binding executes through the existing synthetic HTTP session", async () => {
  const f = localCutFixture();
  assert.equal(f.state.reads, 0); assert.deepEqual(f.fixture.observations.order, []);
  assert.equal(getEventListeners(f.custody.signal, "abort").length, 0);
  assert.equal(getEventListeners(f.shutdown.signal, "abort").length, 0);
  const session = f.owner.bindSession(f.ports, f.openSession);
  const receipt = await session.execute(f.operation);
  assert.equal(receipt.outcome, "completed"); assert.equal(receipt.firstByteState, "sent");
  assert.equal(f.fixture.observations.dispatches, 1); assert.equal(f.state.journalCalls, 1);
  assert.equal(f.owner.cut.read().status, "current"); assert.equal(f.owner.signal.aborted, false);
  assert.equal(getEventListeners(f.owner.signal, "abort").length, 0);
  f.owner.dispose(); f.owner.dispose();
  assert.equal(f.owner.signal.aborted, true); assert.equal(f.custody.signal.aborted, false);
  assert.equal(f.shutdown.signal.aborted, false); assert.equal(f.input.clock.read().controlTime, 0);
  assert.equal(getEventListeners(f.custody.signal, "abort").length, 0);
  assert.equal(getEventListeners(f.shutdown.signal, "abort").length, 0);
});

for (const source of ["custody", "shutdown", "dispose", "session-close"] as const) {
  test(`${source} before execution closes admission before journal or owner consumption`, async () => {
    const f = localCutFixture(); const session = f.owner.bindSession(f.ports, f.openSession);
    if (source === "custody") {f.custody.abort();}
    if (source === "shutdown") {f.shutdown.abort();}
    if (source === "dispose") {f.owner.dispose();}
    if (source === "session-close") {session.close();}
    assert.equal(f.owner.signal.aborted, true);
    assert.notEqual((await session.execute(f.operation)).outcome, "completed");
    assert.equal(f.state.journalCalls, 0); assert.equal(f.fixture.observations.dispatches, 0);
    assert.equal(f.fixture.observations.materializationInputs.length, 0);
    assert.equal(f.owner.cut.read().status, "revoked");
  });
}

for (const source of ["custody", "shutdown", "dispose", "deadline"] as const) {
  test(`${source} synchronously inside durable consume burns the key and hands off zero application bytes`, async () => {
    const f = localCutFixture(); const session = f.owner.bindSession(f.ports, f.openSession);
    f.state.consumeHook = () => {
      if (source === "custody") {f.custody.abort();}
      if (source === "shutdown") {f.shutdown.abort();}
      if (source === "dispose") {f.owner.dispose();}
      if (source === "deadline") {f.state.controlTime = f.input.operationDeadline;}
    };
    const receipt = await session.execute(f.operation);
    assert.notEqual(receipt.outcome, "completed"); assert.equal(receipt.firstByteState, "not_sent");
    assert.equal(f.state.journalCalls, 1); assert.equal(f.keys.size, 1);
    assert.equal(f.fixture.observations.dispatchedRequests.length, 0);
    assert.equal(f.state.dispatchSignal?.aborted, true);
    assert.notEqual((await session.execute(f.operation)).outcome, "completed");
    assert.equal(f.state.journalCalls, 1);
  });
}

test("every cut read samples the borrowed clock; authority, epoch and time uncertainty are irreversible", async t => {
  const changes = [
    {authorityId: "different-authority"}, {epoch: "epoch-2"}, {controlTime: -1}, {controlTime: -0},
    {controlTime: Number.NaN}, {controlTime: Infinity}, {controlTime: Number.MAX_SAFE_INTEGER + 1},
    {controlTime: 0.5}, {controlTime: 2}, {throwClock: true},
  ];
  for (const change of changes) {
    await t.test(JSON.stringify(change), async () => {
      const f = localCutFixture(); const session = f.owner.bindSession(f.ports, f.openSession);
      f.state.controlTime = 3; assert.equal(f.owner.cut.read().status, "current");
      const reads = f.state.reads; assert.equal(f.owner.cut.read().controlTime, 3);
      assert.equal(f.state.reads, reads + 1);
      Object.assign(f.state, change);
      assert.equal(f.owner.cut.read().status, "unknown"); assert.equal(f.owner.signal.aborted, true);
      Object.assign(f.state, {authorityId: "clock-authority", epoch: "epoch-1", controlTime: 4, throwClock: false});
      assert.equal(f.owner.cut.read().status, "unknown");
      assert.notEqual((await session.execute(f.operation)).outcome, "completed");
      assert.equal(f.state.journalCalls, 0);
    });
  }
});

test("pre-aborted custody, disposal before activation, and premature cut reads never reopen", async t => {
  for (const before of ["abort", "dispose", "read"] as const) {
    await t.test(before, async () => {
      const f = localCutFixture();
      if (before === "abort") {f.custody.abort();}
      if (before === "dispose") {f.owner.dispose();}
      if (before === "read") {assert.equal(f.owner.cut.read().status, "unknown");}
      const session = f.owner.bindSession(f.ports, f.openSession);
      assert.equal(f.owner.signal.aborted, true);
      assert.notEqual((await session.execute(f.operation)).outcome, "completed");
      assert.throws(() => f.owner.bindSession(f.ports, f.openSession), /one-use/u);
      assert.equal(f.fixture.observations.opens, 0);
      assert.equal(getEventListeners(f.custody.signal, "abort").length, 0);
    });
  }
});

test("construction validates exact claimed operation/attempt/custody/boot and rejects a qualified boolean", () => {
  const f = localCutFixture();
  for (const field of ["operationId", "attemptId", "custodyId", "hostBootId"] as const) {
    assert.throws(() => createHostHttpLocalCutOwner({...f.input, identity: {...f.input.identity, [field]: "wrong"}}));
  }
  assert.throws(() => createHostHttpLocalCutOwner({...f.input,
    claimed: {...f.input.claimed, committedDispatchProof: true as never}}));
  assert.throws(() => createHostHttpLocalCutOwner({...f.input,
    identity: {...f.input.identity, liveProcessSessionIdentity: true as never}}));
  assert.throws(() => createHostHttpLocalCutOwner({...f.input, claimed: {...f.input.claimed, underlyingCustodyRef: ""}}));
  assert.throws(() => createHostHttpLocalCutOwner({...f.input, operationDeadline: Infinity}));
  assert.equal(f.state.reads, 0);
});

test("request-only cancellation never reopens the operation and request listeners are released", async () => {
  const request = new AbortController(); const f = localCutFixture({signal: request.signal});
  const session = f.owner.bindSession(f.ports, f.openSession); request.abort();
  assert.notEqual((await session.execute(f.operation)).outcome, "completed");
  assert.equal(f.custody.signal.aborted, false); assert.equal(f.owner.signal.aborted, true);
  assert.equal(getEventListeners(request.signal, "abort").length, 0);
  assert.equal(getEventListeners(f.owner.signal, "abort").length, 0);
  await tick(); assert.equal(f.owner.cut.read().status, "revoked");
  assert.notEqual((await session.execute({...f.operation, signal: new AbortController().signal})).outcome, "completed");
  assert.equal(f.state.journalCalls, 0);
});
