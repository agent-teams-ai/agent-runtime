import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { captureDarwinWorkspaceTree } from "../../../src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-protocol.ts";

const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const limits = { maxDepth: 32, maxEntries: 4096, maxFileBytes: 8388608, maxTotalBytes: 33554432 };
const fixture = () => {
  const bytes = Buffer.from("hello");
  const file = { relativePath: "src/main.txt", mode: 0o640, size: bytes.length, digest: hash(bytes), bytes };
  const entries = [{ kind: "directory" as const, relativePath: "empty", mode: 0o700 },
    { kind: "directory" as const, relativePath: "src", mode: 0o750 }, { kind: "file" as const, ...file }];
  return { entries, files: [file], rootIdentity: { dev: 1n, ino: 2n, mode: 0o700n, ctimeNs: 0n, mtimeNs: 0n },
    treeDigest: hash(JSON.stringify(entries.map(entry => entry.kind === "directory"
      ? [entry.kind, entry.relativePath, entry.mode] : [entry.kind, entry.relativePath, entry.mode, entry.size, entry.digest]))) };
};
test("complete native snapshot preserves empty directories, mode and canonical digest while isolating bytes", () => {
  const source = fixture();
  const captured = captureDarwinWorkspaceTree(source, limits);
  assert.equal(captured.treeDigest, source.treeDigest);
  assert.equal(captured.entries.length, 3);
  source.files[0]!.bytes.fill(0);
  assert.equal(captured.files[0]!.bytes.toString(), "hello");
});
test("native snapshot rejects incomplete inventory, changed content, noncanonical order and lower budgets", () => {
  const source = fixture();
  assert.throws(() => captureDarwinWorkspaceTree({ ...source, files: [] }, limits));
  assert.throws(() => captureDarwinWorkspaceTree({ ...source, entries: source.entries.toReversed() }, limits));
  assert.throws(() => captureDarwinWorkspaceTree(source, { ...limits, maxEntries: 2 }));
  assert.throws(() => captureDarwinWorkspaceTree(source, { ...limits, maxFileBytes: 4 }));
  assert.throws(() => captureDarwinWorkspaceTree(source, { ...limits, maxDepth: 0 }));
  assert.throws(() => captureDarwinWorkspaceTree(source, { ...limits, maxEntries: 4097 }));
  source.files[0]!.bytes.fill(0);
  assert.throws(() => captureDarwinWorkspaceTree(source, limits));
});
test("native materializer creates full tree in original inode and burns partial transactions", () => {
  const temporary = mkdtempSync(join(tmpdir(), "darwin-tree-"));
  try {
    const native = fileURLToPath(new URL("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/native/", import.meta.url));
    const executable = join(temporary, "tree-test");
    const argv = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", "-I", native,
      join(native, "darwin-attempt-owner-tree.c"), fileURLToPath(new URL("./darwin-attempt-owner-tree-harness.c", import.meta.url)), "-o", executable];
    const compiled = spawnSync("cc", argv, { encoding: "utf8" });
    console.log(JSON.stringify({ argv: ["cc", ...argv], stdout: compiled.stdout, stderr: compiled.stderr, exit: compiled.status }));
    assert.equal(compiled.status, 0, compiled.stderr);
    const root = join(temporary, "root"); mkdirSync(root);
    const run = spawnSync(executable, [root], { encoding: "utf8" });
    console.log(JSON.stringify({ argv: [executable, root], stdout: run.stdout, stderr: run.stderr, exit: run.status }));
    assert.equal(run.status, 0, run.stderr);
  } finally {rmSync(temporary, { recursive: true, force: true });}
});
