import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";

// Explicit manual compile only. No installation, execution or package wiring.
if (process.platform !== "darwin") {
  throw new Error("Darwin SDK required; portable tests do not compile __APPLE__ sections");
}
const output = process.argv[2];
if (!output || !isAbsolute(output) || process.argv.length !== 3) {
  throw new Error("one absolute disposable output path required");
}
const sources = ["main", "state", "custody", "namespace", "admission", "child"].map((name) =>
  fileURLToPath(new URL(`darwin-attempt-owner-${name}.c`, import.meta.url)));
const result = spawnSync("cc", ["-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-Werror",
  "-Wno-deprecated-declarations", ...sources, "-o", output], { stdio: "inherit" });
if (result.error) {throw result.error;}
process.exitCode = result.status ?? 1;
