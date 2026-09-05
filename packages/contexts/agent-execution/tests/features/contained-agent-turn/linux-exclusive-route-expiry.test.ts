import assert from "node:assert/strict";
import test from "node:test";
import { installLinuxExclusiveRoute, type LinuxExclusiveRouteBinding } from
  "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/linux-exclusive-route-owner.js";
import { linuxExclusiveRouteRules } from
  "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/linux-exclusive-route-policy.js";

const endpoint = {address: "172.30.0.1", port: 18443};
const binding: LinuxExclusiveRouteBinding = {
  tenantId: "tenant:test", projectId: "project:test", scopeDigest: "scope:test", operationId: "operation:test",
  attemptId: "attempt:test", custodyId: "custody:test", sourceRevision: "1711995513bf60fbf0c9042b59f6ab8ab1a8f6cb",
  binaryRevision: "@openai/codex:0.150.1+linux-x64", hostBootId: "boot:test", executionGenerationId: "generation:test",
  adapterRevision: "adapter:test", capabilityManifestRevision: "manifest:test", authorityVectorDigest: "authority:test",
  providerAccountRef: "account:test", accessRef: "access:test", bindingRevision: 3, credentialBindingRef: "credential:test",
  providerRouteRef: "route:test", routeRevision: "revision:1", credentialBindingDigest: "pa-opaque-binding:test",
  credentialGeneration: 7,
};

// This fixture models lifecycle and scheduling only; the companion route suite
// independently validates nft listing bytes, command semantics and exclusive create.
const fixture = () => {
  let time = 10; let present = false; let permit = false;
  let transactions = 0; let reads = 0; let removals = 0; let releases = 0;
  const tasks: {delay: number; callback(): void; cancelled: boolean}[] = [];
  const controls = {
    removed: false, clockFailure: false, cancelFailure: false, readFailure: false, mismatch: false,
    transactionFailure: false, acknowledgementLoss: false, scheduleFailure: false, inline: false,
    removeFailure: false, releaseFailure: false, invalidCancellation: false,
    onRead: () => {}, onSchedule: () => {}, onRelease: () => {},
    removal: undefined as Promise<boolean> | undefined,
  };
  const kernel = {
    transact(value: string) {
      transactions += 1;
      if (controls.transactionFailure) {throw new Error("synthetic transaction failure");}
      const commands = JSON.parse(value).nftables;
      assert.equal(commands[0].delete !== undefined, present);
      const candidate = commands.some((command: any) => command.add?.rule);
      if (present) {assert.equal(candidate, false, "subsequent transactions must only deny");}
      present = true; permit = candidate;
      if (controls.acknowledgementLoss) {throw new Error("synthetic acknowledgement loss");}
    },
    readRules() {
      reads += 1; controls.onRead();
      if (controls.readFailure) {throw new Error("synthetic read failure");}
      return {nftables: linuxExclusiveRouteRules(endpoint, controls.mismatch ? !permit : permit)};
    },
    async containerRemoved() {
      removals += 1;
      if (controls.removeFailure) {throw new Error("synthetic removal failure");}
      return controls.removal ?? controls.removed;
    },
    releaseNamespace() {
      releases += 1;
      controls.onRelease();
      if (controls.releaseFailure) {throw new Error("synthetic close failure");}
    },
  };
  const input = {binding, endpoint, lifetimeMs: 1000, kernel,
    monotonicNow: () => {if (controls.clockFailure) {throw new Error("synthetic clock failure");} return time;},
    scheduleCutoff(delay: number, callback: () => void): () => void {
      const task = {delay, callback, cancelled: false}; tasks.push(task);
      controls.onSchedule();
      if (controls.inline) {callback();}
      if (controls.scheduleFailure) {throw new Error("synthetic scheduling failure");}
      if (controls.invalidCancellation) {return undefined as any;}
      return () => {task.cancelled = true; if (controls.cancelFailure) {throw new Error("synthetic cancel failure");}};
    },
  };
  return {controls, input, tasks, open: () => installLinuxExclusiveRoute(input),
    advance: (value: number) => {time = value;}, fire: (index = tasks.length - 1) => {tasks[index]!.callback();},
    counts: () => ({transactions, reads, removals, releases}), permitted: () => permit};
};

test("early timers rearm only the remaining lifetime; old callbacks cannot renew authority", async () => {
  const f = fixture(); const owner = f.open();
  const cutoff = owner.cutoff; assert.ok(Object.isFrozen(owner));
  f.advance(310); f.fire(); assert.equal(f.tasks[1]!.delay, 700);
  f.advance(510); f.fire(0); assert.equal(f.tasks.length, 2);
  f.fire(1); assert.equal(f.tasks[2]!.delay, 500);
  f.advance(1009); const pending = owner.reserveFirstWrite(binding, "request:active");
  f.advance(1010); f.fire();
  assert.equal(await cutoff, "closed"); assert.equal(owner.cutoff, cutoff);
  assert.equal(f.permitted(), false); assert.equal(pending.consume(), false);
  assert.throws(() => owner.reserveFirstWrite(binding, "request:future"));
  const counts = f.counts(); for (let index = 0; index < 3; index += 1) {f.fire(index);}
  assert.deepEqual(f.counts(), counts);
  f.advance(5000); f.controls.removed = true;
  assert.equal(await owner.releaseAfterContainerRemoval(), "closed");
});

test("late timers cut immediately and retain timing uncertainty after successful removal", async () => {
  const f = fixture(); const owner = f.open();
  f.advance(5000); f.fire();
  assert.equal(await owner.cutoff, "quarantined"); assert.equal(f.permitted(), false);
  assert.equal(f.counts().releases, 0); f.controls.removed = true;
  assert.equal(await owner.releaseAfterContainerRemoval(), "quarantined");
  assert.equal(f.counts().releases, 1);
});

test("manual revoke and expiry fence one another, including callbacks after release", async () => {
  for (const timerFirst of [false, true]) {
    const f = fixture(); const owner = f.open();
    const pending = owner.reserveFirstWrite(binding, "request:active");
    if (timerFirst) {f.advance(1010); f.fire();}
    assert.equal(owner.revoke(), "closed"); assert.equal(await owner.cutoff, "closed");
    assert.equal(pending.consume(), false);
    const counts = f.counts(); f.fire(); assert.deepEqual(f.counts(), counts);
    if (!timerFirst) {assert.equal(f.tasks[0]!.cancelled, true);}
    f.controls.removed = true;
    assert.equal(await owner.releaseAfterContainerRemoval(), "closed");
    const released = f.counts(); f.fire(); owner.revoke();
    assert.equal(await owner.releaseAfterContainerRemoval(), "closed");
    assert.deepEqual(f.counts(), released);
  }
});

test("clock regression, nonfinite time and clock failure autonomously quarantine", async () => {
  for (const time of [9, Number.NaN, Number.POSITIVE_INFINITY, 100]) {
    const f = fixture(); const owner = f.open();
    if (time === 100) {f.controls.clockFailure = true;} else {f.advance(time);}
    assert.doesNotThrow(() => f.fire());
    assert.equal(await owner.cutoff, "quarantined"); assert.equal(f.permitted(), false);
    f.controls.clockFailure = false; f.advance(10); f.controls.removed = true;
    assert.equal(await owner.releaseAfterContainerRemoval(), "quarantined");
  }
  const f = fixture(); const owner = f.open();
  f.advance(300); owner.reserveFirstWrite(binding, "request:high-water");
  f.advance(200); f.fire(); assert.equal(await owner.cutoff, "quarantined");
});

test("timer readback, transaction and cancellation failures are sticky despite later cleanup", async () => {
  for (const failure of ["readFailure", "mismatch", "transactionFailure", "acknowledgementLoss", "cancelFailure"] as const) {
    const f = fixture(); const owner = f.open(); f.controls[failure] = true;
    if (failure === "cancelFailure") {owner.revoke();} else {f.advance(1010); f.fire();}
    assert.equal(await owner.cutoff, "quarantined");
    assert.throws(() => owner.reserveFirstWrite(binding, "request:after-failure"));
    f.controls[failure] = false;
    assert.equal(owner.revoke(), "quarantined"); assert.equal(f.permitted(), false);
    f.controls.removed = true;
    assert.equal(await owner.releaseAfterContainerRemoval(), "quarantined");
    assert.equal(f.counts().releases, 1);
  }
});

test("installation and scheduling failures deny without publishing authority or releasing custody", () => {
  for (const failure of ["scheduleFailure", "invalidCancellation", "inline", "readFailure", "mismatch", "acknowledgementLoss"] as const) {
    const f = fixture(); f.controls[failure] = true;
    assert.throws(f.open);
    assert.equal(f.permitted(), false); assert.equal(f.counts().releases, 0);
    const counts = f.counts(); f.tasks.forEach(task => task.callback());
    assert.deepEqual(f.counts(), counts);
  }
  const f = fixture();
  assert.throws(() => installLinuxExclusiveRoute({...f.input, scheduleCutoff: undefined} as any), /scheduler required/u);
  assert.equal(f.counts().transactions, 0);
});

test("a failed rearm cuts instead of silently abandoning an early timer", async () => {
  const f = fixture(); const owner = f.open();
  f.advance(310); f.controls.scheduleFailure = true; f.fire();
  assert.equal(await owner.cutoff, "quarantined"); assert.equal(f.permitted(), false);
  const counts = f.counts(); f.fire(); assert.deepEqual(f.counts(), counts);
});

test("time spent rearming and regression after observing expiry cannot escape cutoff", async () => {
  const delayed = fixture(); const first = delayed.open(); delayed.advance(310);
  delayed.controls.onSchedule = () => {delayed.advance(1011);}; delayed.fire();
  assert.equal(await first.cutoff, "quarantined"); assert.equal(delayed.permitted(), false);
  assert.equal(delayed.tasks[1]!.cancelled, true);
  const regressed = fixture(); const second = regressed.open(); regressed.advance(1010);
  regressed.controls.onRead = () => {regressed.advance(900);}; regressed.fire();
  assert.equal(await second.cutoff, "quarantined"); assert.equal(regressed.permitted(), false);
});

test("blocking installation and scheduling consume the original lifetime", () => {
  const f = fixture(); f.controls.onRead = () => {f.advance(310);};
  const owner = f.open(); assert.equal(f.tasks[0]!.delay, 700); owner.revoke();
  for (const stage of ["onRead", "onSchedule"] as const) {
    const delayed = fixture(); delayed.controls[stage] = () => {delayed.advance(1010);};
    assert.throws(delayed.open, /expired/u); assert.equal(delayed.permitted(), false);
    assert.equal(delayed.counts().releases, 0);
    const counts = delayed.counts(); delayed.tasks.forEach(task => task.callback());
    assert.deepEqual(delayed.counts(), counts);
  }
});

test("first-write must recheck time after blocking kernel inspection even if timer cannot run", async () => {
  for (const time of [9, 1010, 2000]) {
    const f = fixture(); const owner = f.open();
    const first = owner.reserveFirstWrite(binding, "request:first");
    const queued = owner.reserveFirstWrite(binding, "request:queued");
    f.controls.onRead = () => {f.advance(time);};
    assert.equal(first.consume(), false); assert.equal(queued.consume(), false);
    assert.equal(await owner.cutoff, time === 1010 ? "closed" : "quarantined");
    assert.equal(f.permitted(), false);
  }
});

test("cutoff during a first-write inspection cannot be bypassed by its pending return", async () => {
  const f = fixture(); const owner = f.open();
  const ticket = owner.reserveFirstWrite(binding, "request:inspection");
  f.controls.onRead = () => {f.controls.onRead = () => {}; owner.revoke();};
  assert.equal(ticket.consume(), false); assert.equal(f.permitted(), false);
  assert.equal(await owner.cutoff, "closed");
  assert.equal(owner.revoke(), "quarantined"); // the outer permit inspection also saw the deny policy
});

test("delayed removal never delays cutoff or releases namespace custody early", async () => {
  const f = fixture(); const owner = f.open();
  const removal = Promise.withResolvers<boolean>(); f.controls.removal = removal.promise;
  const first = owner.releaseAfterContainerRemoval();
  assert.equal(owner.releaseAfterContainerRemoval(), first);
  assert.equal(await owner.cutoff, "closed"); assert.equal(f.permitted(), false);
  assert.equal(f.counts().releases, 0);
  const counts = f.counts(); f.advance(2000); f.fire(); assert.deepEqual(f.counts(), counts);
  removal.resolve(false); assert.equal(await first, "quarantined");
  assert.equal(f.counts().releases, 0);
  f.controls.removal = undefined; f.controls.removed = true;
  assert.equal(await owner.releaseAfterContainerRemoval(), "quarantined");
  assert.equal(f.counts().releases, 1);
  assert.equal(await owner.cutoff, "closed"); // immutable earlier observation, not a terminal receipt
});

test("unknown removal and failed namespace close never erase cutoff quarantine", async () => {
  for (const failure of ["removeFailure", "releaseFailure"] as const) {
    const f = fixture(); const owner = f.open(); f.advance(2000); f.fire();
    f.controls[failure] = true; f.controls.removed = true;
    assert.equal(await owner.releaseAfterContainerRemoval(), "quarantined");
    assert.equal(f.counts().releases, failure === "removeFailure" ? 0 : 1);
    f.controls[failure] = false;
    assert.equal(await owner.releaseAfterContainerRemoval(), "quarantined");
  }
});

test("kernel I/O is fenced before descriptor release begins, including failed release", async () => {
  for (const releaseFailure of [false, true]) {
    const f = fixture(); const owner = f.open();
    const pending = owner.reserveFirstWrite(binding, "request:pending-release");
    f.controls.removed = true; f.controls.releaseFailure = releaseFailure;
    let before: ReturnType<typeof f.counts> | undefined;
    f.controls.onRelease = () => {before = f.counts(); owner.revoke(); f.fire();};
    const result = releaseFailure ? "quarantined" : "closed";
    assert.equal(await owner.releaseAfterContainerRemoval(), result);
    assert.deepEqual(f.counts(), before);
    assert.equal(pending.consume(), false);
    assert.equal(owner.revoke(), result);
    assert.equal(await owner.releaseAfterContainerRemoval(), result);
    f.fire();
    assert.deepEqual(f.counts(), before);
    assert.throws(() => owner.reserveFirstWrite(binding, "request:after-release"));
  }
});
