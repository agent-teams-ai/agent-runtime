import assert from "node:assert/strict";
import test from "node:test";
import {prepareDockerProviderProcessIo, dockerProviderProcessMountFacts, createDockerProviderProcessBridge} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {DOCKER_PROVIDER_MAX_WRITE_BYTES} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-bridge.js";
import {DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {fixture, tick, deferred, engineCall, providerExec} from "./support/docker-provider-process-fixture.ts";

const observe = <T>(promise: Promise<T>) => {
  let settled = false;
  void promise.then(() => {settled = true; return;}, () => {settled = true; return;});
  return () => settled;
};
const unknownWrite = (error: unknown): boolean => {
  assert.equal((error as {writeResult?: {kind: string}}).writeResult?.kind, "unknown"); return true;
};

// Each test uses actual lifecycle + journal + init host session. Only the engine
// and its attached duplex channel are in-memory; no Node launch backend exists.
test("effect-free construction; authenticated readiness and durable intent precede one exec", async t => {
  const f = fixture(); await tick(); assert.deepEqual(f.events, []); assert.equal(f.storage.files.size, 0);
  assert.equal(f.registry.processes.get("absent"), undefined);
  const a = await f.launch(); t.after(() => a.contain());
  assert.deepEqual(f.events, ["create", "attach", "start"]);
  const ready = deferred();
  f.channel.onMessage = async message => {
    if (message.kind === "host-handshake") {await ready.promise;}
    f.channel.respond(message);
  };
  const file = f.storage.files.values().next().value!; const append = file.append.bind(file);
  file.append = async (offset, bytes) => {
    await append(offset, bytes);
    if (Buffer.from(bytes).includes(Buffer.from('"state":"provider_exec_requested"'))) {f.events.push("intent-durable");}
  };
  const opening = f.registry.open(a.input); const opened = observe(opening); await tick();
  assert.equal(opened(), false); assert.equal(f.registry.processes.get(a.input.expected.custodyRef), undefined);
  assert.equal(f.events.includes("provider-exec"), false); assert.equal(f.channel.readers, 1);
  ready.resolve(); const process = await opening;
  assert.equal(f.registry.processes.get(process.custodyRef), process); assert.equal(f.registry.processes.get("wrong"), undefined);
  assert.equal(process.workspaceAuthorityPath, a.input.expected.workspaceAuthorityPath);
  assert.deepEqual(f.events.slice(-2), ["intent-durable", "provider-exec"]);
  assert.deepEqual(Object.keys(process).toSorted(), ["closeInput", "custodyRef", "stderr", "stdout", "waitForExit", "workspaceAuthorityPath", "write"].toSorted());
  assert.equal("execute" in process, false); assert.equal("finish" in process.stdout, false);
  await assert.rejects(f.registry.open(a.input), /one-use/u);
  await assert.rejects(createDockerProviderProcessBridge().open(a.input), /unused actual lifecycle launch/u);
  await assert.rejects(f.lifecycle.executeProvider({authority: a.launched.authority, key: a.launched.key, call: engineCall(), exec: providerExec}), /one-use/u);
  await assert.rejects(f.lifecycle.launch(f.launchInput), /unused launch capacity/u);
  assert.equal(f.events.filter(event => event === "provider-exec").length, 1);
});

test("structural launch, ready flag and exact identity mismatches cannot acquire custody", async t => {
  for (const mismatch of ["lookalike", "container", "daemon", "custody", "workspace", "generation", "nonce"] as const) {
    await t.test(mismatch, async () => {
      const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
      const input = {...a.input, expected: {...a.input.expected}, init: {...a.input.init}};
      if (mismatch === "lookalike") {input.launch = {...a.launched, openInitSession: () => ({ready: async () => ({kind: "ready"})})} as never;}
      if (mismatch === "container") {input.expected.authority = {...input.expected.authority, containerId: "b".repeat(64)};}
      if (mismatch === "daemon") {input.expected.authority = {...input.expected.authority, daemonBootGenerationSha256: "b".repeat(64)};}
      if (mismatch === "custody") {input.expected.custodyRef = "custody:foreign";}
      if (mismatch === "workspace") {input.expected.workspaceAuthorityPath = "/synthetic/foreign";}
      if (mismatch === "generation") {input.expected.generation = "generation:foreign";}
      if (mismatch === "nonce") {input.init.authority = {...input.init.authority, operationNonce: "foreign"};}
      await assert.rejects(f.registry.open(Object.assign(input, {ready: true})));
      if (mismatch !== "lookalike") {await assert.rejects(createDockerProviderProcessBridge().open(a.input), /unused actual/);}
      assert.equal(f.events.includes("provider-exec"), false);
    });
  }
});

test("authenticated init rejects forged readiness even though the journal says init_ready", async t => {
  const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
  assert.equal(a.launched.journal.state, "init_ready");
  f.channel.onMessage = message => {
    if (message.kind === "host-handshake") {f.channel.push({kind: "init-ready", nonce: "foreign",
      observedIdentity: message.expectedIdentity, protocol: message.protocol, launchFingerprintSha256: message.launchFingerprintSha256});}
  };
  await assert.rejects(f.registry.open(a.input), /readiness-unproven/u);
  assert.equal(f.events.includes("provider-exec"), false); assert.equal(f.channel.closes, 1);
});

test("durable journal intent failure, including lost ack after append, sends no exec and permits no retry", async t => {
  for (const committed of [false, true]) {
    await t.test(String(committed), async () => {
      const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
      const file = f.storage.files.values().next().value!; const append = file.append.bind(file);
      file.append = async (offset, bytes) => {
        if (Buffer.from(bytes).includes(Buffer.from('"state":"provider_exec_requested"'))) {
          if (committed) {await append(offset, bytes);} throw new Error("synthetic durable intent failure");
        }
        await append(offset, bytes);
      };
      await assert.rejects(f.registry.open(a.input));
      await assert.rejects(createDockerProviderProcessBridge().open(a.input));
      assert.equal(f.events.includes("provider-exec"), false); assert.equal(f.channel.closes, 1);
    });
  }
});

test("interleaved binary output is ordered and backpressures the sole reader; root exit alone is not EOF", async t => {
  const f = fixture(); const a = await f.launch(); t.after(() => a.contain()); const process = await f.registry.open(a.input);
  const out = process.stdout[Symbol.asyncIterator](); const err = process.stderr[Symbol.asyncIterator]();
  assert.throws(() => process.stdout[Symbol.asyncIterator](), /one reader/u);
  const first = Buffer.from([0, 255, 128, 10]);
  f.channel.outputBytes("stdout", first); f.channel.outputBytes("stderr", "err"); f.channel.outputBytes("stdout", "tail");
  await tick(); const stalledReads = f.channel.reads; await tick(); assert.equal(f.channel.reads, stalledReads);
  assert.deepEqual(Buffer.from((await out.next()).value!), first); await tick();
  assert.equal(f.channel.reads, stalledReads + 1, "stderr now applies backpressure before later stdout");
  assert.equal(Buffer.from((await err.next()).value!).toString(), "err");
  assert.equal(Buffer.from((await out.next()).value!).toString(), "tail");
  const outEnd = out.next(); const errEnd = err.next(); const exited = observe(process.waitForExit());
  await tick(); const eof = observe(outEnd); const beforeRoot = f.channel.reads; f.channel.rootExit(); await tick();
  assert.equal(f.channel.reads, beforeRoot + 1, "root observation consumed; session now awaits drain");
  assert.equal(exited(), false); assert.equal(eof(), false); assert.equal(f.engine.running, true);
  await assert.rejects(out.next(), /one pending read/u);
  f.channel.drain(); assert.equal((await outEnd).done, true); assert.equal((await errEnd).done, true);
  assert.deepEqual(await process.waitForExit(), {code: 0, signal: null});
  assert.equal(f.engine.running, true, "protocol closure cannot assert physical containment");
  const contained = await a.contain(); assert.equal(contained.kind, "closed"); assert.equal(f.engine.removed, true);
});

test("abnormal, unknown, overflow, stale and aborted completion reject both streams and exit", async t => {
  for (const mode of ["channel-ended", "duplicate-ack", "overflow", "stale", "aborted", "late-frame"] as const) {
    await t.test(mode, async () => {
      const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
      const abort = new AbortController(); a.input.call = {...a.input.call, signal: abort.signal};
      let current = true; a.input.init.isCurrentGeneration = () => current;
      if (mode === "overflow") {a.input.init.maximumStdoutBytes = 1;}
      const process = await f.registry.open(a.input);
      const out = process.stdout[Symbol.asyncIterator](); const err = process.stderr[Symbol.asyncIterator]();
      const stdoutFailed = assert.rejects(out.next()); const stderrFailed = assert.rejects(err.next());
      const exitFailed = assert.rejects(process.waitForExit());
      if (mode === "channel-ended") {f.channel.rootExit(); f.channel.end();}
      if (mode === "duplicate-ack") {f.channel.push({kind: "provider-exec-ack", requestId: providerExec.requestId, observation: "started"});}
      if (mode === "overflow") {f.channel.outputBytes("stdout", "too large");}
      if (mode === "stale") {current = false; f.channel.rootExit();}
      if (mode === "aborted") {abort.abort();}
      if (mode === "late-frame") {f.channel.rootExit(); f.channel.drain(); f.channel.outputBytes("stdout", "late");}
      await Promise.all([stdoutFailed, stderrFailed, exitFailed]);
      await assert.rejects(process.closeInput()); assert.equal(f.engine.running, true);
    });
  }
});

test("lost async exec acknowledgement cannot publish a registry process or retry", async t => {
  const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
  f.channel.onMessage = message => {if (message.kind !== "provider-exec") {f.channel.respond(message);} else {f.channel.end();}};
  await assert.rejects(f.registry.open(a.input), /exec-unproven/u);
  assert.equal(f.registry.processes.get(a.input.expected.custodyRef), undefined);
  await assert.rejects(createDockerProviderProcessBridge().open(a.input));
  assert.equal(f.events.filter(event => event === "provider-exec").length, 1);
});

test("stdin is copied, bounded, single-flight; close follows its ack and is exactly once", async t => {
  const f = fixture(); const a = await f.launch(); t.after(() => a.contain()); const process = await f.registry.open(a.input);
  const gate = deferred(); const entered = deferred();
  f.channel.onMessage = async message => {if (message.kind === "provider-input") {entered.resolve(); await gate.promise;}};
  const bytes = Buffer.from("abc"); const writing = process.write(bytes); bytes.fill(0); await entered.promise;
  await assert.rejects(process.write(Buffer.from("second")), /write-in-progress/u);
  const close = process.closeInput(); assert.equal(process.closeInput(), close); await tick();
  assert.equal(f.events.includes("provider-input-eof"), false);
  gate.resolve(); await writing; await close;
  const input = f.channel.messages.find(message => message.kind === "provider-input"); assert.equal(input?.bytesBase64, "YWJj");
  assert.equal(f.events.filter(event => event === "provider-input-eof").length, 1);
  await assert.rejects(process.write(Buffer.from("after")), /input-closed/u);
  const other = fixture(); const b = await other.launch(); t.after(() => b.contain()); const bounded = await other.registry.open(b.input);
  await assert.rejects(bounded.write(Buffer.alloc(DOCKER_PROVIDER_MAX_WRITE_BYTES + 1)), /bound/u);
  assert.equal(other.events.includes("provider-input"), false);
});

test("aborted or rejected potentially committed writes retain unknown evidence, including late success", async t => {
  for (const mode of ["aborted", "rejected", "close-aborted", "close-rejected"] as const) {
    await t.test(mode, async () => {
      const f = fixture(); const a = await f.launch(); t.after(() => a.contain()); const abort = new AbortController();
      a.input.call = {...a.input.call, signal: abort.signal}; const process = await f.registry.open(a.input);
      const gate = deferred(); const entered = deferred();
      f.channel.onMessage = async message => {
        if (message.kind === "provider-input" || message.kind === "provider-input-eof") {
          entered.resolve(); await gate.promise; if (mode.endsWith("rejected")) {throw new Error("synthetic lost write acknowledgement");}
        }
      };
      const writing = mode.startsWith("close") ? process.closeInput() : process.write(Buffer.from("committable"));
      const rejected = assert.rejects(writing, unknownWrite); await entered.promise;
      if (mode.endsWith("aborted")) {abort.abort();} else {gate.resolve();}
      await rejected; await assert.rejects(process.waitForExit());
      await assert.rejects(process.write(Buffer.from("no replay"))); await assert.rejects(process.closeInput());
      gate.resolve(); await tick(); await assert.rejects(process.waitForExit());
      assert.equal(f.events.filter(event => event === "provider-input" || event === "provider-input-eof").length, 1);
    });
  }
});

test("reader cancellation and stalled cleanup retain actual session until late contain and retire", async t => {
  const f = fixture(); const a = await f.launch(); const process = await f.registry.open(a.input);
  const cleanup = deferred(); f.channel.closeGate = cleanup.promise;
  t.after(async () => {cleanup.resolve(); await a.contain();});
  f.channel.outputBytes("stdout", "blocked"); await tick();
  const out = process.stdout[Symbol.asyncIterator](); await out.return!();
  await assert.rejects(process.waitForExit());
  await assert.rejects(process.stderr[Symbol.asyncIterator]().next());
  const first = await a.contain({...engineCall(), deadlineEpochMs: Date.now() + 20});
  assert.equal(first.kind, "indeterminate"); assert.equal(f.engine.removed, true);
  assert.equal(f.channel.closes, 1);
  const journal = f.storage.files.values().next().value!;
  const last = JSON.parse(journal.bytes.toString().trim().split("\n").at(-1)!);
  await assert.rejects(f.lifecycle.retire({key: a.launched.key, expectedChecksumSha256: last.checksumSha256}), /cleanup remains unproven/u);
  cleanup.resolve(); await tick();
  const second = await a.contain(); assert.equal(second.kind, "closed"); assert.equal(f.channel.closes, 1);
  if (second.kind === "closed") {await f.lifecycle.retire({key: a.launched.key, expectedChecksumSha256: second.journal.checksumSha256});}
  assert.equal(f.storage.files.size, 0); await assert.rejects(process.waitForExit());
});

test("launch and execution snapshots preserve method receivers and authority across awaits", async t => {
  const f = fixture(); const launching = f.launch();
  const originalPath = f.launchInput.create.workspaceSource;
  (f.launchInput.create as {workspaceSource: string}).workspaceSource = "/synthetic/mutated";
  const a = await launching; t.after(() => a.contain()); a.input.expected.workspaceAuthorityPath = originalPath;
  const gate = deferred(); const entered = deferred();
  f.channel.onMessage = async message => {
    if (message.kind === "host-handshake") {entered.resolve(); await gate.promise;} f.channel.respond(message);
  };
  const init = Object.assign(a.input.init, {valid: true, isCurrentGeneration(this: {valid: boolean}) {return this.valid;}});
  const argv = ["provider-entrypoint", "original"];
  const input = {...a.input, init, exec: {...providerExec, argv}};
  // The launch captured the real lifecycle receiver before publication.
  f.lifecycle.executeProvider = async () => {throw new Error("mutated method must not run");};
  const opening = f.registry.open(input); await entered.promise; argv[1] = "mutated";
  input.expected.custodyRef = "custody:mutated"; gate.resolve(); const process = await opening;
  assert.equal(process.custodyRef, a.launched.key.custodyId); assert.equal(process.workspaceAuthorityPath, originalPath);
  assert.deepEqual(f.channel.messages.find(message => message.kind === "provider-exec")?.argv, ["provider-entrypoint", "original"]);
});

test("containment releases stalled output without a consumer and never turns it into clean EOF", async t => {
  const f = fixture(); const a = await f.launch(); t.after(() => a.contain()); const process = await f.registry.open(a.input);
  f.channel.outputBytes("stdout", "unconsumed"); f.channel.outputBytes("stderr", "also pending"); await tick();
  const stoppedAt = f.channel.reads; await tick(); assert.equal(f.channel.reads, stoppedAt);
  assert.equal((await a.contain()).kind, "closed");
  await assert.rejects(process.stdout[Symbol.asyncIterator]().next());
  await assert.rejects(process.stderr[Symbol.asyncIterator]().next());
  await assert.rejects(process.waitForExit()); assert.equal(f.channel.closes, 1);
});

test("containment during durable exec intent acknowledgement cannot publish or execute late", async t => {
  const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
  const file = f.storage.files.values().next().value!; const append = file.append.bind(file);
  const gate = deferred(); const entered = deferred();
  file.append = async (offset, bytes) => {
    await append(offset, bytes);
    if (Buffer.from(bytes).includes(Buffer.from('"state":"provider_exec_requested"'))) {entered.resolve(); await gate.promise;}
  };
  const opening = f.registry.open(a.input); const rejected = assert.rejects(opening);
  await entered.promise; const containing = a.contain();
  await tick(); gate.resolve(); await rejected; assert.equal((await containing).kind, "closed");
  assert.equal(f.registry.processes.get(a.input.expected.custodyRef), undefined);
  assert.equal(f.events.includes("provider-exec"), false); assert.equal(f.channel.closes, 1);
});

test("otherwise clean drain racing an unacknowledged input write cannot publish EOF or code zero", async t => {
  for (const action of ["write", "close"] as const) {
    await t.test(action, async () => {
      const f = fixture(); const a = await f.launch(); t.after(() => a.contain()); const process = await f.registry.open(a.input);
      const gate = deferred(); const entered = deferred();
      f.channel.onMessage = async () => {entered.resolve(); await gate.promise;};
      const writing = action === "write" ? process.write(Buffer.from("pending")) : process.closeInput();
      const writeFailed = assert.rejects(writing, unknownWrite); await entered.promise;
      const outFailed = assert.rejects(process.stdout[Symbol.asyncIterator]().next());
      const errFailed = assert.rejects(process.stderr[Symbol.asyncIterator]().next());
      const exitFailed = assert.rejects(process.waitForExit());
      f.channel.rootExit(); f.channel.drain(); await Promise.all([writeFailed, outFailed, errFailed, exitFailed]);
      gate.resolve(); await tick(); await assert.rejects(process.waitForExit());
      await assert.rejects(process.closeInput());
      assert.equal(f.events.filter(event => event === "provider-input" || event === "provider-input-eof").length, 1);
    });
  }
});


test("unrepresentable Docker exit signal rejects streams and exit instead of clean EOF", async t => {
  const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
  const process = await f.registry.open(a.input);
  const output = assert.rejects(process.stdout[Symbol.asyncIterator]().next(), /unsupported-exit-signal/);
  const diagnostic = assert.rejects(process.stderr[Symbol.asyncIterator]().next(), /unsupported-exit-signal/);
  const exit = assert.rejects(process.waitForExit(), /unsupported-exit-signal/);
  f.channel.push({kind: "provider-observation", observation: "root-exited", exitCode: null, signal: "SIGEMT",
    requestId: providerExec.requestId, treeEmptyClaim: "not-claimed"});
  f.channel.drain(); await Promise.all([output, diagnostic, exit]);
});


test("large logical writes are snapshotted and framed sequentially before the one close", async t => {
  const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
  const process = await f.registry.open(a.input); const gate = deferred(); const entered = deferred();
  const frames: Buffer[] = [];
  f.channel.onMessage = async message => {
    if (message.kind !== "provider-input") {return;}
    frames.push(Buffer.from(message.bytesBase64, "base64"));
    if (frames.length === 1) {entered.resolve(); await gate.promise;}
  };
  const original = Buffer.alloc(DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES * 2 + 7, 120);
  const writing = process.write(original); original.fill(0); await entered.promise;
  await assert.rejects(process.write(Buffer.from("overlap")), /write-in-progress/);
  const closing = process.closeInput(); await tick(); assert.equal(frames.length, 1);
  gate.resolve(); await writing; await closing;
  assert.deepEqual(frames.map(frame => frame.length), [48_000, 48_000, 7]);
  assert.equal(Buffer.concat(frames).equals(Buffer.alloc(96_007, 120)), true);
  assert.equal(f.events.filter(event => event === "provider-input-eof").length, 1);
});

test("unknown second frame permanently fails the logical write without sending its tail", async t => {
  const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
  const process = await f.registry.open(a.input); let frames = 0;
  f.channel.onMessage = message => {
    if (message.kind === "provider-input" && ++frames === 2) {throw new Error("second acknowledgement lost");}
  };
  await assert.rejects(process.write(Buffer.alloc(144_000)), unknownWrite);
  await assert.rejects(process.write(Buffer.from("retry"))); await assert.rejects(process.closeInput());
  assert.equal(frames, 2); await assert.rejects(process.waitForExit());
});


test("prepared IO keeps one attach/reader and bounded early output through the later claim", async t => {
  const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
  const preparedIo = prepareDockerProviderProcessIo(a.input);
  assert.equal((await preparedIo.ready()).kind, "ready");
  assert.equal(f.events.includes("provider-exec"), false);
  assert.equal(dockerProviderProcessMountFacts(a.launched).workspaceSource, a.input.expected.workspaceAuthorityPath);
  assert.throws(() => prepareDockerProviderProcessIo(a.input), /one-use/);
  f.channel.onMessage = message => {
    f.channel.respond(message);
    if (message.kind === "provider-exec") {f.channel.outputBytes("stdout", "early");}
  };
  const process = await createDockerProviderProcessBridge().open({...a.input, preparedIo});
  await tick(); const reads = f.channel.reads; await tick();
  assert.equal(f.channel.reads, reads, "early output waits in bounded custody for its sole consumer");
  assert.equal(Buffer.from((await process.stdout[Symbol.asyncIterator]().next()).value!).toString(), "early");
  f.channel.rootExit(); f.channel.drain(); await process.waitForExit();
  assert.equal(f.channel.readers, 1); assert.equal(f.events.filter(event => event === "attach").length, 1);
  assert.equal(f.events.filter(event => event === "provider-exec").length, 1);
  await assert.rejects(createDockerProviderProcessBridge().open({...a.input, preparedIo}), /unused actual/);
});

for (const mismatch of ["copy", "cross-launch", "configuration", "authority", "generation"] as const) {
  test(`prepared IO rejects ${mismatch} without a second session or fallback`, async t => {
    const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
    const preparedIo = prepareDockerProviderProcessIo(a.input); await preparedIo.ready();
    let input = {...a.input, preparedIo};
    if (mismatch === "copy") {input.preparedIo = {...preparedIo};}
    if (mismatch === "cross-launch") {
      const other = fixture(); const b = await other.launch(); t.after(() => b.contain());
      input = {...b.input, preparedIo};
    }
    if (mismatch === "configuration") {input.init = {...input.init, maximumStdoutBytes: 7};}
    if (mismatch === "authority") {input.expected = {...input.expected, custodyRef: "foreign"};}
    if (mismatch === "generation") {input.init = {...input.init, isCurrentGeneration: () => true};}
    await assert.rejects(createDockerProviderProcessBridge().open(input), /exact unused launch/);
    await assert.rejects(createDockerProviderProcessBridge().open(input), /unused actual/);
    assert.equal(f.events.includes("provider-exec"), false); assert.equal(f.channel.readers, 1);
  });
}

test("prepared IO enforces its original output bound before bridge publication", async t => {
  const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
  a.input.init.maximumStdoutBytes = 1;
  const preparedIo = prepareDockerProviderProcessIo(a.input); await preparedIo.ready();
  f.channel.onMessage = message => {
    f.channel.respond(message);
    if (message.kind === "provider-exec") {f.channel.outputBytes("stdout", "overflow");}
  };
  const process = await createDockerProviderProcessBridge().open({...a.input, preparedIo});
  await assert.rejects(process.waitForExit());
  await assert.rejects(process.stdout[Symbol.asyncIterator]().next());
  assert.equal(f.channel.readers, 1);
});

test("Docker inert capture rejects proxies and accessors before executing traps or opening a reader", async t => {
  const {captureDockerHttpResourceRecord} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js");
  const {custodyDataRecord} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js");
  let invoked = 0;
  const proxy = new Proxy({}, {ownKeys() {invoked += 1; return [];}, getPrototypeOf() {invoked += 1; return Object.prototype;},
    get() {invoked += 1; throw new Error("proxy invoked");}});
  const accessor = Object.defineProperty({}, "value", {get() {invoked += 1; return "value";}});
  const symbolAccessor = Object.defineProperty({}, Symbol("hidden"), {get() {invoked += 1; return "value";}});
  for (const bad of [proxy, accessor, symbolAccessor]) {
    assert.throws(() => custodyDataRecord(bad)); assert.throws(() => captureDockerHttpResourceRecord(bad));
  }
  const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
  for (const bad of [proxy, accessor, symbolAccessor]) {
    for (const input of [bad, {...a.input, expected: bad}, {...a.input, init: bad},
      {...a.input, expected: {...a.input.expected, authority: bad}},
      {...a.input, init: {...a.input.init, authority: bad}}]) {
      assert.throws(() => prepareDockerProviderProcessIo(input as never));
    }
  }
  assert.equal(invoked, 0); assert.equal(f.channel.readers, 0); assert.equal(f.events.includes("provider-exec"), false);
});
