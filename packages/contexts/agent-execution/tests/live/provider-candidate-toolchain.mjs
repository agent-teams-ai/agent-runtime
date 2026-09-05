import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { inside, sha256 } from "./provider-candidate-build-tree.mjs";
import { candidateFileBytes } from "./provider-candidate-file-read.mjs";
import { choice, exactDigest, record } from "./provider-candidate-evidence-schema.mjs";

const DIGESTS = ["compilerDigest", "dependenciesDigest", "nativeHelperDigest", "nodeDigest", "packageClosureDigest"];
export const NATIVE_HELPER = "packages/platform/filesystem-custody/scripts/build-native-helper.mjs";

// PRIVATE TRUSTED OUTER COMPOSITION INPUT, not a workspace manifest or caller
// claim. The qualifier must independently pin the complete installed dependency
// tree (including all compiler modules), Node executable/version/platform, exact
// package/lock closure and helper bytes. This profile admits only a helper that
// uses that Node closure, without external tools. A digest observed in the
// candidate checkout cannot supply these expected values. No ambient/file/env
// loader or production qualification authority exists in this repository.
export const trustedToolchainQualification = value => {
  if (value === undefined) {throw new TypeError("separately trusted exact build-toolchain qualification required");}
  const input = record(value, ["profile", "platform", "architecture", "nodeVersion", ...DIGESTS]);
  choice(input.profile, ["node-only-offline-toolchain/v1"]);
  choice(input.platform, [process.platform]);
  choice(input.architecture, [process.arch]);
  choice(input.nodeVersion, [process.version]);
  for (const key of DIGESTS) {exactDigest(input[key]);}
  return Object.freeze(input);
};

export const matchTrustedToolchain = async (snapshot, qualification, observed) => {
  // The real Linux recipe also executes cc and consumes host headers/libraries.
  // No separately qualified native closure is available here: a Node pin must
  // never silently authorize that ambient toolchain. Darwin's helper is a no-op.
  if (process.platform === "linux" && snapshot.files.has("packages/platform/filesystem-custody/native/rename-no-replace.c")) {
    throw new Error("native compiler/header toolchain qualification is unavailable");
  }
  const compiler = await realpath(join(snapshot.root, "node_modules/typescript/bin/tsc"));
  if (!inside(snapshot.root, compiler)) {throw new Error("compiler escaped qualified dependency closure");}
  const compilerDigest = sha256(await candidateFileBytes(compiler, 16 * 1024 ** 2));
  const helper = snapshot.files.get(NATIVE_HELPER);
  if (helper === undefined || compilerDigest !== qualification.compilerDigest ||
      sha256(helper.bytes) !== qualification.nativeHelperDigest ||
      sha256(await readFile(process.execPath)) !== qualification.nodeDigest ||
      observed.dependenciesDigest !== qualification.dependenciesDigest ||
      observed.packageClosureDigest !== qualification.packageClosureDigest) {
    throw new Error("build toolchain does not match separately trusted qualification");
  }
  return Object.freeze({compilerDigest, toolchainQualificationDigest: sha256(JSON.stringify(qualification))});
};
