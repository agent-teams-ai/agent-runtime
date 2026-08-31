import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const EXPECTED_BINARY_SHA256 = "abf1bb1643a79f73aa78ee627e111e02d4f8c98f25813a0cf6ce277709664386";
const EXPECTED_SOURCE_SHA256 = "0f1d661f014aac04c3fc9c04b8ebe818494a6d22fc16fe564390d0969a900370";

if (process.env.AR_CODEX_SCHEMA_REGEN_VERIFY !== "1") {
  process.stdout.write(`${JSON.stringify({ status: "skipped-not-external-proof" })}\n`);
  process.exit(0);
}

const requiredEnvironment = name => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {throw new Error(`missing ${name}`);}
  return value;
};
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

const disposableParent = await realpath(requiredEnvironment("AR_CODEX_SCHEMA_REGEN_ROOT"));
assert.equal((await lstat(join(disposableParent, ".agent-runtime-test-sandbox"))).isFile(), true,
  "schema regeneration root is not marked disposable");
const binary = await realpath(requiredEnvironment("AR_CODEX_SCHEMA_REGEN_BINARY"));
const binaryHandle = await open(binary, "r");
const binaryObservation = await binaryHandle.stat();
assert.equal(binaryObservation.isFile(), true, "pinned Codex binary is not a regular file");
const verifiedBinaryBytes = await binaryHandle.readFile();
const executedBinarySha256 = digest(verifiedBinaryBytes);
assert.equal(executedBinarySha256, EXPECTED_BINARY_SHA256, "pinned Codex binary digest mismatch");

const root = await mkdtemp(join(disposableParent, "codex-schema-regeneration-"));
try {
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const generated = join(root, "schema");
  const temporary = join(root, "tmp");
  await Promise.all([
    mkdir(home, { mode: 0o700 }),
    mkdir(codexHome, { mode: 0o700 }),
    mkdir(temporary, { mode: 0o700 }),
  ]);
  // Descriptor 3 is the same retained open-file description whose bytes were
  // hashed above. Executing /proc/self/fd/3 prevents a pathname replacement
  // between verification and exec from changing the generator bytes.
  const result = spawnSync("/proc/self/fd/3", ["app-server", "generate-json-schema", "--out", generated], {
    cwd: root,
    encoding: "utf8",
    env: { CODEX_HOME: codexHome, HOME: home, LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: temporary },
    maxBuffer: 1_048_576,
    stdio: ["ignore", "pipe", "pipe", binaryHandle.fd],
    timeout: 120_000,
  });
  assert.equal(result.error, undefined, "pinned Codex schema generator failed to launch");
  assert.equal(result.signal, null, "pinned Codex schema generator was terminated");
  assert.equal(result.status, 0, "pinned Codex schema generator failed");
  const [committed, regenerated] = await Promise.all([
    readFile(new URL("./ItemCompletedNotification.json", import.meta.url)),
    readFile(join(generated, "v2", "ItemCompletedNotification.json")),
  ]);
  assert.equal(committed.length, 41_664);
  assert.equal(digest(committed), EXPECTED_SOURCE_SHA256);
  assert.deepEqual(regenerated, committed, "regenerated ItemCompletedNotification schema bytes drifted");
  process.stdout.write(`${JSON.stringify({
    artifactBytes: committed.length,
    executedBinarySha256,
    executionSource: "retained-verified-descriptor",
    status: "external-proof-passed",
  })}\n`);
} finally {
  await binaryHandle.close();
  await rm(root, { force: true, recursive: true });
}
