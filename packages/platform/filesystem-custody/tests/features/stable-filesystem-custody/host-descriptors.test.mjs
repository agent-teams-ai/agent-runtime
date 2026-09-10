import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, rename, symlink, writeFile, stat, readdir, copyFile, realpath, chmod, lstat, readlink, readFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import nodeTest from "node:test";
import { hasDarwinHostDescriptors, openNativeHostRoot, decodeHostNameBytes } from "../../../dist/features/stable-filesystem-custody/adapters/outbound/filesystem/host-descriptor.js";

const loaded = { exports: {} };
process.dlopen(loaded, fileURLToPath(new URL("../../../dist/rename-no-replace.node", import.meta.url)));
const native = loaded.exports;
// The shared suite may execute on Darwin only inside the explicitly guarded
// disposable worker. Never confine the main test runner.
const test = process.platform === "darwin" && !native.isDarwinHostAcquisitionGuardInstalled()
  ? (name, ...args) => nodeTest(name, { skip: "requires disposable guarded child" }, args.at(-1))
  : nodeTest;

// Linux runs the actual shared POSIX implementation. This is not a simulated
// Darwin run: Apple fstatfs, F_GETPATH and renameatx_np require separate Mac proof.
const fixture = async t => {
  const path = await mkdtemp(join(await realpath(tmpdir()), "ar-host-descriptor-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  let handle = native.hostRoot();
  try {
    for (const name of path.split("/").filter(Boolean)) {
      const next = native.hostOpen(handle, name, 1);
      native.hostClose(handle);
      handle = next;
    }
  } catch (error) {native.hostClose(handle); throw error;}
  t.after(() => native.hostClose(handle));
  return { path, handle };
};

test("Host native capability requires actual Apple binding methods", () => {
  if (process.platform === "darwin") {
    assert.equal(hasDarwinHostDescriptors(), true);
    const handle = openNativeHostRoot();
    return handle.close();
  }
  assert.equal(hasDarwinHostDescriptors(), false);
  assert.throws(() => openNativeHostRoot(), /unavailable/);
  assert.equal(native.hostMount, undefined);
  assert.equal(native.hostPath, undefined);
});

test("Host capability rejects a missing adjacent native binding", async t => {
  const path = await mkdtemp(join(tmpdir(), "ar-host-no-binding-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  // Mirror the emitted depth so the feature's own native resolver lands on a
  // sibling directory that has no qualified artifact, which is the real failure
  // this test reproduces.
  const outbound = join(path, "dist/features/stable-filesystem-custody/adapters/outbound");
  await mkdir(join(outbound, "filesystem"), { recursive: true });
  await mkdir(join(outbound, "native"), { recursive: true });
  const source = new URL("../../../dist/features/stable-filesystem-custody/adapters/outbound/", import.meta.url);
  const modulePath = join(outbound, "filesystem/host-descriptor.mjs");
  await copyFile(new URL("filesystem/host-descriptor.js", source), modulePath);
  await copyFile(new URL("filesystem/stable-directory-publication.js", source), join(outbound, "filesystem/stable-directory-publication.js"));
  await copyFile(new URL("native/stable-filesystem-native-artifact.js", source), join(outbound, "native/stable-filesystem-native-artifact.js"));
  const worker = spawnSync(process.execPath, [
    fileURLToPath(new URL("./host-descriptor-isolation-worker.mjs", import.meta.url)),
    modulePath,
  ], { encoding: "utf8", timeout: 15_000 });
  assert.ifError(worker.error);
  assert.equal(worker.status, 0, worker.stderr);
});

test("native inspection refuses a FIFO without opening it", async t => {
  const { path, handle } = await fixture(t);
  execFileSync("mkfifo", [join(path, "fifo")]);
  assert.throws(() => native.hostOpen(handle, "fifo", 0), /not a regular file/);
  assert.throws(() => native.hostOpen(handle, "fifo", 1), /not a regular file/);
});

test("native handles reject clones, invalid arguments and use after close", async t => {
  const { handle } = await fixture(t);
  for (const fake of [{}, { ...handle }, null, 0, -1]) {
    assert.throws(() => native.hostStat(fake), /invalid or closed/);
  }
  const duplicate = native.hostDuplicate(handle);
  assert.deepEqual(native.hostStat(duplicate), native.hostStat(handle));
  native.hostClose(duplicate);
  for (const operation of ["hostFd", "hostStat", "hostDuplicate", "hostClose", "hostSync"]) {
    assert.throws(() => native[operation](duplicate), /invalid or closed/);
  }
  for (const name of ["", ".", "..", "a/b", "../x", "a\0b", "\ud800", "\udc00", "x".repeat(256)]) {
    assert.throws(() => native.hostOpen(handle, name, 0), /invalid/);
    assert.throws(() => native.hostMkdir(handle, name), /invalid/);
    assert.throws(() => native.hostUnlink(handle, name), /invalid/);
  }
});

test("native process locks reject descriptor truncation and wrapped aliases", async t => {
  const { handle } = await fixture(t);
  const fd = native.hostFd(handle);
  for (const invalid of [fd + 0.5, 2 ** 32 + fd, NaN, Infinity, -1]) {
    assert.throws(() => native.tryLockDirectory(invalid), /argument is invalid/);
    assert.throws(() => native.unlockDirectory(invalid), /argument is invalid/);
  }
  assert.equal(native.tryLockDirectory(fd), true);
  native.unlockDirectory(fd);
});

test("native listing enforces hard and lower limits before proportional JS allocation", async t => {
  const { handle, path } = await fixture(t);
  await Promise.all([writeFile(join(path, "a"), "a"), mkdir(join(path, "b"))]);
  for (const maximum of [-1, 0.5, NaN, Infinity, 4097]) {
    assert.throws(() => native.hostNames(handle, maximum), /limit is invalid/);
  }
  for (const maximum of [0, 1]) {
    assert.throws(() => native.hostNames(handle, maximum), /bounded enumeration/);
  }
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(native.hostNames(handle, 2).map(bytes => bytes.toString()).toSorted(), ["a", "b"]);
  }
});

test("native open rejects symlink replacement and retains the captured directory inode", async t => {
  const { handle, path } = await fixture(t);
  native.hostMkdir(handle, "child");
  const child = native.hostOpen(handle, "child", 1);
  try {
    const identity = native.hostStat(child);
    await rename(join(path, "child"), join(path, "retained"));
    await symlink("retained", join(path, "child"));
    assert.throws(() => native.hostOpen(handle, "child", 1), /open failed/);
    assert.throws(() => native.hostOpen(handle, "child", 0), /open failed/);
    assert.equal(native.hostStat(child).ino, identity.ino);
    native.hostMkdir(child, "inside");
    assert.deepEqual(await readdir(join(path, "retained")), ["inside"]);
  } finally {native.hostClose(child);}
});

test("native exclusive write, bounded pread, mode, sync and unlink preserve bytes and identity", async t => {
  const { handle, path } = await fixture(t);
  const file = native.hostOpen(handle, "record", 2);
  try {
    assert.throws(() => native.hostOpen(handle, "record", 2), /open failed/);
    assert.throws(() => native.hostWrite(file, Buffer.alloc(65537)), /exceeds bound/);
    native.hostWrite(file, Buffer.from([0, 255, 10, 128]));
    native.hostChmod(file, 0o600);
    native.hostSync(file);
    const actual = await stat(join(path, "record"), { bigint: true });
    const captured = native.hostStat(file);
    for (const key of ["dev", "ino", "size", "uid", "mode", "mtimeNs", "ctimeNs", "nlink"]) {
      assert.equal(captured[key], actual[key]);
    }
  } finally {native.hostClose(file);}
  const readable = native.hostOpen(handle, "record", 0);
  try {
    const bytes = Buffer.alloc(4);
    assert.equal(native.hostRead(readable, bytes, 0), 4);
    assert.deepEqual(bytes, Buffer.from([0, 255, 10, 128]));
    assert.equal(native.hostRead(readable, bytes, 4), 0);
    for (const position of [-1, 0.5, NaN, 33554433]) {
      assert.throws(() => native.hostRead(readable, bytes, position), /invalid/);
    }
    assert.throws(() => native.hostRead(readable, Buffer.alloc(65537), 0), /invalid/);
  } finally {native.hostClose(readable);}
  native.hostUnlink(handle, "record");
  native.hostSync(handle);
  assert.deepEqual(await readdir(path), []);
});


test("Host filename decoder round-trips BOM and non-ASCII native names exactly", async t => {
  const { path, handle } = await fixture(t);
  const names = ["foo", "\uFEFFfoo", "é", "中", "𐀀", "\uE000"];
  for (const name of names) {await writeFile(join(path, name), name);}
  const raw = native.hostNames(handle, names.length);
  const decoded = decodeHostNameBytes(raw);
  assert.deepEqual([...decoded].toSorted(), [...names].toSorted());
  for (let i = 0; i < raw.length; i++) {assert.deepEqual(Buffer.from(decoded[i]), raw[i]);}
  assert.throws(() => decodeHostNameBytes([Buffer.from([0xff])]), /encoded data/);
  for (const name of decoded) {
    const file = native.hostOpen(handle, name, 0);
    try {
      const bytes = Buffer.alloc(32);
      const length = native.hostRead(file, bytes, 0);
      assert.equal(bytes.subarray(0, length).toString(), name);
    } finally {native.hostClose(file);}
    assert.equal(native.hostQuarantine(handle, name, handle, `retained-${name}`), 0);
    assert.equal(await readFile(join(path, `retained-${name}`), "utf8"), name);
  }
});

test("Host syscall errors preserve actual symbolic and positive native errno", async t => {
  const { handle } = await fixture(t);
  assert.throws(() => native.hostOpen(handle, "missing", 0), check("ENOENT"));
  const file = native.hostOpen(handle, "file", 2);
  try {
    assert.throws(() => native.hostOpen(handle, "file", 2), check("EEXIST"));
    assert.throws(() => native.hostOpen(file, "child", 0), check("ENOTDIR"));
    assert.throws(() => native.hostNames(file, 1), check("ENOTDIR"));
    assert.throws(() => native.hostRead(file, Buffer.alloc(1), 0), check("EBADF"));
    assert.throws(() => native.hostRead(handle, Buffer.alloc(1), 0), check("EISDIR"));
    native.hostMkdir(handle, "directory");
    assert.throws(() => native.hostUnlink(handle, "directory"), error =>
      ["EISDIR", "EPERM"].some(code => check(code)(error)));
  } finally {native.hostClose(file);}
});

test("Host quarantine captures symlink and FIFO own identities without opening targets", { timeout: 5000 }, async t => {
  const { path, handle } = await fixture(t);
  await writeFile(join(path, "target"), "untouched");
  await symlink("target", join(path, "link"));
  execFileSync("mkfifo", [join(path, "fifo")]);
  for (const name of ["link", "fifo"]) {
    const before = await lstat(join(path, name), { bigint: true });
    assert.throws(() => native.hostOpen(handle, name, 0), /not a regular file/);
    assert.equal(native.hostQuarantine(handle, name, handle, `saved-${name}`), 0);
    const after = await lstat(join(path, `saved-${name}`), { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
  }
  assert.equal(await readlink(join(path, "saved-link")), "target");
  assert.equal(await readFile(join(path, "target"), "utf8"), "untouched");
  native.hostSync(handle);
});

test("Host quarantine retains no-replace, restoration and ambiguous residue contracts", async t => {
  const { path, handle } = await fixture(t);
  await symlink("missing", join(path, "source"));
  await writeFile(join(path, "destination"), "winner");
  const before = await lstat(join(path, "source"), { bigint: true });
  const incomplete = `.ar-publish-v1-${before.dev.toString(16)}-${before.ino.toString(16)}-destination.incomplete`;
  assert.equal(native.hostQuarantine(handle, "source", handle, "destination"), 73);
  assert.equal((await lstat(join(path, "source"), { bigint: true })).ino, before.ino);
  // An identity-owned incomplete residue cannot overwrite an occupied source.
  await rename(join(path, "source"), join(path, incomplete));
  await symlink("replacement", join(path, "source"));
  const fd = native.hostFd(handle);
  assert.equal(native.publishNoReplace(fd, "source", fd, "destination", before.dev, before.ino, incomplete), 77);
  await rm(join(path, "source"));
  assert.equal(native.publishNoReplace(fd, "source", fd, "destination", before.dev, before.ino, incomplete), 73);
  assert.equal((await lstat(join(path, "source"), { bigint: true })).ino, before.ino);
  assert.equal(await readFile(join(path, "destination"), "utf8"), "winner");
});


test("Host reports EACCES from an actual inaccessible owned parent", { skip: process.getuid?.() === 0 }, async t => {
  const { path, handle } = await fixture(t);
  native.hostMkdir(handle, "denied");
  const denied = native.hostOpen(handle, "denied", 1);
  try {
    await chmod(join(path, "denied"), 0);
    assert.throws(() => native.hostOpen(denied, "child", 2), error =>
      error.code === "EACCES" && error.errno === osConstants.errno.EACCES);
  } finally {
    await chmod(join(path, "denied"), 0o700);
    native.hostClose(denied);
  }
});

test("Host quarantine uses pinned parents after directory name replacement", async t => {
  const { path, handle } = await fixture(t);
  native.hostMkdir(handle, "parent");
  const parent = native.hostOpen(handle, "parent", 1);
  try {
    await mkdir(join(path, "parent", "entry"));
    const before = await lstat(join(path, "parent", "entry"), { bigint: true });
    await rename(join(path, "parent"), join(path, "pinned"));
    await mkdir(join(path, "parent"));
    await writeFile(join(path, "parent", "entry"), "replacement");
    assert.equal(native.hostQuarantine(parent, "entry", handle, "saved-directory"), 0);
    assert.equal((await lstat(join(path, "saved-directory"), { bigint: true })).ino, before.ino);
    assert.equal(await readFile(join(path, "parent", "entry"), "utf8"), "replacement");
  } finally {native.hostClose(parent);}
});

const check = code => error => error.code === code && error.errno === osConstants.errno[code];
