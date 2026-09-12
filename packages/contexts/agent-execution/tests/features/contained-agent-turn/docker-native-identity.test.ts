import assert from "node:assert/strict";
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {EventEmitter, once} from "node:events";
import fs, {chmodSync, copyFileSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync, writeFileSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {join} from "node:path";
import {PassThrough} from "node:stream";
import {test} from "node:test";
import {holdDockerCustodyProviderExecutable} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/node-docker-custody-init-driver.js";
import {hash, tick} from "./support/docker-provider-observation-fixture.ts";
import {disposeChild, fixedChild, linux, nativeDriver, sandbox} from "./support/docker-native-identity-fixture.ts";

const descriptors = (path: string): string[] => readdirSync("/proc/self/fd").filter(fd => {
  try {return readlinkSync(`/proc/self/fd/${fd}`) === path;} catch {return false;}
});

test("native Linux copied executable maps the held object and seals the real child exit and drain", linux, async t => {
  const f = await nativeDriver(t);
  assert.equal(f.started.kind, "started");
  await f.session.writeInput(Buffer.from("native identity\n"));
  const {code, result} = await f.finish();
  assert.equal(code, 0); assert.equal(result.kind, "closed");
  assert.equal(result.observation.executableMapping, "observed");
  assert.equal(result.observation.status, "complete");
  assert.deepEqual(result.observation.stdout, {bytes: 16, sha256: hash("native identity\n")});
  assert.equal(result.observation.supervisorFinality, "unproven");
  const observed = result.observation.providerInstance;
  assert.equal(observed.status, "observed"); assert.ok("identity" in observed);
  const file = statSync(f.slot.executablePath, {bigint: true});
  assert.deepEqual(observed.identity.executableMapping, {device: file.dev.toString(), inode: file.ino.toString(),
    kind: "linux-procfs-exe-v1", scope: "spawn-observation", startTimeTicks: observed.identity.executableMapping?.startTimeTicks});
  assert.match(observed.identity.executableMapping!.startTimeTicks, /^[1-9][0-9]*$/u);
  assert.equal(observed.identity.executableSha256, f.slot.executableSha256);
  assert.deepEqual(observed.identity.binding, f.channel.exec().observationBinding);
  assert.deepEqual(result.observation.rootExit, {exitCode: 0, signal: null});
  assert.ok(Object.isFrozen(observed.identity.executableMapping));
  assert.equal(f.messages.filter(message => message.kind === "provider-instance").length, 1);
  assert.equal(f.messages.filter(message => message.kind === "provider-drain-complete").length, 1);
  assert.deepEqual(descriptors(f.slot.executablePath), []);
});

test("negative control: a held script's interpreter is not the held executable object", linux, async t => {
  const slot = sandbox(t); const interpreter = join(slot.directory, "copied-cat");
  copyFileSync("/bin/cat", interpreter); chmodSync(interpreter, 0o555);
  chmodSync(slot.executablePath, 0o755);
  const script = `#!/bin/sh\nexec '${interpreter}'\n`;
  writeFileSync(slot.executablePath, script); chmodSync(slot.executablePath, 0o555);
  // A pathname launch keeps the script readable by its interpreter after CLOEXEC.
  // This negative seam launches a real wrong mapping; it cannot supply evidence.
  const f = await nativeDriver(t, {...slot, executableSha256: hash(script)}, {
    spawnProcess: () => fixedChild(t, slot.executablePath),
  });
  assert.equal(f.started.kind, "started");
  const providerAssertion = '{"kind":"provider-instance","executableMapping":"observed"}\n';
  await f.session.writeInput(Buffer.from(providerAssertion));
  const {result} = await f.finish();
  assert.equal(result.observation.executableMapping, "unproven");
  assert.equal(result.observation.stdout.sha256, hash(providerAssertion));
  assert.equal(f.messages.filter(message => message.kind === "provider-instance").length, 1);
});

for (const source of ["/bin/cat", "/bin/tee"]) {
  test(`native mapped ${source} from another inode cannot match the held file`, linux, async t => {
    const expected = sandbox(t); const actual = sandbox(t, source);
    if (source === "/bin/cat") {
      assert.equal(actual.executableSha256, expected.executableSha256);
      assert.notEqual(statSync(actual.executablePath).ino, statSync(expected.executablePath).ino);
    }
    const held = holdDockerCustodyProviderExecutable(expected.executablePath, expected.executableSha256);
    try {
      const child = fixedChild(t, actual.executablePath); await once(child, "spawn");
      assert.equal(held.observeMapping(child), undefined);
    } finally {held.close();}
    assert.deepEqual(descriptors(expected.executablePath), []);
  });
}

test("held object survives a same-digest pathname replacement but replacement mapping is rejected", linux, async t => {
  const slot = sandbox(t); const held = holdDockerCustodyProviderExecutable(slot.executablePath, slot.executableSha256);
  try {
    renameSync(slot.executablePath, join(slot.directory, "original"));
    copyFileSync("/bin/cat", slot.executablePath); chmodSync(slot.executablePath, 0o555);
    assert.equal(hash(readFileSync(held.descriptorPath)), slot.executableSha256);
    assert.notEqual(statSync(held.descriptorPath).ino, statSync(slot.executablePath).ino);
    const child = fixedChild(t, slot.executablePath); await once(child, "spawn");
    assert.equal(held.observeMapping(child), undefined);
  } finally {held.close();}
});

test("symlinked slots fail before native launch and same-size content mutation invalidates the held digest", linux, async t => {
  const slot = sandbox(t); const moved = join(slot.directory, "moved");
  renameSync(slot.executablePath, moved); symlinkSync(moved, slot.executablePath);
  assert.throws(() => holdDockerCustodyProviderExecutable(slot.executablePath, slot.executableSha256));
  fs.unlinkSync(slot.executablePath); renameSync(moved, slot.executablePath);
  const held = holdDockerCustodyProviderExecutable(slot.executablePath, slot.executableSha256);
  try {
    const bytes = readFileSync(slot.executablePath);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    chmodSync(slot.executablePath, 0o755); writeFileSync(slot.executablePath, bytes); chmodSync(slot.executablePath, 0o555);
    const child = fixedChild(t, held.descriptorPath); await once(child, "spawn");
    assert.equal(held.observeMapping(child), undefined);
  } finally {held.close();}
});

test("sampling closes temporary procfs/exe descriptors and cannot observe after held close or reap", linux, async t => {
  const slot = sandbox(t); const held = holdDockerCustodyProviderExecutable(slot.executablePath, slot.executableSha256);
  const child = fixedChild(t, held.descriptorPath); await once(child, "spawn");
  try {
    const before = readdirSync("/proc/self/fd").length;
    assert.ok(held.observeMapping(child));
    assert.equal(held.observeMapping({...child} as ChildProcessWithoutNullStreams), undefined, "matching PID fields are not a native child");
    assert.equal(readdirSync("/proc/self/fd").length, before);
    const closed = once(child, "close"); child.stdin.end(); await closed;
    assert.equal(held.observeMapping(child), undefined);
    const other = fixedChild(t, slot.executablePath); await once(other, "spawn");
    Object.defineProperty(child, "pid", {value: other.pid});
    assert.equal(held.observeMapping(child), undefined, "an already-reaped native object cannot be rebound to a live PID");
  } finally {held.close(); held.close();}
  assert.equal(held.observeMapping(child), undefined);
  assert.throws(() => readFileSync(held.descriptorPath));
});

test("a fast child already gone at the native spawn callback retains unproven mapping", linux, async t => {
  const slot = sandbox(t, "/bin/true"); let child: ChildProcessWithoutNullStreams | undefined;
  const f = await nativeDriver(t, slot, {spawnProcess: specification => {
    child = spawn(specification.executablePath, [], {env: {}, stdio: ["pipe", "pipe", "pipe"]});
    t.after(async () => {if (child !== undefined) {await disposeChild(child);}});
    const deadline = performance.now() + 1_000;
    while (!readFileSync(`/proc/${child.pid}/stat`, "utf8").includes(") Z ")) {
      assert.ok(performance.now() < deadline, "fixed /bin/true must exit before releasing the native callback");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
    return child;
  }});
  assert.equal(f.started.kind, "started");
  const {code, result} = await f.finish();
  assert.equal(code, 0); assert.equal(result.observation.executableMapping, "unproven");
  assert.deepEqual(descriptors(slot.executablePath), []);
});

const deny = (): never => {throw Object.assign(new Error("synthetic procfs denial"), {code: "EACCES"});};

for (const fault of ["proc-denied", "exe-denied", "stat-read", "post-stat-read", "post-exe-read", "wrong-parent", "changed-start", "non-procfs", "held-readback"]) {
  test(`native readback uncertainty is unproven and closes temporary descriptors: ${fault}`, linux, async t => {
    const slot = sandbox(t); const held = holdDockerCustodyProviderExecutable(slot.executablePath, slot.executableSha256);
    const child = fixedChild(t, held.descriptorPath); await once(child, "spawn");
    const before = readdirSync("/proc/self/fd").length;
    let statReads = 0; let exeReads = 0;
    const read = fs.readFileSync; const open = fs.openSync; const filesystem = fs.statfsSync; const stat = fs.fstatSync;
    const mocks = [
      t.mock.method(fs, "openSync", ((...args: Parameters<typeof fs.openSync>) => {
        const path = String(args[0]);
        if (path.endsWith("/exe")) {exeReads += 1;}
        if (fault === "proc-denied" && path === `/proc/${child.pid}` || fault === "exe-denied" && path.endsWith("/exe") ||
            fault === "post-exe-read" && exeReads === 2) {return deny();}
        return open(...args);
      }) as typeof fs.openSync),
      t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
        const result = read(...args); if (!String(args[0]).endsWith("/stat")) {return result;}
        statReads += 1;
        if (fault === "stat-read" || fault === "post-stat-read" && statReads === 2) {return deny();}
        const text = String(result); const end = text.lastIndexOf(")") + 2;
        const fields = text.slice(end).split(" ");
        if (fault === "wrong-parent") {fields[1] = "1";}
        if (fault === "changed-start" && statReads === 2) {fields[19] = String(BigInt(fields[19]!) + 1n);}
        return text.slice(0, end) + fields.join(" ");
      }) as typeof fs.readFileSync),
      t.mock.method(fs, "statfsSync", ((...args: Parameters<typeof fs.statfsSync>) =>
        fault === "non-procfs" ? {...filesystem(...args), type: 0} : filesystem(...args)) as typeof fs.statfsSync),
      t.mock.method(fs, "fstatSync", ((...args: Parameters<typeof fs.fstatSync>) =>
        fault === "held-readback" && args[0] === Number(held.descriptorPath.split("/").at(-1)) ? deny() : stat(...args)) as typeof fs.fstatSync),
    ];
    syncBuiltinESMExports();
    try {assert.equal(held.observeMapping(child), undefined);} finally {
      for (const mock of mocks) {mock.mock.restore();} syncBuiltinESMExports(); held.close();
    }
    assert.equal(readdirSync("/proc/self/fd").length, before - 1);
  });
}

for (const failure of ["throw", "error", "late-spawn"] as const) {
  test(`native driver executable descriptor cleanup on ${failure}`, linux, async t => {
    const slot = sandbox(t); let descriptorPath = "";
    const f = await nativeDriver(t, slot, {spawnProcess: specification => {
      descriptorPath = specification.executablePath;
      if (failure === "throw") {throw new Error("synthetic native spawn throw");}
      const child = spawn(join(slot.directory, "missing"), [], {env: {}, stdio: ["pipe", "pipe", "pipe"]});
      if (failure === "late-spawn") {child.once("error", () => {setImmediate(() => {child.emit("spawn");});});}
      return child;
    }});
    await f.completion; const result = await f.session.completion; await tick();
    assert.equal(result.observation.executableMapping, "unproven");
    assert.equal(f.messages.some(message => message.kind === "provider-instance"), false);
    assert.throws(() => readFileSync(descriptorPath));
  });
}

test("late native errors and spawn events cannot mutate a sealed observation", linux, async t => {
  let child: ChildProcessWithoutNullStreams | undefined;
  const slot = sandbox(t);
  const f = await nativeDriver(t, slot, {spawnProcess: specification => {
    child = fixedChild(t, specification.executablePath); return child;
  }});
  const {result} = await f.finish();
  assert.equal(result.observation.executableMapping, "observed");
  const original = JSON.stringify(result.observation);
  assert.doesNotThrow(() => {child!.emit("error", new Error("late error")); child!.emit("error", new Error("second late error"));});
  child!.emit("spawn"); await tick();
  assert.equal(JSON.stringify(f.session.observation), original);
  assert.equal(f.messages.filter(message => message.kind === "provider-instance").length, 1);
  assert.deepEqual(descriptors(slot.executablePath), []);
});

test("failure deadline closes held descriptor even when a synthetic child supplies no native events", linux, async t => {
  const slot = sandbox(t); let descriptorPath = "";
  const child = Object.assign(new EventEmitter(), {pid: 41, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => false});
  t.after(() => {child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();});
  const f = await nativeDriver(t, slot, {spawnProcess: specification => {
    descriptorPath = specification.executablePath; return child as unknown as ChildProcessWithoutNullStreams;
  }});
  f.channel.input.end(); await f.completion;
  const result = await f.session.completion;
  assert.equal(result.observation.executableMapping, "unproven");
  assert.throws(() => readFileSync(descriptorPath));
  child.emit("spawn"); child.emit("error", new Error("late synthetic error"));
  assert.equal(f.messages.some(message => message.kind === "provider-instance"), false);
});

test("proc directory close uncertainty cannot issue mapping and does not retry a closed descriptor", linux, async t => {
  const slot = sandbox(t); const held = holdDockerCustodyProviderExecutable(slot.executablePath, slot.executableSha256);
  const child = fixedChild(t, held.descriptorPath); await once(child, "spawn");
  const before = readdirSync("/proc/self/fd").length; const close = fs.closeSync; let failedCloses = 0;
  const mocked = t.mock.method(fs, "closeSync", (descriptor: number) => {
    const path = readlinkSync(`/proc/self/fd/${descriptor}`); close(descriptor);
    if (path === `/proc/${child.pid}`) {failedCloses += 1; throw new Error("synthetic close uncertainty");}
  });
  syncBuiltinESMExports();
  try {assert.equal(held.observeMapping(child), undefined);} finally {mocked.mock.restore(); syncBuiltinESMExports(); held.close();}
  assert.equal(failedCloses, 1);
  assert.equal(readdirSync("/proc/self/fd").length, before - 1);
});
