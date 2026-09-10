import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, chmod, rename, symlink, readFile, readdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanContainedTurnWorkspace } from "../../../dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-workspace-tree.js";
import { bindContainedTurnRoot, openBoundDirectory } from "../../../dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-filesystem-custody.js";
import { writeImmutableFileAt, readStableFileAt, quarantineAmbiguousStagingDirectory } from "../../../dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-durable-file.js";

const fixture = async (t: import("node:test").TestContext) => {
  // macOS /tmp is an alias; use its canonical disposable location.
  const { realpath } = await import("node:fs/promises");
  const root = await mkdtemp(join(await realpath(tmpdir()), "ar69-scanner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};
const limits = { maxDepth: 2, maxEntries: 4, maxFileBytes: 8, maxTotalBytes: 16 };

test("Host scanner preserves exact bytes, UTF16 ordering, modes and digest", async t => {
  const root = await fixture(t);
  const bytes = Buffer.from([0, 255, 10]);
  await mkdir(join(root, "empty"), { mode: 0o700 });
  await writeFile(join(root, "z"), bytes);
  await chmod(join(root, "z"), 0o640);
  const tree = await scanContainedTurnWorkspace(root, limits);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(tree.entries, [
    { kind: "directory", relativePath: "empty", mode: 0o700 },
    { kind: "file", relativePath: "z", mode: 0o640, size: 3, digest },
  ]);
  assert.deepEqual(tree.files[0]?.bytes, bytes);
  assert.equal(tree.treeDigest, createHash("sha256").update(JSON.stringify([
    ["directory", "empty", 0o700], ["file", "z", 0o640, 3, digest],
  ])).digest("hex"));
});

test("Host scanner enforces lower entry, file, total and depth bounds", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "a"), "12345");
  await writeFile(join(root, "b"), "12345");
  await assert.rejects(scanContainedTurnWorkspace(root, { ...limits, maxEntries: 1 }), /enumeration|entry/);
  await assert.rejects(scanContainedTurnWorkspace(root, { ...limits, maxFileBytes: 4 }), /bounded read/);
  await assert.rejects(scanContainedTurnWorkspace(root, { ...limits, maxFileBytes: 8, maxTotalBytes: 8 }), /bounded read/);
  await mkdir(join(root, "nested"));
  await assert.rejects(scanContainedTurnWorkspace(root, { ...limits, maxDepth: 0 }), /depth/);
});

test("Host scanner rejects symlink replacement and special files", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "a"), "data");
  await assert.rejects(scanContainedTurnWorkspace(root, limits, {
    checkpoint: async event => {
      if (event.phase === "before-entry-open" && event.relativePath === "a") {
        await rename(join(root, "a"), join(root, "retained"));
        await symlink("retained", join(root, "a"));
      }
    },
  }), /symbolic link|open failed/);
  await rm(join(root, "a"));
  execFileSync("mkfifo", [join(root, "fifo")]);
  await assert.rejects(scanContainedTurnWorkspace(root, limits), /non-file|not a regular file/);
});

test("Host scanner rejects namespace mutation after file read", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "a"), "data");
  await assert.rejects(scanContainedTurnWorkspace(root, limits, {
    checkpoint: async event => {
      if (event.phase === "after-file-read") await writeFile(join(root, "new"), "new");
    },
  }), /directory changed/);
});

const store = async (t: import("node:test").TestContext) => {
  const root = await fixture(t);
  const stagingPath = join(root, "staging");
  const finalPath = join(root, "final");
  await mkdir(stagingPath, { mode: 0o700 });
  await mkdir(finalPath, { mode: 0o700 });
  const stagingDirectory = await openBoundDirectory(await bindContainedTurnRoot(stagingPath));
  let finalDirectory;
  try { finalDirectory = await openBoundDirectory(await bindContainedTurnRoot(finalPath)); }
  catch (error) { await stagingDirectory.close(); throw error; }
  t.after(async () => {
    try { await stagingDirectory.close(); } finally { await finalDirectory.close(); }
  });
  return { stagingPath, finalPath, stagingDirectory, finalDirectory };
};

test("Host durable metadata publication preserves duplicates, exact bytes and empty staging", async t => {
  const directories = await store(t);
  const input = { ...directories, finalName: "receipt.json", bytes: Buffer.from('{"version":1}\n'), temporaryKind: "metadata" as const };
  assert.equal(await writeImmutableFileAt(input), "created");
  assert.equal(await writeImmutableFileAt(input), "existing");
  assert.deepEqual(await readStableFileAt(input.finalDirectory, input.finalName, input.bytes.length), input.bytes);
  await assert.rejects(writeImmutableFileAt({ ...input, bytes: Buffer.from("different") }), /bounded|collision|mismatch/);
  assert.deepEqual(await readFile(join(input.finalPath, input.finalName)), input.bytes);
  assert.deepEqual(await readdir(input.stagingPath), []);
});

test("Host durable write failure before publication removes only its own staging file", async t => {
  const directories = await store(t);
  const marker = join(directories.stagingPath, "unowned");
  await writeFile(marker, "preserve");
  let observedBeforePublish = false;
  await assert.rejects(writeImmutableFileAt({
    ...directories, finalName: "receipt.json", bytes: Buffer.from("record"), temporaryKind: "metadata",
    faults: { checkpoint: async point => {
      if (point !== "metadata.before-publish") return;
      observedBeforePublish = true;
      assert.deepEqual(await readdir(directories.finalPath), []);
      assert.equal((await readdir(directories.stagingPath)).length, 2);
      throw new Error("injected before publication");
    } },
  }), /injected before publication/);
  assert.equal(observedBeforePublish, true);
  assert.deepEqual(await readdir(directories.stagingPath), ["unowned"]);
  assert.deepEqual(await readdir(directories.finalPath), []);
  assert.equal(await readFile(marker, "utf8"), "preserve");
});

test("Host staging creation is cleaned when descriptor validation fails", { skip: process.platform !== "linux" }, async t => {
  const directories = await store(t);
  // The existing pathname fault hook is Linux-only. Closing the real newly
  // created descriptor forces validation to fail before the opened checkpoint.
  await assert.rejects(writeImmutableFileAt({
    ...directories, finalName: "receipt.json", bytes: Buffer.from("record"), temporaryKind: "metadata",
    faults: {
      checkpoint() {},
      openFile: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        await handle.close();
        return handle;
      },
    },
  }));
  assert.deepEqual(await readdir(directories.stagingPath), []);
  assert.deepEqual(await readdir(directories.finalPath), []);
});


test("Host scanner and staging quarantine preserve BOM and non-ASCII filename identity", async t => {
  const { stagingPath, finalPath, stagingDirectory, finalDirectory } = await store(t);
  const names = ["foo", "\uFEFFfoo", "é", "中"];
  for (const name of names) await writeFile(join(stagingPath, name), "data");
  const tree = await scanContainedTurnWorkspace(stagingPath, limits);
  assert.deepEqual(tree.entries.map(entry => entry.relativePath), [...names].sort());
  assert.equal(await quarantineAmbiguousStagingDirectory(stagingDirectory, finalDirectory, 4), 4);
  assert.deepEqual(await readdir(stagingPath), []);
  const retained = await readdir(finalPath);
  for (const name of names) {
    assert.equal(retained.filter(entry => entry.endsWith(`-${name}.retained`)).length, 1);
  }
});
