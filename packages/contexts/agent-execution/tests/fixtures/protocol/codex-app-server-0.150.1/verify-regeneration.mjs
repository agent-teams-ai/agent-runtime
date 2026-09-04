import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const EXPECTED_BINARY_SHA256 = "abf1bb1643a79f73aa78ee627e111e02d4f8c98f25813a0cf6ce277709664386";
const EXPECTED_SOURCE_SHA256 = "0f1d661f014aac04c3fc9c04b8ebe818494a6d22fc16fe564390d0969a900370";
const EXPECTED_PERMISSION_CONTRACT_SHA256 = "e692b97c71ce58c3ef2bb3ea109bc33bcd624768ac3cac1de520971da66aa7fb";
const EXPECTED_PERMISSION_TYPE_SOURCES = Object.freeze([
  "v2/ActivePermissionProfile.ts",
  "v2/Config.ts",
  "v2/ConfigLayer.ts",
  "v2/ConfigLayerMetadata.ts",
  "v2/ThreadStartResponse.ts",
  "v2/ThreadStartParams.ts",
  "v2/TurnStartParams.ts",
  "InitializeResponse.ts",
  "v2/ConfigReadResponse.ts",
  "v2/PermissionProfileListResponse.ts",
  "v2/PermissionProfileSummary.ts",
  "v2/TurnInterruptResponse.ts",
  "v2/TurnCompletedNotification.ts",
  "v2/AgentMessageDeltaNotification.ts",
  "v2/TurnStatus.ts",
]);
const EXPECTED_CONFIG_LAYER_SCHEMA_SOURCE = "v2/ConfigReadResponse.json";
const EXPECTED_TREES = Object.freeze({
  schema: Object.freeze({
    fileCount: 411,
    manifestSha256: "9f28c7c4c42a02af6b8a31e978188df6c14547be3c1c8dbe824313b1a8b5fa56",
  }),
  types: Object.freeze({
    fileCount: 812,
    manifestSha256: "3b4836d6282a30cdba8ace7c3ad6fa8ee968da77ca4bf6430c05ff7c525d4fcc",
  }),
});

const requiredEnvironment = name => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {throw new Error(`missing ${name}`);}
  return value;
};
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

const assertRecord = (value, label) => {
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true,
    `${label} must be an object`);
  return value;
};

const assertRelativeSource = (source, expected, label) => {
  assert.equal(source, expected, `${label} source path was substituted`);
  assert.doesNotMatch(source, /(?:^|\/)\.{1,2}(?:\/|$)|[\\\n\r]|^\//u,
    `${label} source must be a canonical relative path`);
};

const readClaimedFile = async (root, claim, expectedSource, label) => {
  const record = assertRecord(claim, label);
  assertRelativeSource(record.source, expectedSource, label);
  assert.match(record.sourceSha256, /^[a-f0-9]{64}$/u, `${label} must retain an exact SHA-256`);
  const path = join(root, record.source);
  const pathObservation = await lstat(path);
  assert.equal(pathObservation.isFile(), true, `${label} source path is not a regular file`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const observation = await handle.stat();
    assert.equal(observation.isFile(), true, `${label} opened source is not a regular file`);
    const bytes = await handle.readFile();
    assert.equal(digest(bytes), record.sourceSha256, `${label} source SHA-256 drifted`);
    return bytes;
  } finally {
    await handle.close();
  }
};

export const verifyPermissionContractClaims = async (permissionContract, generatedSchema, generatedTypes) => {
  const fixture = assertRecord(permissionContract, "permission contract");
  assert.equal(fixture.schemaVersion, 4, "permission contract schema version drifted");
  assert.ok(Array.isArray(fixture.generatedTypeFragments),
    "permission contract generatedTypeFragments must be an array");
  assert.deepEqual(fixture.generatedTypeFragments.map(claim => claim?.source), EXPECTED_PERMISSION_TYPE_SOURCES,
    "permission contract retained TypeScript source paths drifted");

  for (const [index, claim] of fixture.generatedTypeFragments.entries()) {
    const label = `permission contract generatedTypeFragments[${index}]`;
    const bytes = await readClaimedFile(generatedTypes, claim, EXPECTED_PERMISSION_TYPE_SOURCES[index], label);
    assert.equal(typeof claim.fragment, "string", `${label} fragment must be a string`);
    assert.notEqual(claim.fragment.length, 0, `${label} fragment must not be empty`);
    assert.equal(bytes.includes(Buffer.from(claim.fragment, "utf8")), true,
      `${label} retained fragment drifted`);
  }

  const configLayerEvidence = assertRecord(fixture.configLayerEvidence, "configLayerEvidence");
  const jsonSchemaEvidence = assertRecord(configLayerEvidence.jsonSchema, "configLayerEvidence.jsonSchema");
  const schemaBytes = await readClaimedFile(generatedSchema, jsonSchemaEvidence,
    EXPECTED_CONFIG_LAYER_SCHEMA_SOURCE, "configLayerEvidence.jsonSchema");
  const schema = assertRecord(JSON.parse(schemaBytes.toString("utf8")), "ConfigReadResponse JSON Schema");
  const definitions = assertRecord(schema.definitions, "ConfigReadResponse JSON Schema definitions");
  const configLayer = assertRecord(definitions.ConfigLayer, "ConfigReadResponse JSON Schema ConfigLayer");
  const properties = assertRecord(configLayer.properties, "ConfigReadResponse JSON Schema ConfigLayer properties");
  const disabledReason = assertRecord(properties.disabledReason,
    "ConfigReadResponse JSON Schema ConfigLayer.disabledReason");
  assert.ok(Array.isArray(jsonSchemaEvidence.required), "recorded ConfigLayer required keys must be an array");
  assert.deepEqual(configLayer.required, jsonSchemaEvidence.required, "ConfigLayer required keys drifted");
  for (const required of jsonSchemaEvidence.required) {
    assert.equal(Object.hasOwn(properties, required), true, `ConfigLayer required property ${required} is missing`);
  }
  assert.equal(configLayer.required.includes("disabledReason"), jsonSchemaEvidence.disabledReason.required,
    "ConfigLayer disabledReason required semantics drifted");
  assert.deepEqual(disabledReason.type, jsonSchemaEvidence.disabledReason.types,
    "ConfigLayer disabledReason types drifted");

  const typeScriptEvidence = assertRecord(configLayerEvidence.typeScript, "configLayerEvidence.typeScript");
  const typeScriptBytes = await readClaimedFile(generatedTypes, typeScriptEvidence,
    "v2/ConfigLayer.ts", "configLayerEvidence.typeScript");
  assert.equal(typeof typeScriptEvidence.fragment, "string", "ConfigLayer TypeScript fragment must be a string");
  assert.equal(typeScriptBytes.includes(Buffer.from(typeScriptEvidence.fragment, "utf8")), true,
    "ConfigLayer TypeScript retained fragment drifted");
  assert.equal(typeScriptEvidence.disabledReasonRequired, true,
    "ConfigLayer TypeScript required-field evidence drifted");

  return Object.freeze({ jsonSchemaClaims: 1, typeScriptClaims: fixture.generatedTypeFragments.length });
};

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
    Buffer.from(left.relativePath, "utf8").compare(Buffer.from(right.relativePath, "utf8")));
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

const runExternalProof = async () => {
  if (process.env.AR_CODEX_SCHEMA_REGEN_VERIFY !== "1") {
    process.stdout.write(`${JSON.stringify({ status: "skipped-not-external-proof" })}\n`);
    return;
  }
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
    const permissionContractBytes = await readFile(new URL(
      "../../linux-codex-app-server-0.150.1-permission-contract.json", import.meta.url));
    assert.equal(digest(permissionContractBytes), EXPECTED_PERMISSION_CONTRACT_SHA256,
      "committed permission contract digest mismatch");
    const permissionContractClaims = await verifyPermissionContractClaims(
      JSON.parse(permissionContractBytes.toString("utf8")), generatedSchema, generatedTypes);
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
      permissionContractClaims,
      schemaTree,
      status: "external-proof-passed",
      typesTree,
    })}\n`);
  } finally {
    await binaryHandle.close();
    await rm(root, { force: true, recursive: true });
  }
};

const isDirectExecution = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectExecution) {await runExternalProof();}
