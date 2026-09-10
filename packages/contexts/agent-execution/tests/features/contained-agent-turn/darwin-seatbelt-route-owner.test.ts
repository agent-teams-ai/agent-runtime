import assert from "node:assert/strict";
import { test, after } from "node:test";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { PassThrough } from "node:stream";
import { fixture, file, directory, sessionDependencies, guarded, controlDarwinChildObservations, syntheticNodeModule, mutate } from "./darwin-native-finalization-fixture.ts";
const {DarwinSeatbeltRouteOwner} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-seatbelt-route-owner.js");
const {DarwinRouteLifecycleJournal} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-route-lifecycle-journal.js");
const {pinDarwinExecutable, createDarwinSeatbeltProjection} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-seatbelt-launch-projection.js");
const {darwinDigest} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-route-durable-storage.js");
const {acknowledgeProviderSpawn} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-spawn-acknowledgement.js");
const issuer = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
Object.defineProperty(process, "platform", {...platform, value: "darwin"});
after(() => {Object.defineProperty(process, "platform", platform); controlDarwinChildObservations();});

const flush = async () => {for (let i = 0; i < 16; i++) {await Promise.resolve();}};

const setup = async () => {
  const f = fixture("analysis", true); const reservation = await f.reserve(); const records: string[] = [];
  let now = 0; let epoch = "epoch-1"; let reentrant: (() => void) | undefined;
  for (const path of ["/System/Library", "/usr/lib", "/usr/bin", "/owned", "/durable", process.execPath.slice(0, process.execPath.lastIndexOf("/"))]) {directory(path);}
  for (const path of ["/owned/observer", "/usr/bin/sandbox-exec", process.execPath]) {file(path, Buffer.from("pinned tool"), 0o100700);}
  const pin = (path: string) => pinDarwinExecutable(path, darwinDigest("pinned tool"));
  const node = pin(process.execPath); const observer = pin("/owned/observer"); const launcher = pin("/usr/bin/sandbox-exec");
  const provider = pinDarwinExecutable(f.options.executablePath, f.plan.executableSha256);
  const journal = new DarwinRouteLifecycleJournal({append: (_file: string, kind: string) => {records.push(kind);}, assertIntact() {}, close: async () => true} as never, reservation.lifetime);
  const localCut = {expectedClock: {authorityId: "clock-authority", epoch: "epoch-1"}, operationDeadline: 100,
    clock: {read: () => {reentrant?.(); return {authorityId: "clock-authority", epoch, controlTime: now};},
      within: async <T>(_deadline: number, operation: () => Promise<T>) => operation()}};
  const owner = new DarwinSeatbeltRouteOwner(reservation.lifetime, journal, localCut, 200, {node, nativeLaunch: issuer.codexNativeBrokerLaunchInput, files: async () => true});
  reservation.live.httpReservation.retainDarwinRoute(reservation.live, reservation.lifetime, owner);
  const projection = createDarwinSeatbeltProjection({provider, observer, launcher, protectedRoot: "/durable",
    endpoint: {address: "127.0.0.1", family: "IPv4", port: 32123}, operationBinding: {proof: reservation.lifetime.committedDispatchProof.proofDigest},
    readPaths: ["/System/Library", "/usr/lib", f.options.boundary.workspaceRef, f.options.boundary.codexHome], writePaths: [f.options.tmpDir]});
  const prepare = () => owner.run(async () => {
    owner.authorize(projection); const material = await f.install(); const finalizer = reservation.bind();
    const stage = await finalizer.stage({recipe: f.recipe, files: material});
    finalizer.bindSession({...sessionDependencies(reservation), routeFirstWrite: owner.firstWrite});
    const final = finalizer.commit(stage); records.push("prepared"); return final;
  });
  return {...f, ...reservation, owner, records, projection, prepare, node,
    time: (value: number) => {now = value;}, epoch: (value: string) => {epoch = value;},
    reenter: (callback?: () => void) => {reentrant = callback;}};
};

const image = (pid: number, ppid: number, pgid: number, pin: {dev: string; ino: string}) => ({protocol: "ae-darwin-owned-image/v1",
    pid, ppid, pgid, birthSeconds: "123", birthMicros: "1", dev: pin.dev, ino: pin.ino});

const launch = async (f: Awaited<ReturnType<typeof setup>>) => {
  const sent: Record<string, unknown>[] = [];
  const child = Object.assign(new EventEmitter(), {pid: 501, connected: true, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    send(message: Record<string, unknown>, callback?: (error: null) => void) {sent.push(message); callback?.(null);},
    disconnect() {this.connected = false;}, kill() {return true;}});
  controlDarwinChildObservations(() => child, () => JSON.stringify(image(501, process.pid, 501, f.node)));
  f.live.residueAuthority = {attachGuardian: async () => true} as never;
  f.live.launchBinding.firstStart(f.live);
  const guardedLaunch = guarded.launchGuardedProvider({live: f.live, arguments: f.live.plan!.arguments,
    environment: f.live.plan!.environment, maxDiagnosticBytes: 256, maxStderrBytes: 1024, maxStdinBytes: 1024,
    maxStdoutBytes: 1024, stdoutHighWaterBytes: 256, monotonicNow: () => 0, writeAfterMs: 100,
    spawnAcknowledgementAfterMs: 100, onAbort() {}, onOverflow() {}});
  f.live.guardian = guardedLaunch.guardian;
  child.emit("message", {type: "ready"}); await Promise.resolve(); await Promise.resolve();
  assert.equal(sent.some(message => message.type === "launch"), true);
  assert.equal(f.owner.state, "launch-authorized");
  const native = image(502, 501, 501, f.projection.provider);
  child.emit("message", {type: "started", pid: 502, darwinImage: native});
  const result = await acknowledgeProviderSpawn(f.live, guardedLaunch.guardian, {
    hostLifecycleGenerationSha256: f.lifetime.hostLifecycleGenerationSha256, identityObservationAfterMs: 100,
    monotonicNow: () => 0, onStartFailure: async () => {}, spawnAcknowledgementAfterMs: 100,
    spawnAcknowledgementObserver: undefined, processIdentityObserver: {observe: async input => ({...input, status: "proved", proofRef: "synthetic-group-only"})},
  });
  guardedLaunch.authority.close(); child.emit("close");
  return {result, native, sent};
};

test("same actual reservation prepares/finalizes before guardian and installs after native plus existing acknowledgement", async t => {
  const f = await setup(); t.after(f.close); const final = await f.prepare();
  assert.equal(f.live.launchBinding.view.readFinal(), final); assert.ok(f.live.httpReservation.pending);
  const launched = await launch(f); assert.equal(launched.result, "acknowledged"); assert.equal(f.owner.state, "installed");
  assert.ok(f.records.indexOf("prepared") < f.records.indexOf("guardian_allocation_intent"));
  assert.ok(f.records.indexOf("provider_exec_intent") < f.records.indexOf("final_image_installed"));
  assert.equal((launched.sent.find(message => message.type === "launch")!.darwinRoute as {digest: string}).digest, f.projection.digest);
  const firstWrite = f.owner.firstWrite.reserve("request");
  assert.equal(f.records.at(-1), "request_reserved");
  assert.equal(firstWrite.consume(), true);
  assert.throws(() => f.owner.firstWrite.reserve("request")); assert.equal(f.owner.state, "cut");
});

test("guardian preflight failure remains no-intent and permits complete route cleanup", async t => {
  const f = await setup(); t.after(f.close); await f.prepare(); f.live.launchBinding.firstStart(f.live);
  let constructed = 0; controlDarwinChildObservations(() => {constructed++; throw new Error("forbidden guardian");});
  f.time(100);
  assert.throws(() => guarded.launchGuardedProvider({live: f.live, arguments: f.live.plan!.arguments,
    environment: f.live.plan!.environment, maxDiagnosticBytes: 256, maxStderrBytes: 1024, maxStdinBytes: 1024,
    maxStdoutBytes: 1024, stdoutHighWaterBytes: 256, monotonicNow: () => 0, writeAfterMs: 100,
    spawnAcknowledgementAfterMs: 100, onAbort() {}, onOverflow() {}}));
  assert.equal(constructed, 0); assert.equal(f.records.includes("guardian_allocation_intent"), false);
  let resources = 0; assert.equal(await f.owner.cleanup(async () => {resources++; return true;}), true);
  assert.equal(resources, 1); assert.equal(f.owner.state, "released");
});

test("recorded guardian intent without published guardian remains quarantined", async t => {
  const f = await setup(); t.after(f.close); await f.prepare(); f.live.launchBinding.firstStart(f.live);
  f.owner.prepareGuardianAllocation(100);
  let resources = 0; assert.equal(await f.owner.cleanup(async () => {resources++; return true;}), false);
  assert.equal(resources, 0); assert.equal(f.records.includes("guardian_allocation_intent"), true);
  assert.notEqual(f.owner.state, "released");
});

test("early request cuts preparation permanently; missing/copy route session and wrong lifetime cannot commit", async t => {
  for (const mode of ["early", "missing-route", "copy-route", "copy-lifetime"] as const) {
    const f = await setup(); t.after(f.close);
    if (mode === "early") {
      assert.throws(() => f.owner.firstWrite.reserve("early")); await assert.rejects(f.prepare()); continue;
    }
    if (mode === "copy-lifetime") {
      assert.throws(() => f.live.httpReservation.retainDarwinRoute(f.live, {...f.lifetime}, f.owner)); continue;
    }
    f.owner.authorize(f.projection); const files = await f.install(); const finalizer = f.bind();
    const staged = await finalizer.stage({recipe: f.recipe, files});
    assert.throws(() => finalizer.bindSession({...sessionDependencies(f),
      ...(mode === "copy-route" ? {routeFirstWrite: {...f.owner.firstWrite}} : {})}));
    assert.throws(() => finalizer.commit(staged));
  }
});

test("expiry, epoch drift, rollback, abort and reentrant cut between reserve and consume emit no permitted byte", async t => {
  for (const mode of ["expiry", "epoch", "rollback", "abort", "reentrant"] as const) {
    const f = await setup(); t.after(f.close); await f.prepare(); await launch(f);
    f.time(10); const reservation = f.owner.firstWrite.reserve("one");
    if (mode === "expiry") {f.time(100);}
    if (mode === "epoch") {f.epoch("foreign");}
    if (mode === "rollback") {f.time(9);}
    if (mode === "abort") {f.controller.abort();}
    if (mode === "reentrant") {f.reenter(() => f.owner.cutoff());}
    assert.equal(reservation.consume(), false, mode); assert.equal(reservation.consume(), false);
    assert.equal(f.owner.state, "cut");
  }
});

test("exact IPv4 TCP profile and retained material reject endpoint/pin substitutions", async t => {
  const f = await setup(); t.after(f.close); await f.prepare();
  assert.ok(f.projection.profile.includes('(require-all (remote tcp "localhost:32123") (socket-domain AF_INET))'));
  assert.equal(f.projection.profile.includes("remote ip"), false);
  assert.equal(f.projection.profile.includes('(remote tcp "127.0.0.1:'), false);
  assert.ok(f.projection.profile.includes("(deny process-fork)"));
  assert.throws(() => f.owner.bindFinal({...f.live.launchBinding.view.readFinal()}));
  assert.throws(() => createDarwinSeatbeltProjection({provider: f.projection.provider,
    observer: f.projection.observer, launcher: f.projection.launcher, protectedRoot: "/durable", operationBinding: {},
    endpoint: {address: "localhost", family: "IPv4", port: 32123}, readPaths: [], writePaths: []} as never));
});

test("copied projection and different native recipe endpoint cannot authorize the finalized route", async t => {
  for (const mode of ["copy", "endpoint"] as const) {
    const f = await setup(); t.after(f.close);
    if (mode === "copy") {assert.throws(() => f.owner.authorize({...f.projection})); continue;}
    const different = createDarwinSeatbeltProjection({provider: f.projection.provider, observer: f.projection.observer,
      launcher: f.projection.launcher, protectedRoot: "/durable", operationBinding: {},
      endpoint: {...f.projection.endpoint, port: 32124}, readPaths: [f.boundary.codexHome], writePaths: [f.options.tmpDir]});
    f.owner.authorize(different); const files = await f.install(); const finalizer = f.bind();
    const staged = await finalizer.stage({recipe: f.recipe, files});
    finalizer.bindSession({...sessionDependencies(f), routeFirstWrite: f.owner.firstWrite});
    assert.throws(() => finalizer.commit(staged)); assert.equal(f.owner.state, "cut");
    assert.throws(() => f.live.launchBinding.view.readFinal());
  }
});

test("same reservation retains pending route flight through abort and refuses its late publication", async t => {
  const f = await setup(); t.after(f.close);
  const gate = Promise.withResolvers<void>(); const begun = Promise.withResolvers<void>();
  const work = f.owner.run(async () => {begun.resolve(); await gate.promise; f.owner.authorize(f.projection);});
  const rejected = assert.rejects(work); await begun.promise;
  const pending = f.live.httpReservation.pending; assert.ok(pending);
  let finished = false; void pending.then(() => {finished = true; return;});
  f.controller.abort(); await Promise.resolve(); assert.equal(finished, false);
  gate.resolve(); await rejected; await pending;
  assert.equal(finished, true); assert.equal(f.owner.state, "cut");
  assert.equal(f.records.includes("launch_profile_authorized"), false);
});


test("executable pin rejects matching bytes owned by a foreign UID and rechecks retained UID", async t => {
  const f = await setup(); t.after(f.close);
  const {recheckDarwinExecutable} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-seatbelt-launch-projection.js");
  mutate("/owned/observer", {uid: process.getuid!() + 1});
  assert.throws(() => pinDarwinExecutable("/owned/observer", darwinDigest("pinned tool")), /trusted executable/u);
  assert.throws(() => recheckDarwinExecutable(f.projection.observer));
  mutate("/owned/observer", {uid: process.getuid!() === 0 ? 1 : 0});
  assert.throws(() => recheckDarwinExecutable(f.projection.observer));
  mutate("/owned/observer", {uid: process.getuid!()});
});

test("bootstrap operations are explicit and do not widen execution, network or operation writes", async t => {
  const f = await setup(); t.after(f.close); const profile = f.projection.profile;
  for (const required of ['(allow sysctl-read)', '(mac-policy-name "vnguard")',
    '(require-all (mac-policy-name "Sandbox") (mac-syscall-number 67))',
    '(allow file-map-executable (subpath "/usr/lib"))',
    `(allow file-map-executable (literal "${f.options.executablePath}"))`,
    `(path-ancestors "${f.options.tmpDir}")`, `(path-ancestors "${f.boundary.workspaceRef}")`,
    '(deny process-fork)', '(deny network-inbound)', '(deny file-read* file-write* (subpath "/durable"))']) {
    assert.ok(profile.includes(required), required);
  }
  assert.deepEqual(profile.split("\n").filter(line => line.startsWith("(allow process-exec")),
    [`(allow process-exec (literal "${f.options.executablePath}"))`]);
  assert.deepEqual(profile.split("\n").filter(line => line.startsWith("(allow network")),
    ['(allow network-outbound (require-all (remote tcp "localhost:32123") (socket-domain AF_INET)))']);
  for (const forbidden of ['(allow process-exec)', 'mach-lookup', 'mach-register', '(remote tcp "127.0.0.1:',
    '(subpath "/System")', '(subpath "/usr")', '(subpath "/Library")', '(subpath "/")',
    `(allow file-read* file-write* (subpath "${f.boundary.workspaceRef}")`,
    `(allow file-read* file-write* (subpath "${f.boundary.codexHome}")`]) {assert.equal(profile.includes(forbidden), false, forbidden);}
});

test("actual outer guardian, embedded program and route cleanup join through cutoff and pending identity abort", async t => {
  for (const mode of ["normal", "pending", "disconnect", "timeout"] as const) {
    const pending = mode === "pending";
    const f = await setup(); t.after(f.close); await f.prepare();
    const timers = new Map<object, {callback: () => void; delay: number}>();
    const pipelines: (() => void)[] = []; const delivered: string[] = []; const calls: string[] = [];
    let embedded = ""; let inherited: unknown[] = []; let heldDelivery: (() => void) | undefined;
    const provider = Object.assign(new EventEmitter(), {pid: 502, exitCode: null, signalCode: null as string | null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() {calls.push("direct-child-kill"); return true;}});
    const remote = Object.assign(new EventEmitter(), {pid: 501, getuid: process.getuid,
      argv: ["node", "100"], connected: true, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      send(message: {type: string; stream?: string}, callback?: (error: null) => void) {
        queueMicrotask(() => {if (child.connected) {
          child.emit("message", message); delivered.push(message.type);
          if (mode === "normal" && message.type === "stream-final" && message.stream === "stderr") {
            heldDelivery = () => callback?.(null);
          } else {callback?.(null);}
        }});
      },
      kill(pid: number, signal: string) {assert.equal(pid, 0); calls.push("guardian-kill");
        child.signalCode = signal; child.emit("exit", null, signal); child.emit("close");},
      exit() {assert.fail("unexpected guardian exit fallback");}});
    const child = Object.assign(new EventEmitter(), {pid: 501, connected: true, exitCode: null, signalCode: null as string | null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      send(message: {type: string}, callback?: (error: null) => void) {
        queueMicrotask(() => {remote.emit("message", message); callback?.(null);});
      }, disconnect() {calls.push("disconnect"); child.connected = false; remote.connected = false; remote.emit("disconnect");},
      kill() {assert.fail("Host must not bypass direct-child shutdown");}});
    controlDarwinChildObservations((_command, args, options) => {embedded = (args as string[])[1]!; inherited = (options as {stdio: unknown[]}).stdio; return child;},
      () => JSON.stringify(image(501, process.pid, 501, f.node)));
    f.live.residueAuthority = {attachGuardian: async () => true} as never;
    f.live.launchBinding.firstStart(f.live);
    const launched = guarded.launchGuardedProvider({live: f.live, arguments: f.live.plan!.arguments,
      environment: f.live.plan!.environment, maxDiagnosticBytes: 256, maxStderrBytes: 1024, maxStdinBytes: 1024,
      maxStdoutBytes: 1024, stdoutHighWaterBytes: 256, monotonicNow: () => 0, writeAfterMs: 100,
      spawnAcknowledgementAfterMs: 100, onAbort() {}, onOverflow() {}});
    f.live.guardian = launched.guardian; t.after(() => launched.authority.close());
    runInNewContext(embedded, {process: remote, require: (name: string) => {
      if (name === "node:child_process") {return {spawn: () => provider,
        execFileSync: () => JSON.stringify(image(502, 501, 501, f.projection.provider))};}
      if (name === "node:fs") {const fs = syntheticNodeModule(name); return {...fs,
        fstatSync: (fd: number, options: unknown) => (fs.fstatSync as (fd: unknown, options: unknown) => unknown)(inherited[fd], options)};}
      if (name === "node:stream") {return {pipeline: (_source: unknown, _dest: unknown, callback: () => void) => pipelines.push(callback)};}
      return syntheticNodeModule(name);
    }, setTimeout: (callback: () => void, delay: number) => {const key = {}; timers.set(key, {callback, delay}); return key;},
    clearTimeout: (key: object) => timers.delete(key)});
    await flush(); provider.emit("spawn");
    if (!pending) {
      const entry = [...timers].find(([, value]) => value.delay === 1)!; assert.ok(entry);
      timers.delete(entry[0]); entry[1].callback(); await flush();
      assert.equal((await launched.guardian.start).status, "acknowledged");
    }
    const retainedPending = f.live.httpReservation.pending;
    if (pending) {f.controller.abort();} else {f.owner.cutoff();}
    await flush(); assert.deepEqual(calls, ["direct-child-kill"]);
    assert.equal(f.live.httpReservation.pending, retainedPending);
    let resourcesClosed = 0;
    const cleanup = f.owner.cleanup(async () => {resourcesClosed++; return true;});
    if (mode === "disconnect" || mode === "timeout") {
      if (mode === "disconnect") {
        child.disconnect(); provider.signalCode = "SIGKILL"; provider.emit("exit", null, "SIGKILL");
      } else {
        const timer = [...timers].find(([, value]) => value.delay === 1000)!; assert.ok(timer);
        timers.delete(timer[0]); timer[1].callback();
      }
      await flush(); assert.equal(await cleanup, false); assert.equal(resourcesClosed, 0);
      assert.equal(launched.guardian.providerExit, undefined);
      assert.equal(await launched.guardian.streamFinal("stdout"), "incomplete");
      assert.equal(await launched.guardian.streamFinal("stderr"), "incomplete");
      assert.notEqual(f.owner.state, "released"); continue;
    }
    provider.signalCode = "SIGKILL"; provider.emit("exit", null, "SIGKILL"); await flush();
    assert.equal(resourcesClosed, 0); assert.equal(calls.includes("guardian-kill"), false);
    pipelines[0]!(); await flush(); assert.equal(calls.includes("guardian-kill"), false);
    pipelines[1]!(); await flush();
    if (mode === "normal") {
      assert.ok(heldDelivery); assert.equal(calls.includes("guardian-kill"), false);
      heldDelivery(); await flush();
    }
    assert.ok(delivered.includes("provider-exit")); assert.equal(delivered.filter(type => type === "stream-final").length, 2);
    assert.deepEqual(calls, ["direct-child-kill", "guardian-kill"]);
    assert.deepEqual(launched.guardian.providerExit, {code: null, signal: "SIGKILL"});
    assert.equal(await launched.guardian.streamFinal("stdout"), "complete");
    assert.equal(await launched.guardian.streamFinal("stderr"), "complete");
    assert.equal(await cleanup, true); assert.equal(resourcesClosed, 1); assert.equal(f.owner.state, "released");
    if (pending) {assert.equal((await launched.guardian.start).status, "ambiguous");}
    launched.authority.close();
  }
});
