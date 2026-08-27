import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  capturePathLineage,
  openStablePath,
  pathLineagesEqual,
} from "../dist/index.js";

test("opens a synthetic file through stable descriptor custody", async t => {
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
