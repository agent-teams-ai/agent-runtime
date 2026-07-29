import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  link,
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  captureProfileSource,
  ProfileCaptureError,
  type ProfileCaptureErrorCode,
} from "../src/features/profile-capture/capture-profile-source.ts";

const withRoot = async (
  context: TestContext,
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "runtime-profile-capture-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
};

const rejectsWith = async (
  operation: Promise<unknown>,
  code: ProfileCaptureErrorCode,
): Promise<void> => {
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof ProfileCaptureError && error.code === code,
  );
};

test("captures sorted content identity without host paths", async (context) => {
  const root = await withRoot(context);
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "z.json"), "{}\n");
  await writeFile(join(root, "nested", "a.md"), "skill\n");

  const capture = await captureProfileSource(root);

  assert.deepEqual(
    capture.artifacts.map((artifact) => artifact.path),
    ["nested/a.md", "z.json"],
  );
  assert.doesNotMatch(JSON.stringify(capture), new RegExp(root));
});

test("rejects symlinks and hard links", async (context) => {
  const symlinkRoot = await withRoot(context);
  await writeFile(join(symlinkRoot, "target"), "value");
  await symlink("target", join(symlinkRoot, "link"));
  await rejectsWith(
    captureProfileSource(symlinkRoot),
    "SYMLINK_UNSUPPORTED",
  );

  const hardLinkRoot = await withRoot(context);
  await writeFile(join(hardLinkRoot, "first"), "value");
  await link(join(hardLinkRoot, "first"), join(hardLinkRoot, "second"));
  await rejectsWith(
    captureProfileSource(hardLinkRoot),
    "HARD_LINK_UNSUPPORTED",
  );
});

test("rejects source replacement after bytes were read", async (context) => {
  const root = await withRoot(context);
  const path = join(root, "config.json");
  await writeFile(path, '{"value":1}\n');

  await rejectsWith(
    captureProfileSource(root, undefined, {
      async afterFileRead(absolutePath) {
        await rename(absolutePath, `${absolutePath}.old`);
        await writeFile(absolutePath, '{"value":2}\n');
      },
    }),
    "SOURCE_CHANGED",
  );
});

test("enforces file, byte, and type limits", async (context) => {
  const byteRoot = await withRoot(context);
  await writeFile(join(byteRoot, "large"), "12345");
  await rejectsWith(
    captureProfileSource(byteRoot, {
      maxBytes: 4,
      maxDepth: 4,
      maxFiles: 4,
    }),
    "CAPTURE_LIMIT_EXCEEDED",
  );

  if (process.platform !== "win32") {
    const fifoRoot = await withRoot(context);
    execFileSync("mkfifo", [join(fifoRoot, "pipe")]);
    await rejectsWith(
      captureProfileSource(fifoRoot),
      "UNSUPPORTED_FILE_TYPE",
    );
  }
});
