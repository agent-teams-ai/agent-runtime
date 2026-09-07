import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

// Qualified mode is a closed positional protocol from private build composition.
// It never discovers tools/headers or inherits caller compiler/loader variables.
const qualified = process.argv.slice(2);
if (qualified.length) {
  const [mode, recipe, compiler, linker, resources, headers, sysroot, ...tail] = qualified;
  const gcc = recipe === "linux-x64-gcc-shared/v1";
  const [assembler, deployment] = gcc ? tail : [undefined, tail[0]];
  const linux = gcc || recipe === "linux-x64-clang-shared/v1";
  if (qualified.length !== (gcc ? 9 : 8) || mode !== "--qualified" ||
      !["linux-x64-clang-shared/v1", "linux-x64-gcc-shared/v1", "darwin-arm64-clang-bundle/v1"].includes(recipe) ||
      process.platform !== (linux ? "linux" : "darwin") || process.arch !== (linux ? "x64" : "arm64") ||
      [compiler, linker, resources, headers, sysroot, ...(gcc ? [assembler] : [])].some(path =>
        typeof path !== "string" || path.length > 512 || !isAbsolute(path) || normalize(path) !== path ||
        path === "/" || /[\0\r\n]/u.test(path)) ||
      (linux ? deployment !== "none" : !/^[0-9]{1,2}\.[0-9]{1,2}$/u.test(deployment)) ||
      !/^(?:0|[1-9][0-9]{0,10})$/u.test(process.env.SOURCE_DATE_EPOCH ?? "")) {
    throw new Error("complete qualified native recipe inputs required");
  }
  mkdirSync("dist", {recursive: true});
  // GCC's -B prefix selects as/ld.bfd, then approved cc1/collect2 and
  // runtime objects from resources. No PATH search or Clang-only flags.
  const tools = gcc ? realpathSync(mkdtempSync(resolve("dist/.gcc-tools-"))) : undefined;
  try {
    if (gcc) {
      symlinkSync(assembler, resolve(tools, "as"));
      symlinkSync(linker, resolve(tools, "ld"));
      symlinkSync(linker, resolve(tools, "ld.bfd"));
    }
  const result = spawnSync(compiler, [
    "-O2", "-Wall", "-Wextra", "-Werror", "-fPIC", "-nostdinc",
    ...(gcc ? [`-B${tools}/`, `-B${resources}/`, "-fuse-ld=bfd", "-fno-use-linker-plugin", "-m64"] :
      [`--ld-path=${linker}`, "-resource-dir", resources]),
    `--sysroot=${sysroot}`,
    "-isystem", resolve(resources, "include"), "-isystem", resolve(sysroot, "usr/include"),
    ...(gcc ? ["-isystem", resolve(sysroot, "usr/include/x86_64-linux-gnu")] : []),
    `-I${headers}`,
    ...(linux ? [...(gcc ? [] : ["--target=x86_64-unknown-linux-gnu"]), "-shared"] :
      ["--target=arm64-apple-darwin", "-arch", "arm64", `-mmacosx-version-min=${deployment}`,
        "-bundle", "-undefined", "dynamic_lookup"]),
    "native/rename-no-replace.c", "-o", "dist/rename-no-replace.node",
  ], {stdio: "inherit", env: {LC_ALL: "C", TZ: "UTC", SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH}});
  if (result.error !== undefined) {throw result.error;}
  if (result.status !== 0) {throw new Error(`qualified native compiler exited ${result.status}`);}
  } finally {if (tools) {rmSync(tools, {recursive: true, force: true});}}
} else if (process.platform === "linux" || process.platform === "darwin") {
  const includeDirectory = [
    resolve(dirname(process.execPath), "../include/node"),
    "/usr/local/include/node",
    "/usr/include/node",
  ].find(candidate => existsSync(resolve(candidate, "node_api.h")));
  if (includeDirectory === undefined) {
    throw new Error("Node-API headers are required to build stable filesystem publication");
  }
  mkdirSync("dist", { recursive: true });
  const result = spawnSync("cc", [
    "-O2", "-Wall", "-Wextra", "-Werror", "-fPIC",
    ...(process.platform === "darwin" ? ["-bundle", "-undefined", "dynamic_lookup"] : ["-shared"]),
    `-I${includeDirectory}`,
    "native/rename-no-replace.c",
    "-o", "dist/rename-no-replace.node",
  ], { stdio: "inherit" });
  if (result.error !== undefined) {throw result.error;}
  if (result.status !== 0) {process.exit(result.status ?? 1);}
}
