import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Compile the exact owner settlement functions with the real portable tree
// implementation. The minimal custody record replaces Darwin-only bootstrap;
// this exercises actual descriptor ownership, not Mac privilege admission.
test("cutoff settles native writers once and preserves close uncertainty", () => {
  const temporary = mkdtempSync(join(process.cwd(), "node_modules/.cache/native-producers/settlement-"));
  try {
    const native = fileURLToPath(new URL("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/native/", import.meta.url));
    const custody = readFileSync(join(native, "darwin-attempt-owner-custody.c"), "utf8");
    const functions = custody.slice(custody.indexOf("static int unknown("), custody.indexOf("static int sync_fd("));
    assert.ok(functions.includes("int ae_native_abort_transactions("));
    const source = join(temporary, "settlement.c"), executable = join(temporary, "settlement");
    writeFileSync(source, `
#include "darwin-attempt-owner-tree.c"
#include <assert.h>
#define AE_QUARANTINED 99
typedef struct {
  int unknown, material_root, material_consumed, materialization_consumed;
  struct { int phase, cutoff; } state;
  ae_tree_transaction *materialization, *material_transaction;
} ae_custody;
${functions}
int main(int argc,char **argv) {
  assert(argc==2);
  int root=open(argv[1],O_RDONLY|O_DIRECTORY); assert(root>=0);
  ae_tree_limits limits={32,4096,8388608,33554432};
  ae_custody c={0}; c.material_root=dup(root);
  c.materialization=ae_tree_begin(root,&limits);
  c.material_transaction=ae_tree_begin(root,&limits);
  assert(c.materialization && c.material_transaction);
  assert(ae_tree_entry(c.material_transaction,0,UINT32_MAX,"config.toml",0,0600,4));
  int writer=c.material_transaction->nodes[0].fd;
  assert(write(writer,"x",1)==1);
  c.material_consumed=1; c.materialization_consumed=1;
  assert(!native_transactions_settled(&c));
  assert(!ae_native_abort_transactions(&c));
  assert(fcntl(writer,F_GETFD)>=0);
  c.state.cutoff=1;
  assert(ae_native_abort_transactions(&c));
  assert(native_transactions_settled(&c));
  assert(c.material_consumed && c.materialization_consumed);
  assert(fcntl(writer,F_GETFD)<0 && errno==EBADF);
  int replacement=dup(root); assert(replacement>=0);
  assert(ae_native_abort_transactions(&c));
  assert(fcntl(replacement,F_GETFD)>=0);
  assert(close(replacement)==0);
  c.material_root=dup(root); assert(c.material_root>=0);
  assert(close(c.material_root)==0);
  assert(!ae_native_abort_transactions(&c));
  assert(c.unknown && c.state.phase==AE_QUARANTINED);
  assert(c.material_root==-1 && !native_transactions_settled(&c));
  assert(!ae_native_abort_transactions(&c));
  assert(close(root)==0);
  return 0;
}
`);
    const argv = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", "-I", native, source, "-o", executable];
    const compiled = spawnSync("cc", argv, { encoding: "utf8" });
    console.log(JSON.stringify({ argv: ["cc", ...argv], exit: compiled.status, stderr: compiled.stderr }));
    assert.equal(compiled.status, 0, compiled.stderr);
    const root = join(temporary, "root"); mkdirSync(root);
    const run = spawnSync(executable, [root], { encoding: "utf8" });
    console.log(JSON.stringify({ argv: [executable, root], exit: run.status, stderr: run.stderr }));
    assert.equal(run.status, 0, run.stderr);
  } finally {rmSync(temporary, { recursive: true, force: true });}
});
