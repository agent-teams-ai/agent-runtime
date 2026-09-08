import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {access, realpath, stat} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {join} from "node:path";

// Explicit developer integration only. No providers, installs, sudo or shared
// firewall changes. The child creates all network resources in a fresh netns.
assert.equal(process.platform, "linux", "joined integration requires Linux");
assert.equal(process.arch, "x64", "joined integration requires x64");
assert.equal(process.geteuid(), 0, "run only on an authorized disposable Linux test host");
assert.equal(Number(process.versions.node.split(".")[0]), 24, "build and run with Node 24");
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const executable = async name => {
  for (const base of ["/usr/bin", "/usr/sbin", "/bin", "/sbin"]) {
    let path;
    try {path = await realpath(join(base, name));} catch (error) {if (error.code === "ENOENT") {continue;} throw error;}
    const facts = await stat(path);
    assert.ok(facts.isFile() && facts.uid === 0 && !(facts.mode & 0o022), `untrusted installed tool: ${name}`);
    return path;
  }
  throw new Error(`Required installed test tool unavailable: ${name}`);
};
const [unshare] = await Promise.all(["unshare", "nsenter", "ip", "nft"].map(executable));
for (const path of ["packages/apps/embedded-runtime/dist/composition.js",
  "packages/contexts/agent-execution/dist/composition.js", "packages/contexts/provider-access/dist/composition.js",
  "packages/contexts/runtime-security/dist/composition.js", "docs/architecture/qualification-registry.json",
  "packages/contexts/agent-execution/tests/fixtures/codex-native-broker-0.153.4/models.json"]) {
  await access(join(root, path));
}
const binding = {exports: {}};
process.dlopen(binding, join(root, "packages/platform/filesystem-custody/dist/rename-no-replace.node"));
assert.equal(typeof binding.exports.publishNoReplace, "function", "build filesystem-custody native helper first");
const entry = join(root, "packages/apps/embedded-runtime/tests/support/linux-joined-product.mjs");
const child = spawn(unshare, ["--net", "--", process.execPath, "--test", "--test-concurrency=1", entry],
  {cwd: root, stdio: "inherit", detached: true});
const terminate = signal => {
  if (child.pid === undefined) {return;}
  try {process.kill(-child.pid, signal);} catch (error) {if (error.code !== "ESRCH") {throw error;}}
};
let expired = false;
const timer = setTimeout(() => {expired = true; terminate("SIGKILL");}, 120000);
const interrupt = () => terminate("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => resolve(signal === null ? status : 1));
  });
  process.exitCode = expired ? 124 : code ?? 1;
} finally {
  clearTimeout(timer);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
