import assert from "node:assert/strict";
import fs, {type FileHandle} from "node:fs/promises";
import {createHash} from "node:crypto";
import {syncBuiltinESMExports} from "node:module";
import {join} from "node:path";
import {test, type TestContext} from "node:test";
import {createCodexNativeBrokerFileInstaller}
  from "../../../dist/features/contained-agent-turn/composition/codex-native-broker-file-installer.js";
import {createHostPrivateRootOwnerFactory}
  from "../../../dist/features/contained-agent-turn/composition/host-private-root-owner.js";
import {createCodexAppServerPermissionBoundary}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import {createCodexNativeBrokerRecipe, renderCodexNativeBrokerConfig, prepareCodexNativeBrokerFiles}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";

const linux = {skip: process.platform !== "linux"};
const deadline = () => ({deadlineEpochMs: Date.now() + 5000});
const catalog = new URL("../../fixtures/codex-native-broker-0.153.4/models.json", import.meta.url);
const endpoint = "http://10.203.0.1:43129/backend-api/codex";
const fixture = async (t: TestContext) => {
  const base = await fs.mkdtemp("/tmp/codex-native-file-installer-");
  const rootPath = join(base, "private");
  const home = join(rootPath, "home");
  const workspace = join(base, "workspace");
  for (const path of [rootPath, home, workspace]) {await fs.mkdir(path, {mode: 0o700});}
  let deferredConsumer: {quiesce(): Promise<void>} | undefined;
  let installer: ReturnType<typeof createCodexNativeBrokerFileInstaller> | undefined;
  const rootOwner = createHostPrivateRootOwnerFactory({hostInstanceId: "test-host", hostBootId: "test-boot"}).create({
    rootPath, workspacePath: workspace, operationId: "test-operation", attemptId: "test-attempt", custodyRef: "test-custody",
  }, {cutoff() {}, async cleanup() {await installer?.quiesce(); await deferredConsumer?.quiesce(); return {kind: "released"};}});
  const boundary = createCodexAppServerPermissionBoundary({codexHome: home, workspaceRef: workspace, intentMode: "analysis"});
  const recipe = createCodexNativeBrokerRecipe({boundary, endpoint, profile: "codex-chatgpt",
    dockerMounts: {privateRootSource: rootPath, workspaceSource: workspace}});
  const options = {rootOwner, boundary, catalogSource: await fs.readFile(catalog),
    ownerUid: process.getuid!(), ownerGid: process.getgid!()};
  t.after(async () => {
    await installer?.quiesce().catch(() => {});
    await deferredConsumer?.quiesce().catch(() => {});
    await rootOwner.quarantineAndDelete(deadline());
    await fs.rm(base, {recursive: true, force: true});
  });
  return {base, rootPath, home, workspace, boundary, recipe, rootOwner, options,
    retainDeferred(files: {quiesce(): Promise<void>}) {deferredConsumer = files;},
    create(overrides: Partial<typeof options> = {}) {
      installer = createCodexNativeBrokerFileInstaller({...options, ...overrides});
      return installer;
    }};
};

const patchOpen = (t: TestContext, wrap: (handle: FileHandle, path: string) => void) => {
  const original = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    wrap(handle, String(args[0]));
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
};

test("inert construction; exact pinned bytes in retained Host HOME, independent verifier, root cleanup", linux, async t => {
  const f = await fixture(t);
  const installer = f.create();
  assert.equal(f.rootOwner.snapshot().retainedHandles, 0);
  assert.deepEqual(await fs.readdir(f.home), []);
  // Construction copied the explicit catalog source; later caller mutation is irrelevant.
  f.options.catalogSource.fill(0);
  await f.rootOwner.capture();
  await installer.nativeFiles.install(f.recipe);
  assert.deepEqual((await fs.readdir(f.home)).toSorted(), ["config.toml", "models.json"]);
  const config = await fs.readFile(join(f.home, "config.toml"), "utf8");
  assert.equal(config, renderCodexNativeBrokerConfig(f.recipe));
  assert.ok(config.includes('model_catalog_json = "/agent-private/home/models.json"'));
  const actual = await fs.readFile(join(f.home, "models.json"));
  assert.equal(actual.length, 515145);
  assert.equal(createHash("sha256").update(actual).digest("hex"), "d7136a413cfac1b5b1686d9e0dcc5c80ca05bebed5e9fc3911376561d0ef6ee8");
  for (const name of ["config.toml", "models.json"]) {
    const stat = await fs.stat(join(f.home, name));
    assert.equal(stat.mode & 0o7777, 0o600);
    assert.equal(stat.uid, process.getuid!()); assert.equal(stat.gid, process.getgid!());
  }
  assert.equal((await prepareCodexNativeBrokerFiles(f.recipe)).kind, "codex-native-broker-prepared-files/v1");
  assert.deepEqual(installer.snapshot(), {installing: false, installed: true, debt: true, retainedHandles: 0});
  await assert.rejects(installer.nativeFiles.install(f.recipe));
  await installer.quiesce();
  assert.equal(installer.snapshot().debt, true);
  assert.equal((await f.rootOwner.quarantineAndDelete(deadline())).evidence.status, "deleted");
  assert.equal(installer.snapshot().debt, false);
});

test("wrong catalog size, digest and owner identity fail before any creation", linux, async t => {
  for (const attack of ["size", "hash", "uid", "gid"]) {
    const f = await fixture(t);
    const overrides = attack === "size" ? {catalogSource: Buffer.alloc(1)} : attack === "hash"
      ? {catalogSource: Buffer.alloc(515145)} : attack === "uid" ? {ownerUid: process.getuid!() + 1} : {ownerGid: process.getgid!() + 1};
    const installer = f.create(overrides);
    await f.rootOwner.capture();
    await assert.rejects(installer.nativeFiles.install(f.recipe));
    assert.deepEqual(await fs.readdir(f.home), []);
    assert.equal(installer.snapshot().debt, false);
  }
});

test("uncaptured root, structural recipe and another issued boundary are rejected", linux, async t => {
  for (const attack of ["uncaptured", "structural", "foreign"]) {
    const f = await fixture(t);
    const installer = f.create();
    if (attack !== "uncaptured") {await f.rootOwner.capture();}
    const boundary = createCodexAppServerPermissionBoundary({codexHome: f.home, workspaceRef: f.workspace, intentMode: "analysis"});
    const recipe = attack === "structural" ? {...f.recipe} : attack === "foreign"
      ? createCodexNativeBrokerRecipe({boundary, endpoint, profile: "codex-chatgpt"}) : f.recipe;
    await assert.rejects(installer.nativeFiles.install(recipe));
    assert.deepEqual(await fs.readdir(f.home), []);
  }
});

test("home and ancestor symlinks cannot redirect writes into a foreign tree", linux, async t => {
  for (const target of ["home", "root"]) {
    const f = await fixture(t);
    const installer = f.create();
    await f.rootOwner.capture();
    const path = target === "home" ? f.home : f.rootPath;
    await fs.rename(path, `${path}-retained`);
    await fs.symlink(f.workspace, path);
    await assert.rejects(installer.nativeFiles.install(f.recipe));
    assert.deepEqual(await fs.readdir(f.workspace), []);
  }
});

test("exclusive creation never overwrites existing files or follows leaf symlinks; partial pair remains root debt", linux, async t => {
  for (const name of ["config.toml", "models.json"]) {
    for (const link of [false, true]) {
      const f = await fixture(t);
      const installer = f.create();
      const outside = join(f.workspace, "keep");
      await fs.writeFile(outside, "untouched");
      if (link) {await fs.symlink(outside, join(f.home, name));}
      else {await fs.writeFile(join(f.home, name), "untouched", {mode: 0o600});}
      await f.rootOwner.capture();
      await assert.rejects(installer.nativeFiles.install(f.recipe));
      assert.equal(await fs.readFile(outside, "utf8"), "untouched");
      assert.equal(await fs.readFile(join(f.home, name), "utf8"), "untouched");
      assert.equal(installer.snapshot().debt, true);
      await installer.quiesce();
      assert.equal(installer.snapshot().debt, true);
      assert.equal((await f.rootOwner.quarantineAndDelete(deadline())).evidence.status, "deleted");
      assert.equal(installer.snapshot().debt, false);
    }
  }
});

test("failed partial write is retained until the existing Host cleanup proves deletion", linux, async t => {
  const f = await fixture(t);
  const installer = f.create();
  await f.rootOwner.capture();
  patchOpen(t, (handle, path) => {
    if (!path.endsWith("/models.json")) {return;}
    t.mock.method(handle, "writeFile", async () => {
      await handle.write(Buffer.from("partial"));
      throw new Error("synthetic write failure");
    });
  });
  await assert.rejects(installer.nativeFiles.install(f.recipe));
  assert.equal(await fs.readFile(join(f.home, "models.json"), "utf8"), "partial");
  assert.equal(installer.snapshot().retainedHandles, 0);
  assert.equal(installer.snapshot().debt, true);
  await assert.rejects(prepareCodexNativeBrokerFiles(f.recipe));
  assert.equal((await f.rootOwner.quarantineAndDelete(deadline())).evidence.status, "deleted");
  assert.equal(installer.snapshot().debt, false);
});

test("repeat and reentrant install are rejected, quiescence joins the sole in-flight writer", linux, async t => {
  const f = await fixture(t);
  const installer = f.create();
  await f.rootOwner.capture();
  let opened!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => {opened = resolve;});
  const gate = new Promise<void>(resolve => {release = resolve;});
  patchOpen(t, (handle, path) => {
    if (!path.endsWith("/config.toml")) {return;}
    const write = handle.writeFile.bind(handle);
    t.mock.method(handle, "writeFile", async (...args: Parameters<typeof write>) => {
      opened(); await gate; return write(...args);
    });
  });
  const install = installer.nativeFiles.install(f.recipe);
  await entered;
  await assert.rejects(installer.nativeFiles.install(f.recipe));
  let settled = false;
  const quiescence = installer.quiesce().then(() => {settled = true; return settled;});
  await new Promise(resolve => {setImmediate(resolve);});
  assert.equal(settled, false);
  const rejected = assert.rejects(install);
  release();
  await rejected; await quiescence;
  assert.equal(installer.snapshot().retainedHandles, 0);
  assert.deepEqual(await fs.readdir(f.home), ["config.toml"]);
  await assert.rejects(installer.nativeFiles.install(f.recipe));
  assert.equal((await f.rootOwner.quarantineAndDelete(deadline())).evidence.status, "deleted");
  assert.equal(installer.snapshot().debt, false);
});


test("file and directory flush failures preserve debt; successful creation flushes both", linux, async t => {
  for (const failure of ["none", "file", "directory"]) {
    const f = await fixture(t);
    const installer = f.create();
    await f.rootOwner.capture();
    const synced = new Set<string>();
    patchOpen(t, (handle, path) => {
      const name = path.endsWith("/config.toml") ? "config" : path.endsWith("/models.json") ? "catalog"
        : path.endsWith("/home") ? "directory" : undefined;
      if (name === undefined) {return;}
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => {
        synced.add(name);
        if ((failure === "file" && name === "config") || (failure === "directory" && name === "directory")) {
          throw new Error("synthetic flush failure");
        }
        await sync();
      });
    });
    if (failure === "none") {
      await installer.nativeFiles.install(f.recipe);
      assert.deepEqual([...synced].toSorted(), ["catalog", "config", "directory"]);
    } else {await assert.rejects(installer.nativeFiles.install(f.recipe));}
    assert.equal(installer.snapshot().debt, true);
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal((await f.rootOwner.quarantineAndDelete(deadline())).evidence.status, "deleted");
    assert.equal(installer.snapshot().debt, false);
  }
});

test("ambiguous descriptor close blocks private-root quiescence and never retries the close", linux, async t => {
  const f = await fixture(t);
  const installer = f.create();
  await f.rootOwner.capture();
  let closes = 0;
  patchOpen(t, (handle, path) => {
    if (!path.endsWith("/config.toml")) {return;}
    const close = handle.close.bind(handle);
    t.mock.method(handle, "close", async () => {
      closes += 1; await close(); throw new Error("synthetic close acknowledgement failure");
    });
  });
  await assert.rejects(installer.nativeFiles.install(f.recipe));
  await assert.rejects(installer.quiesce());
  await assert.rejects(installer.quiesce());
  assert.equal(closes, 1);
  assert.equal(installer.snapshot().retainedHandles, 1);
  assert.equal(installer.snapshot().debt, true);
  const cleanup = await f.rootOwner.quarantineAndDelete(deadline());
  assert.equal(cleanup.evidence.status, "unproven");
  assert.equal(cleanup.debt, true);
  assert.equal(installer.snapshot().debt, true);
});

test("an authentic recipe for a HOME outside the retained root cannot authorize a path write", linux, async t => {
  const f = await fixture(t);
  const home = join(f.base, "foreign-home");
  await fs.mkdir(home, {mode: 0o700});
  const boundary = createCodexAppServerPermissionBoundary({codexHome: home, workspaceRef: f.workspace, intentMode: "analysis"});
  const installer = f.create({boundary});
  const recipe = createCodexNativeBrokerRecipe({boundary, endpoint, profile: "codex-chatgpt"});
  await f.rootOwner.capture();
  await assert.rejects(installer.nativeFiles.install(recipe));
  assert.deepEqual(await fs.readdir(home), []);
  assert.equal(installer.snapshot().debt, false);
});

// The deferred adapter must preserve the concrete installer's provenance and
// debt semantics, not introduce another root or a cleanup-to-deletion cycle.
test("deferred binding snapshots options and retains same-root file debt through quiescence", linux, async t => {
  const {createDeferredCodexNativeBrokerFiles} = await import("../../../dist/features/contained-agent-turn/composition/deferred-codex-native-broker-files.js");
  const f = await fixture(t);
  const files = createDeferredCodexNativeBrokerFiles(f.options);
  f.retainDeferred(files);
  t.after(() => files.quiesce());
  f.options.catalogSource.fill(0);
  await assert.rejects(files.install(f.recipe));
  assert.equal(files.snapshot().binding, "unbound");
  await f.rootOwner.capture();
  files.bindRoot(f.rootOwner);
  assert.throws(() => files.bindRoot(f.rootOwner));
  await files.install(f.recipe);
  assert.equal((await prepareCodexNativeBrokerFiles(f.recipe)).kind, "codex-native-broker-prepared-files/v1");
  await files.quiesce();
  assert.equal(files.snapshot().debt, true);
  await assert.rejects(files.install(f.recipe));
  assert.equal((await f.rootOwner.quarantineAndDelete(deadline())).evidence.status, "deleted");
  assert.equal(files.snapshot().debt, false);
});

test("deferred failed binding and unbound cutoff permanently consume admission without file effects", linux, async t => {
  const {createDeferredCodexNativeBrokerFiles} = await import("../../../dist/features/contained-agent-turn/composition/deferred-codex-native-broker-files.js");
  for (const closed of [false, true]) {
    const f = await fixture(t);
    const files = createDeferredCodexNativeBrokerFiles(f.options);
  f.retainDeferred(files);
    if (closed) {files.cutoff();}
    assert.throws(() => files.bindRoot(f.rootOwner));
    assert.equal(files.snapshot().binding, closed ? "unbound" : "failed");
    await f.rootOwner.capture();
    assert.throws(() => files.bindRoot(f.rootOwner));
    await assert.rejects(files.install(f.recipe));
    await files.quiesce();
    assert.equal(files.snapshot().retainedHandles, 0);
    assert.equal(files.snapshot().debt, false);
    assert.deepEqual(await fs.readdir(f.home), []);
  }
});

test("deferred concrete constructor failure after capture consumes binding and invents no file debt", linux, async t => {
  const {createDeferredCodexNativeBrokerFiles} = await import("../../../dist/features/contained-agent-turn/composition/deferred-codex-native-broker-files.js");
  const f = await fixture(t);
  const files = createDeferredCodexNativeBrokerFiles(f.options);
  f.retainDeferred(files);
  await f.rootOwner.capture();
  const original = Buffer.from;
  t.mock.method(Buffer, "from", () => {throw new Error("inert constructor allocation failed");});
  try {assert.throws(() => files.bindRoot(f.rootOwner), /allocation failed/);}
  finally {Buffer.from = original;}
  assert.equal(files.snapshot().binding, "failed");
  assert.throws(() => files.bindRoot(f.rootOwner));
  assert.equal(files.snapshot().debt, false);
  await files.quiesce();
  assert.equal((await f.rootOwner.quarantineAndDelete(deadline())).evidence.status, "deleted");
});

test("deferred cutoff synchronously fences a gated writer and quiescence retains that flight", linux, async t => {
  const {createDeferredCodexNativeBrokerFiles} = await import("../../../dist/features/contained-agent-turn/composition/deferred-codex-native-broker-files.js");
  const f = await fixture(t);
  const files = createDeferredCodexNativeBrokerFiles(f.options);
  f.retainDeferred(files);
  await f.rootOwner.capture(); files.bindRoot(f.rootOwner);
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  patchOpen(t, (handle, path) => {
    if (!path.endsWith("models.json")) {return;}
    const write = handle.writeFile.bind(handle);
    t.mock.method(handle, "writeFile", async (...args: Parameters<typeof write>) => {
      entered.resolve(); await gate.promise; return write(...args);
    });
  });
  const writing = files.install(f.recipe); const rejected = assert.rejects(writing);
  await entered.promise; files.cutoff();
  assert.equal(files.snapshot().closed, true);
  await assert.rejects(files.install(f.recipe));
  let settled = false;
  const joining = files.quiesce().then(() => {settled = true; return settled;});
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.equal(settled, false);
  assert.equal(f.rootOwner.snapshot().history.includes("exact-entry-remove-attempt"), false);
  gate.resolve(); await rejected; await joining;
  assert.equal(files.snapshot().debt, true);
  assert.equal((await f.rootOwner.quarantineAndDelete(deadline())).evidence.status, "deleted");
});

test("deferred quiescence retains ambiguous close rejection across every observation", linux, async t => {
  const {createDeferredCodexNativeBrokerFiles} = await import("../../../dist/features/contained-agent-turn/composition/deferred-codex-native-broker-files.js");
  const f = await fixture(t);
  const files = createDeferredCodexNativeBrokerFiles(f.options);
  f.retainDeferred(files);
  await f.rootOwner.capture(); files.bindRoot(f.rootOwner);
  let closes = 0;
  patchOpen(t, (handle, path) => {
    if (!path.endsWith("config.toml")) {return;}
    const close = handle.close.bind(handle);
    t.mock.method(handle, "close", async () => {closes += 1; await close(); throw new Error("ambiguous close");});
  });
  await assert.rejects(files.install(f.recipe));
  files.cutoff();
  await assert.rejects(files.quiesce()); await assert.rejects(files.quiesce());
  assert.equal(closes, 1); assert.equal(files.snapshot().retainedHandles, 1);
  assert.equal(f.rootOwner.snapshot().history.includes("exact-entry-remove-attempt"), false);
});

for (const failure of ["write", "sync"] as const) {
  test(`deferred catalog ${failure} failure keeps the config and partial catalog with the same root`, linux, async t => {
    const {createDeferredCodexNativeBrokerFiles} = await import("../../../dist/features/contained-agent-turn/composition/deferred-codex-native-broker-files.js");
    const f = await fixture(t);
    const files = createDeferredCodexNativeBrokerFiles(f.options); f.retainDeferred(files);
    await f.rootOwner.capture(); files.bindRoot(f.rootOwner);
    patchOpen(t, (handle, path) => {
      if (!path.endsWith("models.json")) {return;}
      if (failure === "write") {
        t.mock.method(handle, "writeFile", async () => {await handle.write(Buffer.from("partial")); throw new Error("partial write");});
      } else {t.mock.method(handle, "sync", async () => {throw new Error("flush failure");});}
    });
    await assert.rejects(files.install(f.recipe));
    await files.quiesce();
    assert.equal(files.snapshot().debt, true); assert.equal(files.snapshot().retainedHandles, 0);
    assert.deepEqual((await fs.readdir(f.home)).toSorted(), ["config.toml", "models.json"]);
    assert.equal((await f.rootOwner.quarantineAndDelete(deadline())).evidence.status, "deleted");
    assert.equal(files.snapshot().debt, false);
  });
}

test("deferred binding rejects reentry and retains an installer constructed across cutoff", linux, async t => {
  const {createDeferredCodexNativeBrokerFiles} = await import("../../../dist/features/contained-agent-turn/composition/deferred-codex-native-broker-files.js");
  for (const action of ["rebind", "cutoff"] as const) {
    const f = await fixture(t);
    const files = createDeferredCodexNativeBrokerFiles(f.options); f.retainDeferred(files);
    await f.rootOwner.capture();
    const original = Buffer.from;
    let entered = false;
    t.mock.method(Buffer, "from", (...args: Parameters<typeof Buffer.from>) => {
      if (!entered) {
        entered = true;
        if (action === "rebind") {assert.throws(() => files.bindRoot(f.rootOwner));}
        else {files.cutoff();}
      }
      return Reflect.apply(original, Buffer, args);
    });
    try {
      if (action === "cutoff") {assert.throws(() => files.bindRoot(f.rootOwner));}
      else {files.bindRoot(f.rootOwner);}
    } finally {Buffer.from = original;}
    assert.equal(entered, true);
    assert.equal(files.snapshot().binding, action === "cutoff" ? "failed" : "bound");
    assert.throws(() => files.bindRoot(f.rootOwner));
    await files.quiesce();
    await assert.rejects(files.install(f.recipe));
    assert.equal(files.snapshot().retainedHandles, 0);
    assert.equal(files.snapshot().debt, false);
    assert.equal((await f.rootOwner.quarantineAndDelete(deadline())).evidence.status, "deleted");
  }
});
