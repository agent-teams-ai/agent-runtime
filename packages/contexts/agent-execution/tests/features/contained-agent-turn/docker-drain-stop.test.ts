import assert from "node:assert/strict";
import test from "node:test";
import {DockerCustodyJournal, DockerCustodyJournalUnavailableError} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";
import {DockerCustodyInitRuntime} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-runtime.js";
import {FakeSyscalls} from "./docker-custody-init-test-fixture.ts";
import {createInput} from "./support/docker-host-custody-lifecycle-fixture.ts";
import {fixture, deferred, engineCall, initOptions, providerExec, stdout, stderr, tick} from "./support/docker-drain-stop-fixture.ts";

for (const immediateClose of [true, false]) {
  test(immediateClose ? "counterexample: immediate cancellation before stop loses final output, exit and drain"
    : "containment preserves exact final bytes, root exit and drain through physical stop and removal", async t => {
    const f = await fixture(t); const launched = await f.launch();
    const chunks: {stream: string; bytes: Buffer}[] = []; const observed: string[] = [];
    const session = launched.openInitSession({...initOptions(),
      onOutput: chunk => {chunks.push({stream: chunk.stream, bytes: Buffer.from(chunk.bytes)}); observed.push(chunk.stream);},
      onRootExit: exit => {assert.deepEqual(exit, {exitCode: 17, signal: null}); observed.push("root-exit");},
      onDrainComplete: drain => {assert.equal(drain.outerContainmentClaim, "unproven"); observed.push("drain");},
    });
    await session.ready(); await f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec});
    f.controls.onStop = async () => {assert.equal(f.controls.closes, immediateClose ? 1 : 0); f.tail();};
    if (immediateClose) {await session.cancel();}
    assert.equal((await f.lifecycle.contain({...launched, call: engineCall()})).kind, "closed");
    const completion = await session.completion;
    if (immediateClose) {
      assert.equal(completion.kind, "failed"); assert.deepEqual(chunks, []); assert.deepEqual(observed, []);
    } else {
      assert.deepEqual(completion, {kind: "closed", generation: "generation:synthetic", acknowledgement: "started",
        rootExit: {exitCode: 17, signal: null}, stdoutBytes: stdout.length, stderrBytes: stderr.length,
        drain: {outerContainmentClaim: "unproven", rootExit: "observed", stdout: "eof", stderr: "eof"}});
      assert.deepEqual(chunks, [{stream: "stdout", bytes: stdout}, {stream: "stderr", bytes: stderr}]);
      assert.deepEqual(observed, ["stdout", "root-exit", "stderr", "drain"]);
      assert.ok(f.events.indexOf("stop") < f.events.indexOf("close"));
    }
    assert.equal(f.controls.readers, 1); assert.equal(f.controls.closes, 1); assert.equal(f.controls.returns, 1);
    assert.equal(f.wire.filter(message => message.kind === "host-signal").length, 0);
    assert.ok(f.events.includes("residue")); assert.ok(f.events.includes("remove"));
  });
}

test("the retained reader finishes buffered callbacks after physical stop acknowledgement", async t => {
  const f = await fixture(t); const launched = await f.launch(); const gate = deferred(); const entered = deferred();
  t.after(() => gate.resolve()); const observed: string[] = [];
  const session = launched.openInitSession({...initOptions(),
    onOutput: async chunk => {if (chunk.stream === "stdout") {entered.resolve(); await gate.promise;} observed.push(chunk.stream);},
    onRootExit: () => {observed.push("root");}, onDrainComplete: () => {observed.push("drain");}});
  await session.ready(); await f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec});
  f.controls.onStop = async () => {f.tail();};
  f.controls.onStopped = () => {setImmediate(() => {gate.resolve();});};
  f.controls.onRemove = async () => {assert.equal((await session.completion).kind, "closed");};
  assert.equal((await f.lifecycle.contain({...launched, call: engineCall()})).kind, "closed");
  assert.equal((await session.completion).kind, "closed"); assert.deepEqual(observed, ["stdout", "root", "stderr", "drain"]);
});

for (const kind of ["provider-input", "provider-input-eof", "host-signal"] as const) {
  test(`actual Docker beforeWrite rejects queued ${kind} at cutoff without cancelling observation`, async t => {
    const f = await fixture(t); const launched = await f.launch(); const entered = deferred(); const gate = deferred();
    t.after(() => gate.resolve()); const session = launched.openInitSession(initOptions());
    await session.ready(); await f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec});
    f.controls.beforeWrite = async message => {if (message === kind) {entered.resolve(); await gate.promise;}};
    const write = kind === "provider-input" ? session.writeInput(Buffer.from("forbidden"))
      : kind === "provider-input-eof" ? session.closeProviderInput() : session.signal("SIGTERM");
    await entered.promise;
    f.controls.onStop = async () => {gate.resolve(); await write; f.tail();};
    const containing = f.lifecycle.contain({...launched, call: engineCall()});
    const queued = session.writeInput(Buffer.from("also forbidden"));
    assert.equal((await containing).kind, "closed");
    assert.equal((await write).kind, "closed"); assert.equal((await queued).kind, "closed");
    assert.equal(f.wire.some(message => message.kind === kind), false);
    assert.equal((await session.completion).kind, "closed");
  });
}

test("generation drift during containment rejects otherwise valid final frames", async t => {
  const f = await fixture(t); const launched = await f.launch(); let current = true; let callbacks = 0;
  const session = launched.openInitSession({...initOptions(), isCurrentGeneration: () => current,
    onOutput: () => {callbacks += 1;}, onRootExit: () => {callbacks += 1;}, onDrainComplete: () => {callbacks += 1;}});
  await session.ready(); await f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec});
  f.controls.onStop = async () => {current = false; f.tail();};
  assert.equal((await f.lifecycle.contain({...launched, call: engineCall()})).kind, "closed");
  assert.equal((await session.completion).kind, "failed"); assert.equal(callbacks, 0);
});

test("never-executed launch is cut off synchronously and closes without fabricating provider drain", async t => {
  const f = await fixture(t); const launched = await f.launch(); const session = launched.openInitSession(initOptions());
  await session.ready(); const containing = f.lifecycle.contain({...launched, call: engineCall()});
  await assert.rejects(f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec}), /cut off/u);
  assert.equal((await containing).kind, "closed"); assert.equal((await session.completion).kind, "failed");
  assert.deepEqual(f.wire.map(message => message.kind), ["host-handshake"]);
});

test("EOF and absence without residue proof cannot manufacture containment or drain", async t => {
  const f = await fixture(t); const launched = await f.launch(); const session = launched.openInitSession(initOptions());
  await session.ready(); await f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec});
  await f.engine.stop(launched.authority, engineCall()); await f.engine.remove(launched.authority, engineCall());
  f.output.end(); f.controls.residue = "unknown";
  assert.equal((await f.lifecycle.contain({...launched, call: engineCall()})).kind, "indeterminate");
  assert.equal((await session.completion).kind, "failed"); assert.equal(f.controls.closes, 1);
});

for (const cleanup of ["iterator", "channel", "rejection"] as const) {
  test(`physical close plus ${cleanup} cleanup debt stays unretirable; late completion is owned`, async t => {
    const f = await fixture(t); const gate = deferred(); t.after(() => gate.resolve());
    if (cleanup === "iterator") {f.controls.returnGate = gate.promise;}
    if (cleanup === "channel") {f.controls.closeGate = gate.promise;}
    f.controls.rejectClose = cleanup === "rejection";
    const launched = await f.launch(); const session = launched.openInitSession(initOptions());
    await session.ready(); await f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec});
    f.controls.onStop = async () => {f.tail();};
    const start = performance.now();
    const result = await f.lifecycle.contain({...launched, call: {...engineCall(), deadlineEpochMs: Date.now() + 500}});
    assert.ok(performance.now() - start < 1_500); assert.equal(result.kind, "indeterminate");
    const journal = await new DockerCustodyJournal(f.storage).lookup(launched.key); assert.equal(journal.state, "closed");
    await assert.rejects(f.lifecycle.retire({key: launched.key, expectedChecksumSha256: journal.checksumSha256}));
    gate.resolve(); await tick();
    assert.equal((await session.completion).kind, "closed");
    assert.equal((await f.lifecycle.contain({...launched, call: engineCall()})).kind, cleanup === "rejection" ? "indeterminate" : "closed");
    assert.equal(f.controls.closes, 1); assert.equal(f.controls.returns, 1);
  });
}

test("concurrent and repeated containment join one reader and one attachment cleanup", async t => {
  const f = await fixture(t); const launched = await f.launch(); const entered = deferred(); const stopGate = deferred();
  t.after(() => stopGate.resolve()); const session = launched.openInitSession(initOptions());
  await session.ready(); await f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec});
  f.controls.onStop = async () => {entered.resolve(); await stopGate.promise; f.tail();};
  const first = f.lifecycle.contain({...launched, call: engineCall()}); await entered.promise;
  const second = f.lifecycle.contain({...launched, call: engineCall()});
  assert.equal((await session.writeInput(Buffer.from("forbidden"))).kind, "closed");
  stopGate.resolve();
  assert.equal((await first).kind, "closed"); assert.equal((await second).kind, "closed");
  assert.equal((await f.lifecycle.contain({...launched, call: engineCall()})).kind, "closed");
  assert.equal((await session.completion).kind, "closed");
  assert.equal(f.controls.readers, 1); assert.equal(f.controls.closes, 1); assert.equal(f.controls.returns, 1);
  assert.deepEqual(f.wire.map(message => message.kind), ["host-handshake", "provider-exec"]);
});

for (const boundary of ["journal-intent", "provider-exec", "host-handshake"] as const) {
  test(`late ${boundary} completion cannot send after synchronous containment cutoff`, async t => {
    const f = await fixture(t); const launched = await f.launch(); const entered = deferred(); const gate = deferred();
    t.after(() => gate.resolve()); const session = launched.openInitSession(initOptions());
    if (boundary !== "host-handshake") {await session.ready();}
    if (boundary === "journal-intent") {
      const file = f.storage.files.values().next().value!; const append = file.append.bind(file);
      file.append = async (offset, bytes) => {
        await append(offset, bytes);
        if (Buffer.from(bytes).includes(Buffer.from('"state":"provider_exec_requested"'))) {entered.resolve(); await gate.promise;}
      };
    } else {
      f.controls.beforeWrite = async kind => {if (kind === boundary) {entered.resolve(); await gate.promise;}};
    }
    const pending = boundary === "host-handshake" ? session.ready()
      : f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec}).catch(() => null);
    await entered.promise;
    const containing = f.lifecycle.contain({...launched, call: engineCall()});
    gate.resolve(); await pending;
    assert.equal((await containing).kind, "closed");
    assert.equal(f.wire.some(message => message.kind === "provider-exec"), false);
    if (boundary === "host-handshake") {assert.deepEqual(f.wire, []);}
    assert.notEqual((await session.completion).kind, "closed");
    await assert.rejects(f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec}));
    assert.equal(f.controls.readers, 1); assert.equal(f.controls.closes, 1);
  });
}

test("an exec handed to the channel without acknowledgement remains ambiguous after containment", async t => {
  const f = await fixture(t); const launched = await f.launch(); f.controls.acknowledge = false;
  const session = launched.openInitSession({...initOptions(), acknowledgementTimeoutMs: 200}); await session.ready();
  const sent = deferred(); f.controls.beforeWrite = kind => {if (kind === "provider-exec") {queueMicrotask(sent.resolve);}};
  const executing = f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec}).catch(() => null);
  await sent.promise; await tick(); assert.equal(f.wire.filter(message => message.kind === "provider-exec").length, 1);
  assert.equal((await f.lifecycle.contain({...launched, call: engineCall()})).kind, "closed"); await executing;
  const completion = await session.completion; assert.equal(completion.kind, "unknown");
  const journal = (await new DockerCustodyJournal(f.storage).recover())[0];
  assert.equal(journal?.providerExecution, "may_have_executed");
  f.push({kind: "provider-exec-ack", observation: "started", requestId: providerExec.requestId}); await tick();
  assert.strictEqual(await session.completion, completion);
});

const failJournal = async () => {throw new DockerCustodyJournalUnavailableError("synthetic unavailable");};

for (const failure of ["lookup", "append"] as const) {
  test(`journal ${failure} failure still stops physically, drains and joins failed cleanup`, async t => {
    const f = await fixture(t); const launched = await f.launch(); const session = launched.openInitSession(initOptions());
    await session.ready(); await f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec});
    f.controls.rejectClose = true; f.controls.onStop = async () => {f.tail();};
    const file = f.storage.files.values().next().value!;
    if (failure === "lookup") {f.storage.open = failJournal;} else {file.append = failJournal;}
    const result = await f.lifecycle.contain({...launched, call: engineCall()});
    assert.equal(result.kind, "indeterminate"); assert.ok("reason" in result && result.reason === "journal_unavailable");
    assert.ok("containment" in result); assert.equal(result.containment, "indeterminate");
    assert.equal((await session.completion).kind, "closed"); assert.ok(f.events.includes("stopped")); assert.ok(f.events.includes("remove"));
    assert.equal(f.controls.closes, 1); assert.equal(f.controls.returns, 1);
    await assert.rejects(f.lifecycle.retire({key: launched.key, expectedChecksumSha256: "0".repeat(64)}), /cleanup/u);
  });
}

for (const boundary of ["caller-deadline", "caller-abort", "session-abort"] as const) {
  test(`${boundary} bounds stalled observation cleanup and fences late callback completion`, async t => {
    const f = await fixture(t); const launched = await f.launch(); const entered = deferred(); const gate = deferred();
    const abort = new AbortController(); t.after(() => gate.resolve()); let roots = 0; let drains = 0;
    const session = launched.openInitSession({...initOptions(), acknowledgementTimeoutMs: 500,
      ...(boundary === "session-abort" ? {signal: abort.signal} : {}),
      onOutput: async () => {entered.resolve(); await gate.promise;},
      onRootExit: () => {roots += 1;}, onDrainComplete: () => {drains += 1;}});
    await session.ready(); await f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec});
    f.controls.onStop = async () => {f.tail();};
    // Docker stop completes before the caller's observation wait is interrupted.
    const physical = deferred(); f.controls.onStopped = () => {physical.resolve();};
    const call = {...engineCall(), ...(boundary === "caller-abort" ? {signal: abort.signal} : {}),
      deadlineEpochMs: Date.now() + (boundary === "caller-deadline" ? 200 : 2_000)};
    const started = performance.now(); const containing = f.lifecycle.contain({...launched, call});
    await entered.promise; await physical.promise;
    if (boundary !== "caller-deadline") {await tick(); abort.abort();}
    await containing;
    assert.ok(performance.now() - started < 1_000);
    assert.equal((await session.completion).kind, "failed"); gate.resolve(); await tick();
    assert.equal(roots, 0); assert.equal(drains, 0); assert.equal(f.controls.closes, 1); assert.equal(f.controls.returns, 1);
    assert.equal((await session.writeInput(Buffer.from("late"))).kind, "closed");
  });
}

test("late attachment after physical closure is retained, closed once and never starts init", async t => {
  const f = await fixture(t); const gate = deferred(); t.after(() => gate.resolve());
  const entered = Promise.withResolvers<Parameters<typeof f.lifecycle.contain>[0]>(); const attach = f.engine.attachCustody.bind(f.engine);
  f.engine.attachCustody = async (...args) => {
    const channel = await attach(...args); const [journal] = await new DockerCustodyJournal(f.storage).recover();
    assert.ok(journal?.kind === "replayed"); entered.resolve({authority: args[0], key: journal.attemptKey, call: engineCall()});
    await gate.promise; return channel;
  };
  const rejected = assert.rejects(f.launch(), /cut off/u); const input = await entered.promise;
  assert.equal((await f.lifecycle.contain(input)).kind, "indeterminate");
  const journal = await new DockerCustodyJournal(f.storage).lookup(input.key);
  await assert.rejects(f.lifecycle.retire({key: input.key, expectedChecksumSha256: journal.checksumSha256}));
  gate.resolve(); await rejected; await tick();
  assert.equal((await f.lifecycle.contain(input)).kind, "closed");
  assert.equal(f.controls.closes, 1); assert.equal(f.controls.readers, 0); assert.deepEqual(f.wire, []);
  assert.equal(f.engine.events.includes("start:id"), false);
});

test("queued Docker start receives synchronous cutoff while the attach observation call stays live", async t => {
  const f = await fixture(t); const gate = deferred(); t.after(() => gate.resolve());
  const entered = Promise.withResolvers<Parameters<typeof f.lifecycle.contain>[0]>();
  const start = f.engine.start.bind(f.engine); const attach = f.engine.attachCustody.bind(f.engine);
  let startSignal: AbortSignal | undefined; let attachSignal: AbortSignal | undefined;
  f.engine.attachCustody = async (...args) => {attachSignal = args[1].signal; return attach(...args);};
  f.engine.start = async (...args) => {
    startSignal = args[1].signal; const [journal] = await new DockerCustodyJournal(f.storage).recover();
    assert.ok(journal?.kind === "replayed"); entered.resolve({authority: args[0], key: journal.attemptKey, call: engineCall()});
    await gate.promise; await start(...args);
  };
  const rejected = assert.rejects(f.launch()); const input = await entered.promise;
  const containing = f.lifecycle.contain(input);
  assert.equal(startSignal?.aborted, true); assert.equal(attachSignal?.aborted, false);
  gate.resolve(); await rejected; await containing;
  assert.equal((await f.lifecycle.contain(input)).kind, "closed");
  assert.equal(f.engine.events.includes("start:id"), false); assert.deepEqual(f.wire, []);
  assert.equal(f.controls.closes, 1);
});

test("closed journal with rejected attach cleanup remains indeterminate in same-owner recovery", async t => {
  const f = await fixture(t); const launched = await f.launch(); f.controls.rejectClose = true;
  const session = launched.openInitSession(initOptions()); await session.ready();
  await f.lifecycle.contain({...launched, call: engineCall()});
  const recovered = await f.lifecycle.recover({async resolve() {
    return {authority: launched.authority, create: createInput(f.root), call: engineCall()};
  }});
  assert.equal(recovered[0]?.kind, "indeterminate"); assert.equal(f.controls.closes, 1);
});

for (const signalResult of ["sent", "absent", "failed"] as const) {
  test(`actual init stop observation preserves final output without proving physical closure: ${signalResult}`, async t => {
    const f = await fixture(t); const launched = await f.launch(); const chunks: Buffer[] = [];
    const session = launched.openInitSession({...initOptions(), onOutput: chunk => {chunks.push(Buffer.from(chunk.bytes));}});
    await session.ready(); await f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec});
    const syscalls = new FakeSyscalls(); syscalls.wall = Date.now();
    syscalls.observeIdentity = () => initOptions().authority.expectedIdentity;
    syscalls.signalFailure = signalResult === "failed";
    const signal = syscalls.signalProviderRoot.bind(syscalls);
    Object.defineProperty(syscalls, "signalProviderRoot", {value: (...args: Parameters<typeof signal>) => {
      const result = signal(...args); return signalResult === "absent" ? "absent" : result;
    }});
    syscalls.writeProviderOutput = (stream, bytes) => {
      f.push({kind: "provider-output", requestId: providerExec.requestId, stream, bytesBase64: Buffer.from(bytes).toString("base64")});
      return {committedBytes: bytes.byteLength, status: "accepted"};
    };
    let forwarding = false;
    const runtime = new DockerCustodyInitRuntime({allowedEnvironmentNames: [], executablePath: "/immutable/provider",
      executableSha256: providerExec.executableSha256, maximumProviderRuntimeMs: 30_000,
      maximumStderrBytes: 100, maximumStdinBytes: 100, maximumStdoutBytes: 100,
      observedIdentity: syscalls.observeIdentity(), shutdownGraceMs: 50, syscalls,
      writeControl: message => {if (forwarding) {f.push(message);} return "accepted";}});
    for (const message of f.wire) {
      if (message.kind === "host-handshake" || message.kind === "provider-exec") {runtime.receive(message);}
    }
    assert.equal(runtime.snapshot().phase, "provider-running"); forwarding = true;
    f.controls.residue = "unknown";
    f.controls.onStop = async () => {
      runtime.forwardHostSignal("SIGTERM"); runtime.tick();
      assert.equal(runtime.snapshot().signalEvidence[0]?.result, signalResult);
      runtime.acceptProviderOutput(syscalls.stdoutHandle, stdout);
      syscalls.rootExits.push({handle: syscalls.providerRootHandle, exitCode: 17, signal: null}); runtime.tick();
      runtime.acceptProviderOutput(syscalls.stderrHandle, stderr);
      runtime.closeProviderOutput(syscalls.stdoutHandle); runtime.closeProviderOutput(syscalls.stderrHandle); runtime.tick();
      assert.equal(runtime.snapshot().phase, "drained"); f.output.end();
    };
    assert.equal((await f.lifecycle.contain({...launched, call: engineCall()})).kind, "indeterminate");
    const completion = await session.completion;
    assert.equal(completion.kind, "closed");
    assert.deepEqual(chunks, [stdout, stderr]);
    if (completion.kind === "closed") {
      assert.deepEqual(completion.rootExit, {exitCode: 17, signal: null});
      assert.equal(completion.drain.outerContainmentClaim, "unproven");
    }
    assert.equal(f.controls.readers, 1);
  });
}

for (const invalid of ["wrong-request", "signal-only"] as const) {
  test(`signal observations cannot repair missing execution evidence: ${invalid}`, async t => {
    const f = await fixture(t); const launched = await f.launch();
    const session = launched.openInitSession(initOptions());
    await session.ready(); await f.lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec});
    f.controls.onStop = async () => {
      f.push({kind: "provider-signal-observation", action: "stop-term", signal: "SIGTERM", result: "sent",
        requestId: invalid === "wrong-request" ? "another-request" : providerExec.requestId});
      if (invalid === "wrong-request") {f.tail();} else {f.output.end();}
    };
    await f.lifecycle.contain({...launched, call: engineCall()});
    assert.equal((await session.completion).kind, "failed");
  });
}
