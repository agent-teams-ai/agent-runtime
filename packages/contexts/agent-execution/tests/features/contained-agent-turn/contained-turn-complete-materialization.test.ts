import assert from "node:assert/strict";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";

import { assertCompleteWorkspaceMaterialization } from
  "../../../dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-workspace-creation.js";
import { scanContainedTurnWorkspace } from
  "../../../dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-workspace-tree.js";
import {
  cleanupTrackedFilesystemLayouts, createSyntheticFilesystemLayout,
} from "../../filesystem-contained-turn/fixture.ts";

const seed = async (root: string): Promise<void> => {
  await mkdir(join(root, "empty"), { mode: 0o750 });
  await mkdir(join(root, "nested"), { mode: 0o700 });
  await writeFile(join(root, "nested", "run.sh"), "echo bounded\n", { mode: 0o750 });
  await writeFile(join(root, "notes.txt"), "complete source\n", { mode: 0o640 });
  await writeFile(join(root, "zero.txt"), "", { mode: 0o600 });
};

after(cleanupTrackedFilesystemLayouts);

test("complete materialization compares observed full trees across different original inodes", {
  skip: process.platform !== "linux",
}, async () => {
  const layout = await createSyntheticFilesystemLayout();
  await seed(layout.canonicalProjectRoot);
  await seed(layout.workspaceRoot);
  const source = await scanContainedTurnWorkspace(layout.canonicalProjectRoot);
  const destination = await scanContainedTurnWorkspace(layout.workspaceRoot);
  assert.notEqual(source.rootIdentity.ino, destination.rootIdentity.ino);
  assert.equal(destination.entries.length, 5);
  assert.equal(destination.files.length, 3);
  assertCompleteWorkspaceMaterialization(source, destination);
  assert.throws(() => assertCompleteWorkspaceMaterialization(source, source), /canonical source inode/u);
  const file = destination.files[0];
  assert.ok(file);
  file.bytes[0] = file.bytes[0]! ^ 1;
  assert.throws(() => assertCompleteWorkspaceMaterialization(source, destination), /file observation mismatch/u);
});

for (const [name, change] of [
  ["missing empty directory", (root: string) => rm(join(root, "empty"), { recursive: true })],
  ["changed directory mode", (root: string) => chmod(join(root, "empty"), 0o700)],
  ["changed executable mode", (root: string) => chmod(join(root, "nested", "run.sh"), 0o640)],
  ["changed same-length bytes", (root: string) => writeFile(join(root, "notes.txt"), "different text!\n")],
  ["extra file", (root: string) => writeFile(join(root, "extra.txt"), "extra")],
] as const) {
  test(`complete materialization rejects ${name}`, { skip: process.platform !== "linux" }, async () => {
    const layout = await createSyntheticFilesystemLayout();
    await seed(layout.canonicalProjectRoot);
    await seed(layout.workspaceRoot);
    await change(layout.workspaceRoot);
    const source = await scanContainedTurnWorkspace(layout.canonicalProjectRoot);
    const destination = await scanContainedTurnWorkspace(layout.workspaceRoot);
    assert.throws(() => assertCompleteWorkspaceMaterialization(source, destination), /inventory mismatch/u);
  });
}
