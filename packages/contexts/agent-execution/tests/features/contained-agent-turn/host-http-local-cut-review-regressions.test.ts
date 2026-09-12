import assert from "node:assert/strict";
import {getEventListeners} from "node:events";
import test from "node:test";
import {createHostHttpLocalCutOwner} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-local-cut-owner.js";
import type {HttpEgressClock} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import {localCutFixture} from "./support/host-http-local-cut-fixture.ts";

test("an already queued await continuation freshly samples after another microtask reads the cut", async () => {
  const f = localCutFixture(); let clock: HttpEgressClock | undefined;
  f.owner.bindSession(f.ports, ports => {clock = ports.clock; return f.openSession(ports);});
  assert.ok(clock);
  queueMicrotask(() => {f.state.controlTime = 1; f.owner.cut.read(); f.state.controlTime = 2;});
  await Promise.resolve();
  const reads = f.state.reads; const now = clock.now();
  f.owner.dispose();
  assert.equal(now, 2); assert.equal(f.state.reads, reads + 1);
});

test("resolver continuation cannot beginOpen at the operation deadline after a queued cut read", async () => {
  const f = localCutFixture(); let queued = false; const openedAt: number[] = [];
  const owner = createHostHttpLocalCutOwner({...f.input, clock: {...f.input.clock,
    async within<T>(deadline: number, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const result = await f.input.clock.within(deadline, action, signal);
      if (typeof result === "object" && result !== null && "resolverIdentity" in result) {
        queueMicrotask(() => {
          queued = true; f.state.controlTime = 1; owner.cut.read();
          f.state.controlTime = f.input.operationDeadline;
        });
      }
      return result;
    }}});
  const session = owner.bindSession({...f.ports, transport: {beginOpen(input) {
    openedAt.push(f.state.controlTime); return f.ports.transport.beginOpen(input);
  }}}, f.openSession);
  const receipt = await session.execute(f.operation);
  owner.dispose();
  assert.equal(queued, true); assert.equal(f.state.controlTime, 1000);
  assert.notEqual(receipt.outcome, "completed"); assert.equal(receipt.firstByteState, "not_sent");
  assert.equal(f.state.journalCalls, 0); assert.equal(receipt.upstreamRequestBytes, 0);
  assert.equal(f.fixture.observations.dispatchedRequests.length, 0);
  assert.equal(f.fixture.observations.opens, 0, `transport opened at ${JSON.stringify(openedAt)}`);
});

for (const slot of ["claimed.signal", "hostShutdownSignal"] as const) {
  test(`${slot} proxy is rejected without callbacks, clock reads or subscriptions`, () => {
    const f = localCutFixture(); let calls = 0;
    const signal = new Proxy(slot === "claimed.signal" ? f.custody.signal : f.shutdown.signal, {
      getPrototypeOf(target) {calls += 1; return Reflect.getPrototypeOf(target);},
      get(target, key, receiver) {calls += 1; return Reflect.get(target, key, receiver);},
    });
    const input = slot === "claimed.signal" ? {...f.input, claimed: {...f.input.claimed, signal}}
      : {...f.input, hostShutdownSignal: signal};
    let error: unknown;
    try {createHostHttpLocalCutOwner(input);} catch (caught) {error = caught;}
    assert.equal(calls, 0); assert.ok(error instanceof TypeError);
    assert.equal(f.state.reads, 0); assert.deepEqual(f.fixture.observations.order, []);
    assert.equal(getEventListeners(f.custody.signal, "abort").length, 0);
    assert.equal(getEventListeners(f.shutdown.signal, "abort").length, 0);
  });
}

for (const phase of ["before journal", "after journal"] as const) {
  for (const fault of ["custody", "shutdown", "authority", "epoch", "regression", "expiry",
    "dispatch-deadline", "operation-deadline"] as const) {
    test(`${fault} at the closing clock observation ${phase} prevents application bytes`, async () => {
      const f = localCutFixture({mutateProvisional: value => ({...value, policy: {...value.policy,
        limits: {...value.policy.limits, totalMilliseconds: 100}}})});
      f.state.controlTime = 3; let injected = false;
      const session = f.owner.bindSession(f.ports, ports => f.openSession({...ports, localAuthorityCut: {read() {
        const cut = ports.localAuthorityCut.read();
        const atBoundary = phase === "after journal" ? f.state.journalCalls === 1
          : f.fixture.observations.order.at(-1) === "dispatch" && f.state.journalCalls === 0;
        if (atBoundary && !injected) {
          assert.equal(cut.status, "current"); assert.equal(cut.controlTime, 3); injected = true;
          if (fault === "custody") {f.custody.abort();}
          if (fault === "shutdown") {f.shutdown.abort();}
          if (fault === "authority") {f.state.authorityId = "foreign-authority";}
          if (fault === "epoch") {f.state.epoch = "foreign-epoch";}
          if (fault === "regression") {f.state.controlTime = 2;}
          if (fault === "expiry") {f.state.controlTime = 900;}
          if (fault === "dispatch-deadline") {f.state.controlTime = 100;}
          if (fault === "operation-deadline") {f.state.controlTime = 1000;}
        }
        return cut;
      }}}));
      const receipt = await session.execute(f.operation);
      assert.equal(injected, true); assert.notEqual(receipt.outcome, "completed");
      assert.equal(receipt.firstByteState, "not_sent"); assert.equal(receipt.upstreamRequestBytes, 0);
      assert.equal(f.state.journalCalls, phase === "before journal" ? 0 : 1);
      assert.equal(f.fixture.observations.dispatchedRequests.length, 0);
      assert.equal(f.fixture.observations.outboundWrites.length, 0); assert.equal(f.owner.signal.aborted, true);
      Object.assign(f.state, {authorityId: "clock-authority", epoch: "epoch-1", controlTime: 4});
      assert.notEqual((await session.execute(f.operation)).outcome, "completed");
      assert.equal(f.state.journalCalls, phase === "before journal" ? 0 : 1);
    });
  }
}

for (const slot of ["claimed.signal", "hostShutdownSignal"] as const) {
  test(`${slot} rejects an inherited Proxy without traversing it`, () => {
    const f = localCutFixture(); let calls = 0;
    const prototype = new Proxy(AbortSignal.prototype, {
      getPrototypeOf(target) {calls += 1; return Reflect.getPrototypeOf(target);},
    });
    const signal = Object.create(prototype) as AbortSignal;
    const input = slot === "claimed.signal" ? {...f.input, claimed: {...f.input.claimed, signal}}
      : {...f.input, hostShutdownSignal: signal};
    assert.throws(() => createHostHttpLocalCutOwner(input), TypeError);
    assert.equal(calls, 0); assert.equal(f.state.reads, 0);
    assert.equal(getEventListeners(f.custody.signal, "abort").length, 0);
    assert.equal(getEventListeners(f.shutdown.signal, "abort").length, 0);
  });
}

for (const phase of ["before journal", "after journal"] as const) {
  for (const observation of ["closing clock", "final cut"] as const) {
    for (const source of ["custody", "shutdown", "dispose"] as const) {
      test(`${source} during ${observation} ${phase} cannot consume or emit using the preceding current cut`, async () => {
        const f = localCutFixture(); let cuts = 0; let injected = false;
        const atBoundary = () => phase === "after journal" ? f.state.journalCalls === 1
          : f.fixture.observations.order.at(-1) === "dispatch" && f.state.journalCalls === 0;
        const cancel = () => {
          injected = true;
          if (source === "custody") {f.custody.abort();}
          if (source === "shutdown") {f.shutdown.abort();}
          if (source === "dispose") {f.owner.dispose();}
        };
        const session = f.owner.bindSession(f.ports, ports => f.openSession({...ports,
          clock: {...ports.clock, now() {
            const now = ports.clock.now();
            if (atBoundary() && cuts === 1 && observation === "closing clock" && !injected) {cancel();}
            assert.equal(now, 0); return now;
          }}, localAuthorityCut: {read() {
            const cut = ports.localAuthorityCut.read();
            if (atBoundary() && ++cuts === 2 && observation === "final cut" && !injected) {
              assert.equal(cut.status, "current"); cancel();
            }
            return cut;
          }}}));
        const receipt = await session.execute(f.operation);
        assert.equal(injected, true); assert.notEqual(receipt.outcome, "completed");
        assert.equal(receipt.firstByteState, "not_sent"); assert.equal(receipt.upstreamRequestBytes, 0);
        assert.equal(f.state.journalCalls, phase === "before journal" ? 0 : 1);
        assert.equal(f.fixture.observations.dispatchedRequests.length, 0);
        assert.equal(f.fixture.observations.outboundWrites.length, 0);
        assert.equal(f.owner.signal.aborted, true);
        assert.notEqual((await session.execute(f.operation)).outcome, "completed");
        assert.equal(f.state.journalCalls, phase === "before journal" ? 0 : 1);
      });
    }
  }
}
