import {strict as assert} from "node:assert";
import {mkdtemp, mkdir, readdir, rm, stat, symlink} from "node:fs/promises";
import {join} from "node:path";
import {test} from "node:test";
import {allocateLinuxCodexLiveAdminDirectories} from "./linux-codex-live-admin-directories.ts";

// Only disposable filesystem administration is exercised. No bootstrap, Pool,
// credentials, provider, Engine, network or fabricated runtime receipt.
test("allocates independent empty trees and retains them when cleanup is uncertain", {skip: process.platform !== "linux"}, async () => {
  const parent = await mkdtemp(join(process.cwd(), ".linux-codex-admin-directories-test-"));
  try {
    const first = await allocateLinuxCodexLiveAdminDirectories(parent);
    const second = await allocateLinuxCodexLiveAdminDirectories(parent);
    assert.notEqual(first.root, second.root);
    assert.deepEqual(await readdir(first.workspace.canonicalProjectRoot), []);
    assert.equal((await stat(first.workspace.root)).mode & 0o777, 0o700);
    let calls = 0;
    const result = await first.releaseAfterBootstrap(async () => {
      calls += 1;
      throw new Error("cleanup outcome unknown");
    });
    assert.equal(result, "pending");
    assert.equal(calls, 1);
    assert.equal((await stat(first.root)).isDirectory(), true);
    assert.equal((await stat(second.root)).isDirectory(), true);
  } finally {
    // The test never handed any directory to a runtime owner.
    await rm(parent, {recursive: true});
  }
});

test("refuses non-private and symlinked parents before allocation", {skip: process.platform !== "linux"}, async () => {
  const parent = await mkdtemp(join(process.cwd(), ".linux-codex-admin-directories-test-"));
  try {
    const shared = join(parent, "shared");
    await mkdir(shared, {mode: 0o755});
    await assert.rejects(allocateLinuxCodexLiveAdminDirectories(shared), TypeError);
    assert.deepEqual(await readdir(shared), []);
    const alias = join(parent, "alias");
    await symlink(shared, alias);
    await assert.rejects(allocateLinuxCodexLiveAdminDirectories(alias), TypeError);
    await assert.rejects(allocateLinuxCodexLiveAdminDirectories("relative-parent"), TypeError);
  } finally {await rm(parent, {recursive: true});}
});
