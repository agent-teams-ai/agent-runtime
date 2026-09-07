import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createHostPrivateRootOwnerFactory } from "../../../dist/features/contained-agent-turn/internal.js";

const retainedFactories = new Set<ReturnType<typeof createHostPrivateRootOwnerFactory>>();

const released = Object.freeze({ cutoff() {}, async cleanup() {return { kind: "released" as const };} });
const deadline = () => ({ deadlineEpochMs: Date.now() + 5000 });

const fixture = async (t: TestContext, factoryOptions = {}) => {
  const base = await fs.mkdtemp("/tmp/host-private-root-component-");
  const parent = join(base, "host");
  const rootPath = join(parent, "private");
  const workspacePath = join(base, "workspace");
  await fs.mkdir(parent, { mode: 0o700 });
  await fs.mkdir(rootPath, { mode: 0o700 });
  await fs.mkdir(workspacePath, { mode: 0o700 });
  // Dispose only this test's synthetic files after inspecting the owner's debt.
  // Retained debt handles are intentionally owned until test process exit.
  t.after(async () => {await fs.rm(base, { recursive: true, force: true });});
  const factory = createHostPrivateRootOwnerFactory({ hostInstanceId: "synthetic-host", hostBootId: "synthetic-incarnation", ...factoryOptions });
  retainedFactories.add(factory);
  const options = { rootPath, workspacePath, operationId: "operation", attemptId: "attempt", custodyRef: "custody" };
  return { base, parent, rootPath, workspacePath, factory, options, owner: factory.create(options, released) };
};

const patch = (t: TestContext, method: "rmdir" | "lstat" | "open", replacement: (...args: any[]) => any) => {
  t.mock.method(fs, method, replacement);
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
};

test("inert factory, concrete capture, mutable contents, descriptor deletion and stable shared history", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  const f = await fixture(t);
  assert.equal(f.owner.snapshot().retainedHandles, 0);
  const pending = f.owner.capture();
  assert.equal(f.owner.capture(), pending);
  const binding = await pending;
  assert.equal(binding.canonicalBindSourcePath, f.rootPath);
  assert.ok(!binding.canonicalBindSourcePath.startsWith("/proc/"));
  assert.equal(binding.identity.ino, (await fs.stat(f.rootPath, { bigint: true })).ino);
  assert.equal(binding.parentIdentity.ino, (await fs.stat(f.parent, { bigint: true })).ino);
  assert.equal(binding.uid, BigInt(process.getuid!()));
  await fs.mkdir(join(f.rootPath, "nested"));
  await fs.writeFile(join(f.rootPath, "nested", "private-data"), "synthetic");
  await fs.writeFile(join(f.workspacePath, "artifact"), "keep");
  assert.deepEqual(await f.owner.revalidate(), binding);
  const cleanup = f.owner.quarantineAndDelete(deadline());
  assert.equal(f.owner.quarantineAndDelete(deadline()), cleanup);
  const result = await cleanup;
  assert.equal(result.evidence.status, "deleted", JSON.stringify(result));
  assert.equal(result.debt, false);
  assert.equal(result.retainedHandles, 0);
  assert.ok(result.history.includes("deletion-observations-sealed"));
  assert.deepEqual(await fs.readdir(f.parent), []);
  assert.equal(await fs.readFile(join(f.workspacePath, "artifact"), "utf8"), "keep");
  await assert.rejects(f.owner.revalidate());
  assert.deepEqual(await f.owner.quarantineAndDelete(deadline()), result);
});

test("one Host generation spans reservations, a different Host factory cannot alias it", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  const f = await fixture(t);
  const first = await f.owner.capture();
  const rootPath = join(f.parent, "second");
  await fs.mkdir(rootPath, { mode: 0o700 });
  const second = f.factory.create({ ...f.options, rootPath, attemptId: "second", custodyRef: "second" }, released);
  const secondBinding = await second.capture();
  assert.equal(first.hostLifecycleGenerationSha256, secondBinding.hostLifecycleGenerationSha256);
  const other = await fixture(t);
  assert.notEqual(first.hostLifecycleGenerationSha256, (await other.owner.capture()).hostLifecycleGenerationSha256);
  for (const owner of [f.owner, second, other.owner]) {assert.equal((await owner.quarantineAndDelete(deadline())).evidence.status, "deleted");}
});

test("root and containing parent replacement preserve foreign trees and cleanup debt", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  for (const which of ["root", "parent"]) {
    const f = await fixture(t);
    await f.owner.capture();
    const replaced = which === "root" ? f.rootPath : f.parent;
    await fs.rename(replaced, `${replaced}-retained`);
    await fs.mkdir(replaced, { mode: 0o700 });
    await fs.writeFile(join(replaced, "foreign"), "keep");
    await assert.rejects(f.owner.revalidate());
    const result = await f.owner.quarantineAndDelete(deadline());
    assert.equal(result.evidence.status, "unproven");
    assert.equal(result.debt, true);
    assert.equal(await fs.readFile(join(replaced, "foreign"), "utf8"), "keep");
    assert.ok(!result.history.includes("exact-entry-remove-attempt"));
  }
});

test("symlinks are unlinked without following their outside targets", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  const f = await fixture(t);
  await fs.writeFile(join(f.workspacePath, "outside"), "survives");
  await fs.symlink(f.workspacePath, join(f.rootPath, "escape"));
  await fs.symlink("/does-not-exist", join(f.rootPath, "dangling"));
  await f.owner.capture();
  const result = await f.owner.quarantineAndDelete(deadline());
  assert.equal(result.evidence.status, "deleted", JSON.stringify(result));
  assert.equal(await fs.readFile(join(f.workspacePath, "outside"), "utf8"), "survives");
});

test("root symlink, overlapping workspace and unprotected parent reject capture", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  for (const kind of ["symlink", "overlap", "permissions"]) {
    const f = await fixture(t);
    if (kind === "symlink") {
      await fs.rmdir(f.rootPath);
      await fs.symlink(f.workspacePath, f.rootPath);
    }
    if (kind === "permissions") {await fs.chmod(f.parent, 0o755);}
    const owner = kind === "overlap" ? f.factory.create({ ...f.options, custodyRef: "overlap", workspacePath: f.parent }, released) : f.owner;
    await assert.rejects(owner.capture());
    assert.equal(owner.snapshot().debt, true);
    assert.equal(owner.snapshot().retainedHandles, 0);
  }
});

test("unknown hardlinks and bounded traversal fail closed without deletion", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  const f = await fixture(t);
  await fs.writeFile(join(f.workspacePath, "outside"), "keep");
  await fs.link(join(f.workspacePath, "outside"), join(f.rootPath, "hardlink"));
  await assert.rejects(f.owner.capture(), /hardlink/u);
  const limited = await fixture(t, { maximumEntries: 1 });
  await fs.writeFile(join(limited.rootPath, "one"), "one");
  await fs.writeFile(join(limited.rootPath, "two"), "two");
  await assert.rejects(limited.owner.capture(), /limit/u);
});

test("nested mount simulation rejects actual descriptor mount mismatch at capture", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  const f = await fixture(t);
  await fs.mkdir(join(f.rootPath, "nested"));
  const original = fs.open;
  let injected = false;
  patch(t, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]).includes("/proc/self/fdinfo/")) {
      const targetFd = String(args[0]).split("/").at(-1);
      const target = await fs.readlink(`/proc/self/fd/${targetFd}`);
      if (target === join(f.rootPath, "nested")) {
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: any[]) => {
          const result = await (read as any)(...readArgs);
          const buffer = readArgs[0] as Buffer;
          const modified = buffer.subarray(0, result.bytesRead).toString().replace(/^mnt_id:.*$/mu, "mnt_id:\t999999999");
          result.bytesRead = buffer.write(modified);
          injected = true;
          return result;
        }) as typeof handle.read;
      }
    }
    return handle;
  });
  await assert.rejects(f.owner.capture(), /mount boundary/u);
  assert.equal(injected, true);
});

test("private collection settles before deletion, closed read admission and shared cleanup", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  const f = await fixture(t);
  let finish!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => {started = resolve;});
  const collection = new Promise<void>(resolve => {finish = resolve;});
  let calls = 0;
  const owner = f.factory.create({ ...f.options, custodyRef: "with-owner" }, { cutoff() {}, async cleanup() {
    calls++; started(); await collection; return { kind: "released" };
  } });
  await owner.capture();
  const work = owner.quarantineAndDelete(deadline());
  await entered;
  assert.ok((await fs.stat(f.rootPath)).isDirectory());
  assert.equal(owner.quarantineAndDelete(deadline()), work);
  await assert.rejects(owner.revalidate());
  finish();
  assert.equal((await work).evidence.status, "deleted");
  assert.equal(calls, 1);
});

test("unproven quiescence and timed out cleanup never authorize late destructive work", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  const f = await fixture(t);
  const owner = f.factory.create({ ...f.options, custodyRef: "with-owner" }, { cutoff() {}, async cleanup() {return { kind: "quarantined" };} });
  await owner.capture();
  assert.equal((await owner.quarantineAndDelete(deadline())).debt, true);
  assert.ok((await fs.stat(f.rootPath)).isDirectory());
  const late = await fixture(t);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => {finish = resolve;});
  const lateOwner = late.factory.create({ ...late.options, custodyRef: "with-owner" }, { cutoff() {}, async cleanup() {await pending; return { kind: "released" };} });
  await lateOwner.capture();
  const work = lateOwner.quarantineAndDelete({ deadlineEpochMs: Date.now() + 30 });
  const result = await work;
  assert.equal(result.debt, true);
  finish();
  await new Promise(resolve => {setImmediate(resolve);});
  assert.ok((await fs.stat(late.rootPath)).isDirectory());
  assert.equal(lateOwner.quarantineAndDelete(deadline()), work);
  assert.ok(!lateOwner.snapshot().history.includes("exact-entry-remove-attempt"));
});

test("remove success followed by readback failure remains debt and is never retried", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  const f = await fixture(t);
  await f.owner.capture();
  const originalRemove = fs.rmdir;
  let removes = 0;
  patch(t, "rmdir", async (...args: Parameters<typeof fs.rmdir>) => {
    await originalRemove(...args);
    removes++;
    const originalStat = fs.lstat;
    fs.lstat = (async (...statArgs: any[]) => {
      if (String(statArgs[0]).includes(".ar-private-root-")) {throw new Error("synthetic final readback failed");}
      return (originalStat as any)(...statArgs);
    }) as typeof fs.lstat;
    syncBuiltinESMExports();
    t.after(() => {fs.lstat = originalStat; syncBuiltinESMExports();});
  });
  const work = f.owner.quarantineAndDelete(deadline());
  assert.equal((await work).debt, true);
  assert.deepEqual(await fs.readdir(f.parent), []);
  assert.equal(f.owner.quarantineAndDelete(deadline()), work);
  assert.equal(removes, 1);
  assert.ok(f.owner.snapshot().retainedHandles >= 2);
});

test("metadata sync or descriptor release uncertainty after unlink cannot become deleted", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  for (const fault of ["sync", "close"] as const) {
    await t.test(fault, async context => {
      const f = await fixture(context);
      const original = fs.open;
      let failures = 0;
      patch(context, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        if (!String(args[0]).endsWith("/private")) {return handle;}
        const action = handle[fault].bind(handle);
        handle[fault] = async () => {
          const removed = (await handle.stat()).nlink === 0;
          await action();
          if (removed) {failures++; throw new Error(`synthetic ${fault} acknowledgement loss`);}
        };
        return handle;
      });
      await f.owner.capture();
      const work = f.owner.quarantineAndDelete(deadline());
      const result = await work;
      assert.equal(result.evidence.status, "unproven");
      assert.equal(result.debt, true);
      assert.equal(failures, 1);
      assert.deepEqual(await fs.readdir(f.parent), []);
      assert.equal(f.owner.quarantineAndDelete(deadline()), work);
      assert.equal(failures, 1);
      assert.equal(result.history.includes("deletion-observations-sealed"), fault === "close");
    });
  }
});

test("ENOENT and a held unlinked directory alone are not deletion proof", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  const f = await fixture(t);
  await f.owner.capture();
  await fs.rmdir(f.rootPath);
  const result = await f.owner.quarantineAndDelete(deadline());
  assert.equal(result.evidence.status, "unproven");
  assert.ok(!result.history.includes("deletion-observations-sealed"));
  assert.equal(result.debt, true);
});

test("a special-file descriptor observation rejects traversal before unlink", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  const f = await fixture(t);
  await f.owner.capture();
  await fs.writeFile(join(f.rootPath, "special"), "synthetic fixture");
  const original = fs.open;
  patch(t, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]).endsWith("/special")) {
      const stat = handle.stat.bind(handle);
      handle.stat = (async (...statArgs: any[]) => {
        const value = await (stat as any)(...statArgs);
        value.isFile = () => false;
        return value;
      }) as typeof handle.stat;
    }
    return handle;
  });
  const result = await f.owner.quarantineAndDelete(deadline());
  assert.equal(result.debt, true);
  assert.equal(await fs.readFile(join(f.rootPath, "special"), "utf8"), "synthetic fixture");
});

test("workspace may be a sibling under the protected containing parent", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  const f = await fixture(t);
  const workspacePath = join(f.parent, "workspace");
  await fs.mkdir(workspacePath, { mode: 0o700 });
  const owner = f.factory.create({ ...f.options, workspacePath, custodyRef: "sibling" }, released);
  await owner.capture();
  assert.equal((await owner.quarantineAndDelete(deadline())).evidence.status, "deleted");
  assert.ok((await fs.stat(workspacePath)).isDirectory());
  assert.equal(f.factory.get("sibling"), owner);
  assert.throws(() => f.factory.create({ ...f.options, custodyRef: "sibling" }, released), /already owned/u);
});

test("Darwin is explicitly unsupported for strict descriptor custody", async t => {
  const f = await fixture(t);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  try {
    await assert.rejects(f.owner.capture(), /unsupported outside Linux/u);
    assert.equal(f.owner.snapshot().retainedHandles, 0);
  } finally {Object.defineProperty(process, "platform", platform);}
});

test("no-replace quarantine collision never overwrites or traverses the existing tree", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  const f = await fixture(t);
  await f.owner.capture();
  const uuid = "00000000-0000-4000-8000-000000000001";
  const foreign = join(f.parent, `.ar-private-root-${uuid}`);
  await fs.mkdir(foreign, { mode: 0o700 });
  await fs.writeFile(join(foreign, "foreign"), "keep");
  t.mock.method(crypto, "randomUUID", () => uuid);
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  const result = await f.owner.quarantineAndDelete(deadline());
  assert.equal(result.debt, true);
  assert.ok((await fs.stat(f.rootPath)).isDirectory());
  assert.equal(await fs.readFile(join(foreign, "foreign"), "utf8"), "keep");
  assert.ok(!result.history.includes("exact-entry-remove-attempt"));
});

test("directory replacement between enumeration and no-follow open rejects foreign traversal", {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false}, async t => {
  const f = await fixture(t);
  const nested = join(f.rootPath, "nested");
  await fs.mkdir(nested);
  await f.owner.capture();
  const original = fs.open;
  let replaced = false;
  patch(t, "open", async (...args: Parameters<typeof fs.open>) => {
    if (!replaced && String(args[0]).endsWith("/nested")) {
      replaced = true;
      await fs.rename(nested, `${nested}-original`);
      await fs.mkdir(nested);
      await fs.writeFile(join(nested, "foreign"), "keep");
    }
    return original(...args);
  });
  const result = await f.owner.quarantineAndDelete(deadline());
  assert.equal(replaced, true);
  assert.equal(result.debt, true);
  assert.equal(await fs.readFile(join(nested, "foreign"), "utf8"), "keep");
  assert.ok(!result.history.includes("exact-entry-remove-attempt"));
});

for (const metadata of ["name", "length"] as const) {
  test(`private root construction does not evaluate cleanup method ${metadata}`, () => {
    let reads = 0;
    const cleanupOwner = {cutoff() {}, async cleanup() {return {kind: "released" as const};}};
    for (const method of [cleanupOwner.cutoff, cleanupOwner.cleanup]) {
      Object.defineProperty(method, metadata, {get() {reads += 1; throw Error("cleanup metadata evaluated");}});
      Object.freeze(method);
    }
    const factory = createHostPrivateRootOwnerFactory({hostInstanceId: "synthetic-host", hostBootId: "synthetic-boot"});
    const owner = factory.create({rootPath: "/synthetic/private", workspacePath: "/synthetic/workspace",
      operationId: "operation", attemptId: "attempt", custodyRef: "custody"}, cleanupOwner);
    assert.equal(reads, 0);
    assert.equal(owner.snapshot().retainedHandles, 0);
  });
}
