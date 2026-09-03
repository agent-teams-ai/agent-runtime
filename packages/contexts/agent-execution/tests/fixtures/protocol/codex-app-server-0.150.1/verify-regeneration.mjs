import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const EXPECTED_BINARY_SHA256 = "abf1bb1643a79f73aa78ee627e111e02d4f8c98f25813a0cf6ce277709664386";
const EXPECTED_SOURCE_SHA256 = "0f1d661f014aac04c3fc9c04b8ebe818494a6d22fc16fe564390d0969a900370";
const EXPECTED_TREES = Object.freeze({
  schema: Object.freeze({
    fileCount: 411,
    manifestSha256: "771c11d73b369e67eb4f59fb2fa3caac3e789a3c51f3ad326dc19f1ef1504b97",
  }),
  types: Object.freeze({
    fileCount: 812,
    manifestSha256: "9f2ae4a23ad7b60b65f2b4a26cddf1b72ca6d3cff3081171c8badd5630ebefe1",
  }),
});

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

const regularFiles = async (root, directory = root) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {files.push(...await regularFiles(root, path)); continue;}
    assert.equal(entry.isFile(), true, `generated tree contains a non-regular entry: ${path}`);
    const relativePath = path.slice(root.length + 1);
    assert.doesNotMatch(relativePath, /[\\\n]/u, "generated path cannot be represented by the documented manifest algorithm");
    files.push({ path, relativePath });
  }
  return files;
};

const observeTree = async root => {
  const files = (await regularFiles(root)).toSorted((left, right) =>
    Buffer.from(left.relativePath).compare(Buffer.from(right.relativePath)));
  const manifest = createHash("sha256");
  for (const file of files) {
    manifest.update(`${digest(await readFile(file.path))}  ${file.relativePath}\n`);
  }
  return Object.freeze({ fileCount: files.length, manifestSha256: manifest.digest("hex") });
};

const assertTree = async (name, root, expected) => {
  const observation = await observeTree(root);
  assert.equal(observation.fileCount, expected.fileCount,
    `${name} tree has missing or extra regular files`);
  assert.equal(observation.manifestSha256, expected.manifestSha256,
    `${name} tree has missing, extra, or drifted files`);
  return observation;
};

const runGenerator = (binaryHandle, root, environment, generator, output) => {
  const result = spawnSync("/proc/self/fd/3",
    ["app-server", generator, "--out", output, "--experimental"], {
      cwd: root,
      encoding: "utf8",
      env: environment,
      maxBuffer: 1_048_576,
      stdio: ["ignore", "pipe", "pipe", binaryHandle.fd],
      timeout: 120_000,
    });
  assert.equal(result.error, undefined, `pinned Codex ${generator} failed to launch`);
  assert.equal(result.signal, null, `pinned Codex ${generator} was terminated`);
  assert.equal(result.status, 0, `pinned Codex ${generator} failed: ${result.stderr}`);
};

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
  const generatedSchema = join(root, "schema-experimental");
  const generatedTypes = join(root, "generated-experimental");
  const temporary = join(root, "tmp");
  await Promise.all([
    mkdir(home, { mode: 0o700 }),
    mkdir(codexHome, { mode: 0o700 }),
    mkdir(temporary, { mode: 0o700 }),
  ]);
  // Descriptor 3 is the same retained open-file description whose bytes were
  // hashed above. Executing /proc/self/fd/3 prevents a pathname replacement
  // between verification and exec from changing the generator bytes.
  const environment = { CODEX_HOME: codexHome, HOME: home, LANG: "C.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: temporary };
  runGenerator(binaryHandle, root, environment, "generate-json-schema", generatedSchema);
  runGenerator(binaryHandle, root, environment, "generate-ts", generatedTypes);
  const [schemaTree, typesTree] = await Promise.all([
    assertTree("schema", generatedSchema, EXPECTED_TREES.schema),
    assertTree("types", generatedTypes, EXPECTED_TREES.types),
  ]);
  const [committed, regenerated] = await Promise.all([
    readFile(new URL("./ItemCompletedNotification.json", import.meta.url)),
    readFile(join(generatedSchema, "v2", "ItemCompletedNotification.json")),
  ]);
  assert.equal(committed.length, 41_664);
  assert.equal(digest(committed), EXPECTED_SOURCE_SHA256);
  assert.deepEqual(regenerated, committed, "regenerated ItemCompletedNotification schema bytes drifted");
  process.stdout.write(`${JSON.stringify({
    artifactBytes: committed.length,
    executedBinarySha256,
    executionSource: "retained-verified-descriptor",
    schemaTree,
    status: "external-proof-passed",
    typesTree,
  })}\n`);
} finally {
  await binaryHandle.close();
  await rm(root, { force: true, recursive: true });
}
