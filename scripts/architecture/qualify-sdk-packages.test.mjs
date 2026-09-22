import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { assertPackedSdkArchive, assertPublicImports } from "./qualify-sdk-packages.mjs";

const contract = JSON.parse(readFileSync(new URL("../../architecture/c0/ar-owned-lifetime/contract.json", import.meta.url), "utf8"));
// These fixtures test membership, not type extraction. Real built package
// qualification uses the separate disposable pack command and retains archives.
function fixture(t, pkg, mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "ar-sdk-archive-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const expected = { name: pkg.name, exports: pkg.exports };
  const files = new Map([["package/package.json", JSON.stringify(expected)]]);
  for (const target of Object.values(pkg.exports).flatMap(branch => typeof branch === "string" ? [branch] : Object.values(branch))) {
    files.set(`package/${target.slice(2)}`, "export {};\n");
  }
  mutate(files);
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), bytes);
  }
  const archive = join(directory, "candidate.tgz");
  const result = spawnSync("tar", ["czf", archive, "package"], { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return { directory, archive, expected };
}

for (const pkg of contract.inventory.packages.filter(entry => entry.exports !== null)) {
  test(`accept exact C0 packed export membership: ${pkg.name}`, t => {
    const { directory, archive, expected } = fixture(t, pkg);
    assertPackedSdkArchive(archive, expected, directory);
  });
  test(`reject missing packed declaration: ${pkg.name}`, t => {
    const { directory, archive, expected } = fixture(t, pkg, files => files.delete("package/dist/composition.d.ts"));
    assert.throws(() => assertPackedSdkArchive(archive, expected, directory), /SDK_PACKED_TARGET_MISSING/u);
  });
}
test("reject historical Embedded Runtime missing exported runner", t => {
  const pkg = contract.inventory.packages.find(entry => entry.name === "@agent-teams/embedded-runtime");
  const { directory, archive, expected } = fixture(t, pkg, files => files.delete("package/scripts/run-package-tests.mjs"));
  assert.throws(() => assertPackedSdkArchive(archive, expected, directory), /SDK_PACKED_TARGET_MISSING/u);
});
test("reject packed export map substitution", t => {
  const pkg = contract.inventory.packages[1];
  const { directory, archive, expected } = fixture(t, pkg, files => {
    files.set("package/package.json", JSON.stringify({ name: pkg.name, exports: { ".": "./dist/index.js" } }));
  });
  assert.throws(() => assertPackedSdkArchive(archive, expected, directory), /SDK_PACKED_EXPORT_MISMATCH/u);
});
test("reject source-only file leaking into archive", t => {
  const { directory, archive, expected } = fixture(t, contract.inventory.packages[1], files => files.set("package/src/private.ts", "export const privateValue = 1;\n"));
  assert.throws(() => assertPackedSdkArchive(archive, expected, directory), /SDK_SOURCE_ONLY_ENTRY_LEAK/u);
});
test("reject packed condition reorder with identical keys and values", t => {
  const pkg = contract.inventory.packages[1];
  const { directory, archive, expected } = fixture(t, pkg, files => {
    const exports = structuredClone(pkg.exports);
    exports["."] = Object.fromEntries(Object.entries(exports["."]).toReversed());
    files.set("package/package.json", JSON.stringify({ name: pkg.name, exports }));
  });
  assert.throws(() => assertPackedSdkArchive(archive, expected, directory), /SDK_PACKED_EXPORT_MISMATCH/u);
});
test("public import qualification executes the packed entrypoint", t => {
  const directory = mkdtempSync(join(tmpdir(), "ar-sdk-import-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packageRoot = join(directory, "node_modules", "test-package");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "test-package", type: "module", exports: "./index.js" }));
  writeFileSync(join(packageRoot, "index.js"), "export const qualified = true;\n");
  assert.deepEqual(assertPublicImports(directory, ["test-package"]), ["test-package"]);
  assert.throws(() => assertPublicImports(directory, ["test-package/missing"]), /ERR_PACKAGE_PATH_NOT_EXPORTED/u);
});
