import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withStableDirectoryProcessLock } from "../dist/stable-directory-process-lock.js";
import { stableDirectoryMutationCapability } from "../dist/stable-directory-capability.js";
import { publishStableDirectoryNoReplace } from "../dist/stable-directory-publication.js";

const supported = process.platform === "linux" || process.platform === "darwin";
const nativeTest = supported ? test : test.skip;
const disposable = async <T>(operation: (path: string) => Promise<T>): Promise<T> => {
  const path = await mkdtemp(join(await realpath(tmpdir()), "ar-directory-lock-test-"));
  try { return await operation(path); }
  finally { await rm(path, { recursive: true, force: true }); }
};

const message = (child: ChildProcess, expected: string): Promise<void> => new Promise((resolve, reject) => {
  const clean = () => {child.off("message", received); child.off("exit", exited); child.off("error", failed);};
  const received = (value: unknown) => {if (value === expected) {clean(); resolve();}};
  const exited = () => {clean(); reject(new Error("lock fixture exited before acknowledgement"));};
  const failed = (error: Error) => {clean(); reject(error);};
  child.on("message", received); child.once("exit", exited); child.once("error", failed);
});
const childOwner = (path: string) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./directory-process-lock-worker.mjs", import.meta.url)), path], {
    cwd: path, env: {}, shell: false, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.stderr?.resume();
  const closed = once(child, "close");
  return { child, closed, async dispose() {
    if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}
    await closed;
  } };
};

nativeTest("directory process lock returns the callback value and releases after errors", async () => {
  await disposable(async path => {
    const directory = await open(path, "r");
    try {
      assert.equal(await withStableDirectoryProcessLock(directory, async () => "held"), "held");
      await assert.rejects(withStableDirectoryProcessLock(directory, async () => {throw new Error("callback failed");}),
        /callback failed/u);
      const independent = await open(path, "r");
      try {assert.equal(await withStableDirectoryProcessLock(independent, async () => "reacquired"), "reacquired");}
      finally {await independent.close();}
    } finally {await directory.close();}
  });
});

nativeTest("different descriptors serialize and report contention once", { timeout: 5_000 }, async () => {
  await disposable(async path => {
    const firstDirectory = await open(path, "r"), secondDirectory = await open(path, "r");
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const contention = Promise.withResolvers<void>();
    let first: Promise<void> | undefined, second: Promise<void> | undefined, secondEntered = false, contentions = 0;
    try {
      first = withStableDirectoryProcessLock(firstDirectory, async () => {entered.resolve(); await release.promise;});
      void first.catch(entered.reject);
      await entered.promise;
      second = withStableDirectoryProcessLock(secondDirectory, async () => {secondEntered = true;}, {
        onContention: () => {contentions += 1; contention.resolve();},
      });
      void second.catch(contention.reject);
      await contention.promise;
      assert.equal(secondEntered, false);
      release.resolve();
      await Promise.all([first, second]);
      assert.equal(secondEntered, true);
      assert.equal(contentions, 1);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
      await firstDirectory.close(); await secondDirectory.close();
    }
  });
});

nativeTest("separate processes share the directory lock until its owner releases", { timeout: 5_000 }, async () => {
  await disposable(async path => {
    const first = childOwner(path);
    let second: ReturnType<typeof childOwner> | undefined;
    try {
      await message(first.child, "locked");
      second = childOwner(path);
      const secondLocked = message(second.child, "locked");
      void secondLocked.catch(() => {});
      await message(second.child, "contended");
      first.child.send("release");
      await secondLocked;
      second.child.send("release");
      assert.deepEqual(await first.closed, [0, null]);
      assert.deepEqual(await second.closed, [0, null]);
    } finally {await first.dispose(); await second?.dispose();}
  });
});

nativeTest("kernel releases the directory lock when its owner process dies", { timeout: 5_000 }, async () => {
  await disposable(async path => {
    const first = childOwner(path);
    let second: ReturnType<typeof childOwner> | undefined;
    try {
      await message(first.child, "locked");
      first.child.kill("SIGKILL");
      assert.deepEqual(await first.closed, [null, "SIGKILL"]);
      second = childOwner(path);
      await message(second.child, "locked");
      second.child.send("release");
      assert.deepEqual(await second.closed, [0, null]);
    } finally {await first.dispose(); await second?.dispose();}
  });
});

nativeTest("regular files and invalid descriptors never invoke a lock callback", async () => {
  await disposable(async path => {
    const file = await open(join(path, "file"), "wx", 0o600);
    let called = false;
    const callback = async () => {called = true;};
    try {
      await assert.rejects(withStableDirectoryProcessLock(file, callback), /argument is invalid/u);
      await assert.rejects(withStableDirectoryProcessLock({ fd: -1 }, callback), /argument is invalid/u);
      assert.equal(called, false);
    } finally {await file.close();}
  });
});

test("Darwin process locking does not admit Linux directory mutation or publication", { skip: process.platform !== "darwin" }, async () => {
  assert.equal(stableDirectoryMutationCapability().kind, "unsupported");
  await assert.rejects(publishStableDirectoryNoReplace({
    destinationDirectory: { fd: 0 }, destinationName: "target", expectedSourceIdentity: { dev: 1n, ino: 1n },
    sourceDirectory: { fd: 0 }, sourceName: "source",
  }), /qualified only on Linux/u);
});
