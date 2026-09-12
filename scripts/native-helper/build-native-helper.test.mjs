import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../packages/platform/filesystem-custody/scripts/build-native-helper.mjs", import.meta.url), "utf8");
// Evaluate only argument composition with disposable in-memory filesystem/process doubles.
const body = source.replace(/^import .*;\n/gmu, "");
const capture = (platform, args = []) => {
  const calls = [];
  runInNewContext(body, {
    process: {platform, arch: platform === "darwin" ? "arm64" : "x64",
      argv: ["node", "build", ...args], execPath: "/disposable/bin/node",
      env: {SOURCE_DATE_EPOCH: "1", CC: "unapproved", CPATH: "/unapproved"}},
    dirname, isAbsolute, normalize, resolve,
    existsSync: () => true, mkdirSync: () => {},
    mkdtempSync: () => "/disposable/tools", realpathSync: value => value,
    symlinkSync: () => {}, rmSync: () => {},
    spawnSync: (...call) => { calls.push(JSON.parse(JSON.stringify(call))); return {status: 0}; },
  });
  assert.equal(calls.length, 1);
  return calls[0];
};
const qualified = recipe => ["--qualified", recipe, "/approved/cc", "/approved/ld",
  "/approved/resources", "/approved/hash-bound-headers", "/approved/sysroot",
  ...(recipe.includes("gcc") ? ["/approved/as"] : []), recipe.startsWith("darwin") ? "14.0" : "none"];

for (const platform of ["linux", "darwin"]) {
  test(`ordinary ${platform} linker arguments`, () => {
    const [compiler, args, options] = capture(platform);
    assert.equal(compiler, "cc");
    assert.deepEqual(args, ["-O2", "-Wall", "-Wextra", "-Werror", "-fPIC",
      ...(platform === "darwin" ? ["-bundle", "-undefined", "dynamic_lookup", "-lsandbox"] : ["-shared"]),
      "-I/disposable/include/node", "native/rename-no-replace.c", "-o", "dist/rename-no-replace.node"]);
    assert.deepEqual(options, {stdio: "inherit"});
  });
}
for (const recipe of ["linux-x64-clang-shared/v1", "linux-x64-gcc-shared/v1", "darwin-arm64-clang-bundle/v1"]) {
  test(`qualified ${recipe} closed arguments and headers`, () => {
    const darwin = recipe.startsWith("darwin");
    const gcc = recipe.includes("gcc");
    const platform = darwin ? "darwin" : "linux";
    const inputs = qualified(recipe);
    const [compiler, args, options] = capture(platform, inputs);
    assert.equal(compiler, "/approved/cc");
    assert.deepEqual(args, ["-O2", "-Wall", "-Wextra", "-Werror", "-fPIC", "-nostdinc",
      ...(gcc ? ["-B/disposable/tools/", "-B/approved/resources/", "-fuse-ld=bfd", "-fno-use-linker-plugin", "-m64"] :
        ["--ld-path=/approved/ld", "-resource-dir", "/approved/resources"]),
      "--sysroot=/approved/sysroot", "-isystem", "/approved/resources/include", "-isystem", "/approved/sysroot/usr/include",
      ...(gcc ? ["-isystem", "/approved/sysroot/usr/include/x86_64-linux-gnu"] : []),
      "-I/approved/hash-bound-headers",
      ...(darwin ? ["--target=arm64-apple-darwin", "-arch", "arm64", "-mmacosx-version-min=14.0",
        "-bundle", "-undefined", "dynamic_lookup", "-lsandbox"] : [...(gcc ? [] : ["--target=x86_64-unknown-linux-gnu"]), "-shared"]),
      "native/rename-no-replace.c", "-o", "dist/rename-no-replace.node"]);
    assert.deepEqual(options, {stdio: "inherit", env: {LC_ALL: "C", TZ: "UTC", SOURCE_DATE_EPOCH: "1"}});
    assert.throws(() => capture(platform, [...inputs, "--headers", "/unapproved"]), /complete qualified native recipe inputs required/u);
    assert.throws(() => capture(platform, inputs.slice(0, -1)), /complete qualified native recipe inputs required/u);
  });
}

test("durable file restores the existing custody module import", () => {
  const durable = readFileSync(new URL("../packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-durable-file.ts", import.meta.url), "utf8");
  assert.match(durable, /isNativeHostDescriptor, openNativeHostEntry, quarantineNativeHostEntry,/u);
  assert.match(durable, /openNativeHostEntry\(input\.stagingDirectory, temporaryName, "create"\)/u);
});
