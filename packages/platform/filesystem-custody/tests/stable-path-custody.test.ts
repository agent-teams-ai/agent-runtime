import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  type FileHandle,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertSameStableDirectoryMountIdentity,
  capturePathLineage,
  openStablePath,
  pathLineagesEqual,
  publishStableDirectoryNoReplace,
  readStableDirectoryMountIdentity,
  resolveStableDirectoryMutationCapability,
  StableDirectoryPublicationAmbiguousResidueError,
} from "../dist/index.js";

const execFile = promisify(execFileCallback);
const publicationCrashWorker = fileURLToPath(new URL(
  "./publication-crash-worker.ts",
  import.meta.url,
));

test("classifies macOS destructive descriptor custody as explicitly unsupported", () => {
  assert.deepEqual(resolveStableDirectoryMutationCapability({
    hasDirectoryOpen: true,
    hasNoFollowOpen: true,
    platform: "darwin",
  }), {
    kind: "unsupported",
    platform: "darwin",
    reason: "identity-stable descriptor-relative directory mutation is unavailable through current Node APIs",
    version: 1,
  });
});

test("classifies the complete Linux descriptor capability as supported", () => {
  assert.deepEqual(resolveStableDirectoryMutationCapability({
    hasDirectoryOpen: true,
    hasNoFollowOpen: true,
    platform: "linux",
  }), {
    descriptorRoot: "/proc/self/fd",
    kind: "supported",
    platform: "linux",
    version: 1,
  });
});

test("classifies incomplete descriptor primitives as unsupported without platform I/O", () => {
  for (const input of [
    { hasDirectoryOpen: false, hasNoFollowOpen: true, platform: "linux" as const },
    { hasDirectoryOpen: true, hasNoFollowOpen: false, platform: "linux" as const },
  ]) {
    assert.deepEqual(resolveStableDirectoryMutationCapability(input), {
      kind: "unsupported",
      platform: "linux",
      reason: "identity-stable descriptor-relative directory mutation is unavailable through current Node APIs",
      version: 1,
    });
  }
});

test("reads a bounded stable Linux mount identity without exposing a path", async t => {
  if (process.platform !== "linux") {
    t.skip("Linux descriptor mount identity is not claimed on this platform");
    return;
  }
  const handle = await open(tmpdir(), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    assert.match(await readStableDirectoryMountIdentity(handle.fd), /^\d+$/u);
  } finally {
    await handle.close();
  }
});

test("rejects injected same-device traversal when mount identities differ", () => {
  assert.doesNotThrow(() => assertSameStableDirectoryMountIdentity("41", "41"));
  assert.throws(
    () => assertSameStableDirectoryMountIdentity("41", "99"),
    /crossed a mount boundary/u,
  );
});

test("detects a same-device bind mount with a distinct Linux mount identity", async t => {
  if (process.platform !== "linux") {
    t.skip("Linux bind-mount identity is not claimed on this platform");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ar-bind-mount-"));
  const source = join(root, "source");
  const mounted = join(root, "mounted");
  await Promise.all([mkdir(source), mkdir(mounted)]);
  let fixtureMounted = false;
  t.after(async () => {
    if (fixtureMounted) {await execFile("/usr/bin/umount", [mounted]);}
    await rm(root, { force: true, recursive: true });
  });
  try {
    await execFile("/usr/bin/mount", ["--bind", source, mounted]);
    fixtureMounted = true;
  } catch {
    t.skip("the disposable runner cannot create a bind-mount fixture");
    return;
  }
  const [sourceStat, mountedStat] = await Promise.all([stat(source), stat(mounted)]);
  assert.equal(sourceStat.dev, mountedStat.dev);
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_DIRECTORY);
  const mountedHandle = await open(mounted, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const [sourceMount, mountedMount] = await Promise.all([
      readStableDirectoryMountIdentity(sourceHandle.fd),
      readStableDirectoryMountIdentity(mountedHandle.fd),
    ]);
    assert.notEqual(sourceMount, mountedMount);
    assert.throws(
      () => assertSameStableDirectoryMountIdentity(sourceMount, mountedMount),
      /crossed a mount boundary/u,
    );
  } finally {await Promise.all([sourceHandle.close(), mountedHandle.close()]);}
});

test("Linux no-replace publication preserves inserted destinations and replaced sources", async t => {
  if (process.platform !== "linux") {
    t.skip("Linux renameat2 publication is not claimed on this platform");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ar-no-replace-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourceRoot = join(root, "source");
  const destinationRoot = join(root, "destination");
  await Promise.all([mkdir(sourceRoot), mkdir(destinationRoot)]);
  const sourceParent = await open(sourceRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  const destinationParent = await open(destinationRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await mkdir(join(sourceRoot, "candidate"));
    await mkdir(join(destinationRoot, "published"));
    const source = await open(join(sourceRoot, "candidate"), constants.O_RDONLY | constants.O_DIRECTORY);
    const sourceIdentity = await source.stat({ bigint: true });
    await source.close();
    assert.equal(await publishStableDirectoryNoReplace({
      destinationDirectory: destinationParent,
      destinationName: "published",
      expectedSourceIdentity: sourceIdentity,
      sourceDirectory: sourceParent,
      sourceName: "candidate",
    }), "existing");
    assert.equal((await stat(join(sourceRoot, "candidate"))).isDirectory(), true);

    await rename(join(sourceRoot, "candidate"), join(sourceRoot, "displaced"));
    await mkdir(join(sourceRoot, "candidate"));
    await assert.rejects(
      publishStableDirectoryNoReplace({
        destinationDirectory: destinationParent,
        destinationName: "other",
        expectedSourceIdentity: sourceIdentity,
        sourceDirectory: sourceParent,
        sourceName: "candidate",
      }),
      /source identity changed/u,
    );
    assert.equal((await stat(join(sourceRoot, "candidate"))).isDirectory(), true);
  } finally {
    await Promise.all([sourceParent.close(), destinationParent.close()]);
  }
});

test("Linux no-replace publication recovers a durably captured incomplete source", async t => {
  if (process.platform !== "linux") {
    t.skip("Linux descriptor publication recovery is not claimed on this platform");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ar-no-replace-recovery-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourceRoot = join(root, "source");
  const destinationRoot = join(root, "destination");
  await Promise.all([mkdir(sourceRoot), mkdir(destinationRoot)]);
  await mkdir(join(sourceRoot, "candidate"));
  const sourceParent = await open(sourceRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  const destinationParent = await open(destinationRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const source = await open(join(sourceRoot, "candidate"), constants.O_RDONLY | constants.O_DIRECTORY);
    const identity = await source.stat({ bigint: true });
    await source.close();
    const incomplete = `.ar-publish-v1-${identity.dev.toString(16)}-${identity.ino.toString(16)}-published.incomplete`;
    await rename(join(sourceRoot, "candidate"), join(destinationRoot, incomplete));
    assert.equal(await publishStableDirectoryNoReplace({
      destinationDirectory: destinationParent,
      destinationName: "published",
      expectedSourceIdentity: identity,
      sourceDirectory: sourceParent,
      sourceName: "candidate",
    }), "created");
    assert.equal((await stat(join(destinationRoot, "published"))).ino, Number(identity.ino));
  } finally {await Promise.all([sourceParent.close(), destinationParent.close()]);}
});

test("Linux no-replace publication recovers its identity-bound SIGKILL residue", async t => {
  if (process.platform !== "linux") {
    t.skip("Linux descriptor publication recovery is not claimed on this platform");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ar-no-replace-sigkill-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourceRoot = join(root, "source");
  const destinationRoot = join(root, "destination");
  await Promise.all([mkdir(sourceRoot), mkdir(destinationRoot)]);
  await mkdir(join(sourceRoot, "candidate"));
  const identity = await stat(join(sourceRoot, "candidate"), { bigint: true });
  const child = execFileCallback(process.execPath, [publicationCrashWorker, root]);
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  assert.deepEqual(outcome, { code: null, signal: "SIGKILL" });
  const [residue] = await readdir(destinationRoot);
  assert.match(residue ?? "", /^\.ar-publish-v1-.+\.incomplete$/u);

  const source = await open(sourceRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  const destination = await open(destinationRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    assert.equal(await publishStableDirectoryNoReplace({
      destinationDirectory: destination,
      destinationName: "published",
      expectedSourceIdentity: identity,
      sourceDirectory: source,
      sourceName: "candidate",
    }), "created");
  } finally {await Promise.all([source.close(), destination.close()]);}
  assert.deepEqual(await readdir(destinationRoot), ["published"]);
  assert.equal((await stat(join(destinationRoot, "published"), { bigint: true })).ino, identity.ino);
});

test("Linux no-replace restart restores owned SIGKILL residue when a destination appeared", async t => {
  if (process.platform !== "linux") {
    t.skip("Linux descriptor publication recovery is not claimed on this platform");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ar-no-replace-sigkill-race-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourceRoot = join(root, "source");
  const destinationRoot = join(root, "destination");
  await Promise.all([mkdir(sourceRoot), mkdir(destinationRoot)]);
  await mkdir(join(sourceRoot, "candidate"));
  const identity = await stat(join(sourceRoot, "candidate"), { bigint: true });
  const child = execFileCallback(process.execPath, [publicationCrashWorker, root]);
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  assert.deepEqual(outcome, { code: null, signal: "SIGKILL" });
  await mkdir(join(destinationRoot, "published"));

  const source = await open(sourceRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  const destination = await open(destinationRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    assert.equal(await publishStableDirectoryNoReplace({
      destinationDirectory: destination,
      destinationName: "published",
      expectedSourceIdentity: identity,
      sourceDirectory: source,
      sourceName: "candidate",
    }), "existing");
  } finally {await Promise.all([source.close(), destination.close()]);}
  assert.deepEqual(await readdir(destinationRoot), ["published"]);
  assert.equal((await stat(join(sourceRoot, "candidate"), { bigint: true })).ino, identity.ino);
});

test("Linux no-replace restart fails closed when final, residue, and replacement source coexist", async t => {
  if (process.platform !== "linux") {
    t.skip("Linux descriptor publication recovery is not claimed on this platform");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ar-no-replace-sigkill-ambiguous-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourceRoot = join(root, "source");
  const destinationRoot = join(root, "destination");
  await Promise.all([mkdir(sourceRoot), mkdir(destinationRoot)]);
  await mkdir(join(sourceRoot, "candidate"));
  const identity = await stat(join(sourceRoot, "candidate"), { bigint: true });
  const child = execFileCallback(process.execPath, [publicationCrashWorker, root]);
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  assert.deepEqual(outcome, { code: null, signal: "SIGKILL" });
  const [residue] = await readdir(destinationRoot);
  assert.match(residue ?? "", /^\.ar-publish-v1-.+\.incomplete$/u);
  await mkdir(join(destinationRoot, "published"));
  await mkdir(join(sourceRoot, "candidate"));
  const replacement = await stat(join(sourceRoot, "candidate"), { bigint: true });

  const source = await open(sourceRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  const destination = await open(destinationRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await assert.rejects(publishStableDirectoryNoReplace({
      destinationDirectory: destination,
      destinationName: "published",
      expectedSourceIdentity: identity,
      sourceDirectory: source,
      sourceName: "candidate",
    }), error => error instanceof StableDirectoryPublicationAmbiguousResidueError);
  } finally {await Promise.all([source.close(), destination.close()]);}
  assert.deepEqual((await readdir(destinationRoot)).toSorted(), [residue, "published"].toSorted());
  assert.equal((await stat(join(sourceRoot, "candidate"), { bigint: true })).ino, replacement.ino);
  assert.notEqual(replacement.ino, identity.ino);
});

test("Linux no-replace recovery never moves arbitrary deterministic-name residue", async t => {
  if (process.platform !== "linux") {
    t.skip("Linux descriptor publication recovery is not claimed on this platform");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ar-no-replace-unowned-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourceRoot = join(root, "source");
  const destinationRoot = join(root, "destination");
  await Promise.all([mkdir(sourceRoot), mkdir(destinationRoot)]);
  await mkdir(join(sourceRoot, "candidate"));
  const identity = await stat(join(sourceRoot, "candidate"), { bigint: true });
  await rename(join(sourceRoot, "candidate"), join(root, "retained-evidence"));
  const incomplete = `.ar-publish-v1-${identity.dev.toString(16)}-${identity.ino.toString(16)}-published.incomplete`;
  await mkdir(join(destinationRoot, incomplete));
  await writeFile(join(destinationRoot, incomplete, "unknown"), "arbitrary");
  const source = await open(sourceRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  const destination = await open(destinationRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await assert.rejects(publishStableDirectoryNoReplace({
      destinationDirectory: destination,
      destinationName: "published",
      expectedSourceIdentity: identity,
      sourceDirectory: source,
      sourceName: "candidate",
    }), /source identity changed/u);
  } finally {await Promise.all([source.close(), destination.close()]);}
  assert.equal(await readFile(join(destinationRoot, incomplete, "unknown"), "utf8"), "arbitrary");
  assert.deepEqual(await readdir(sourceRoot), []);
});

const makeFifo = async (path: string): Promise<void> => {
  await execFile("/usr/bin/mkfifo", [path]);
};

test("opens a POSIX/macOS regular file through stable descriptor custody", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-path-custody-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "inside", "config.toml");
  await mkdir(join(root, "inside"));
  await writeFile(path, "model = 'synthetic'\n");
  let retainedHandle: FileHandle | undefined;

  const result = await openStablePath(path, await realpath(path), async opened => {
    retainedHandle = opened.handle;
    return {
      bytes: await opened.handle.readFile(),
      identity: `${opened.stats.dev}:${opened.stats.ino}`,
    };
  });

  assert.equal(result.bytes.toString("utf8"), "model = 'synthetic'\n");
  assert.match(result.identity, /^\d+:\d+$/u);
  assert.ok(retainedHandle);
  await assert.rejects(retainedHandle.stat(), error =>
    typeof error === "object" && error !== null && "code" in error && error.code === "EBADF"
  );
});

test(
  "rejects existing non-regular and multiply-linked paths before open",
  { skip: process.platform === "win32" },
  async t => {
    const root = await mkdtemp(join(tmpdir(), "ar-path-preflight-"));
    t.after(() => rm(root, { force: true, recursive: true }));

    const regular = join(root, "regular");
    const hardlink = join(root, "hardlink");
    const fifo = join(root, "fifo");
    const directory = join(root, "directory");
    const socket = join(root, "socket");
    await writeFile(regular, "synthetic");
    await link(regular, hardlink);
    await makeFifo(fifo);
    await mkdir(directory);

    const assertPreflightRejection = async (
      name: string,
      path: string,
    ): Promise<void> => {
      await t.test(name, async () => {
        let openCalls = 0;
        let callbackCalls = 0;
        await assert.rejects(
          openStablePath(
            path,
            await realpath(path),
            async () => {
              callbackCalls += 1;
            },
            {
              async openFile(target, flags) {
                openCalls += 1;
                return open(target, flags);
              },
            },
          ),
          /single-link regular file/u,
        );
        assert.equal(openCalls, 0, `${name} must not reach open`);
        assert.equal(callbackCalls, 0, `${name} must not reach the callback`);
      });
    };

    for (const [name, path] of [
      ["FIFO", fifo],
      ["directory", directory],
      ["hardlink", hardlink],
      ["device", "/dev/null"],
    ] as const) {
      await assertPreflightRejection(name, path);
    }

    await t.test("socket", async socketTest => {
      const server = createServer();
      const previousDirectory = process.cwd();
      try {
        process.chdir(root);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen("socket", resolve);
        });
      } catch (error) {
        process.chdir(previousDirectory);
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "EPERM" || error.code === "EINVAL")
        ) {
          socketTest.skip("Unix socket creation is unavailable at this sandbox path");
          return;
        }
        throw error;
      }
      socketTest.after(() => new Promise<void>(resolve => {
        server.close(() => {
          process.chdir(previousDirectory);
          resolve();
        });
      }));
      let openCalls = 0;
      let callbackCalls = 0;
      await assert.rejects(
        openStablePath(
          socket,
          await realpath(socket),
          async () => {
            callbackCalls += 1;
          },
          {
            async openFile(target, flags) {
              openCalls += 1;
              return open(target, flags);
            },
          },
        ),
        /single-link regular file/u,
      );
      assert.equal(openCalls, 0, "socket must not reach open");
      assert.equal(callbackCalls, 0, "socket must not reach the callback");
    });
  },
);

test(
  "rejects a regular-to-FIFO replacement after one nonblocking open",
  { skip: process.platform === "win32" },
  async t => {
    const root = await mkdtemp(join(tmpdir(), "ar-path-fifo-race-"));
    t.after(() => rm(root, { force: true, recursive: true }));
    const path = join(root, "candidate");
    const displaced = join(root, "candidate-before");
    await writeFile(path, "synthetic");
    let openCalls = 0;
    let callbackCalls = 0;
    let retainedHandle: FileHandle | undefined;

    await assert.rejects(
      openStablePath(
        path,
        await realpath(path),
        async () => {
          callbackCalls += 1;
        },
        {
          async openFile(target, flags) {
            openCalls += 1;
            await rename(path, displaced);
            await makeFifo(path);
            retainedHandle = await open(target, flags);
            return retainedHandle;
          },
        },
      ),
      /single-link regular file/u,
    );
    assert.equal(openCalls, 1);
    assert.equal(callbackCalls, 0);
    assert.ok(retainedHandle);
    await assert.rejects(retainedHandle.stat(), error =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EBADF"
    );
  },
);

test("rejects a regular-to-regular replacement before callback", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-path-regular-race-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "candidate");
  const displaced = join(root, "candidate-before");
  await writeFile(path, "first");
  let openCalls = 0;
  let callbackCalls = 0;
  let retainedHandle: FileHandle | undefined;

  await assert.rejects(
    openStablePath(
      path,
      await realpath(path),
      async () => {
        callbackCalls += 1;
      },
      {
        async openFile(target, flags) {
          openCalls += 1;
          await rename(path, displaced);
          await writeFile(path, "second");
          retainedHandle = await open(target, flags);
          return retainedHandle;
        },
      },
    ),
    /Path lineage changed while it was being opened/u,
  );
  assert.equal(openCalls, 1);
  assert.equal(callbackCalls, 0);
  assert.ok(retainedHandle);
  await assert.rejects(retainedHandle.stat(), error =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EBADF"
  );
});

test("closes descriptor custody when the operation is cancelled", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-path-custody-cancel-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "config.toml");
  await writeFile(path, "model = 'synthetic'\n");
  const controller = new AbortController();
  let retainedHandle: FileHandle | undefined;

  await assert.rejects(
    openStablePath(
      path,
      await realpath(path),
      async opened => {
        retainedHandle = opened.handle;
        controller.abort(new Error("cancelled during descriptor custody"));
        controller.signal.throwIfAborted();
      },
      { signal: controller.signal },
    ),
    /cancelled during descriptor custody/u,
  );
  assert.ok(retainedHandle);
  await assert.rejects(retainedHandle.readFile(), error =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EBADF"
  );
});

test("detects an ancestor that was renamed and restored", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-path-lineage-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const parent = join(root, "inside");
  const moved = join(root, "moved");
  const path = join(parent, "config.toml");
  await mkdir(parent);
  await writeFile(path, "synthetic");

  const before = await capturePathLineage(path, root);
  await rename(parent, moved);
  await rename(moved, parent);
  const after = await capturePathLineage(path, root);

  assert.equal(pathLineagesEqual(before, after), false);
});

test("accepts a legitimate path component beginning with two dots", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-path-dot-prefix-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "..config");
  await writeFile(path, "synthetic");

  const lineage = await capturePathLineage(path, root);

  assert.equal(lineage.components.length, 2);
});

test(
  "treats a backslash as a filename character on POSIX",
  { skip: process.platform === "win32" },
  async t => {
    const root = await mkdtemp(join(tmpdir(), "ar-path-backslash-"));
    t.after(() => rm(root, { force: true, recursive: true }));
    const path = join(root, "directory\\name");
    await writeFile(path, "synthetic");

    const lineage = await capturePathLineage(path, root);

    assert.equal(lineage.components.length, 2);
  },
);

test("rejects a path under an unrelated sibling boundary", async t => {
  const parent = await mkdtemp(join(tmpdir(), "ar-path-twin-root-"));
  t.after(() => rm(parent, { force: true, recursive: true }));
  const boundary = join(parent, "root");
  const twin = join(parent, "root-twin");
  const path = join(twin, "config.toml");
  await Promise.all([mkdir(boundary), mkdir(twin)]);
  await writeFile(path, "synthetic");

  await assert.rejects(
    capturePathLineage(path, boundary),
    /outside its custody boundary/u,
  );
  assert.equal(dirname(path), twin);
});
