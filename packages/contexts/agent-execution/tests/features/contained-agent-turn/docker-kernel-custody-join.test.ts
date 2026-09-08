import {rm} from "node:fs/promises";
import {reserveWorkspace} from "./support/docker-workspace-authority-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {DockerKernelHostCustody} from "../../../dist/features/contained-agent-turn/composition/docker-kernel-host-custody.js";
import {prepareDockerProviderProcessIo, createDockerProviderProcessBridge} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-bridge.js";
import {executionEvidenceIsClosed, physicalEvidenceIsClosed, noStartEvidenceIsClosed, observeHostStart}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-projections.js";
import {fixture, tick, deferred} from "./support/docker-provider-process-fixture.ts";
import {residueFixture} from "./support/linux-docker-residue-fixture.ts";
import {initOptions, installSyntheticInit} from "./support/docker-claim-init-fixture.ts";
import {engineCall, disposable, createInput} from "./support/docker-host-custody-lifecycle-fixture.ts";
import type {HostCustodyReservationInput} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";

const reservation = (launch: Awaited<ReturnType<ReturnType<typeof fixture>["launch"]>>["launched"],
  workspaceRef: string, privateRootPath: string): Omit<HostCustodyReservationInput, "workspaceAuthority"> => ({
  operationId: launch.key.operationId, attemptId: launch.key.attemptId, intentMode: "analysis", workspaceRef,
  providerBinding: {provider: "codex", binaryRevision: "synthetic", adapterRevision: "synthetic",
    capabilityManifestRevision: "synthetic", credentialBindingDigest: "synthetic", providerRouteRef: "synthetic"},
  launchPlan: {arguments: [], binaryRevision: "synthetic", containmentProfile: "strict-linux-cgroup-v2",
    environment: {}, executablePath: "/synthetic/provider", executableSha256: "a".repeat(64), privateRootPath,
    intentMode: "analysis", provider: "codex", spawnMode: "sdk-delegated"},
});
const joined = async (t: import("node:test").TestContext) => {
  const directory = await disposable();
  t.after(() => rm(directory, {recursive: true, force: true}));
  const f = fixture(); f.launchInput.create = createInput(directory);
  const a = await f.launch();
  const raw = new DockerKernelHostCustody(1000);
  const input = reservation(a.launched, f.launchInput.create.workspaceSource, f.launchInput.create.privateRootSource);
  const handle = await reserveWorkspace(t, raw, input); const retained = raw.reservation(handle.custodyRef);
  const io = prepareDockerProviderProcessIo(a.input); retained.evidence.attach(f.lifecycle, a.launched, io);
  const containment = {...handle, operationId: input.operationId, attemptId: input.attemptId};
  let cleanups = 0;
  raw.installCleanup(handle.custodyRef, {cutoff() {}, async cleanup() {
    cleanups += 1; return {kind: (await a.contain()).kind === "closed" ? "released" : "quarantined"};
  }});
  return {...f, ...a, raw, io, retained, containment, cleanups: () => cleanups,
    read: () => raw.evidence(handle.custodyRef)!};
};

for (const delay of ["ack", "root-exit", "drain", "channel-eof"] as const) {
  test(`joined evidence independently waits for ${delay}; self-reported init never proves kernel start`, {skip: process.platform !== "linux"}, async t => {
    const f = await joined(t); t.after(() => f.contain());
    const gate = deferred(); const entered = deferred(); t.after(() => gate.resolve());
    f.channel.onMessage = async message => {
      if (message.kind === "provider-exec" && delay === "ack") {entered.resolve(); await gate.promise;}
      f.channel.respond(message);
    };
    const opening = createDockerProviderProcessBridge().open({...f.input, preparedIo: f.io});
    if (delay === "ack") {
      await entered.promise; assert.equal(f.read().spawn, "ambiguous"); gate.resolve();
    }
    const process = await opening;
    const drains = Promise.allSettled([Array.fromAsync(process.stdout), Array.fromAsync(process.stderr)]);
    assert.equal(f.read().spawn, "acknowledged");
    assert.equal(f.read().identity.status, "unproven");
    assert.equal("pid" in f.read().identity, false); assert.equal("pgid" in f.read().identity, false);
    assert.equal(f.io.observation.supervisorFinality, "unproven");
    const before = f.read();
    f.channel.outputBytes("stdout", "before root exit"); await tick();
    if (delay === "root-exit") {assert.equal(f.read().providerExit.status, "unobserved");}
    f.channel.rootExit(17); await tick();
    assert.deepEqual(f.read().providerExit, {status: "observed", code: 17, signal: null});
    f.channel.outputBytes("stderr", "stop tail"); await tick();
    assert.equal(f.read().stderr.bytes, 9); assert.equal(f.read().stdout.status, "incomplete");
    if (delay === "channel-eof") {
      f.channel.push({kind: "provider-drain-complete", requestId: f.input.exec.requestId,
        rootExit: "observed", stdout: "eof", stderr: "eof", outerContainmentClaim: "unproven"});
      await tick(); assert.equal(f.read().stdout.status, "incomplete"); f.channel.end();
    } else {f.channel.drain();}
    await f.io.completion; await process.waitForExit(); await drains;
    assert.equal(executionEvidenceIsClosed(f.read()), false);
    assert.equal(noStartEvidenceIsClosed(f.read()), false);
    // Missing native mapping is independent of successful ack and output EOF.
    assert.equal(f.io.observation.providerInstance.status, "missing");
    assert.equal(before.stdout.bytes, 0); assert.ok(Object.isFrozen(before.stdout));
    const observation = await observeHostStart({contain: async () => {}, creatorCalled: () => true, cutoff: () => false,
      evidence: f.read, executionSettled: () => true, monotonicNow: (() => {let now = 0; return () => ++now;})(),
      reservation: {attemptId: f.input.launch.key.attemptId, custodyId: "custody:synthetic", operationId: f.input.launch.key.operationId} as never,
      timeoutMs: 1});
    assert.equal(observation.kind, "indeterminate");
    assert.equal(f.channel.readers, 1);
    assert.equal(f.channel.messages.filter(m => m.kind === "provider-exec").length, 1);
  });
}

test("execution acknowledgement survives later containment journal transitions; generic empty callback is insufficient", {skip: process.platform !== "linux"}, async t => {
  const f = await joined(t); t.after(() => f.contain());
  await createDockerProviderProcessBridge().open({...f.input, preparedIo: f.io});
  const execution = f.lifecycle.observeLaunch(f.launched).execution;
  assert.equal(execution?.result?.kind, "started"); assert.equal(execution?.journal?.state, "provider_exec_observed");
  f.channel.rootExit(17); f.channel.drain(); await f.io.completion;
  const first = f.raw.requestContainment(f.containment); const second = f.raw.requestContainment(f.containment);
  assert.strictEqual(first, second); assert.equal((await first).kind, "unproven");
  assert.equal(f.lifecycle.observeLaunch(f.launched).journal.state, "closed");
  assert.strictEqual(f.lifecycle.observeLaunch(f.launched).execution, execution);
  assert.equal(f.read().spawn, "acknowledged"); assert.equal(physicalEvidenceIsClosed(f.read()), false);
  assert.equal(f.read().privateRoot.status, "unproven");
  assert.equal((await f.raw.release({...f.containment, receiptRef: "forged"})).kind, "unproven");
  await f.raw.requestContainment(f.containment); assert.equal(f.cleanups(), 1);
});

test("foreign launches and copied prepared IO cannot supply a reservation's evidence", {skip: process.platform !== "linux"}, async t => {
  const f = await joined(t); const other = await joined(t); t.after(() => f.contain()); t.after(() => other.contain());
  const fresh = new DockerKernelHostCustody(1000);
  const input = {...reservation(f.launched, f.launchInput.create.workspaceSource, f.launchInput.create.privateRootSource), operationId: "operation:foreign"};
  const handle = await reserveWorkspace(t, fresh, input);
  const evidence = fresh.reservation(handle.custodyRef).evidence;
  assert.throws(() => evidence.attach(f.lifecycle, f.launched, {...f.io}), /actual prepared/);
  assert.throws(() => evidence.attach(f.lifecycle, f.launched, other.io), /actual prepared/);
  assert.throws(() => evidence.attach(f.lifecycle, f.launched, f.io), /reservation conflicts/);
});

for (const failure of ["init-crash", "late-output"] as const) {
  test(`${failure} retains observed provider exit without inventing drain or container exit`, {skip: process.platform !== "linux"}, async t => {
    const f = await joined(t); t.after(() => f.contain());
    const process = await createDockerProviderProcessBridge().open({...f.input, preparedIo: f.io});
    const exit = process.waitForExit().catch(() => null);
    f.channel.rootExit(31); await tick();
    if (failure === "late-output") {
      f.channel.push({kind: "provider-drain-complete", requestId: f.input.exec.requestId, rootExit: "observed",
        stdout: "eof", stderr: "eof", outerContainmentClaim: "unproven"});
      f.channel.outputBytes("stdout", "invalid post-drain output");
    }
    f.channel.end(); await f.io.completion; await exit;
    assert.deepEqual(f.read().providerExit, {status: "observed", code: 31, signal: null});
    assert.equal(f.read().stdout.status, "incomplete"); assert.equal(f.read().stderr.status, "incomplete");
    assert.equal(f.read().guardianExit.status, "unobserved"); assert.equal(executionEvidenceIsClosed(f.read()), false);
  });
}

for (const residue of [false, true]) {
  test(`concrete Linux owner supplies physical predicate independently of execution and private root: residue=${residue}`, {skip: process.platform !== "linux"}, async t => {
    const f = await residueFixture(t); installSyntheticInit(f.fake);
    const launched = await f.launch(); const raw = new DockerKernelHostCustody(1000);
    const create = (await import("./support/docker-host-custody-lifecycle-fixture.ts")).createInput(f.root);
    const input = reservation(launched, create.workspaceSource, create.privateRootSource);
    const handle = await reserveWorkspace(t, raw, input); const retained = raw.reservation(handle.custodyRef);
    const init = initOptions(); const io = prepareDockerProviderProcessIo({launch: launched, init,
      expected: {authority: launched.authority, custodyRef: launched.key.custodyId,
        workspaceAuthorityPath: create.workspaceSource, generation: init.authority.generation}});
    retained.evidence.attach(f.lifecycle, launched, io); await io.ready();
    f.controls.descendants = residue;
    raw.installCleanup(handle.custodyRef, {cutoff() {}, async cleanup() {
      return {kind: (await f.contain(launched)).kind === "closed" ? "released" : "quarantined"};
    }});
    const bound = {...handle, operationId: input.operationId, attemptId: input.attemptId};
    const result = await raw.requestContainment(bound);
    assert.equal(result.kind, residue ? "unproven" : "contained");
    assert.equal(physicalEvidenceIsClosed(raw.evidence(handle.custodyRef)!), !residue);
    assert.equal(executionEvidenceIsClosed(raw.evidence(handle.custodyRef)!), false);
    assert.equal(raw.evidence(handle.custodyRef)!.privateRoot.status, "unproven");
    if (result.kind === "contained") {
      assert.equal((await raw.release({...bound, receiptRef: result.receiptRef})).kind, "unproven");
      assert.equal(f.io.handles.size, 0);
    }
    assert.equal((await raw.release({...bound, operationId: "foreign", receiptRef: "forged"})).kind, "unproven");
    await f.contain(launched, engineCall());
  });
}

test("sampled native mapping and complete streams do not invent independent init provenance; container status stays distinct", {skip: process.platform !== "linux"}, async t => {
  const f = await joined(t); t.after(() => f.contain());
  const {instance} = await import("./support/docker-provider-observation-fixture.ts");
  const process = await createDockerProviderProcessBridge().open({...f.input, preparedIo: f.io});
  const request = f.channel.messages.find(m => m.kind === "provider-exec"); assert.ok(request?.kind === "provider-exec");
  assert.equal(f.io.observation.providerInstance.status, "missing");
  f.channel.push({...instance(request), executableMapping: {kind: "linux-procfs-exe-v1", scope: "spawn-observation",
    device: "1", inode: "2", startTimeTicks: "3"}} as never);
  await tick(); assert.equal(f.io.observation.executableMapping, "observed");
  assert.equal(f.read().identity.status, "unproven");
  const drains = Promise.all([Array.fromAsync(process.stdout), Array.fromAsync(process.stderr)]);
  f.channel.outputBytes("stdout", "actual bytes"); f.channel.rootExit(17); f.channel.drain();
  await f.io.completion; await drains;
  assert.equal(f.read().stdout.status, "complete"); assert.equal(f.read().stderr.status, "complete");
  assert.equal(f.read().guardianExit.status, "unobserved");
  const inspect = f.engine.inspect.bind(f.engine);
  f.engine.inspect = async authority => {
    const observed = await inspect(authority);
    return observed.existence === "absent" ? observed : {...observed, state: {...observed.state, exitCode: 91,
      startedAt: "2026-09-07T00:00:00Z", finishedAt: f.engine.running ? "" : "2026-09-07T00:00:01Z"}};
  };
  await f.contain();
  assert.deepEqual(f.read().guardianExit, {status: "observed", code: 91, signal: null});
  assert.deepEqual(f.read().providerExit, {status: "observed", code: 17, signal: null});
  assert.equal(executionEvidenceIsClosed(f.read()), false);
});

for (const held of ["stdout", "stderr"] as const) {
  test(`sole reader waits for the actual ${held} consumer before accepting root exit and drain`, {skip: process.platform !== "linux"}, async t => {
    const f = await joined(t); t.after(() => f.contain());
    const process = await createDockerProviderProcessBridge().open({...f.input, preparedIo: f.io});
    const other = held === "stdout" ? "stderr" : "stdout";
    const flowing = Array.fromAsync(process[other]);
    f.channel.outputBytes(held, "held bytes"); f.channel.rootExit(); f.channel.drain(); await tick();
    assert.equal(f.read()[held].bytes, 10); assert.equal(f.read()[held].status, "incomplete");
    assert.equal(f.read().providerExit.status, "unobserved");
    const resumed = Array.fromAsync(process[held]);
    await Promise.all([resumed, flowing, f.io.completion]);
    assert.equal(f.read().providerExit.status, "observed");
    assert.equal(f.channel.readers, 1);
  });
}

test("concrete recursive empty is retained before removal; absence and FD closure gate physical proof", {skip: process.platform !== "linux"}, async t => {
  const f = await residueFixture(t); installSyntheticInit(f.fake);
  const launched = await f.launch(); const raw = new DockerKernelHostCustody(1000);
  const create = (await import("./support/docker-host-custody-lifecycle-fixture.ts")).createInput(f.root);
  const input = reservation(launched, create.workspaceSource, create.privateRootSource);
  const handle = await reserveWorkspace(t, raw, input); const init = initOptions();
  const io = prepareDockerProviderProcessIo({launch: launched, init, expected: {authority: launched.authority,
    custodyRef: launched.key.custodyId, generation: init.authority.generation, workspaceAuthorityPath: create.workspaceSource}});
  raw.reservation(handle.custodyRef).evidence.attach(f.lifecycle, launched, io); await io.ready();
  const entered = deferred(); const gate = deferred(); t.after(() => gate.resolve());
  const remove = f.engine.remove.bind(f.engine);
  f.engine.remove = async (...args) => {entered.resolve(); await gate.promise; return remove(...args);};
  raw.installCleanup(handle.custodyRef, {cutoff() {}, async cleanup() {
    return {kind: (await f.contain(launched)).kind === "closed" ? "released" : "quarantined"};
  }});
  const contained = raw.requestContainment({...handle, operationId: input.operationId, attemptId: input.attemptId});
  await entered.promise;
  const snapshot = f.lifecycle.observeLaunch(launched);
  assert.ok(snapshot.terminal); assert.ok(snapshot.recursiveEmpty); assert.equal(snapshot.removal, null);
  assert.ok(f.io.handles.size > 0); assert.equal(physicalEvidenceIsClosed(raw.evidence(handle.custodyRef)!), false);
  gate.resolve(); assert.equal((await contained).kind, "contained");
  assert.ok(f.lifecycle.observeLaunch(launched).removal); assert.equal(f.io.handles.size, 0);
  assert.equal(physicalEvidenceIsClosed(raw.evidence(handle.custodyRef)!), true);
  assert.equal(snapshot.removal, null);
});

test("retained evidence cannot be replaced by caller-authored snapshots or a substituted lifecycle readback", {skip: process.platform !== "linux"}, async t => {
  const f = await joined(t); t.after(() => f.contain());
  assert.ok(Object.isFrozen(f.retained.evidence));
  assert.throws(() => Object.defineProperty(f.retained.evidence, "snapshot", {value: () => ({sealed: true})}));
  Object.defineProperty(f.lifecycle, "observeLaunch", {value() {throw new Error("substituted readback must not run");}});
  assert.equal(f.read().closure.status, "unproven");
  assert.equal(f.read().identity.status, "unproven");
});

const concreteJoined = async (t: import("node:test").TestContext, cleanupMilliseconds = 1000) => {
  const f = await residueFixture(t); const channel = installSyntheticInit(f.fake);
  const launch = await f.launch(); const raw = new DockerKernelHostCustody(cleanupMilliseconds);
  const {createInput: createLifecycleInput} = await import("./support/docker-host-custody-lifecycle-fixture.ts");
  const create = createLifecycleInput(f.root); const input = reservation(launch, create.workspaceSource, create.privateRootSource);
  const handle = await reserveWorkspace(t, raw, input); const init = initOptions();
  const io = prepareDockerProviderProcessIo({launch, init, expected: {authority: launch.authority,
    custodyRef: launch.key.custodyId, generation: init.authority.generation, workspaceAuthorityPath: create.workspaceSource}});
  raw.reservation(handle.custodyRef).evidence.attach(f.lifecycle, launch, io); await io.ready();
  return {...f, launch, raw, io, channel, handle,
    containment: {...handle, operationId: input.operationId, attemptId: input.attemptId},
    read: () => raw.evidence(handle.custodyRef)!};
};

test("cleanup observation timeout rejoins the sole destructive flight and later proves concrete containment", {skip: process.platform !== "linux"}, async t => {
  const f = await concreteJoined(t, 25);
  const {awaitNetworkCleanupWork} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js");
  const entered = deferred(); const gate = deferred(); t.after(() => gate.resolve());
  const remove = f.engine.remove.bind(f.engine); let removals = 0; let cutoffs = 0; let observations = 0;
  f.engine.remove = async (...args) => {removals += 1; entered.resolve(); await gate.promise; return remove(...args);};
  // Same retained-work/bounded-wait contract as the production preparation owner.
  let work: ReturnType<typeof f.contain> | undefined;
  f.raw.installCleanup(f.handle.custodyRef, {cutoff() {cutoffs += 1;}, async cleanup(input) {
    observations += 1; work ??= f.contain(f.launch);
    try {
      await awaitNetworkCleanupWork(work, {...input, signal: new AbortController().signal});
      return {kind: (await work).kind === "closed" ? "released" : "quarantined"};
    } catch {return {kind: "quarantined"};}
  }});
  const first = f.raw.requestContainment(f.containment);
  assert.strictEqual(f.raw.requestContainment(f.containment), first);
  await entered.promise; assert.equal((await first).kind, "unproven");
  assert.equal(f.read().closure.status, "unproven"); assert.equal(removals, 1);
  assert.throws(() => f.raw.installCleanup(f.handle.custodyRef, {cutoff() {}, async cleanup() {return {kind: "released"};}}));
  assert.equal((await f.raw.release({...f.containment, receiptRef: "forged"})).kind, "unproven");
  gate.resolve(); await work; // The original effect finishes after its first observer timed out.
  const second = f.raw.requestContainment(f.containment);
  assert.notStrictEqual(second, first); assert.strictEqual(f.raw.requestContainment(f.containment), second);
  assert.equal((await second).kind, "contained");
  assert.equal(f.read().closure.status, "closed"); assert.equal(f.read().sealed, true);
  assert.equal(observations, 2); assert.equal(cutoffs, 1); assert.equal(removals, 1);
  assert.equal(f.channel.closes, 1); assert.equal(f.io.observation.supervisorFinality, "unproven");
  assert.equal(f.read().identity.status, "unproven"); assert.equal(f.read().privateRoot.status, "unproven");
  const receipt = await second;
  assert.strictEqual(await f.raw.requestContainment(f.containment), receipt);
  assert.equal((await f.raw.release({...f.containment, receiptRef: receipt.kind === "contained" ? receipt.receiptRef : "missing"})).kind, "unproven");
});

test("containment wins the execution journal race; rejected acknowledgement settles without inventing spawn proof", {skip: process.platform !== "linux"}, async t => {
  const f = await concreteJoined(t);
  const entered = deferred(); const gate = deferred(); t.after(() => gate.resolve());
  const exclusive = f.storage.exclusive.bind(f.storage); let held = false;
  f.storage.exclusive = async operation => {
    // Pause the real acknowledgement before it acquires the journal lock.
    // Containment can now commit a later sequence while this observation waits.
    if (!held && f.lifecycle.observeLaunch(f.launch).execution?.result?.kind === "started") {
      held = true; entered.resolve(); await gate.promise;
    }
    return exclusive(operation);
  };
  const {providerExec} = await import("./support/docker-claim-init-fixture.ts");
  const {DockerCustodyJournalConflictError} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js");
  const executing = f.lifecycle.executeProvider({authority: f.launch.authority, key: f.launch.key,
    exec: providerExec, call: engineCall()});
  const rejected = assert.rejects(executing, DockerCustodyJournalConflictError);
  await entered.promise;
  const pending = f.lifecycle.observeLaunch(f.launch).execution!;
  assert.equal(pending.settled, false); assert.equal(pending.journal, null);
  let cleanups = 0;
  f.raw.installCleanup(f.handle.custodyRef, {cutoff() {}, async cleanup() {
    cleanups += 1; return {kind: (await f.contain(f.launch)).kind === "closed" ? "released" : "quarantined"};
  }});
  assert.equal((await f.raw.requestContainment(f.containment)).kind, "unproven");
  assert.equal(f.lifecycle.observeLaunch(f.launch).journal.state, "closed");
  assert.equal(f.read().closure.status, "closed"); assert.equal(f.read().sealed, false);
  gate.resolve(); await rejected;
  const settled = f.lifecycle.observeLaunch(f.launch).execution!;
  assert.equal(settled.settled, true); assert.equal(settled.journal, null); assert.equal(pending.settled, false);
  assert.equal(f.read().sealed, true); assert.equal(f.read().spawn, "ambiguous");
  assert.equal(f.read().identity.status, "unproven"); assert.equal(f.read().providerExit.status, "unobserved");
  assert.equal(f.read().stdout.status, "incomplete"); assert.equal(f.read().stderr.status, "incomplete");
  assert.equal(executionEvidenceIsClosed(f.read()), false); assert.equal(noStartEvidenceIsClosed(f.read()), false);
  assert.equal((await f.raw.requestContainment(f.containment)).kind, "contained"); assert.equal(cleanups, 1);
  assert.equal(f.channel.attaches, 1); assert.equal(f.channel.closes, 1);
});

for (const preparation of ["missing", "pending", "settled"] as const) {
  test(`no-IO physical closure does not seal ${preparation} preparation prematurely`, {skip: process.platform !== "linux"}, async t => {
    const f = await residueFixture(t);
    const launch = await f.launch();
    const create = createInput(f.root);
    const raw = new DockerKernelHostCustody(1000);
    const handle = await reserveWorkspace(t, raw, reservation(launch, create.workspaceSource, create.privateRootSource));
    const evidence = raw.reservation(handle.custodyRef).evidence;
    evidence.attachLifecycle(f.lifecycle, launch);
    assert.throws(() => evidence.attachLifecycle(f.lifecycle, launch), /one-use/);
    const gate = deferred(); t.after(() => gate.resolve());
    if (preparation !== "missing") {
      evidence.trackPreparation(gate.promise);
      assert.throws(() => evidence.trackPreparation(Promise.resolve()), /one-use/);
    }
    if (preparation === "settled") {gate.resolve(); await tick();}
    assert.equal(evidence.snapshot().sealed, false);
    assert.equal((await f.contain(launch)).kind, "closed");
    assert.equal(evidence.snapshot().closure.status, "closed");
    assert.equal(evidence.snapshot().sealed, preparation === "settled");
    if (preparation === "pending") {
      gate.resolve(); await tick();
      assert.equal(evidence.snapshot().sealed, true);
    }
    assert.equal(evidence.snapshot().spawn, "ambiguous");
    assert.equal(evidence.snapshot().identity.status, "unproven");
    assert.equal(evidence.snapshot().providerExit.status, "unobserved");
    assert.equal(executionEvidenceIsClosed(evidence.snapshot()), false);
    assert.equal(noStartEvidenceIsClosed(evidence.snapshot()), false);
  });
}

test("split attachments retain exact lifecycle and reject foreign or repeated provider IO", {skip: process.platform !== "linux"}, async t => {
  const f = await joined(t); const other = await joined(t);
  t.after(() => f.contain()); t.after(() => other.contain());
  const raw = new DockerKernelHostCustody(1000);
  const handle = await reserveWorkspace(t, raw, reservation(f.launched, f.launchInput.create.workspaceSource,
    f.launchInput.create.privateRootSource));
  const evidence = raw.reservation(handle.custodyRef).evidence;
  assert.throws(() => evidence.attachProviderIo(f.io), /unavailable/);
  assert.throws(() => evidence.attachLifecycle(other.lifecycle, f.launched));
  evidence.attachLifecycle(f.lifecycle, f.launched);
  assert.throws(() => evidence.attachProviderIo({...f.io}), /actual prepared/);
  assert.throws(() => evidence.attachProviderIo(other.io), /actual prepared/);
  evidence.attachProviderIo(f.io);
  assert.throws(() => evidence.attachProviderIo(f.io), /unavailable/);
  assert.equal(evidence.snapshot().spawn, "ambiguous");
  assert.equal(evidence.snapshot().sealed, false);
});
