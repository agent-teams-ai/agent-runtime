import assert from "node:assert/strict";
import test from "node:test";
import {createHostHttpLocalCutOwner} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-local-cut-owner.js";
import type {HttpEgressClock} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import {localCutFixture} from "./support/host-http-local-cut-fixture.ts";

for (const advancement of ["every read", "between post-journal samples"] as const) {
  test(`healthy clock advancement ${advancement} permits the first application byte`, async () => {
    const f = localCutFixture(); let postJournalReads = 0;
    const owner = createHostHttpLocalCutOwner({...f.input, clock: {...f.input.clock, read() {
      const sample = f.input.clock.read();
      if (advancement === "every read") {f.state.controlTime = f.state.reads;}
      else if (f.state.journalCalls > 0) {f.state.controlTime = postJournalReads++ === 0 ? 0 : 1;}
      return {...sample, controlTime: f.state.controlTime};
    }}});
    const session = owner.bindSession(f.ports, f.openSession);
    const receipt = await session.execute(f.operation);
    assert.equal(receipt.outcome, "completed", JSON.stringify(receipt));
    assert.equal(receipt.firstByteState, "sent"); assert.ok(receipt.upstreamRequestBytes > 0);
    assert.equal(f.state.journalCalls, 1); assert.equal(f.fixture.observations.dispatchedRequests.length, 1);
    assert.equal(owner.signal.aborted, false);
    if (advancement === "between post-journal samples") {
      assert.ok(postJournalReads >= 2); assert.equal(f.state.controlTime, 1);
    } else {assert.ok(f.state.controlTime > 1);}
    owner.dispose();
  });
}

test("every cut and clock read freshly samples, synchronously and across awaits", async () => {
  const f = localCutFixture(); let clock: HttpEgressClock | undefined;
  f.owner.bindSession(f.ports, ports => {clock = ports.clock; return f.openSession(ports);});
  assert.ok(clock);
  f.state.controlTime = 1;
  const first = f.owner.cut.read(); const reads = f.state.reads;
  assert.equal(first.controlTime, 1);
  f.state.controlTime = 2;
  assert.equal(clock.now(), 2); assert.equal(f.state.reads, reads + 1);
  assert.equal(f.owner.cut.read().controlTime, 2); assert.equal(f.state.reads, reads + 2);
  f.state.controlTime = 3;
  assert.equal(f.owner.cut.read().controlTime, 3);
  assert.equal(clock.now(), 3); assert.equal(f.state.reads, reads + 4);
  f.owner.cut.read(); await Promise.resolve(); f.state.controlTime = 4;
  assert.equal(clock.now(), 4);
  f.owner.cut.read(); f.state.controlTime = 5;
  await clock.within(10, async () => {assert.equal(clock!.now(), 5);});
  f.owner.cut.read(); f.state.controlTime = 10;
  await assert.rejects(clock.within(10, async () => {}), /deadline/u);
  f.state.epoch = "foreign-epoch";
  assert.ok(Number.isNaN(clock.now())); assert.equal(f.owner.signal.aborted, true);
  f.state.epoch = "epoch-1";
  assert.equal(f.owner.cut.read().status, "unknown");
});

test("clock consumers freshly sample while execution stays closed during cancellation notification", () => {
  const f = localCutFixture(); let clock: HttpEgressClock | undefined;
  f.owner.bindSession(f.ports, ports => {clock = ports.clock; return f.openSession(ports);});
  assert.ok(clock);
  f.owner.cut.read(); const reads = f.state.reads;
  f.owner.signal.addEventListener("abort", () => {
    assert.equal(clock!.now(), 1); assert.equal(f.owner.cut.read().status, "revoked");
  }, {once: true});
  f.state.controlTime = 1; f.shutdown.abort();
  assert.equal(f.state.reads, reads + 2); assert.equal(f.owner.cut.read().status, "revoked");
});

for (const change of ["authority", "epoch", "rollback", "expiry", "operation-deadline"] as const) {
  test(`${change} during journal consumption is rechecked before bytes and cannot reopen`, async () => {
    const f = localCutFixture(); f.state.controlTime = 3;
    const session = f.owner.bindSession(f.ports, f.openSession);
    f.state.consumeHook = () => {
      if (change === "authority") {f.state.authorityId = "foreign-authority";}
      if (change === "epoch") {f.state.epoch = "foreign-epoch";}
      if (change === "rollback") {f.state.controlTime = 2;}
      if (change === "expiry") {f.state.controlTime = 900;}
      if (change === "operation-deadline") {f.state.controlTime = f.input.operationDeadline;}
    };
    const receipt = await session.execute(f.operation);
    assert.notEqual(receipt.outcome, "completed"); assert.equal(receipt.firstByteState, "not_sent");
    assert.equal(receipt.upstreamRequestBytes, 0); assert.equal(f.state.journalCalls, 1);
    assert.equal(f.fixture.observations.dispatchedRequests.length, 0); assert.equal(f.owner.signal.aborted, true);
    Object.assign(f.state, {authorityId: "clock-authority", epoch: "epoch-1", controlTime: 4});
    assert.notEqual((await session.execute(f.operation)).outcome, "completed");
    assert.equal(f.state.journalCalls, 1);
  });
}
