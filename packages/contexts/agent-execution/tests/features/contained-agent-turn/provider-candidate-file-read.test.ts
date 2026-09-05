import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { candidateFileBytes, readCandidateFile } from "../../live/provider-candidate-file-read.mjs";
import { digestTree } from "../../live/provider-candidate-build-tree.mjs";

const temporary = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ar-candidate-read-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
};

test("candidate reads accept the exact byte limit and refuse one-byte overflow and path aliases", async t => {
  const root = await temporary(t);
  const file = join(root, "file");
  await writeFile(file, "abc");
  assert.equal((await candidateFileBytes(file, 3)).toString(), "abc");
  await assert.rejects(candidateFileBytes(file, 2), /byte limit/u);
  const leaf = join(root, "leaf");
  await symlink(file, leaf);
  await assert.rejects(candidateFileBytes(leaf, 3), /unaliased regular path/u);
  const directory = join(root, "parent");
  await symlink(root, directory);
  await assert.rejects(candidateFileBytes(join(directory, "file"), 3), /unaliased regular path/u);
  await link(file, join(root, "hardlink"));
  await assert.rejects(candidateFileBytes(file, 3), /unaliased regular path/u);
});

test("a file changing after its first bounded chunk invalidates the read", async t => {
  const root = await temporary(t);
  const file = join(root, "file");
  await writeFile(file, Buffer.alloc(70_000, 65));
  let calls = 0;
  await assert.rejects(readCandidateFile(file, 70_000, () => {
    if (calls++ === 0) {writeFileSync(file, Buffer.alloc(70_001, 66));}
  }), /grew during read|changed during read/u);
  assert.ok(calls > 0);
});

test("tree hashing bounds empty-directory depth and follows dependency cycles only once", async t => {
  const root = await temporary(t);
  await writeFile(join(root, "file"), "content");
  await symlink(root, join(root, "cycle"));
  const first = await digestTree(root, root);
  assert.deepEqual(await digestTree(root, root), first);
  assert.equal(first.files, 2);
  await assert.rejects(digestTree(root), /unauthorized symbolic link/u);
  await mkdir(join(root, ...Array.from({length: 34}, () => "deep")), {recursive: true});
  await assert.rejects(digestTree(root, root), /depth limit/u);
});
