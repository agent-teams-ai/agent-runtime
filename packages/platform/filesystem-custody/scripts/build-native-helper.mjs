import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

if (process.platform === "linux") {
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
    "-O2", "-Wall", "-Wextra", "-Werror", "-fPIC", "-shared",
    `-I${includeDirectory}`,
    "native/rename-no-replace.c",
    "-o", "dist/rename-no-replace.node",
  ], { stdio: "inherit" });
  if (result.error !== undefined) {throw result.error;}
  if (result.status !== 0) {process.exit(result.status ?? 1);}
}
