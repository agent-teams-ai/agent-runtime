import assert from "node:assert/strict";
import test from "node:test";
import {readCustodyStartAdmission} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-start-admission.js";
import {getEventListeners} from "node:events";
import {Core, Kernel, deferred, fixture, startInput, tick} from "./node-custody-http-reservation-fixture.ts";

test("reservation identity belongs to the same LiveCustody before and after delegated start", async () => {
  const f = fixture();
  const {custodyRef} = await f.reserve();
  const live = f.live();
  assert.equal(f.core.get(custodyRef), undefined);
  assert.equal(live.identity.status, "not-started");
  assert.ok(live.privateRootCleanupAuthority);
  assert.equal(live.spawnStatus, "never-started");
  assert.equal(f.closedPrivateRoots(), 0);
  assert.equal(live.childProcessInstanceSha256, undefined);
  const identity = live.httpReservation.executionSessionIdentity;
  const lifetime = f.preparation.acquire(f.handoff(custodyRef));
  assert.equal(lifetime.executionSessionIdentity, identity);
  assert.equal(lifetime.signal, live.httpReservation.signal);
  assert.ok(Object.isFrozen(lifetime.executionSessionIdentity));
  assert.equal(lifetime.underlyingCustodyRef, custodyRef);
  assert.notEqual(lifetime.committedDispatchProof.custodyId, custodyRef);
  assert.notEqual(lifetime.committedDispatchProof.hostBootId, lifetime.hostLifecycleGenerationSha256);
  assert.equal(lifetime.hostLifecycleGenerationSha256, live.identity.hostLifecycleGenerationSha256);
  const fingerprint = live.fingerprint;
  f.start(custodyRef);
  assert.equal(f.live(), live);
  assert.ok(f.core.get(custodyRef));
  assert.equal(live.httpReservation.signal, lifetime.signal);
  assert.equal(live.fingerprint, fingerprint);
  assert.equal(live.httpReservation.executionSessionIdentity, identity);
  assert.ok(live.childProcessInstanceSha256);
  assert.equal(f.closedPins(), 1);
  assert.throws(() => f.preparation.acquire(f.handoff(custodyRef)), /unavailable|conflicts/u);
});

test("foreign references and conflicting reservation-owned facts reject without consuming", async () => {
  const f = fixture();
  const {custodyRef} = await f.reserve();
  const handoff = f.handoff(custodyRef);
  const foreign = new Core(f.options as never, f.profile as never);
  assert.throws(() => Core.httpPreparation(foreign)!.acquire(handoff), /unavailable/u);
  for (const field of ["attemptId", "operationId", "provider"] as const) {
    const proof = f.proofFor({hostBootId: "host-boot:kernel", hostInstanceId: "host-instance:kernel", hostCustodyProof: {proofId: "proof:kernel"}},
      {[field]: field === "provider" ? "claude" : `${field === "attemptId" ? "attempt" : "operation"}:foreign`});
    assert.throws(() => f.preparation.acquire({...handoff, committedDispatchProof: proof}), /conflicts/u);
  }
  assert.equal(f.core.get(custodyRef), undefined);
  const replay = await f.reserve();
  assert.equal(replay.custodyRef, custodyRef);
  assert.equal(f.closedPins(), 0); // Replay opens no new retained descriptor.
  const lifetime = f.preparation.acquire(handoff);
  assert.deepEqual(lifetime.committedDispatchProof, handoff.committedDispatchProof);
  assert.notEqual(lifetime.committedDispatchProof, handoff.committedDispatchProof);
  assert.throws(() => f.preparation.acquire({...handoff}), /conflicts/u);
});

test("real kernel preparation binds kernel-only Host/custody facts and rejects replay", async () => {
  const f = fixture();
  let acquired: any;
  let preparations = 0;
  const kernel = new Kernel(f.core, {hostBootId: "host-boot:actual-kernel", hostInstanceId: "host-instance:actual-kernel",
    workspaceOwner: {async withLaunchAuthority(_input, consume) {return consume(f.reservation.workspaceAuthority);}},
    attemptOwner: {async prepare() {return f.reservation.launchPlan as never;}, retain() {}, retire() {}},
    postClaimPreparation: {async prepareClaimed(handoff) {
      preparations += 1; acquired = f.preparation.acquire(handoff);
      return {kind: "unsupported", reason: "owner"}; // HTTP assembly remains absent.
    }},
  });
  const opened = await kernel.open(f.input);
  const start = {...f.identity, intentMode: "analysis" as const,
    committedDispatchProof: f.proofFor(opened), execute: async () => {throw new Error("must not execute");}};
  for (const field of ["hostBootId", "hostInstanceId", "custodyId", "hostCustodyProofId"] as const) {
    const prefix = {hostBootId: "host-boot", hostInstanceId: "host-instance", custodyId: "custody", hostCustodyProofId: "proof"}[field];
    await assert.rejects(kernel.start({...start, committedDispatchProof: f.proofFor(opened, {[field]: `${prefix}:foreign`})}), /conflicts/u);
  }
  assert.equal(preparations, 0);
  assert.equal((await kernel.start(start)).kind, "indeterminate");
  assert.equal(preparations, 1);
  assert.equal(acquired.committedDispatchProof.hostBootId, opened.hostBootId);
  assert.equal(acquired.committedDispatchProof.custodyId, opened.custodyId);
  assert.equal(acquired.signal.aborted, true);
  await assert.rejects(kernel.start(start), /consumed/u);
  assert.equal(preparations, 1);
});

test("containment cuts synchronously and remains single-flight under abort reentrancy", async () => {
  const f = fixture();
  const {custodyRef} = await f.reserve();
  const lifetime = f.preparation.acquire(f.handoff(custodyRef));
  const physical = deferred<boolean>();
  f.closeWith(() => physical.promise);
  let reentered: unknown;
  lifetime.signal.addEventListener("abort", () => {
    reentered = f.core.requestContainment({...f.identity, custodyRef});
    assert.throws(() => f.start(custodyRef), /sealed/u);
    assert.throws(() => f.preparation.acquire(f.handoff(custodyRef)), /conflicts/u);
  });
  const containment = f.core.requestContainment({...f.identity, custodyRef});
  assert.equal(lifetime.signal.aborted, true);
  assert.equal(reentered, containment);
  assert.equal(f.containmentCalls(), 1);
  assert.equal(f.live().evidenceSealed, false);
  await tick();
  assert.equal(f.live().contained, undefined);
  physical.resolve(false);
  assert.equal((await containment).kind, "unproven");
  assert.ok(f.core.evidence(custodyRef));
  assert.equal(lifetime.signal.aborted, true);
});

for (const callback of ["abort", "overflow", "start-failure"] as const) {
  test(`direct ${callback} callback cuts HTTP while physical cleanup is pending`, async () => {
    const f = fixture();
    const {custodyRef} = await f.reserve();
    const lifetime = f.preparation.acquire(f.handoff(custodyRef));
    f.start(custodyRef);
    const pending = f.holdContainment();
    const trigger = callback === "abort" ? f.callbacks().onAbort : callback === "overflow"
      ? f.callbacks().onOverflow : f.acknowledgement().onStartFailure;
    const completion = trigger();
    assert.equal(lifetime.signal.aborted, true);
    assert.equal(f.signal.signal.aborted, false);
    assert.equal(f.live().evidenceSealed, false);
    assert.ok(f.core.get(custodyRef));
    const containment = f.core.requestContainment({...f.identity, custodyRef});
    pending.resolve({kind: "unproven", evidenceRef: "synthetic:pending-cleanup"});
    await containment; await completion; await tick();
    trigger();
    assert.equal(lifetime.signal.aborted, true);
    assert.throws(() => f.preparation.acquire(f.handoff(custodyRef)), /conflicts/u);
    assert.ok(f.core.get(custodyRef));
    await tick();
  });
}

for (const field of ["signal", "arguments"] as const) {
  test(`third ${field} read cannot cross delegated start admission`, async t => {
    const f = fixture(); const {custodyRef} = await f.reserve();
    const lifetime = f.preparation.acquire(f.handoff(custodyRef));
    const execution = new AbortController();
    const input = {arguments: f.plan.arguments, command: f.plan.executablePath, cwd: "/proc/self/fd/4",
      environment: f.plan.environment, signal: execution.signal};
    const value = input[field];
    let reads = 0;
    Object.defineProperty(input, field, {get() {
      if (++reads === 3) {throw new Error(`synthetic third ${field} read`);}
      return value;
    }});
    assert.throws(() => f.core.start(custodyRef, input));
    const observations = {reads, httpAborted: lifetime.signal.aborted,
      startConsumed: f.live().startIdentitySha256 !== undefined, processPublished: f.core.get(custodyRef) !== undefined,
      spawnStatus: f.live().spawnStatus, listeners: getEventListeners(execution.signal, "abort").length,
      containmentCalls: f.containmentCalls(), evidenceSealed: f.live().evidenceSealed};
    t.diagnostic(JSON.stringify(observations));
    assert.deepEqual(observations, {reads: 0, httpAborted: false, startConsumed: false, processPublished: false,
      spawnStatus: "never-started", listeners: 0, containmentCalls: 0, evidenceSealed: false});
    f.start(custodyRef);
    assert.ok(f.core.get(custodyRef));
    assert.equal(lifetime.signal.aborted, false);
  });
}

test("release retains ownership during failed cleanup and tombstone/replay cannot reacquire", async () => {
  const f = fixture();
  const {custodyRef} = await f.reserve();
  const lifetime = f.preparation.acquire(f.handoff(custodyRef));
  const contained = await f.core.requestContainment({...f.identity, custodyRef});
  assert.equal(contained.kind, "contained");
  if (contained.kind !== "contained") {return;}
  const authority = f.live().privateRootCleanupAuthority;
  assert.ok(authority);
  const release = {...f.identity, custodyRef, receiptRef: contained.receiptRef};
  const cleanup = deferred<boolean>(); f.closeWith(() => cleanup.promise);
  const releasing = f.core.release(release);
  assert.equal(lifetime.signal.aborted, true);
  assert.equal(f.closedPins(), 0);
  cleanup.resolve(false);
  assert.equal((await releasing).kind, "unproven");
  assert.equal(f.live().privateRootCleanupAuthority, authority);
  assert.equal(f.closedPrivateRoots(), 0);
  assert.equal(f.closedPins(), 0);
  assert.ok(f.core.evidence(custodyRef));
  f.closeWith(async () => true);
  assert.equal((await f.core.release(release)).kind, "released");
  assert.equal(f.live().privateRootCleanupAuthority, undefined);
  assert.equal(f.closedPrivateRoots(), 1);
  authority.close();
  assert.equal(f.closedPrivateRoots(), 1);
  assert.equal(f.closedPins(), 1);
  assert.throws(() => f.preparation.acquire(f.handoff(custodyRef)), /unavailable/u);
  const replay = await f.reserve();
  assert.equal(replay.custodyRef, custodyRef);
  assert.throws(() => f.preparation.acquire(f.handoff(replay.custodyRef)), /unavailable/u);
});

test("kernel and delegated abort plus synchronous launch failure irreversibly cut", async () => {
  for (const mode of ["pre-abort", "kernel-abort", "start-abort", "launch-failure"]) {
    const f = fixture();
    const {custodyRef} = await f.reserve();
    if (mode === "pre-abort") {
      f.signal.abort();
      assert.throws(() => f.preparation.acquire(f.handoff(custodyRef)), /cut off/u);
    } else {
      f.preparation.acquire(f.handoff(custodyRef));
      if (mode === "kernel-abort") {f.signal.abort();}
      if (mode === "start-abort") {assert.throws(() => f.start(custodyRef, AbortSignal.abort()), /abort/iu);}
      if (mode === "launch-failure") {f.failLaunch(); assert.throws(() => f.start(custodyRef));}
    }
    assert.equal(f.live().httpReservation.signal.aborted, true);
    assert.throws(() => f.start(custodyRef), /sealed/u);
    assert.throws(() => f.preparation.acquire(f.handoff(custodyRef)), /conflicts/u);
    await f.live().containment;
  }
});

test("opening failure seals the actual reservation before retirement", async () => {
  const f = fixture();
  const pending = deferred<void>(); f.holdOpening(pending.promise); f.failCandidate();
  const opening = f.reserve();
  await tick();
  const live = f.live();
  assert.equal(live.httpReservation.signal.aborted, false);
  pending.resolve();
  await assert.rejects(opening);
  assert.equal(live.httpReservation.signal.aborted, true);
  assert.equal(f.core.evidence(live.custodyRef), undefined);
  assert.throws(() => f.preparation.acquire(f.handoff(live.custodyRef)), /unavailable/u);
});

test("construction, capability inspection and malformed handoffs invoke no traps/accessors", async () => {
  const f = fixture();
  let effects = 0;
  const trap = () => {effects += 1; throw new Error("must not execute");};
  const proxy = new Proxy({}, {get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, has: trap});
  const accessor = Object.defineProperty({}, "launchPlans", {get: trap});
  for (const value of [proxy, accessor]) {
    assert.throws(() => new Core(value as never, f.profile as never));
    assert.equal(Core.httpPreparation(value), undefined);
  }
  assert.equal(Core.httpPreparation(new Proxy(f.core, {get: trap, has: trap})), undefined);
  for (const value of [proxy, Object.defineProperty({}, "containmentProfile", {get: trap})]) {
    assert.throws(() => new Core(f.options as never, value as never));
  }
  const {custodyRef} = await f.reserve();
  const handoff = f.handoff(custodyRef);
  for (const value of [proxy, Object.defineProperty({}, "signal", {get: trap}),
    {...handoff, committedDispatchProof: proxy}, {...handoff, signal: proxy}, {...handoff, signal: Object.create(AbortSignal.prototype)},
    {...handoff, signal: Object.defineProperty(new AbortController().signal, "aborted", {get: trap})},
    {...handoff, committedDispatchProof: Object.defineProperty({}, "attemptId", {get: trap})}]) {
    assert.throws(() => f.preparation.acquire(value as never));
  }
  assert.equal(effects, 0);
  assert.equal(f.preparation.acquire(handoff).signal.aborted, false);
});


test("separate live reservations own distinct session identities and spent proof remains spent", async () => {
  const f = fixture();
  const first = await f.reserve();
  const original = f.preparation.acquire(f.handoff(first.custodyRef));
  const second = await f.core.reserve({...f.reservation, attemptId: "attempt:another", operationId: "operation:another"} as never);
  const secondLive = f.live();
  assert.notEqual(original.executionSessionIdentity, secondLive.httpReservation.executionSessionIdentity);
  assert.throws(() => f.preparation.acquire({...f.handoff(first.custodyRef), underlyingCustodyRef: second.custodyRef}), /conflicts/u);
  assert.throws(() => f.preparation.acquire(f.handoff(first.custodyRef)), /conflicts/u);
  assert.equal(secondLive.httpReservation.signal.aborted, false);
});

test("delegated signal abort and blocked kernel abort propagation cannot leave HTTP open", async () => {
  const f = fixture();
  const {custodyRef} = await f.reserve();
  f.signal.signal.addEventListener("abort", event => event.stopImmediatePropagation());
  const lifetime = f.preparation.acquire(f.handoff(custodyRef));
  f.signal.abort();
  assert.equal(lifetime.signal.aborted, true);
  const g = fixture();
  const next = await g.reserve();
  const retained = g.preparation.acquire(g.handoff(next.custodyRef));
  const execution = new AbortController();
  const pending = g.holdContainment();
  g.start(next.custodyRef, execution.signal);
  execution.abort();
  assert.equal(retained.signal.aborted, true);
  assert.equal(g.signal.signal.aborted, false);
  pending.resolve({kind: "unproven", evidenceRef: "synthetic:execution-abort"});
  await g.live().containment;
});

test("late preparation after cutoff and preparation after unclaimed start reject", async () => {
  const f = fixture();
  const {custodyRef} = await f.reserve();
  f.start(custodyRef);
  assert.throws(() => f.preparation.acquire(f.handoff(custodyRef)), /conflicts/u);
  const g = fixture();
  const pending = deferred<void>();
  g.holdOpening(pending.promise);
  const opening = g.reserve();
  await tick();
  const live = g.live();
  const identity = live.httpReservation.executionSessionIdentity;
  const containment = g.core.requestContainment(g.identity);
  assert.equal(live.httpReservation.signal.aborted, true);
  pending.resolve();
  const opened = await opening;
  await containment;
  assert.equal(live.httpReservation.executionSessionIdentity, identity);
  assert.throws(() => g.preparation.acquire(g.handoff(opened.custodyRef)), /conflicts/u);
  assert.equal(g.core.get(opened.custodyRef), undefined);
});


test("rejected delegated fingerprints preserve the accepted start and single-flight process", async () => {
  for (const http of [false, true]) {
    const f = fixture();
    const {custodyRef} = await f.reserve();
    if (http) {f.preparation.acquire(f.handoff(custodyRef));}
    const exact = {arguments: f.plan.arguments, command: f.plan.executablePath, cwd: "/proc/self/fd/4",
      environment: f.plan.environment, signal: new AbortController().signal};
    for (const drift of [{command: "/synthetic/foreign"}, {cwd: "/synthetic/foreign"},
      {arguments: ["foreign"]}, {environment: {FOREIGN: "value"}}]) {
      assert.throws(() => f.core.start(custodyRef, {...exact, ...drift}), /fingerprint conflict/u);
    }
    assert.equal(f.live().httpReservation.signal.aborted, false);
    assert.equal(f.core.get(custodyRef), undefined);
    assert.equal(f.closedPins(), 0);
    const first = f.core.start(custodyRef, exact);
    assert.equal(f.core.start(custodyRef, exact), first);
    assert.equal(f.closedPins(), 1);
  }
});


test("fingerprinted opening rejection cuts before pending cleanup without losing the live owner", async () => {
  const f = fixture();
  const cleanup = deferred<boolean>();
  const allocated = deferred<any>();
  const core = new Core({...f.options, residueAuthorityFactory: {create: () => allocated.promise}} as never, f.profile as never);
  const opening = core.reserve(f.reservation as never);
  await tick();
  const live = f.live();
  assert.ok(live.fingerprint);
  const preparation = Core.httpPreparation(core)!;
  const lifetime = preparation.acquire(f.handoff(live.custodyRef));
  const closed = () => cleanup.promise;
  // Model failed owner acquisition after its resource slot was retained;
  // real open cleanup then awaits that exact slot.
  live.residueAuthority = {close: closed} as never;
  allocated.reject(new Error("synthetic residue acquisition failure"));
  await tick();
  assert.equal(lifetime.signal.aborted, true);
  assert.equal(live.evidenceSealed, false);
  assert.ok(core.evidence(live.custodyRef));
  let settled = false;
  void opening.then(() => {settled = true; return null;}, () => {settled = true; return null;});
  await tick();
  assert.equal(settled, false);
  cleanup.resolve(false);
  await assert.rejects(opening);
  assert.ok(core.evidence(live.custodyRef));
  assert.throws(() => preparation.acquire(f.handoff(live.custodyRef)), /conflicts/u);
});

test("containment rejection leaves cutoff irreversible while retaining retry ownership", async () => {
  const f = fixture();
  const {custodyRef} = await f.reserve();
  const lifetime = f.preparation.acquire(f.handoff(custodyRef));
  const pending = f.holdContainment();
  const containment = f.core.requestContainment({...f.identity, custodyRef});
  assert.equal(lifetime.signal.aborted, true);
  pending.reject(new Error("synthetic containment failure"));
  await assert.rejects(containment);
  const next = f.holdContainment();
  const retry = f.core.requestContainment({...f.identity, custodyRef});
  assert.equal(f.containmentCalls(), 2);
  assert.equal(lifetime.signal.aborted, true);
  assert.throws(() => f.preparation.acquire(f.handoff(custodyRef)), /conflicts/u);
  next.resolve({kind: "unproven", evidenceRef: "synthetic:retained"});
  assert.equal((await retry).kind, "unproven");
  assert.ok(f.core.evidence(custodyRef));
});


for (const started of [false, true]) {
  for (const field of ["command", "cwd", "arguments", "environment"] as const) {
    test(`unreadable ${field} preserves the ${started ? "started" : "reserved"} HTTP owner`, async () => {
      const f = fixture(); const {custodyRef} = await f.reserve();
      const lifetime = f.preparation.acquire(f.handoff(custodyRef));
      const accepted = started ? f.start(custodyRef) : undefined;
      const fingerprint = f.live().fingerprint;
      const startIdentity = f.live().startIdentitySha256;
      const plan = f.reservation.launchPlan;
      const input = {arguments: plan.arguments, command: plan.executablePath, cwd: "/proc/self/fd/4",
        environment: plan.environment, signal: new AbortController().signal};
      let reads = 0;
      Object.defineProperty(input, field, {get() {reads += 1; throw new Error("synthetic failed identity read");}});
      assert.throws(() => f.core.start(custodyRef, input));
      assert.equal(reads, 0);
      assert.equal(getEventListeners(input.signal, "abort").length, 0);
      assert.equal(lifetime.signal.aborted, false);
      assert.equal(f.live().fingerprint, fingerprint);
      assert.equal(f.live().startIdentitySha256, startIdentity);
      assert.equal(f.containmentCalls(), 0); assert.equal(f.live().evidenceSealed, false);
      const valid = f.start(custodyRef);
      if (started) {assert.equal(valid, accepted);}
      assert.equal(lifetime.signal.aborted, false);
    });
  }
}

for (const started of [false, true]) {
  test(`inert rejection of nested collections and proxies preserves ${started ? "started" : "reserved"} ownership`, async () => {
    let effects = 0;
    const trap = () => {effects += 1; throw new Error("caller code must not run");};
    const proxy = (target: object) => new Proxy(target, {
      get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, has: trap,
    });
    const revoked = Proxy.revocable([], {}); revoked.revoke();
    const accessor = (target: object, key: PropertyKey) => Object.defineProperty(target, key, {get: trap});
    const sparseArguments: string[] = []; sparseArguments.length = 1;
    const malformed = [
      () => proxy(startInput()), () => accessor(startInput(), "signal"),
      () => ({...startInput(), arguments: proxy(["synthetic"])}),
      () => ({...startInput(), arguments: revoked.proxy}),
      () => ({...startInput(), arguments: accessor(["synthetic"], "0")}),
      () => ({...startInput(), arguments: accessor(["synthetic"], Symbol.iterator)}),
      () => ({...startInput(), arguments: accessor(["synthetic"], "map")}),
      () => ({...startInput(), arguments: [proxy({toString: trap})]}),
      () => ({...startInput(), arguments: sparseArguments}),
      () => ({...startInput(), arguments: {0: "synthetic", length: 1}}),
      () => ({...startInput(), environment: proxy({})}),
      () => ({...startInput(), environment: accessor({}, "HOME")}),
      () => ({...startInput(), environment: {HOME: proxy({toString: trap})}}),
      () => ({...startInput(), environment: {toJSON: trap}}),
      () => ({...startInput(), command: proxy({toString: trap})}),
      () => ({...startInput(), signal: proxy(new AbortController().signal)}),
      () => ({...startInput(), signal: Object.create(AbortSignal.prototype)}),
      ...["aborted", "addEventListener", "removeEventListener"].map(key =>
        () => ({...startInput(), signal: accessor(new AbortController().signal, key)})),
      () => ({...startInput(), signal: Object.assign(new AbortController().signal, {addEventListener: trap})}),
    ];
    for (const make of malformed) {
      const f = fixture(); const {custodyRef} = await f.reserve();
      const lifetime = f.preparation.acquire(f.handoff(custodyRef));
      const execution = new AbortController();
      const accepted = started ? f.start(custodyRef, execution.signal) : undefined;
      const owner = f.live(); const identity = owner.startIdentitySha256; const fingerprint = owner.fingerprint;
      const listeners = getEventListeners(execution.signal, "abort").length;
      assert.throws(() => f.core.start(custodyRef, make() as never));
      assert.equal(effects, 0);
      assert.equal(f.live(), owner); assert.equal(owner.fingerprint, fingerprint);
      assert.equal(owner.startIdentitySha256, identity); assert.equal(lifetime.signal.aborted, false);
      assert.equal(owner.evidenceSealed, false); assert.equal(f.containmentCalls(), 0);
      assert.equal(f.launchCalls(), started ? 1 : 0); assert.equal(f.closedPins(), started ? 1 : 0);
      assert.equal(getEventListeners(execution.signal, "abort").length, listeners);
      const valid = f.start(custodyRef);
      if (started) {assert.equal(valid, accepted);}
      assert.equal(f.launchCalls(), 1); assert.equal(lifetime.signal.aborted, false);
      await tick();
    }
  });

  test(`second fingerprint rejection precedes ${started ? "replay" : "new start"} admission`, async () => {
    const f = fixture(); const {custodyRef} = await f.reserve();
    const lifetime = f.preparation.acquire(f.handoff(custodyRef));
    const first = started ? f.start(custodyRef) : undefined;
    const owner = f.live(); const identity = owner.startIdentitySha256;
    const fingerprint = owner.fingerprint!;
    assert.throws(() => {Object.assign(owner, {fingerprint: {...fingerprint, fingerprintSha256: "synthetic:conflict"}});}, TypeError);
    const input = startInput();
    assert.throws(() => readCustodyStartAdmission(input, {...owner,
      fingerprint: {...fingerprint, fingerprintSha256: "synthetic:conflict"}}), /fingerprint conflict/u);
    assert.equal(getEventListeners(input.signal, "abort").length, 0);
    assert.equal(owner.startIdentitySha256, identity); assert.equal(lifetime.signal.aborted, false);
    assert.equal(f.launchCalls(), started ? 1 : 0); assert.equal(f.containmentCalls(), 0);
    assert.equal(owner.fingerprint, fingerprint);
    const valid = f.start(custodyRef);
    if (started) {assert.equal(valid, first);}
    assert.equal(f.launchCalls(), 1);
  });
}

const external = () => {};

for (const settle of ["resolve", "reject"] as const) {
  test(`exact replay retains both native signals until process exit ${settle}`, async () => {
    const f = fixture(); const {custodyRef} = await f.reserve();
    const lifetime = f.preparation.acquire(f.handoff(custodyRef));
    const exit = deferred<{code: number | null; signal: null}>(); f.exitWith(exit.promise);
    const first = new AbortController(); const replay = new AbortController();
    first.signal.addEventListener("abort", external);
    const process = f.start(custodyRef, first.signal);
    assert.equal(f.start(custodyRef, replay.signal), process);
    assert.equal(f.start(custodyRef, first.signal), process);
    await tick();
    assert.equal(f.launchCalls(), 1);
    assert.equal(getEventListeners(first.signal, "abort").length, 3);
    assert.equal(getEventListeners(replay.signal, "abort").length, 1);
    let reads = 0;
    Object.defineProperty(first.signal, "removeEventListener", {get() {
      reads += 1; throw new Error("caller cleanup getter must not run");
    }});
    if (settle === "resolve") {exit.resolve({code: 0, signal: null});}
    else {exit.reject(new Error("synthetic exit observation failure"));}
    await tick();
    assert.deepEqual(getEventListeners(first.signal, "abort"), [external]);
    assert.equal(getEventListeners(replay.signal, "abort").length, 0);
    first.abort(); replay.abort();
    assert.equal(reads, 0); assert.equal(f.containmentCalls(), 0); assert.equal(lifetime.signal.aborted, false);
  });
}

for (const replay of [false, true]) {
  test(`conflicting pre-aborted ${replay ? "replay" : "start"} cannot revoke the accepted owner`, async () => {
    const f = fixture(); const {custodyRef} = await f.reserve();
    const lifetime = f.preparation.acquire(f.handoff(custodyRef));
    const first = replay ? f.start(custodyRef) : undefined;
    const input = startInput(AbortSignal.abort());
    assert.throws(() => f.core.start(custodyRef, {...input, arguments: ["conflict"]}), /fingerprint conflict/u);
    assert.equal(lifetime.signal.aborted, false); assert.equal(f.containmentCalls(), 0);
    assert.equal(getEventListeners(input.signal, "abort").length, 0);
    const valid = f.start(custodyRef);
    if (replay) {assert.equal(valid, first);}
    assert.equal(f.launchCalls(), 1);
  });
}

test("snapshots launch bytes once and never reads later caller accessors or overridden native signal operations", async () => {
  const f = fixture(); const {custodyRef} = await f.reserve();
  const lifetime = f.preparation.acquire(f.handoff(custodyRef));
  const execution = new AbortController(); const input = startInput(execution.signal);
  const originalArguments = input.arguments; const environment = input.environment;
  const pending = f.holdContainment();
  let effects = 0;
  const trap = () => {effects += 1; throw new Error("later caller read must not run");};
  f.onLaunch(() => {
    originalArguments[0] = "changed-after-admission"; environment.LANG = "changed-after-admission";
    environment.FOREIGN = "changed-after-admission";
    for (const key of ["arguments", "command", "cwd", "environment", "signal"]) {
      Object.defineProperty(input, key, {get: trap});
    }
    for (const key of ["aborted", "addEventListener", "removeEventListener"]) {
      Object.defineProperty(execution.signal, key, {get: trap});
    }
  });
  const process = f.core.start(custodyRef, input);
  assert.ok(process); assert.equal(effects, 0);
  assert.deepEqual(f.callbacks().arguments, ["synthetic"]);
  assert.deepEqual(Object.keys(f.callbacks().environment), ["LANG"]);
  assert.equal(f.callbacks().environment.LANG, "C.UTF-8");
  assert.notEqual(f.callbacks().arguments, originalArguments); assert.notEqual(f.callbacks().environment, environment);
  assert.ok(Object.isFrozen(f.callbacks().arguments)); assert.ok(Object.isFrozen(f.callbacks().environment));
  execution.abort();
  assert.equal(effects, 0); assert.equal(lifetime.signal.aborted, true);
  assert.equal(getEventListeners(execution.signal, "abort").length, 0);
  pending.resolve({kind: "unproven", evidenceRef: "synthetic:retained-native-abort"});
  await f.live().containment; await tick(); assert.equal(effects, 0);
});

for (const failure of ["launch", "pin-close", "acknowledgement", "return-subscription"] as const) {
  test(`admitted ${failure} rejection cuts synchronously and retains actual containment ownership`, async t => {
    const f = fixture(); const {custodyRef} = await f.reserve();
    const lifetime = f.preparation.acquire(f.handoff(custodyRef));
    const execution = new AbortController(); const pending = failure === "launch" ? undefined : f.holdContainment();
    const fail = () => {throw new Error(`synthetic ${failure} failure`);};
    if (failure === "launch") {f.failLaunch();}
    if (failure === "pin-close") {f.onPinClose(fail);}
    if (failure === "acknowledgement") {f.onAcknowledgement(fail);}
    if (failure === "return-subscription") {
      const exit = Promise.resolve({code: 0, signal: null});
      t.mock.method(exit, "then", fail); f.exitWith(exit);
    }
    let reentered: unknown;
    lifetime.signal.addEventListener("abort", () => {
      assert.throws(() => f.start(custodyRef), /sealed/u);
      reentered = f.core.requestContainment({...f.identity, custodyRef});
    });
    assert.throws(() => f.start(custodyRef, execution.signal));
    const live = f.live();
    assert.equal(lifetime.signal.aborted, true); assert.equal(live.evidenceSealed, false);
    assert.equal(live.contained, undefined); assert.notEqual(live.closureEvidence.status, "closed");
    assert.equal(getEventListeners(execution.signal, "abort").length, 0);
    assert.equal(f.containmentCalls(), failure === "launch" ? 0 : 1); assert.equal(reentered, live.containment);
    assert.equal(f.launchCalls(), 1); assert.ok(live.startIdentitySha256);
    if (failure !== "launch") {
      assert.ok(f.core.get(custodyRef)); assert.ok(live.child); assert.ok(live.guardian);
      assert.ok(live.launchAuthority); assert.ok(live.exit); assert.ok(live.sdkProcess);
    }
    assert.ok(f.core.evidence(custodyRef));
    assert.throws(() => f.start(custodyRef), /sealed/u);
    pending?.resolve({kind: "unproven", evidenceRef: "synthetic:admitted-failure"});
    assert.equal((await reentered as {kind: string}).kind, "unproven");
    assert.equal(live.evidenceSealed, false); assert.equal(live.contained, undefined);
  });
}

test("reentrant launch cancellation cannot admit another process or manufacture no-start closure", async () => {
  const f = fixture(); const {custodyRef} = await f.reserve();
  const lifetime = f.preparation.acquire(f.handoff(custodyRef));
  const execution = new AbortController(); const rejected = new AbortController();
  const pending = f.holdContainment();
  f.onLaunch(() => {
    assert.equal(f.live().spawnStatus, "ambiguous");
    assert.throws(() => f.start(custodyRef, rejected.signal), /fingerprint conflict/u);
    assert.equal(getEventListeners(rejected.signal, "abort").length, 0);
    assert.equal(lifetime.signal.aborted, false); assert.equal(f.containmentCalls(), 0);
    execution.abort();
    assert.equal(lifetime.signal.aborted, true); assert.ok(f.live().containment);
    assert.equal(f.containmentCalls(), 0);
    assert.equal(f.live().evidenceSealed, false); assert.equal(f.live().contained, undefined);
    assert.throws(() => f.start(custodyRef), /sealed/u);
  });
  assert.ok(f.start(custodyRef, execution.signal));
  assert.ok(f.core.get(custodyRef)); assert.equal(f.launchCalls(), 1);
  assert.equal(getEventListeners(execution.signal, "abort").length, 0);
  await tick(); assert.equal(f.containmentCalls(), 1);
  pending.resolve({kind: "unproven", evidenceRef: "synthetic:reentrant-cancellation"});
  await f.live().containment;
});

for (const signalKind of ["controller", "composite", "timeout", "pre-aborted-replay"] as const) {
  test(`${signalKind} cancellation preserves native signal semantics and ignores stopped event propagation`, async () => {
    const f = fixture(); const {custodyRef} = await f.reserve();
    const lifetime = f.preparation.acquire(f.handoff(custodyRef));
    const exit = deferred<{code: number | null; signal: null}>(); f.exitWith(exit.promise);
    const execution = new AbortController();
    const signal = signalKind === "composite" ? AbortSignal.any([execution.signal]) :
      signalKind === "timeout" ? AbortSignal.timeout(1) : execution.signal;
    signal.addEventListener("abort", event => event.stopImmediatePropagation(), {once: true});
    const pending = f.holdContainment();
    const first = f.start(custodyRef, signal);
    if (signalKind === "pre-aborted-replay") {
      assert.throws(() => f.start(custodyRef, AbortSignal.abort()), /abort/iu);
      assert.equal(f.live().sdkProcess, first);
    } else if (signalKind === "timeout") {
      await new Promise(resolve => {setTimeout(resolve, 10);});
    } else {execution.abort();}
    assert.equal(lifetime.signal.aborted, true); assert.equal(f.containmentCalls(), 1);
    assert.equal(f.launchCalls(), 1); assert.equal(f.live().evidenceSealed, false);
    pending.resolve({kind: "unproven", evidenceRef: "synthetic:native-signal"});
    await f.live().containment;
    exit.resolve({code: 0, signal: null}); await tick();
    // A pre-aborted replay leaves the unrelated external listener intact.
    assert.equal(getEventListeners(signal, "abort").length, signalKind === "pre-aborted-replay" ? 1 : 0);
  });
}

test("a thrown admitted launch without a returned guardian cannot prove physical no-start", async () => {
  const f = fixture(); const {custodyRef} = await f.reserve();
  const lifetime = f.preparation.acquire(f.handoff(custodyRef));
  f.failLaunch();
  assert.throws(() => f.start(custodyRef));
  assert.equal(lifetime.signal.aborted, true);
  const containment = f.live().containment;
  assert.ok(containment);
  assert.equal((await containment).kind, "unproven");
  const evidence = f.core.evidence(custodyRef)!;
  assert.equal(evidence.sealed, false); assert.equal(f.live().contained, undefined);
  assert.equal(evidence.closure.status, "unproven");
  assert.equal(f.core.get(custodyRef), undefined);
  assert.ok(f.live().residueAuthority);
  assert.ok(f.live().privateRootCleanupAuthority);
  assert.equal(f.closedPrivateRoots(), 0);
  assert.throws(() => f.start(custodyRef), /sealed/u);
});

for (const failure of ["pin-close", "acknowledgement", "return-subscription", "direct-containment"] as const) {
  test(`preparation listener native cleanup preserves containment after ${failure}`, async t => {
    const f = fixture(); const {custodyRef} = await f.reserve();
    const lifetime = f.preparation.acquire(f.handoff(custodyRef));
    const pending = f.holdContainment(); let reads = 0;
    f.onLaunch(() => {
      Object.defineProperty(f.signal.signal, "removeEventListener", {get() {
        reads += 1; throw new Error("caller preparation cleanup getter must not run");
      }});
    });
    const fail = () => {throw new Error(`synthetic ${failure} failure`);};
    if (failure === "pin-close") {f.onPinClose(fail);}
    if (failure === "acknowledgement") {f.onAcknowledgement(fail);}
    if (failure === "return-subscription") {
      const exit = Promise.resolve({code: 0, signal: null});
      t.mock.method(exit, "then", fail); f.exitWith(exit);
    }
    if (failure === "direct-containment") {
      f.start(custodyRef, f.signal.signal);
      void f.core.requestContainment({...f.identity, custodyRef});
    } else {assert.throws(() => f.start(custodyRef, f.signal.signal));}
    const live = f.live();
    assert.equal(reads, 0); assert.equal(lifetime.signal.aborted, true);
    assert.ok(live.containment); assert.equal(f.containmentCalls(), 1); assert.equal(live.sealed, true);
    assert.ok(live.process); assert.ok(live.guardian);
    assert.equal(live.evidenceSealed, false); assert.equal(live.contained, undefined);
    assert.equal(getEventListeners(f.signal.signal, "abort").length, failure === "direct-containment" ? 1 : 0);
    pending.resolve({kind: "unproven", evidenceRef: "synthetic:preparation-listener-cleanup"});
    await live.containment;
    assert.equal(live.evidenceSealed, false); assert.equal(reads, 0);
  });
}
