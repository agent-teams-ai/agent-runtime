import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureFileSnapshot,
  diffFileSnapshots,
} from "../src/features/filesystem-observation/file-snapshot.ts";

test("detects sandbox filesystem mutations", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-profile-spike-"));
  context.after(async () => {
    await rm(root, { force: true, recursive: true });
  });

  await mkdir(join(root, "state"));
  await writeFile(join(root, "state", "existing.json"), "{}\n");
  await writeFile(join(root, "removed.txt"), "remove me\n");
  const before = await captureFileSnapshot(root);

  await writeFile(join(root, "state", "existing.json"), '{"changed":true}\n');
  await writeFile(join(root, "created.txt"), "new\n");
  await rm(join(root, "removed.txt"));
  const after = await captureFileSnapshot(root);
  const diff = diffFileSnapshots(before, after);

  assert.deepEqual(
    diff.added.map((entry) => entry.path),
    ["created.txt"],
  );
  assert.deepEqual(
    diff.removed.map((entry) => entry.path),
    ["removed.txt"],
  );
  assert.deepEqual(
    diff.changed.map((entry) => entry.after.path),
    ["state/existing.json"],
  );
});
