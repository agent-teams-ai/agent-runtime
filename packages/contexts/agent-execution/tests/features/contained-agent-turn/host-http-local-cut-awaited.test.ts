import assert from "node:assert/strict";
import {getEventListeners} from "node:events";
import test from "node:test";
import {localCutFixture, deferred, tick} from "./support/host-http-local-cut-fixture.ts";
import {bytes} from "./http-egress-test-fixture.ts";

for (const source of ["custody", "shutdown", "dispose", "clock-epoch"] as const) {
  test(`${source} during dispatch aborts the exact in-flight signal and preserves acceptance ambiguity`, {timeout: 1500}, async () => {
    const f = localCutFixture(); const entered = deferred<void>(); const late = deferred<never>();
    f.state.dispatchHook = pending => {void pending.then(() => entered.resolve()); return late.promise;};
    const session = f.owner.bindSession(f.ports, f.openSession);
    const pending = session.execute(f.operation); await entered.promise;
    assert.equal(f.fixture.observations.dispatchedRequests.length, 1);
    assert.equal(f.state.dispatchSignal?.aborted, false);
    if (source === "custody") {f.custody.abort();}
    if (source === "shutdown") {f.shutdown.abort();}
    if (source === "dispose") {f.owner.dispose();}
    if (source === "clock-epoch") {f.state.epoch = "new-epoch"; f.owner.cut.read();}
    assert.equal(f.state.dispatchSignal?.aborted, true);
    assert.equal(f.owner.signal.aborted, true);
    const denied = session.execute(f.operation);
    const receipt = await pending;
    assert.equal(receipt.outcome, "reconcile_required"); assert.equal(receipt.firstByteState, "uncertain");
    assert.equal(receipt.upstreamClosure, "closed"); assert.equal(receipt.inboundClosure, "closed");
    assert.notEqual((await denied).outcome, "completed");
    assert.equal(f.fixture.observations.dispatches, 1); assert.equal(f.state.journalCalls, 1);
    assert.equal(getEventListeners(f.owner.signal, "abort").length, 0);
    assert.equal(getEventListeners(f.state.dispatchSignal!, "abort").length, 0);
    late.reject(new Error("late ambiguous dispatch rejection")); await tick();
    assert.equal(receipt.outcome, "reconcile_required");
    assert.notEqual(f.owner.cut.read().status, "current");
  });
}

for (const source of ["custody", "shutdown", "request"] as const) {
  test(`${source} during body observation propagates abort without laundering an emitted request`, {timeout: 1500}, async () => {
    const entered = deferred<void>(); const body = deferred<IteratorResult<Uint8Array>>();
    const request = new AbortController(); let reads = 0;
    const responseSource: AsyncIterable<Uint8Array> = {[Symbol.asyncIterator]() {return {async next() {
      reads += 1;
      if (reads === 1) {return {done: false, value: bytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx")};}
      entered.resolve(); return body.promise;
    }};}};
    const f = localCutFixture({signal: request.signal, responseSource});
    const session = f.owner.bindSession(f.ports, f.openSession);
    const pending = session.execute(f.operation); await entered.promise;
    if (source === "custody") {f.custody.abort();}
    if (source === "shutdown") {f.shutdown.abort();}
    if (source === "request") {request.abort();}
    assert.equal(f.state.dispatchSignal?.aborted, true);
    const receipt = await pending;
    assert.equal(receipt.outcome, "reconcile_required"); assert.equal(receipt.firstByteState, "sent");
    assert.equal(receipt.anomalyCode, "inbound_cancelled");
    const writes = f.fixture.observations.outboundWrites.length;
    body.resolve({done: false, value: bytes("y")}); await tick();
    assert.equal(f.fixture.observations.outboundWrites.length, writes);
    assert.notEqual((await session.execute({...f.operation, signal: new AbortController().signal})).outcome, "completed");
    assert.equal(f.fixture.observations.dispatches, 1);
    assert.equal(getEventListeners(request.signal, "abort").length, 0);
    assert.equal(getEventListeners(f.owner.signal, "abort").length, 0);
    assert.equal(getEventListeners(f.state.dispatchSignal!, "abort").length, 0);
    if (source === "request") {assert.equal(f.custody.signal.aborted, false);}
  });
}

for (const phase of ["authorization", "materialization", "resolver", "ready", "final"] as const) {
  test(`shutdown during awaited ${phase} rejects late success before any journal consumption`, {timeout: 1500}, async () => {
    const f = localCutFixture(); const entered = deferred<void>(); const release = deferred<void>();
    const wait = async <T>(action: () => Promise<T>): Promise<T> => {
      const result = await action(); entered.resolve(); await release.promise; return result;
    };
    const ports = {...f.ports};
    if (phase === "authorization") {ports.providerAccess = {...ports.providerAccess,
      authorize: input => wait(() => f.ports.providerAccess.authorize(input))};}
    let fields: Awaited<ReturnType<typeof ports.materializer.render>> | undefined;
    if (phase === "materialization") {ports.materializer = {render: input => wait(async () => {
      fields = await f.ports.materializer.render(input); return fields;
    })};}
    if (phase === "resolver") {ports.resolver = {resolve: host => wait(() => f.ports.resolver.resolve(host))};}
    if (phase === "ready") {ports.transport = {beginOpen: input => {
      const attempt = f.ports.transport.beginOpen(input); return {...attempt, ready: () => wait(() => attempt.ready())};
    }};}
    if (phase === "final") {ports.runtimeSecurity = {...ports.runtimeSecurity,
      authorizeFirstApplicationByte: input => wait(() => f.ports.runtimeSecurity.authorizeFirstApplicationByte(input))};}
    const session = f.owner.bindSession(ports, f.openSession);
    const pending = session.execute(f.operation); await entered.promise;
    const signal = f.phaseSignals.at(-1); assert.ok(signal);
    f.shutdown.abort(); assert.equal(signal.aborted, true);
    const receipt = await pending;
    assert.equal(receipt.outcome, "cancelled"); assert.equal(receipt.firstByteState, "not_sent");
    release.resolve(); await tick();
    assert.equal(f.state.journalCalls, 0); assert.equal(f.fixture.observations.dispatches, 0);
    assert.notEqual((await session.execute(f.operation)).outcome, "completed");
    assert.equal(getEventListeners(signal, "abort").length, 0);
    if (fields !== undefined) {assert.ok(fields[0]); assert.ok(fields[0].valueBytes.every(value => value === 0));}
  });
}

test("cutoff closes admission before invoking synchronous transport listeners", {timeout: 1500}, async () => {
  const f = localCutFixture(); const entered = deferred<void>(); const late = deferred<never>();
  f.state.dispatchHook = pending => {void pending.then(() => entered.resolve()); return late.promise;};
  const session = f.owner.bindSession(f.ports, f.openSession);
  const pending = session.execute(f.operation); await entered.promise;
  let reentrant: ReturnType<typeof session.execute> | undefined;
  f.state.dispatchSignal!.addEventListener("abort", () => {reentrant = session.execute(f.operation);}, {once: true});
  f.custody.abort();
  assert.ok(reentrant); assert.notEqual((await reentrant).outcome, "completed");
  assert.equal((await pending).outcome, "reconcile_required");
  assert.equal(f.fixture.observations.provisionalInputs.length, 1);
  assert.equal(f.state.journalCalls, 1); assert.equal(f.fixture.observations.dispatches, 1);
  late.reject(new Error("late failure")); await tick();
});

test("unknown upstream containment stays reconciliation debt after disposal and late completion", {timeout: 1500}, async () => {
  const entered = deferred<void>(); const body = deferred<IteratorResult<Uint8Array>>();
  const responseSource: AsyncIterable<Uint8Array> = {[Symbol.asyncIterator]() {return {next() {
    entered.resolve(); return body.promise;
  }};}};
  const f = localCutFixture({responseSource, upstreamClosure: "unknown"});
  const session = f.owner.bindSession(f.ports, f.openSession);
  const pending = session.execute(f.operation); await entered.promise;
  f.owner.dispose(); f.owner.dispose();
  const receipt = await pending;
  assert.equal(receipt.outcome, "reconcile_required"); assert.equal(receipt.upstreamClosure, "unknown");
  body.resolve({done: true, value: undefined}); await tick();
  assert.equal(receipt.upstreamClosure, "unknown"); assert.equal(f.owner.cut.read().status, "revoked");
  assert.equal(getEventListeners(f.owner.signal, "abort").length, 0);
});
