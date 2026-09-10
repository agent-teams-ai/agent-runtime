import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, rename, symlink, writeFile, stat, readdir, copyFile, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { hasDarwinHostDescriptors, openNativeHostRoot } from "../dist/host-descriptor.js";

const loaded = { exports: {} };
process.dlopen(loaded, fileURLToPath(new URL("../dist/rename-no-replace.node", import.meta.url)));
const native = loaded.exports;

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
  const modulePath = join(path, "host-descriptor.mjs");
  await copyFile(new URL("../dist/host-descriptor.js", import.meta.url), modulePath);
  const isolated = await import(pathToFileURL(modulePath).href);
  assert.equal(isolated.hasDarwinHostDescriptors(), false);
  assert.throws(() => isolated.openNativeHostRoot(), /unavailable/);
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
    assert.deepEqual(native.hostNames(handle, 2).map(bytes => bytes.toString()).sort(), ["a", "b"]);
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
