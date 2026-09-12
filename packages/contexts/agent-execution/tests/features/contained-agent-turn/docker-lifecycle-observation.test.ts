import assert from "node:assert/strict";
import test from "node:test";
import {createDockerProviderProcessLaunchIssuer} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-lifecycle-issued-launch.js";
import {claimDockerProviderProcessLaunch, dockerProviderProcessMountFacts} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";
import type {DockerContainerAuthority, DockerContainerObservation, DockerContainerStateFacts} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-port.js";
import {DockerCustodyJournal} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/docker-custody-journal.js";
import {DockerCustodyJournalUnavailableError} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/docker-custody-journal-types.js";
import {fixture, engineCall, initOptions, providerExec, deferred, tick, createInput, owner, digest} from "./support/docker-lifecycle-observation-fixture.ts";

const assertFrozen = (value: unknown): void => {
  if (value === null || typeof value !== "object") {return;}
  assert.equal(Object.isFrozen(value), true); Object.values(value).forEach(assertFrozen);
};

test("retains the exact terminal Engine observation before removal destroys state", async t => {
  const f = await fixture(t);
  const before = f.read(); assert.equal(before.terminal, null);
  assert.equal(before.initial.state.running, true); assert.ok(before.initial.state.hostPid > 0);
  await f.engine.kill(f.launched.authority, engineCall());
  const actual = await f.engine.inspect(f.launched.authority, engineCall());
  f.controls.onRemove = async () => {assert.deepEqual(f.read().terminal?.observation, actual);};
  assert.equal((await f.contain()).kind, "closed");
  assert.equal((await f.engine.inspect(f.launched.authority, engineCall())).existence, "absent");
  assert.deepEqual(f.read().terminal?.observation, actual);
  assert.equal(f.read().attachCleanup, "complete");
  assert.equal(f.read().terminal?.journal.state, "contain_requested");
  assert.equal(f.read().recursiveEmpty?.journal.state, "contain_requested");
  assert.equal(f.read().removal?.journal.state, "remove_requested");
  assert.deepEqual(f.read().journal, await new DockerCustodyJournal(f.storage).lookup(f.launched.key));
  assert.equal(before.journal.state, "init_ready"); assert.equal(before.terminal, null);
  assertFrozen(f.read());
});

test("observations require the same issued launch and preserve independent one-use IO rights", async t => {
  const f = await fixture(t);
  assert.throws(() => f.lifecycle.observeLaunch({...f.launched}), /actual issued launch/);
  assert.throws(() => f.lifecycle.observeLaunch(Object.create(f.launched)), /actual issued launch/);
  assert.throws(() => f.restart().observeLaunch(f.launched), /actual issued launch/);
  const mount = dockerProviderProcessMountFacts(f.launched); f.read();
  const claimed = claimDockerProviderProcessLaunch(f.launched);
  assert.deepEqual(claimed.mountFacts, mount); f.read();
  assert.throws(() => claimDockerProviderProcessLaunch(f.launched));
  await f.contain(); assert.ok(f.read().terminal);
});

test("provider root exit, drain and EOF alone never supply Engine finality", async t => {
  const f = await fixture(t); const claimed = claimDockerProviderProcessLaunch(f.launched);
  const session = claimed.openInitSession(initOptions()); await session.ready();
  await claimed.execute(providerExec, engineCall()); f.tail();
  const completion = await session.completion; assert.equal(completion.kind, "closed");
  if (completion.kind === "closed") {assert.equal(completion.rootExit.exitCode, 17);}
  assert.equal(f.read().terminal, null); assert.equal(f.read().removal, null); assert.equal(f.read().recursiveEmpty, null);
  assert.equal((await f.contain()).kind, "closed");
  assert.equal(f.read().terminal?.observation.state.exitCode, 0); assert.equal(f.controls.readers, 1);
});

test("unacknowledged provider execution remains unproved independently of later Docker termination", async t => {
  const f = await fixture(t); f.controls.acknowledge = false;
  const session = f.launched.openInitSession({...initOptions(), acknowledgementTimeoutMs: 200}); await session.ready();
  const executed = await f.lifecycle.executeProvider({...f.launched, call: engineCall(), exec: providerExec});
  assert.equal(executed.evidence.status, "unproven"); assert.equal(f.read().terminal, null);
  await f.contain(); assert.ok(f.read().terminal);
  assert.equal((await new DockerCustodyJournal(f.storage).recover())[0]?.providerExecution, "may_have_executed");
});

for (const field of ["containerId", "daemonIdentitySha256", "daemonBootGenerationSha256", "hostIdentitySha256",
  "hostBootGenerationSha256", "createSpecificationSha256", "imageDigest", "launchFingerprintSha256",
  "operationNonceSha256", "ownerIdentitySha256"] satisfies (keyof DockerContainerAuthority)[]) {
  test(`wrong requested ${field} cannot affect or prove the issued launch`, async t => {
    const f = await fixture(t); const authority = {...f.launched.authority, [field]: digest("wrong")};
    const result = await f.lifecycle.contain({...f.launched, authority, call: engineCall()}).catch(() => null);
    assert.notEqual(result?.kind, "closed"); assert.equal(f.read().terminal, null);
    assert.equal(f.engine.events.includes("stop:id"), false); await f.contain();
  });
}

test("a key with the same nonce but a different owner cannot obtain proof", async t => {
  const f = await fixture(t);
  await assert.rejects(f.lifecycle.contain({...f.launched, key: {...f.launched.key, hostInstanceId: "host:wrong"}, call: engineCall()}));
  assert.equal(f.read().terminal, null); assert.equal(f.read().recursiveEmpty, null); await f.contain();
});

for (const fault of ["daemonIdentitySha256", "daemonBootGenerationSha256", "hostIdentitySha256", "hostBootGenerationSha256", "container", "specification"] as const) {
  test(`wrong returned Engine ${fault} prevents terminal and physical proof`, async t => {
    const f = await fixture(t); const inspect = f.engine.inspect.bind(f.engine);
    await f.engine.kill(f.launched.authority, engineCall());
    f.engine.inspect = async (...args) => {
      const observed = await inspect(...args);
      return fault === "container" || fault === "specification"
        ? {...observed, authority: {...observed.authority, [fault === "container" ? "containerId" : "createSpecificationSha256"]: digest("wrong")}}
        : {...observed, engine: {...observed.engine, [fault]: digest("wrong")}};
    };
    assert.equal((await f.contain()).kind, "indeterminate");
    assert.equal(f.read().terminal, null); assert.equal(f.read().recursiveEmpty, null); assert.equal(f.read().removal, null);
    f.engine.inspect = inspect; await f.contain();
  });
}

const invalidStates: ReadonlyArray<Partial<DockerContainerStateFacts>> = [
  {startedAt: ""}, {finishedAt: ""}, {finishedAt: "0001-01-01T00:00:00Z"}, {finishedAt: "yesterday"},
  {startedAt: "2026-02-30T00:00:00Z"}, {finishedAt: "2025-12-31T23:59:59Z"},
  {startedAt: "2026-01-01T00:00:01.000000002Z", finishedAt: "2026-01-01T00:00:01.000000001Z"},
  {exitCode: Number.NaN}, {status: "created"}, {paused: true}, {restarting: true}, {hostPid: 12},
];
for (const [index, state] of invalidStates.entries()) {
  test(`invalid terminal facts ${index} remain unobserved even if physical journal closure succeeds`, async t => {
    const f = await fixture(t); const inspect = f.engine.inspect.bind(f.engine);
    await f.engine.kill(f.launched.authority, engineCall());
    f.engine.inspect = async (...args) => {
      const observation = await inspect(...args);
      return observation.existence === "present" ? {...observation, state: {...observation.state, ...state}} : observation;
    };
    await f.contain(); assert.equal(f.read().terminal, null);
    f.engine.inspect = inspect; await f.contain();
  });
}

test("retention copies exact Docker fields and nanoseconds without inventing Node process facts", async t => {
  const f = await fixture(t); const inspect = f.engine.inspect.bind(f.engine);
  await f.engine.kill(f.launched.authority, engineCall()); let response: DockerContainerObservation | undefined;
  f.engine.inspect = async (...args) => {
    const observation = await inspect(...args);
    response = observation.existence === "present" ? {...observation, state: {...observation.state,
      startedAt: "2026-01-01T00:00:00.123456789Z", finishedAt: "2026-01-01T00:00:01.987654321Z",
      exitCode: 23, dead: true, status: "dead", oomKilled: true, errorPresent: true}} : observation;
    return response;
  };
  f.controls.onRemove = async () => {
    assert.deepEqual(f.read().terminal?.observation, response);
    if (response?.existence === "present") {Object.assign(response.state, {exitCode: 42});}
  };
  await f.contain(); const state = f.read().terminal?.observation.state; assert.ok(state);
  assert.equal(state.exitCode, 23); assert.equal(state.dead, true); assert.equal(state.oomKilled, true); assert.equal(state.errorPresent, true);
  assert.equal(state.finishedAt, "2026-01-01T00:00:01.987654321Z"); assert.equal("signal" in state, false); assert.equal("guardianPid" in state, false);
});

test("unknown stop and kill acknowledgements cannot become finality while Docker still runs", async t => {
  const f = await fixture(t);
  for (const operation of ["stop", "kill"] as const) {f.engine.enqueueMutationOutcome(operation, {acknowledgement: "lost", effect: "not-applied"});}
  assert.equal((await f.contain()).kind, "indeterminate");
  assert.equal(f.read().terminal, null); assert.equal(f.read().recursiveEmpty, null); assert.equal(f.read().removal, null);
  assert.equal(f.read().attachCleanup, "complete"); await f.contain(); assert.ok(f.read().terminal);
});

for (const effect of ["applied", "not-applied"] as const) {
  test(`lost removal acknowledgement with effect ${effect} requires exact observed absence`, async t => {
    const f = await fixture(t); f.engine.enqueueMutationOutcome("remove", {acknowledgement: "lost", effect});
    assert.equal((await f.contain()).kind, effect === "applied" ? "closed" : "indeterminate");
    const historical = f.read().terminal; assert.ok(historical);
    assert.equal(f.read().removal === null, effect === "not-applied");
    await f.contain(); assert.strictEqual(f.read().terminal, historical); assert.ok(f.read().removal);
  });
}

test("an unavailable post-remove observation stays unproved until same-owner recovery sees exact absence", async t => {
  const f = await fixture(t); const remove = f.engine.remove.bind(f.engine);
  f.engine.remove = async (...args) => {await remove(...args); f.engine.setDisconnected(true);};
  assert.equal((await f.contain()).kind, "indeterminate");
  const historical = f.read().terminal; assert.ok(historical); assert.equal(f.read().removal, null);
  f.engine.setDisconnected(false); assert.equal((await f.lifecycle.recover(f.resolver))[0]?.kind, "closed");
  assert.strictEqual(f.read().terminal, historical); assert.ok(f.read().removal);
});

for (const generation of ["daemon", "host"] as const) {
  for (const phase of ["before-contain", "after-stop", "before-remove"] as const) {
    test(`${generation} generation drift ${phase} cannot create fresh proof`, async t => {
      const f = await fixture(t);
      const drift = () => generation === "daemon" ? f.engine.restartDaemon("new") : f.engine.restartHost("new");
      if (phase === "before-contain") {drift();}
      if (phase === "after-stop") {f.controls.onStopped = drift;}
      if (phase === "before-remove") {f.controls.onRemove = async () => {drift();};}
      assert.equal((await f.contain()).kind, "indeterminate");
      assert.equal(f.read().terminal === null, phase !== "before-remove"); assert.equal(f.read().removal, null);
      if (phase !== "before-remove") {assert.equal(f.read().recursiveEmpty, null);}
    });
  }
}

test("repeat and concurrent containment retain one immutable terminal record and one reader", async t => {
  const f = await fixture(t); const gate = deferred(); const entered = deferred(); t.after(() => gate.resolve());
  const session = f.launched.openInitSession(initOptions()); await session.ready();
  await f.lifecycle.executeProvider({...f.launched, call: engineCall(), exec: providerExec});
  f.controls.onStop = async () => {entered.resolve(); await gate.promise; f.tail();};
  const first = f.contain(); await entered.promise; const second = f.contain(); gate.resolve();
  assert.equal((await first).kind, "closed"); assert.equal((await second).kind, "closed");
  const historical = f.read().terminal; await f.contain(); assert.strictEqual(f.read().terminal, historical);
  const inspect = f.engine.inspect.bind(f.engine); let queries = 0;
  f.engine.inspect = (...args) => {queries += 1; return inspect(...args);};
  f.read(); f.read(); assert.equal(queries, 0);
  assert.equal(f.controls.readers, 1); assert.equal(f.controls.returns, 1); assert.equal(f.controls.closes, 1);
});

for (const cleanup of ["iterator", "channel", "rejection"] as const) {
  test(`actual ${cleanup} cleanup debt remains separate from closed journal and blocks capacity/retirement`, async t => {
    const f = await fixture(t); const gate = deferred(); t.after(() => gate.resolve());
    if (cleanup === "iterator") {f.controls.returnGate = gate.promise;}
    if (cleanup === "channel") {f.controls.closeGate = gate.promise;}
    f.controls.rejectClose = cleanup === "rejection";
    const session = f.launched.openInitSession(initOptions()); await session.ready();
    await f.lifecycle.executeProvider({...f.launched, call: engineCall(), exec: providerExec}); f.controls.onStop = async () => {f.tail();};
    const contained = await f.lifecycle.contain({...f.launched, call: {...engineCall(), deadlineEpochMs: Date.now() + 300}});
    assert.equal(contained.kind, "indeterminate"); const snapshot = f.read();
    assert.equal(snapshot.journal.state, "closed"); assert.equal(snapshot.attachCleanup, "pending"); assert.ok(snapshot.terminal);
    await assert.rejects(f.lifecycle.retire({key: f.launched.key, expectedChecksumSha256: snapshot.journal.checksumSha256}));
    await assert.rejects(f.lifecycle.launch({call: engineCall(), create: createInput(f.root, digest("next")), owner: {...owner, attemptId: "attempt:next"}}), /capacity/);
    gate.resolve(); await tick(); await f.contain();
    assert.equal(f.read().attachCleanup, cleanup === "rejection" ? "pending" : "complete"); assert.equal(snapshot.attachCleanup, "pending");
  });
}

test("retired evidence remains readable without replay, cross-owner adoption or retained live capacity", async t => {
  const f = await fixture(t); await f.contain(); const historical = f.read().terminal;
  await f.lifecycle.retire({key: f.launched.key, expectedChecksumSha256: f.read().journal.checksumSha256});
  assert.equal(f.read().retired, true); assert.strictEqual(f.read().terminal, historical);
  assert.throws(() => claimDockerProviderProcessLaunch(f.launched));
  await assert.rejects(f.launch(), /retired/);
  await assert.rejects(f.restart().launch({call: engineCall(), create: createInput(f.root), owner: {...owner, attemptId: "attempt:adopt"}}), /retired/);
  await assert.rejects(f.restart().launch({call: engineCall(), create: createInput(f.root), owner}), /retired/);
  assert.equal(f.engine.events.filter(event => event.startsWith("create:")).length, 1);
  for (let index = 0; index < 4; index += 1) {
    const next = await f.lifecycle.launch({call: engineCall(), create: createInput(f.root, digest(`next:${index}`)), owner: {...owner, attemptId: `attempt:${index}`}});
    assert.equal(f.lifecycle.observeLaunch(next).terminal, null);
    await f.lifecycle.contain({...next, call: engineCall()}); const snapshot = f.lifecycle.observeLaunch(next);
    await f.lifecycle.retire({key: next.key, expectedChecksumSha256: snapshot.journal.checksumSha256});
  }
  assert.strictEqual(f.read().terminal, historical);
});

test("restart recovery can contain exact absence but cannot recreate volatile execution observations", async t => {
  const f = await fixture(t); await f.engine.stop(f.launched.authority, engineCall()); await f.engine.remove(f.launched.authority, engineCall());
  assert.equal(f.read().terminal, null); const restarted = f.restart();
  assert.equal((await restarted.recover(f.resolver))[0]?.kind, "closed");
  assert.throws(() => restarted.observeLaunch(f.launched), /actual issued launch/);
  assert.equal(f.read().terminal, null); await f.contain(); assert.equal(f.read().terminal, null);
});

test("a retirement tombstone fences even a coexisting prepared journal before launch effects", async t => {
  const f = await fixture(t); await f.contain();
  await f.lifecycle.retire({key: f.launched.key, expectedChecksumSha256: f.read().journal.checksumSha256});
  // The base raw journal API can recreate this memory entry; lifecycle admission must still refuse it.
  await new DockerCustodyJournal(f.storage).prepare(f.launched.key);
  await assert.rejects(f.restart().launch({call: engineCall(), create: createInput(f.root), owner}), /retired/);
  assert.equal(f.engine.events.filter(event => event.startsWith("create:")).length, 1);
});

test("same-owner recovery automatically records observed Engine terminal facts", async t => {
  const f = await fixture(t); assert.equal((await f.lifecycle.recover(f.resolver))[0]?.kind, "closed");
  assert.ok(f.read().terminal); assert.ok(f.read().recursiveEmpty); assert.ok(f.read().removal); assert.equal(f.read().attachCleanup, "complete");
});

test("journal loss retains exact last journal binding without manufacturing a closed journal", async t => {
  const f = await fixture(t); f.storage.open = async () => {throw new DockerCustodyJournalUnavailableError();};
  const result = await f.contain(); assert.equal(result.kind, "indeterminate");
  assert.equal(f.read().journal.state, "init_ready"); assert.equal(f.read().terminal?.journal.checksumSha256, f.launched.journal.checksumSha256);
  assert.ok(f.read().recursiveEmpty); assert.ok(f.read().removal); assert.equal(f.read().attachCleanup, "complete");
});

test("an independently constructed issuer cannot mint or reopen the lifecycle bridge capability", async t => {
  const f = await fixture(t); const actualProcess = claimDockerProviderProcessLaunch(f.launched);
  const outsider = createDockerProviderProcessLaunchIssuer(); const copy = {...f.launched};
  outsider.issue(copy, actualProcess, () => {});
  outsider.issue(f.launched, actualProcess, () => {});
  assert.throws(() => claimDockerProviderProcessLaunch(copy), /unused actual lifecycle launch/);
  assert.throws(() => claimDockerProviderProcessLaunch(f.launched), /unused actual lifecycle launch/);
  assert.throws(() => dockerProviderProcessMountFacts(copy), /unused actual launch/);
  const before = f.wire.filter(message => message.kind === "provider-exec").length;
  await f.contain(); const record = f.read().journal;
  await f.lifecycle.retire({key: f.launched.key, expectedChecksumSha256: record.checksumSha256});
  assert.throws(() => claimDockerProviderProcessLaunch(copy), /unused actual lifecycle launch/);
  assert.equal(f.wire.filter(message => message.kind === "provider-exec").length, before);
});

test("a consumed issuer capability cannot be reissued or shared with a second issuer", async t => {
  const f = await fixture(t); const process = claimDockerProviderProcessLaunch(f.launched);
  const issuer = createDockerProviderProcessLaunchIssuer(); const other = createDockerProviderProcessLaunchIssuer();
  const copy = {...f.launched}; issuer.issue(copy, process, () => {});
  assert.throws(() => issuer.issue(copy, process, () => {}), /cannot be reissued/);
  assert.throws(() => other.claim(copy), /unused actual lifecycle launch/);
  assert.equal(issuer.claim(copy), process);
  assert.throws(() => issuer.issue(copy, process, () => {}), /cannot be reissued/);
  assert.throws(() => issuer.claim(copy), /unused actual lifecycle launch/);
  await f.contain();
});
