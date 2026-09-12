import assert from "node:assert/strict";
import {getEventListeners} from "node:events";
import test from "node:test";
import {createHostHttpLocalCutOwner} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-local-cut-owner.js";
import {openAuthenticatedHostHttpEgressSession} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-egress-session.js";
import {chunks} from "./http-egress-test-fixture.ts";
import {localCutFixture, deferred, tick} from "./support/host-http-local-cut-fixture.ts";

test("snapshots bindings and clock methods without copying the owner's opaque live identity or signals", async () => {
  const f = localCutFixture(); const originalLiveIdentity = f.input.identity.liveProcessSessionIdentity;
  const request = new AbortController();
  const input = {...f.input, identity: {...f.input.identity}, claimed: {...f.input.claimed},
    expectedClock: {...f.input.expectedClock}, clock: {...f.input.clock}};
  const owner = createHostHttpLocalCutOwner(input);
  input.identity.operationId = "foreign-operation"; input.identity.liveProcessSessionIdentity = {};
  input.claimed.underlyingCustodyRef = "foreign-reservation"; input.claimed.signal = new AbortController().signal;
  input.expectedClock.authorityId = "foreign-clock"; input.expectedClock.epoch = "foreign-epoch";
  input.operationDeadline = 1;
  input.clock.read = () => {throw new Error("replacement must not be called");};
  input.clock.within = () => {throw new Error("replacement must not be called");};
  const session = owner.bindSession(f.ports, ports => {
    assert.strictEqual(ports.identity.liveProcessSessionIdentity, originalLiveIdentity);
    assert.equal(ports.identity.operationId, f.operation.operationId);
    assert.strictEqual(ports.localAuthorityCut, owner.cut);
    return f.openSession(ports);
  });
  f.state.controlTime = 2;
  assert.equal((await session.execute({...f.operation, signal: request.signal})).outcome, "completed");
  assert.equal(getEventListeners(request.signal, "abort").length, 0);
  assert.equal(getEventListeners(owner.signal, "abort").length, 0);
  f.custody.abort(); assert.equal(owner.signal.aborted, true);
  assert.equal(input.claimed.signal.aborted, false);
});

test("accessor and proxy binding data cannot run owner code during construction", () => {
  const f = localCutFixture(); let accesses = 0;
  const getter = () => {accesses += 1; return f.input.clock.read;};
  assert.throws(() => createHostHttpLocalCutOwner({...f.input,
    clock: Object.defineProperty({...f.input.clock}, "read", {get: getter})}));
  assert.throws(() => createHostHttpLocalCutOwner(Object.defineProperty({...f.input}, "identity", {get: getter})));
  assert.throws(() => createHostHttpLocalCutOwner(new Proxy(f.input, {ownKeys() {accesses += 1; return [];}})));
  assert.equal(accesses, 0); assert.equal(f.state.reads, 0);
});

test("symbol accessors on every copied binding are rejected without invocation", () => {
  const f = localCutFixture(); let accesses = 0;
  for (const enumerable of [true, false]) {
    const accessor = <T extends object>(value: T): T => Object.defineProperty({...value}, Symbol("invalid"),
      {enumerable, get() {accesses += 1; return "must not run";}});
    for (const input of [accessor(f.input), {...f.input, claimed: accessor(f.input.claimed)},
      {...f.input, claimed: {...f.input.claimed, committedDispatchProof: accessor(f.input.claimed.committedDispatchProof)}},
      {...f.input, identity: accessor(f.input.identity)}, {...f.input, expectedClock: accessor(f.input.expectedClock)},
      {...f.input, clock: accessor(f.input.clock)}]) {
      assert.throws(() => createHostHttpLocalCutOwner(input), /invalid Host HTTP local cut data/u);
      assert.equal(accesses, 0); assert.equal(f.state.reads, 0);
    }
  }
  assert.deepEqual(f.fixture.observations.order, []);
  assert.equal(getEventListeners(f.custody.signal, "abort").length, 0);
});

test("clock-return accessors, asynchronous samples and clock reentrancy fail permanently closed", () => {
  for (const fault of ["accessor", "symbol-accessor", "promise", "reentrant"] as const) {
    const f = localCutFixture(); let reads = 0; let accessors = 0;
    let owner: ReturnType<typeof createHostHttpLocalCutOwner>;
    owner = createHostHttpLocalCutOwner({...f.input, clock: {...f.input.clock, read() {
      reads += 1;
      if (fault === "accessor") {return Object.defineProperty({authorityId: "clock-authority", epoch: "epoch-1"},
        "controlTime", {get() {accessors += 1; return 0;}}) as never;}
      if (fault === "symbol-accessor") {return Object.defineProperty({authorityId: "clock-authority", epoch: "epoch-1", controlTime: 0},
        Symbol("invalid"), {enumerable: true, get() {accessors += 1; return 0;}});}
      if (fault === "promise") {return Promise.resolve({authorityId: "clock-authority", epoch: "epoch-1", controlTime: 0}) as never;}
      owner.cut.read(); return {authorityId: "clock-authority", epoch: "epoch-1", controlTime: 0};
    }}});
    owner.bindSession(f.ports, f.openSession);
    assert.equal(owner.signal.aborted, true); assert.equal(reads, 1); assert.equal(accessors, 0);
    assert.equal(owner.cut.read().status, "unknown"); assert.equal(reads, 2);
  }
});

test("operation deadline narrows request execution without borrowing the closure acknowledgement budget", async () => {
  const f = localCutFixture(); const owner = createHostHttpLocalCutOwner({...f.input, operationDeadline: 700});
  const session = owner.bindSession(f.ports, f.openSession);
  assert.equal((await session.execute(f.operation)).outcome, "completed");
  assert.ok(f.deadlines.includes(700)); assert.ok(f.deadlines.includes(f.operation.limits.closureDeadline));
  assert.ok(f.deadlines.every(deadline => deadline === 700 || deadline === f.operation.limits.closureDeadline));
  f.state.controlTime = 700;
  assert.equal(owner.cut.read().status, "revoked"); assert.equal(owner.signal.aborted, true);
});

test("the explicit existing authenticated factory retains its private token capability and cutoff closes it", async () => {
  const f = localCutFixture(); const session = f.owner.bindSession(f.ports, openAuthenticatedHostHttpEgressSession);
  const token = session.nativeBearerToken();
  const request = `POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Type: application/json\r\nContent-Length: 2\r\nAuthorization: Bearer ${token}\r\n\r\n{}`;
  const operation = {...f.operation, connection: {...f.operation.connection, request: chunks([request])}};
  const receipt = await session.execute(operation);
  assert.equal(receipt.outcome, "completed");
  assert.equal(new TextDecoder().decode(f.fixture.observations.dispatchedRequests[0]).includes(token), false);
  f.shutdown.abort(); assert.throws(session.nativeBearerToken, /inbound_authentication_denied/u);
  assert.notEqual((await session.execute(operation)).outcome, "completed");
  assert.equal(f.fixture.observations.dispatches, 1);
});

test("session allocation or malformed execution errors propagate and seal the owner", async () => {
  const f = localCutFixture(); const error = new Error("synthetic construction fault");
  assert.throws(() => f.owner.bindSession(f.ports, () => {throw error;}), value => value === error);
  assert.equal(f.owner.signal.aborted, true);
  assert.equal(getEventListeners(f.custody.signal, "abort").length, 0);
  const next = localCutFixture(); const session = next.owner.bindSession(next.ports, next.openSession);
  await assert.rejects(session.execute({} as never));
  assert.equal(next.owner.cut.read().status, "unknown");
  assert.equal(next.fixture.observations.opens, 0);
});

const otherListener = () => {};

test("Host shutdown signal is optional and disposal only releases owned listeners", async () => {
  const f = localCutFixture(); const {hostShutdownSignal: _shutdown, ...input} = f.input;
  f.custody.signal.addEventListener("abort", otherListener);
  const owner = createHostHttpLocalCutOwner(input); owner.bindSession(f.ports, f.openSession);
  assert.equal(getEventListeners(f.custody.signal, "abort").length, 2);
  owner.dispose(); owner.dispose(); await tick();
  assert.deepEqual(getEventListeners(f.custody.signal, "abort"), [otherListener]);
  assert.equal(f.custody.signal.aborted, false); assert.equal(f.shutdown.signal.aborted, false);
  f.custody.signal.removeEventListener("abort", otherListener);
  assert.equal(f.input.clock.read().authorityId, "clock-authority");
});

test("late evidence acknowledgement preserves completed HTTP facts but cannot reopen admission", {timeout: 1500}, async () => {
  const f = localCutFixture(); const entered = deferred<void>(); const release = deferred<void>();
  const session = f.owner.bindSession({...f.ports, evidence: {...f.ports.evidence, async record(receipt) {
    entered.resolve(); await release.promise; return f.ports.evidence.record(receipt);
  }}}, f.openSession);
  const pending = session.execute(f.operation); await entered.promise;
  f.owner.dispose(); assert.equal(f.owner.signal.aborted, true);
  release.resolve(); const receipt = await pending;
  assert.equal(receipt.outcome, "completed", "the bytes and both closures were observed before disposal");
  assert.equal(receipt.firstByteState, "sent");
  assert.equal(f.owner.cut.read().status, "revoked");
  assert.notEqual((await session.execute(f.operation)).outcome, "completed");
  assert.equal(f.fixture.observations.dispatches, 1);
});
