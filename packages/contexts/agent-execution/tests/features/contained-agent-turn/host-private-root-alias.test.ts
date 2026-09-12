import assert from "node:assert/strict";
import fs, { type FileHandle } from "node:fs/promises";
import { fstatSync, lstatSync, renameSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { NodeHostPrivateRootOwner } from "../../../dist/features/contained-agent-turn/adapters/outbound/filesystem/host-private-root-owner.js";
import { traversePrivateRoot } from "../../../dist/features/contained-agent-turn/adapters/outbound/filesystem/host-private-root-filesystem.js";

type Identity = Readonly<{ dev: bigint; ino: bigint }>;
const linux = { skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false };
// Debt capabilities remain retained until process exit, as in the owner suite.
const owners = new Set<NodeHostPrivateRootOwner>();
const deadline = () => ({ deadlineEpochMs: Date.now() + 5000 });

const fixture = async (t: TestContext) => {
  const base = await fs.mkdtemp("/tmp/host-private-root-alias-");
  const parent = join(base, "safe");
  const rootPath = join(parent, "private");
  const workspacePath = join(base, "workspace");
  for (const path of [parent, rootPath, workspacePath]) {await fs.mkdir(path, { mode: 0o700 });}
  await fs.writeFile(join(rootPath, "secret"), "private");
  await fs.writeFile(join(parent, "sibling"), "retained");
  t.after(async () => {await fs.rm(base, { recursive: true, force: true });});
  const create = (options = {}) => {
    const owner = new NodeHostPrivateRootOwner({ rootPath, workspacePath, operationId: "operation",
      attemptId: "attempt", custodyRef: "custody", hostInstanceId: "host", hostBootId: "boot",
      generation: () => "generation", maximumEntries: 64, maximumDepth: 8, maximumMilliseconds: 5000,
      async awaitQuiescence() {}, ...options });
    owners.add(owner);
    return owner;
  };
  return { base, parent, rootPath, workspacePath, create };
};

// Model only dev/ino aliases. Real no-follow opens, enumeration, stat metadata,
// descriptor mount readbacks, limits and cleanup all run unchanged. Distinct
// real directories stand in for bind views without requiring actual mounts.
const simulateIdentities = (t: TestContext, aliases: Map<string, Identity>) => {
  const originalOpen = fs.open;
  const originalLstat = fs.lstat;
  let observations = 0;
  const apply = <T extends Identity>(path: string, value: T): T => {
    const identity = aliases.get(path);
    if (identity !== undefined) {observations++; Object.assign(value, { dev: identity.dev, ino: identity.ino });}
    return value;
  };
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const stat = handle.stat.bind(handle);
    handle.stat = (async (...statArgs: Parameters<FileHandle["stat"]>) => {
      const value = await stat(...statArgs);
      return apply(await fs.readlink(`/proc/self/fd/${handle.fd}`), value as Identity);
    }) as FileHandle["stat"];
    return handle;
  });
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const value = await originalLstat(...args);
    if (!value.isDirectory()) {return value;}
    return apply(await fs.realpath(args[0]), value as Identity);
  });
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  return () => observations;
};

test("capture rejects workspace bind alias of retained parent before enumeration", linux, async t => {
  const f = await fixture(t);
  const alias = await fs.stat(f.parent, { bigint: true });
  const observed = simulateIdentities(t, new Map([[f.workspacePath, alias]]));
  const owner = f.create();
  await assert.rejects(owner.capture(), /containing parent is exposed/u);
  assert.ok(observed() > 0);
  assert.equal(owner.snapshot().retainedHandles, 0);
  assert.equal(owner.snapshot().debt, true);
  assert.equal(await fs.readFile(join(f.parent, "sibling"), "utf8"), "retained");
});

for (const exposure of ["parent-in-workspace", "root-in-workspace", "workspace-in-root", "nested-shared"] as const) {
  for (const stage of ["capture", "revalidate", "predelete"] as const) {
    test(`${stage} rejects ${exposure} identity exposure`, linux, async t => {
      const f = await fixture(t);
      const privateChild = join(f.rootPath, "nested");
      const workspaceChild = join(f.workspacePath, "nested");
      await fs.mkdir(privateChild);
      await fs.mkdir(workspaceChild);
      const [path, target] = exposure === "parent-in-workspace" ? [workspaceChild, f.parent]
        : exposure === "root-in-workspace" ? [workspaceChild, f.rootPath]
        : exposure === "workspace-in-root" ? [privateChild, f.workspacePath]
        : [workspaceChild, privateChild];
      const aliases = new Map<string, Identity>();
      const identity = await fs.stat(target, { bigint: true });
      const observations = simulateIdentities(t, aliases);
      const expose = () => {aliases.set(path, identity);};
      const owner = f.create({ async awaitQuiescence() {if (stage === "predelete") {expose();}} });
      if (stage === "capture") {expose();} else {await owner.capture();}
      if (stage === "predelete") {
        const result = await owner.quarantineAndDelete(deadline());
        assert.equal(result.debt, true);
        assert.ok(!result.history.some(value => value.startsWith("quarantine-attempt:")));
      } else {
        if (stage === "revalidate") {expose();}
        await assert.rejects(stage === "capture" ? owner.capture() : owner.revalidate(), /identity overlaps/u);
      }
      assert.ok(observations() > 0);
      assert.equal(owner.snapshot().evidence.status, "unproven");
      assert.equal(owner.snapshot().debt, true);
      assert.equal(owner.snapshot().retainedHandles === 0, stage === "capture");
      assert.equal(await fs.readFile(join(f.rootPath, "secret"), "utf8"), "private");
      assert.equal(await fs.readFile(join(f.parent, "sibling"), "utf8"), "retained");
    });
  }
}

test("workspace sibling captures and revalidates with distinct dev/ino pairs", linux, async t => {
  const f = await fixture(t);
  const workspacePath = join(f.parent, "workspace");
  await fs.mkdir(workspacePath, { mode: 0o700 });
  const owner = f.create({ workspacePath });
  const captured = await owner.capture();
  assert.deepEqual(await owner.revalidate(), captured);
  assert.equal(owner.snapshot().debt, false);
});

test("matching inode numbers on different devices do not imply overlap", linux, async t => {
  const f = await fixture(t);
  const parent = await fs.stat(f.parent, { bigint: true });
  const observed = simulateIdentities(t, new Map([[f.workspacePath, { dev: parent.dev + 1n, ino: parent.ino }]]));
  const owner = f.create();
  await owner.capture();
  await owner.revalidate();
  assert.ok(observed() > 0);
  assert.equal(owner.snapshot().debt, false);
});

test("destructive traversal rejects nested alias introduced after separation scan", linux, async t => {
  const f = await fixture(t);
  const nested = join(f.rootPath, "nested");
  await fs.mkdir(nested);
  await fs.writeFile(join(nested, "foreign"), "keep");
  const owner = f.create();
  await owner.capture();
  await owner.revalidate();
  const workspace = await fs.stat(f.workspacePath, { bigint: true });
  simulateIdentities(t, new Map([[nested, workspace]]));
  // Exercise the actual destructive traversal, without needing native rename.
  const handle = await fs.open(f.rootPath, "r");
  const retained = new Set<FileHandle>();
  try {
    await assert.rejects(traversePrivateRoot(handle, {
      remaining: 64, maximumDepth: 8, directoryIdentities: new Set(),
      forbiddenDirectoryIdentities: new Set([`${workspace.dev}:${workspace.ino}`]), check() {},
      retain(child) {retained.add(child); return child;},
      async close(child) {await child.close(); retained.delete(child);},
    }, { depth: 0, remove: true }), /identity overlaps/u);
    assert.equal(retained.size, 0);
    assert.equal(await fs.readFile(join(nested, "foreign"), "utf8"), "keep");
  } finally {await handle.close();}
});

for (const limit of ["entries", "depth"] as const) {
  test(`separation traversal retains ${limit} bound`, linux, async t => {
    const f = await fixture(t);
    await fs.mkdir(join(f.workspacePath, "one"));
    await fs.mkdir(join(f.workspacePath, "one", "two"));
    const owner = f.create(limit === "entries" ? { maximumEntries: 1 } : { maximumDepth: 1 });
    await assert.rejects(owner.capture(), /limit|depth exceeded/u);
    assert.equal(owner.snapshot().debt, true);
    assert.equal(owner.snapshot().retainedHandles, 0);
  });
}

test("capture final readback rejects exposure introduced after its initial scan", linux, async t => {
  const f = await fixture(t);
  const nested = join(f.workspacePath, "nested");
  await fs.mkdir(nested);
  const aliases = new Map<string, Identity>();
  const parent = await fs.stat(f.parent, { bigint: true });
  simulateIdentities(t, aliases);
  const owner = f.create({ generation() {aliases.set(nested, parent); return "generation";} });
  await assert.rejects(owner.capture(), /identity overlaps/u);
  assert.equal(owner.snapshot().retainedHandles, 0);
  assert.equal(owner.snapshot().debt, true);
});

test("post-quarantine predelete readback rejects newly exposed parent (publication simulation)", linux, async t => {
  const f = await fixture(t);
  const nested = join(f.workspacePath, "nested");
  await fs.mkdir(nested);
  const aliases = new Map<string, Identity>();
  const parent = await fs.stat(f.parent, { bigint: true });
  simulateIdentities(t, aliases);
  const owner = f.create();
  await owner.capture();
  let published = false;
  // Simulate only the native publication boundary in this disposable fixture.
  // This proves the owner's post-publication ordering, not renameat2/native
  // qualification. All later descriptor readbacks and deletions are real.
  t.mock.method(process, "dlopen", (module: NodeModule, filename: string) => {
    assert.ok(filename.endsWith("/rename-no-replace.node"));
    module.exports = { publishNoReplace(sourceFd: number, source: string, destinationFd: number,
      destination: string, device: bigint, inode: bigint) {
      assert.equal(sourceFd, destinationFd);
      const sourcePath = `/proc/self/fd/${sourceFd}/${source}`;
      const destinationPath = `/proc/self/fd/${destinationFd}/${destination}`;
      assert.equal(fstatSync(sourceFd).isDirectory(), true);
      const stat = lstatSync(sourcePath, { bigint: true });
      assert.equal(stat.dev, device);
      assert.equal(stat.ino, inode);
      assert.throws(() => lstatSync(destinationPath), { code: "ENOENT" });
      renameSync(sourcePath, destinationPath);
      aliases.set(nested, parent);
      published = true;
      return 0;
    } };
  });
  const result = await owner.quarantineAndDelete(deadline());
  assert.equal(published, true);
  assert.ok(result.history.includes("quarantine-identity-readback"));
  assert.equal(result.evidence.status, "unproven");
  assert.equal(result.debt, true);
  assert.ok(!result.history.includes("exact-entry-remove-attempt"));
  const quarantine = (await fs.readdir(f.parent)).find(name => name.startsWith(".ar-private-root-"));
  assert.ok(quarantine);
  assert.equal(await fs.readFile(join(f.parent, quarantine, "secret"), "utf8"), "private");
  assert.equal(await fs.readFile(join(f.parent, "sibling"), "utf8"), "retained");
});
