import { lstat, realpath } from "node:fs/promises";
import { release, version } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { digestTree, sha256 } from "./provider-candidate-build-tree.mjs";
import { candidateFileBytes } from "./provider-candidate-file-read.mjs";
import { choice, exactDigest, record } from "./provider-candidate-evidence-schema.mjs";

export const NATIVE_SOURCE = "packages/platform/filesystem-custody/native/rename-no-replace.c";
export const NATIVE_OUTPUT = "dist/rename-no-replace.node";
const ROLES = ["compiler", "linker", "resources", "nodeHeaders", "sysroot"];
const rolesFor = native => native.recipe === "linux-x64-gcc-shared/v1" ? [...ROLES, "assembler"] : ROLES;
const fail = () => {throw new TypeError("exact host-bound native qualification required");};
const boundedText = value => {
  if (typeof value !== "string" || !value.length || value.length > 512 || /[\0\r\n]/u.test(value)) {fail();}
  return value;
};
const absolutePath = value => {
  boundedText(value);
  if (!isAbsolute(value) || normalize(value) !== value || value === "/") {fail();}
  return value;
};

// Detached data from PRIVATE composition only. Digests of installation provenance
// and reviewed driver defaults are independent operator attestations, not facts
// manufactured by this verifier. Unknown defaults cannot be qualified.
export const captureNativeQualification = (value, platform, architecture) => {
  const input = record(value, ["sourceSha", "sourceTreeDigest", "cSourceDigest", "recipe", "recipeDigest",
    "epoch", "deploymentTarget", "environment", "inputs", "expectedOutput"]);
  choice(`${platform}-${architecture}`, ["linux-x64", "darwin-arm64"]);
  choice(input.recipe, platform === "linux" ? ["linux-x64-clang-shared/v1", "linux-x64-gcc-shared/v1"] : ["darwin-arm64-clang-bundle/v1"]);
  if (typeof input.sourceSha !== "string" || !/^[a-f0-9]{40}$/u.test(input.sourceSha)) {fail();}
  for (const key of ["sourceTreeDigest", "cSourceDigest", "recipeDigest"]) {exactDigest(input[key]);}
  if (typeof input.epoch !== "string" || !/^(?:0|[1-9][0-9]{0,10})$/u.test(input.epoch)) {fail();}
  if (platform === "linux") {choice(input.deploymentTarget, ["none"]);}
  else if (typeof input.deploymentTarget !== "string" || !/^[0-9]{1,2}\.[0-9]{1,2}$/u.test(input.deploymentTarget)) {fail();}
  const environment = record(input.environment, ["release", "version", "identityDigest", "installationProvenanceDigest", "defaultResolutionDigest"]);
  for (const key of ["release", "version"]) {boundedText(environment[key]);}
  for (const key of ["identityDigest", "installationProvenanceDigest", "defaultResolutionDigest"]) {exactDigest(environment[key]);}
  input.environment = Object.freeze(environment);
  const inputs = record(input.inputs, rolesFor(input));
  for (const role of rolesFor(input)) {
    const item = record(inputs[role], ["path", "digest"]);
    absolutePath(item.path); exactDigest(item.digest);
    inputs[role] = Object.freeze(item);
  }
  input.inputs = Object.freeze(inputs);
  const output = record(input.expectedOutput, ["path", "digest", "bytes"]);
  choice(output.path, [NATIVE_OUTPUT]); exactDigest(output.digest);
  if (!Number.isSafeInteger(output.bytes) || output.bytes < 1 || output.bytes > 64 * 1024 ** 2) {fail();}
  input.expectedOutput = Object.freeze(output);
  return Object.freeze(input);
};

// Fixed helper protocol, not arbitrary arguments or a candidate build callback.
// The separately pinned helper implements these fixed recipes; its exact bytes
// remain part of the existing Node/TS/package qualification.
export const nativeInvocation = native => Object.freeze({
  args: Object.freeze(["scripts/build-native-helper.mjs", "--qualified", native.recipe,
    ...rolesFor(native).map(role => native.inputs[role].path), native.deploymentTarget]),
  // This is the explicitly supplied environment, not a claim that the OS
  // cannot augment it. Darwin may inject __CF_USER_TEXT_ENCODING at spawn;
  // that host behavior belongs to the independently attested environment.
  environment: Object.freeze({LC_ALL: "C", TZ: "UTC", SOURCE_DATE_EPOCH: native.epoch}),
});

const matchGccResources = async native => {
  if (native.recipe === "linux-x64-gcc-shared/v1") {
    // Approved GCC resources include the actual cc1/collect2 driver programs,
    // internal headers and runtime objects. Other driver defaults are covered
    // independently by defaultResolutionDigest; observation cannot authorize them.
    for (const name of ["cc1", "collect2"]) {
      const path = join(native.inputs.resources.path, name);
      const entry = await lstat(path);
      if (!(entry.mode & 0o111)) {fail();}
      await candidateFileBytes(path, 512 * 1024 ** 2);
    }
  }
};

export const matchNativeQualification = async (snapshot, qualification) => {
  const native = qualification.native;
  if (!snapshot.files.has(NATIVE_SOURCE) || snapshot.head !== native.sourceSha || snapshot.treeDigest !== native.sourceTreeDigest ||
      sha256(snapshot.files.get(NATIVE_SOURCE)?.bytes ?? "") !== native.cSourceDigest ||
      release() !== native.environment.release || version() !== native.environment.version ||
      sha256(JSON.stringify(nativeInvocation(native))) !== native.recipeDigest) {
    throw new Error("native source, environment, or recipe differs from independent qualification");
  }
  for (const role of rolesFor(native)) {
    const {path, digest} = native.inputs[role];
    if (await realpath(path) !== path) {throw new Error("native input path must be canonical");}
    const entry = await lstat(path);
    const file = role === "compiler" || role === "linker" || role === "assembler";
    if (entry.isSymbolicLink() || (file ? !entry.isFile() || !(entry.mode & 0o111) : !entry.isDirectory())) {
      throw new Error("native input kind differs from approved recipe");
    }
    const actual = file ? sha256(await candidateFileBytes(path, 512 * 1024 ** 2)) : (await digestTree(path, path)).treeDigest;
    if (actual !== digest) {throw new Error("native input differs from independent qualification");}
  }
  await matchGccResources(native);
  // Header discovery is forbidden even if a driver would find another copy.
  await candidateFileBytes(join(native.inputs.nodeHeaders.path, "node_api.h"), 16 * 1024 ** 2);
  return Object.freeze({
    nativeQualificationDigest: sha256(JSON.stringify(native)),
    nativeRecipeDigest: native.recipeDigest,
    nativeEnvironmentDigest: sha256(JSON.stringify(native.environment)),
    nativeOutputDigest: native.expectedOutput.digest,
  });
};

export const matchNativeOutput = async (packageRoot, native) => {
  const bytes = await candidateFileBytes(join(packageRoot, NATIVE_OUTPUT), native.expectedOutput.bytes);
  if (bytes.length !== native.expectedOutput.bytes || sha256(bytes) !== native.expectedOutput.digest) {
    throw new Error("native output differs from independent exact artifact receipt");
  }
};

// Native provenance is implementation evidence for an independently qualified
// host-bound recipe in an operator-managed cooperative checkout. It binds exact
// source, input, recipe, and artifact identities and rejects observed mutation
// and stale output. It does not prove uninterrupted byte custody against
// adversarial same-privilege mutation. Provider containment, route enforcement,
// operation receipts, and deployment qualification remain separately required.
