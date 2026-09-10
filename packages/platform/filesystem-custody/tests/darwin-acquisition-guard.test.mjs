import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("actual Darwin binding installs only in fresh disposable children and denies raw device opens", {
  skip: process.platform !== "darwin", timeout: 90000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "ar-host-guard-"));
  try {
    writeFileSync(join(root, "regular"), "owned");
    symlinkSync("regular", join(root, "link"));
    execFileSync("mkfifo", [join(root, "fifo")], { timeout: 5000 });
    for (const mode of ["control", "guarded"]) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL(
        "./darwin-acquisition-guard-worker.mjs", import.meta.url)), mode, root],
      { encoding: "utf8", timeout: 40000, maxBuffer: 1024 * 1024 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, JSON.stringify(result));
      assert.match(result.stdout, /"rawOpenControls":"pass"/);
      console.log(result.stdout);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Linux exposes no Darwin guard authority and initializer leaves shared acquisition unchanged", {
  skip: process.platform !== "linux",
}, async () => {
  const api = await import("../dist/index.js");
  assert.equal(api.hasDarwinHostDescriptors(), false);
  assert.throws(() => api.initializeDarwinHostAcquisitionGuard(), /unavailable/);
  const loaded = { exports: {} };
  process.dlopen(loaded, fileURLToPath(new URL("../dist/rename-no-replace.node", import.meta.url)));
  assert.equal(loaded.exports.initializeDarwinHostAcquisitionGuard, undefined);
  assert.equal(loaded.exports.isDarwinHostAcquisitionGuardInstalled, undefined);
  const root = loaded.exports.hostRoot();
  loaded.exports.hostClose(root);
});
