import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  type FileHandle,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  capturePathLineage,
  openStablePath,
  pathLineagesEqual,
} from "../dist/index.js";

const execFile = promisify(execFileCallback);

const makeFifo = async (path: string): Promise<void> => {
  await execFile("/usr/bin/mkfifo", [path]);
};

test("opens a POSIX/macOS regular file through stable descriptor custody", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-path-custody-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "inside", "config.toml");
  await mkdir(join(root, "inside"));
  await writeFile(path, "model = 'synthetic'\n");

  const result = await openStablePath(path, await realpath(path), async opened => ({
    bytes: await opened.handle.readFile(),
    identity: `${opened.stats.dev}:${opened.stats.ino}`,
  }));

  assert.equal(result.bytes.toString("utf8"), "model = 'synthetic'\n");
  assert.match(result.identity, /^\d+:\d+$/u);
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
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socket, resolve);
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EPERM"
        ) {
          socketTest.skip("Unix socket creation is unavailable in this sandbox");
          return;
        }
        throw error;
      }
      socketTest.after(() => new Promise<void>(resolve => {
        server.close(() => resolve());
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
