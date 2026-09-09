import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { StableProcessGroupGuardian } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-stable-guardian.js";

// Exercise the actual embedded program in THIS workspace's emitted AE build.
// All OS effects below are controlled observations, not native Darwin evidence.
const {GUARDIAN_SOURCE: source} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-guardian-program.js");

const fixture = (darwin = true, route = false) => {
  const calls: string[] = [];
  const messages: Record<string, unknown>[] = [];
  const timers = new Map<object, {callback: () => void; delay: number}>();
  const provider = Object.assign(new EventEmitter(), {
    pid: 99, exitCode: null as number | null, signalCode: null as string | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill(signal: string) {calls.push(`provider:${signal}`); return true;},
  });
  const host = Object.assign(new EventEmitter(), {
    pid: 88, getuid: () => 1000, argv: darwin ? ["node", "100"] : ["node"], connected: true,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    send: ((message: Record<string, unknown>, callback?: (error: Error | null) => void) => {
      messages.push(message); callback?.(null);
    }) as ((message: Record<string, unknown>, callback?: (error: Error | null) => void) => void) | undefined,
    kill(pid: number, signal: string) {calls.push(`group:${pid}:${signal}`);},
    exit(code: number) {calls.push(`exit:${code}`);},
  });
  let spawnOptions: {stdio: unknown[]} | undefined;
  const stat = {dev: 1n, ino: 2n, uid: 1000n, mode: 0o100755n, nlink: 1n, isSymbolicLink: () => false, isFile: () => true, isDirectory: () => true};
  let nativeImage: unknown = {protocol: "ae-darwin-owned-image/v1", pid: 99, ppid: 88, pgid: 88,
    birthSeconds: "1000", birthMicros: "1", dev: "1", ino: "2"};
  let observeError = false;
  let command: string | undefined; let launchArguments: string[] | undefined;
  const modules: Record<string, unknown> = {
    "node:child_process": {spawn: (_command: string, _args: string[], options: {stdio: unknown[]}) => {
      calls.push("spawn"); command = _command; launchArguments = _args; spawnOptions = options; return provider;
    }, execFileSync: () => {calls.push("observe"); if (observeError) {throw new Error("wrapper pending");} return JSON.stringify(nativeImage);}},
    "node:crypto": {createHash},
    "node:fs": {fstatSync: () => stat, lstatSync: () => stat, readFileSync: () => Buffer.from("pinned")},
    "node:stream": {pipeline: () => {}},
  };
  runInNewContext(source!, {process: host, require: (id: string) => {
    assert.ok(Object.hasOwn(modules, id)); return modules[id];
  }, setTimeout: (callback: () => void, delay: number) => {
    const timer = {}; timers.set(timer, {callback, delay}); return timer;
  }, clearTimeout: (timer: object) => {timers.delete(timer);}});
  const launch = () => host.emit("message", {
    type: "launch", command: "/owned/codex", cwd: "/owned/workspace",
    ...(route ? {darwinRoute: {
      profile: "pinned", profileSha256: createHash("sha256").update("pinned").digest("hex"),
      provider: {path: "/owned/codex", dev: "1", ino: "2", uid: "1000", sha256: createHash("sha256").update("pinned").digest("hex")},
      observer: {path: "/owned/observer", dev: "1", ino: "2", uid: "1000", sha256: createHash("sha256").update("pinned").digest("hex")},
      launcher: {path: "/usr/bin/sandbox-exec", dev: "1", ino: "2", uid: "1000", sha256: createHash("sha256").update("pinned").digest("hex")},
    }} : {}),
    arguments: [], environment: {}, inheritedDescriptors: [4, 5, 6],
    ...(darwin ? {canonicalAuthority: {
      executableDescriptor: 5, workspaceDescriptor: 4, executableDev: "1", executableIno: "2",
      workspaceDev: "1", workspaceIno: "2",
      executableSha256: createHash("sha256").update("pinned").digest("hex"),
    }} : {}),
  });
  const fire = (delay: number) => {
    const entry = [...timers].find(([, value]) => value.delay === delay);
    assert.ok(entry, `missing ${delay}ms timer`); timers.delete(entry[0]); entry[1].callback();
  };
  const disconnect = () => {host.connected = false; host.emit("disconnect");};
  return {calls, messages, timers, provider, host, launch, fire, disconnect, options: () => spawnOptions,
    command: () => command, arguments: () => launchArguments, setImage: (value: unknown) => {nativeImage = value;},
    observationFails: (value: boolean) => {observeError = value;}};
};

test("emitted Darwin guardian keeps zero proof descriptors; Linux projection is unchanged", () => {
  const darwin = fixture(); darwin.launch();
  assert.deepEqual(Array.from(darwin.options()!.stdio), ["pipe", "pipe", "pipe"]);
  const linux = fixture(false); linux.launch();
  assert.deepEqual(Array.from(linux.options()!.stdio), ["pipe", "pipe", "pipe", "ignore", 4, 5, 6]);
  assert.equal(linux.timers.size, 0);
  linux.disconnect(); assert.deepEqual(linux.calls, ["spawn"]);
});

test("Host loss stops the retained direct provider before group shutdown and waits for exit", () => {
  const f = fixture(); f.launch(); f.provider.emit("spawn"); f.disconnect();
  assert.deepEqual(f.calls, ["spawn", "provider:SIGKILL"]);
  f.provider.exitCode = 0; f.provider.emit("exit", 0, null);
  assert.deepEqual(f.calls, ["spawn", "provider:SIGKILL", "group:0:SIGKILL"]);
  assert.equal(f.timers.size, 0);
  f.disconnect(); assert.equal(f.calls.length, 3);
});

test("direct child shutdown remains bounded without an exit acknowledgement", () => {
  const f = fixture(); f.launch(); f.disconnect(); f.fire(1000);
  assert.deepEqual(f.calls, ["spawn", "provider:SIGKILL", "group:0:SIGKILL"]);
  assert.equal(f.messages.some(message => message.type === "provider-exit"), false);
});

test("admission timeout before launch refuses a late launch message", () => {
  const f = fixture(); f.fire(100); f.launch();
  assert.deepEqual(f.calls, ["group:0:SIGKILL"]);
});

test("admission timeout during spawn stops the child and refuses late acknowledgement", () => {
  const f = fixture(); f.launch(); f.fire(100); f.provider.emit("spawn");
  assert.equal(f.messages.some(message => message.type === "started"), false);
  assert.ok(f.calls.includes("provider:SIGKILL"));
});

test("Host loss before launch refuses allocation", () => {
  const f = fixture(); f.disconnect(); f.launch();
  assert.deepEqual(f.calls, ["group:0:SIGKILL"]);
});

test("missing, throwing and failed send all preserve local shutdown", () => {
  for (const mode of ["missing", "throw", "callback"] as const) {
    const f = fixture(); f.launch();
    f.host.send = mode === "missing" ? undefined : mode === "throw"
      ? () => {throw new Error("IPC lost");}
      : (_message, callback) => {callback?.(new Error("IPC lost"));};
    f.provider.emit("spawn");
    assert.deepEqual(f.calls, ["spawn", "provider:SIGKILL"], mode);
    f.fire(1000);
    assert.equal(f.calls.at(-1), "group:0:SIGKILL");
  }
});

test("Darwin SIGKILL request signals the direct child even if reporting never acknowledges", () => {
  const f = fixture(); f.launch(); f.provider.emit("spawn");
  f.host.send = () => {};
  f.host.emit("message", {type: "signal", signal: "SIGKILL"});
  assert.deepEqual(f.calls, ["spawn", "provider:SIGKILL"]);
  f.fire(1000); assert.equal(f.calls.at(-1), "group:0:SIGKILL");
});

test("actual emitted Host guardian refuses late beforeLaunch after its admission deadline", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  const sent: Record<string, unknown>[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 101, connected: true, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    send(message: Record<string, unknown>) {sent.push(message);},
    disconnect() {this.connected = false;}, kill() {return true;},
  });
  const spawn = t.mock.method(childProcess, "spawn", () => child as never);
  syncBuiltinESMExports();
  t.after(() => {spawn.mock.restore(); syncBuiltinESMExports();});
  const attached = Promise.withResolvers<boolean>();
  const guardian = new StableProcessGroupGuardian({
    arguments: [], environment: {}, beforeLaunch: () => attached.promise, launchPermitted: () => true,
    canonicalLaunch: {command: "/owned/codex", cwd: "/owned/workspace", executableDev: "1",
      executableIno: "2", executableSha256: "a".repeat(64), workspaceDev: "1", workspaceIno: "3"},
    descriptors: {workspaceDescriptor: {childDescriptor: 4, parentDescriptor: 4},
      executableDescriptor: {childDescriptor: 5, parentDescriptor: 5}, privatePathDescriptors: {}} as never,
  }, 100);
  child.emit("message", {type: "ready"});
  t.mock.timers.tick(100);
  assert.equal((await guardian.start).status, "error-before-start");
  attached.resolve(true); await Promise.resolve(); await Promise.resolve();
  assert.equal(sent.some(message => message.type === "launch"), false);
  assert.equal(sent.some(message => message.type === "shutdown"), true);
  assert.equal(child.connected, true);
  t.mock.timers.tick(1500);
  assert.equal(child.connected, false);
  const argv = spawn.mock.calls[0]!.arguments[1];
  assert.ok(Array.isArray(argv)); assert.equal(argv.at(-1), "100");
});


test("route guardian does not acknowledge wrapper spawn; exact two native observations precede final started", () => {
  const f = fixture(true, true); f.launch();
  assert.equal(f.command(), "/usr/bin/sandbox-exec");
  assert.deepEqual(Array.from(f.arguments()!), ["-p", "pinned", "/owned/codex"]);
  assert.deepEqual(Array.from(f.options()!.stdio), ["pipe", "pipe", "pipe"]);
  f.provider.emit("spawn"); assert.equal(f.messages.some(message => message.type === "started"), false);
  f.fire(1);
  const started = f.messages.find(message => message.type === "started");
  assert.equal(started?.pid, 99); assert.ok(started); assert.equal((started.darwinImage as {ino: string}).ino, "2");
  assert.equal(f.calls.filter(call => call === "observe").length, 2);
});

test("route guardian delayed exec, final image mismatch, PID reuse and Host loss never produce final acknowledgement", () => {
  for (const mode of ["pending", "wrong-image", "birth-change", "disconnect"] as const) {
    const f = fixture(true, true); f.launch();
    if (mode === "pending") {f.observationFails(true);}
    if (mode === "wrong-image") {f.setImage({});}
    f.provider.emit("spawn");
    if (mode === "pending") {f.fire(10); f.fire(100);}
    if (mode === "birth-change") {
      f.setImage({protocol: "ae-darwin-owned-image/v1", pid: 99, ppid: 88, pgid: 88,
        birthSeconds: "1001", birthMicros: "1", dev: "1", ino: "2"}); f.fire(1);
    }
    if (mode === "disconnect") {f.disconnect();}
    assert.equal(f.messages.some(message => message.type === "started"), false, mode);
    assert.ok(f.calls.includes("provider:SIGKILL"), mode);
  }
});
