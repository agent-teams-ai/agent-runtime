import assert from "node:assert/strict";
import {getEventListeners} from "node:events";
import test from "node:test";
import {createHostHttpLocalCutOwner} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-local-cut-owner.js";
import {forwardStrictHttpResponse, StrictHttpResponseError} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-response.js";
import type {HttpEgressClock} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import {bytes, createEgressFixture, outputText} from "./http-egress-test-fixture.ts";
import {localCutFixture, tick} from "./support/host-http-local-cut-fixture.ts";

const fixed = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
const chunked = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n";
const bodyless = "HTTP/1.1 204 No Content\r\n\r\n";
const makeResponseSource = (wire: string, next: () => Promise<IteratorResult<Uint8Array>>) => {
  let reads = 0; let returns = 0;
  const source: AsyncIterable<Uint8Array> = {[Symbol.asyncIterator]: () => ({
    next: async () => ++reads === 1 ? {done: false, value: bytes(wire)} : await next(),
    return: async () => {returns += 1; return {done: true, value: undefined};},
  })};
  return {source, get reads() {return reads;}, get returns() {return returns;}};
};

for (const owned of [false, true]) {
 for (const [framing, wire] of [["fixed", fixed], ["chunked", chunked], ["bodyless", bodyless]] as const) {
  for (const closeTime of [699, 700, 701, 1099, 1100]) {
    test(`${owned ? "owned cut.read inside close" : "borrowed close"} at ${closeTime} observes ${framing} EOF`, async () => {
      let reads = 0;
      const responseSource: AsyncIterable<Uint8Array> = {[Symbol.asyncIterator]() {return {async next() {
        reads += 1;
        return reads === 1 ? {done: false, value: bytes(wire)}
          : {done: true, value: undefined};
      }};}};
      const f = localCutFixture({responseSource});
      const owner = createHostHttpLocalCutOwner({...f.input, operationDeadline: 700});
      const ports = {...f.ports, transport: {beginOpen: input => {
        const attempt = f.ports.transport.beginOpen(input);
        return {...attempt, close() {
          assert.equal(f.state.controlTime, 0);
          assert.equal(outputText(f.fixture).split("\r\n\r\n")[1], framing === "bodyless" ? "" : "ok");
          f.state.controlTime = closeTime;
          if (owned) {
            assert.equal(owner.cut.read().status, closeTime < 700 ? "current" : "revoked");
            assert.equal(owner.signal.aborted, closeTime >= 700);
          }
          return attempt.close();
        }};
      }}} satisfies typeof f.ports;
      const session = owned ? owner.bindSession(ports, f.openSession)
        : f.openSession({...ports, identity: f.input.identity,
          clock: {now: () => f.input.clock.read().controlTime, within: f.input.clock.within}});
      const receipt = await session.execute({...f.operation, limits: {...f.operation.limits, deadline: 700}});
      assert.equal(receipt.outcome, closeTime < 1100 ? "completed" : "reconcile_required", JSON.stringify(receipt));
      assert.equal(receipt.firstByteState, "sent");
      assert.equal(reads, closeTime < 1100 ? 2 : 1);
      assert.equal(f.state.journalCalls, 1);
      if (closeTime < 1100) {
        assert.equal(receipt.anomalyCode, "none");
        assert.equal(receipt.upstreamClosure, "closed"); assert.equal(receipt.inboundClosure, "closed");
        assert.deepEqual(f.fixture.observations.order.slice(-3), ["upstream-close", "inbound-close", "record-evidence"]);
      }
      if (owned && closeTime >= 700) {
        assert.equal(owner.cut.read().status, "revoked"); assert.equal(owner.signal.aborted, true);
        assert.notEqual((await session.execute(f.operation)).outcome, "completed");
        assert.equal(f.state.journalCalls, 1); assert.equal(f.fixture.observations.opens, 1);
      }
      owner.dispose(); session.close();
      assert.equal(getEventListeners(f.custody.signal, "abort").length, 0);
      assert.equal(getEventListeners(f.shutdown.signal, "abort").length, 0);
      assert.equal(getEventListeners(owner.signal, "abort").length, 0);
    });
  }
 }
}

for (const revoke of ["custody", "dispose", "shutdown"] as const) {
 for (const closure of ["closed", "unknown", "throw"] as const) {
  test(`${revoke} during pending ${closure} closure never restores execution`, async () => {
    const peer = makeResponseSource(fixed, async () => ({done: true, value: undefined}));
    const f = localCutFixture({responseSource: peer.source, upstreamClosure: closure === "unknown" ? "unknown" : "closed",
      upstreamCloseThrows: closure === "throw"});
    const owner = createHostHttpLocalCutOwner({...f.input, operationDeadline: 700});
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const session = owner.bindSession({...f.ports, transport: {beginOpen(input) {
      const attempt = f.ports.transport.beginOpen(input);
      return {...attempt, async close() {entered.resolve(); await release.promise; return attempt.close();}};
    }}}, f.openSession);
    const result = session.execute(f.operation);
    await entered.promise;
    try {
      f.state.controlTime = 699;
      if (revoke === "custody") {f.custody.abort();}
      if (revoke === "dispose") {owner.dispose();}
      if (revoke === "shutdown") {f.shutdown.abort();}
      assert.equal(owner.cut.read().status, "revoked"); assert.equal(owner.signal.aborted, true);
      assert.equal(peer.reads, 1); assert.equal(f.fixture.observations.receipts.length, 0);
      assert.equal(f.fixture.observations.order.includes("inbound-close"), false);
    } finally {release.resolve();}
    const receipt = await result;
    assert.equal(receipt.outcome, closure === "closed" ? "completed" : "reconcile_required");
    assert.equal(receipt.anomalyCode, closure === "closed" ? "none" : "closure_unproved");
    assert.equal(peer.reads, closure === "closed" ? 2 : 1); assert.equal(peer.returns, 0);
    assert.equal(outputText(f.fixture).split("\r\n\r\n")[1], "ok");
    assert.equal(owner.signal.aborted, true);
    assert.notEqual((await session.execute(f.operation)).outcome, "completed");
    assert.equal(f.state.journalCalls, 1); assert.equal(f.fixture.observations.dispatches, 1);
    owner.dispose(); session.close();
    for (const signal of [owner.signal, f.custody.signal, f.shutdown.signal]) {
      assert.equal(getEventListeners(signal, "abort").length, 0);
    }
  });
 }
}

for (const [name, wire, anomaly] of [
  ["partial fixed", fixed.slice(0, -1), "inbound_cancelled"],
  ["partial chunked", chunked.slice(0, -2), "inbound_cancelled"],
  ["buffered fixed surplus", fixed + "x", "upstream_malformed"],
  ["buffered chunked surplus", chunked + "x", "upstream_malformed"],
  ["trailer", chunked.slice(0, -2) + "X-Trailer: no\r\n\r\n", "upstream_malformed"],
] as const) {
  test(`${name} cannot acquire the final observation budget`, async () => {
    const peer = makeResponseSource(wire, async () => {
      f.state.controlTime = 700; owner.cut.read();
      return {done: false, value: bytes("x")};
    });
    const f = localCutFixture({responseSource: peer.source});
    const owner = createHostHttpLocalCutOwner({...f.input, operationDeadline: 700});
    const session = owner.bindSession({...f.ports, transport: {beginOpen(input) {
      const attempt = f.ports.transport.beginOpen(input);
      return {...attempt, close() {f.state.controlTime = 701; owner.cut.read(); return attempt.close();}};
    }}}, f.openSession);
    const receipt = await session.execute(f.operation);
    assert.equal(receipt.outcome, "reconcile_required"); assert.equal(receipt.anomalyCode, anomaly);
    assert.equal(peer.reads, name.startsWith("partial") ? 2 : 1);
    assert.equal(peer.returns, 0); assert.equal(receipt.upstreamClosure, "closed");
    assert.equal(receipt.inboundClosure, "closed"); assert.equal(f.state.journalCalls, 1);
    assert.equal(outputText(f.fixture).split("\r\n\r\n")[1], name === "partial fixed" ? "o" : "ok");
    owner.dispose();
  });
}

test("cutoff during final body write still cancels before framing", async () => {
  const peer = makeResponseSource(fixed, async () => ({done: true, value: undefined}));
  const f = localCutFixture({responseSource: peer.source});
  const owner = createHostHttpLocalCutOwner({...f.input, operationDeadline: 700});
  const session = owner.bindSession(f.ports, f.openSession);
  const entered = Promise.withResolvers<Uint8Array>(); const release = Promise.withResolvers<void>();
  const result = session.execute({...f.operation, connection: {...f.operation.connection, async write(chunk) {
    if (new TextDecoder().decode(chunk) === "ok") {entered.resolve(chunk); await release.promise;}
    else {await f.operation.connection.write(chunk);}
  }}});
  const retained = await entered.promise;
  try {
    f.state.controlTime = 700; owner.cut.read();
    const receipt = await result;
    assert.equal(receipt.outcome, "reconcile_required"); assert.equal(receipt.anomalyCode, "inbound_cancelled");
    assert.equal(receipt.outboundResponseWriteUncertain, true);
    assert.equal(peer.reads, 1); assert.equal(outputText(f.fixture).split("\r\n\r\n")[1], "");
    assert.ok(retained.every(value => value === 0)); assert.equal(owner.signal.aborted, true);
  } finally {release.resolve(); owner.dispose();}
  await tick(); assert.equal(peer.reads, 1);
});

for (const wire of [fixed, chunked, bodyless]) {
 for (const suffix of ["surplus", "empty then EOF", "oversized"] as const) {
  test(`${wire === fixed ? "fixed" : wire === chunked ? "chunked" : "bodyless"} ${suffix} after closure is observed without forwarding`, async () => {
    const surplus = bytes(suffix === "oversized" ? "x".repeat(9000) : suffix === "surplus" ? "x" : "");
    const peer = makeResponseSource(wire, async () => peer.reads === 2
      ? {done: false, value: surplus} : {done: true, value: undefined});
    const f = localCutFixture({responseSource: peer.source});
    const owner = createHostHttpLocalCutOwner({...f.input, operationDeadline: 700});
    let outputAtClose = "";
    const session = owner.bindSession({...f.ports, transport: {beginOpen(input) {
      const attempt = f.ports.transport.beginOpen(input);
      return {...attempt, close() {outputAtClose = outputText(f.fixture);
        f.state.controlTime = 701; owner.cut.read(); return attempt.close();}};
    }}}, f.openSession);
    const receipt = await session.execute(f.operation);
    assert.equal(receipt.outcome, suffix === "empty then EOF" ? "completed" : "reconcile_required");
    assert.equal(receipt.anomalyCode, suffix === "surplus" ? "upstream_malformed"
      : suffix === "oversized" ? "output_oversized" : "none");
    assert.equal(peer.reads, suffix === "empty then EOF" ? 3 : 2); assert.equal(peer.returns, 0);
    assert.equal(receipt.upstreamResponseBytes, bytes(wire).byteLength + surplus.byteLength);
    assert.ok(surplus.every(value => value === 0));
    assert.equal(outputText(f.fixture), outputAtClose); assert.equal(owner.signal.aborted, true);
    assert.equal(receipt.upstreamClosure, "closed"); assert.equal(receipt.inboundClosure, "closed");
    owner.dispose();
  });
 }
}

for (const failure of ["hanging EOF", "late EOF", "late bytes", "late rejection"] as const) {
  test(`${failure} after positive closure stays bounded and cannot refill disposed buffers`, {timeout: 1000}, async () => {
    const pending = Promise.withResolvers<IteratorResult<Uint8Array>>();
    const peer = makeResponseSource(fixed, () => pending.promise);
    const fixture = createEgressFixture(); const controller = new AbortController();
    let now = 0;
    const clock: HttpEgressClock = {now: () => now, async within(deadline, action, signal) {
      signal?.throwIfAborted();
      if (peer.reads < 1 || !controller.signal.aborted) {return action();}
      assert.equal(deadline, 1100); assert.equal(signal, undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([action(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {now = deadline; reject(new Error("synthetic EOF deadline"));}, 10);
        })]);
      } finally {clearTimeout(timer);}
    }};
    const result = forwardStrictHttpResponse(peer.source, fixture.operation.connection,
      {...fixture.operation.limits, deadline: 700, closureDeadline: 1100}, clock, controller.signal, undefined,
      async () => {now = 701; controller.abort(); return true;});
    await assert.rejects(result, error => {
      assert.ok(error instanceof StrictHttpResponseError); assert.equal(error.kind, "stalled");
      assert.equal(error.upstreamBytes, bytes(fixed).byteLength);
      assert.equal(error.outboundBytes, bytes(outputText(fixture)).byteLength); return true;
    });
    assert.equal(peer.reads, 2); const output = outputText(fixture);
    const late = bytes("private-late-surplus");
    if (failure === "late bytes") {pending.resolve({done: false, value: late});}
    if (failure === "late EOF") {pending.resolve({done: true, value: undefined});}
    if (failure === "late rejection") {pending.reject(new Error("synthetic late failure"));}
    await tick();
    if (failure === "late bytes") {assert.ok(late.every(value => value === 0));}
    assert.equal(outputText(fixture), output); assert.equal(peer.reads, 2); assert.equal(peer.returns, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}

for (const hostClosed of [false, true]) {
 for (const observation of ["cancel", "deadline", "invalid", "EOF"] as const) {
  test(`${hostClosed ? "positive closure" : "no closure callback"} preserves ${observation} at final observation`, async () => {
    const fixture = createEgressFixture(); const controller = new AbortController();
    let now = 0; const limits = {...fixture.operation.limits, deadline: 700, closureDeadline: 1100};
    const peer = makeResponseSource(fixed, async () => {
      if (observation === "cancel") {controller.abort();}
      if (observation === "deadline") {now = hostClosed ? 1100 : 700;}
      // Invalid source values must never become clean EOF, even after cancellation.
      if (observation === "invalid") {return {done: false, value: "invalid" as unknown as Uint8Array};}
      return {done: true, value: undefined};
    });
    const clock: HttpEgressClock = {now: () => now, async within(deadline, action, signal) {
      signal?.throwIfAborted();
      if (peer.reads === 1 && outputText(fixture).endsWith("ok")) {
        assert.equal(deadline, hostClosed ? 1100 : 700);
        assert.equal(signal, hostClosed ? undefined : controller.signal);
      }
      return action();
    }};
    const result = forwardStrictHttpResponse(peer.source, fixture.operation.connection, limits, clock,
      controller.signal, undefined, hostClosed ? async () => {now = 701; controller.abort(); return true;} : undefined);
    if (observation === "EOF" || hostClosed && observation === "cancel") {await result;}
    else {await assert.rejects(result, error => {
      assert.ok(error instanceof StrictHttpResponseError);
      assert.equal(error.kind, observation === "cancel" ? "cancelled" : observation === "deadline" ? "stalled" : "malformed");
      return true;
    });}
    assert.equal(peer.reads, 2); assert.equal(peer.returns, 0);
    assert.equal(outputText(fixture).split("\r\n\r\n")[1], "ok");
  });
 }
}

for (const fault of ["incomplete framing", "late EOF", "late cleanup"] as const) {
  test(`${fault} remains reconciliation debt after operation expiry`, async () => {
    let reads = 0;
    const responseSource: AsyncIterable<Uint8Array> = {[Symbol.asyncIterator]() {return {async next() {
      reads += 1;
      if (reads === 1) {return {done: false,
        value: bytes(`HTTP/1.1 200 OK\r\nContent-Length: ${fault === "incomplete framing" ? 3 : 2}\r\n\r\nok`)};}
      if (fault === "late EOF") {f.state.controlTime = 1100;}
      return {done: true, value: undefined};
    }};}};
    const f = localCutFixture({responseSource});
    const owner = createHostHttpLocalCutOwner({...f.input, operationDeadline: 700});
    const session = owner.bindSession({...f.ports, transport: {beginOpen(input) {
      const attempt = f.ports.transport.beginOpen(input);
      return {...attempt, close() {f.state.controlTime = fault === "late cleanup" ? 1101 : 701; return attempt.close();}};
    }}}, f.openSession);
    const receipt = await session.execute(f.operation);
    assert.equal(receipt.outcome, "reconcile_required"); assert.equal(receipt.firstByteState, "sent");
    if (fault === "incomplete framing") {
      assert.equal(receipt.upstreamClosure, "closed"); assert.equal(receipt.inboundClosure, "closed");
    }
    if (fault === "late EOF") {assert.equal(reads, 2);}
    owner.dispose();
  });
}

for (const revoke of ["expiry", "custody", "shutdown", "dispose"] as const) {
  test(`time remains fresh after ${revoke}, with execution permanently closed`, async () => {
    const f = localCutFixture(); let clock: HttpEgressClock | undefined;
    const owner = createHostHttpLocalCutOwner({...f.input, operationDeadline: 700});
    const session = owner.bindSession(f.ports, ports => {clock = ports.clock; return f.openSession(ports);});
    assert.ok(clock);
    if (revoke === "custody") {f.custody.abort();}
    if (revoke === "shutdown") {f.shutdown.abort();}
    if (revoke === "dispose") {owner.dispose();}
    f.state.controlTime = 700; const reads = f.state.reads;
    assert.equal(clock.now(), 700); assert.equal(f.state.reads, reads + 1);
    f.state.controlTime = 701; assert.equal(clock.now(), 701);
    assert.equal(owner.cut.read().status, "revoked"); assert.equal(owner.signal.aborted, true);
    await clock.within(1100, async () => {assert.equal(clock!.now(), 701);});
    assert.notEqual((await session.execute(f.operation)).outcome, "completed");
    assert.equal(f.fixture.observations.opens, 0); assert.equal(f.state.journalCalls, 0);
  });
}

for (const fault of ["authority", "epoch", "regression", "invalid", "throw"] as const) {
  test(`${fault} after revocation makes clock uncertainty sticky`, () => {
    const f = localCutFixture(); let clock: HttpEgressClock | undefined;
    f.owner.bindSession(f.ports, ports => {clock = ports.clock; return f.openSession(ports);});
    assert.ok(clock); f.state.controlTime = 3; assert.equal(clock.now(), 3); f.owner.dispose();
    if (fault === "authority") {f.state.authorityId = "foreign";}
    if (fault === "epoch") {f.state.epoch = "foreign";}
    if (fault === "regression") {f.state.controlTime = 2;}
    if (fault === "invalid") {f.state.controlTime = Number.NaN;}
    if (fault === "throw") {f.state.throwClock = true;}
    assert.ok(Number.isNaN(clock.now()));
    Object.assign(f.state, {authorityId: "clock-authority", epoch: "epoch-1", controlTime: 4, throwClock: false});
    assert.ok(Number.isNaN(clock.now())); assert.equal(f.owner.signal.aborted, true);
    assert.notEqual(f.owner.cut.read().status, "current");
  });
}
