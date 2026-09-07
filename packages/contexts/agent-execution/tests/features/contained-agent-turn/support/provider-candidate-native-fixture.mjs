import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { release, tmpdir, version } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { commit, sourceFixture } from "./provider-candidate-source-fixture.mjs";
import { digestTree, sha256 } from "../../../live/provider-candidate-build-tree.mjs";
import { sourceSnapshot } from "../../../live/provider-candidate-source.mjs";
import { nativeInvocation, NATIVE_SOURCE } from "../../../live/provider-candidate-native-build.mjs";
import { NATIVE_HELPER } from "../../../live/provider-candidate-toolchain.mjs";
import { git } from "./provider-candidate-source-fixture.mjs";

export const freeze = value => Object.freeze(value);
export const artifact = "synthetic independently expected native artifact\n";
export const nativeFixture = async t => {
  const fixture = await sourceFixture(t);
  const tools = await realpath(await mkdtemp(join(tmpdir(), "ar-native-approved-fixture-")));
  t.after(() => rm(tools, {recursive: true, force: true}));
  const marker = join(tools, "invocation.json");
  // Operator-authored synthetic tool bytes, never qualified from candidate output.
  const compiler = `#!${process.execPath}
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2),env:process.env}));
writeFileSync('dist/rename-no-replace.node', ${JSON.stringify(artifact)});
`;
  const inputs = {};
  for (const role of ["compiler", "linker", "resources", "nodeHeaders", "sysroot"]) {
    const path = join(tools, role);
    if (["compiler", "linker"].includes(role)) {
      const bytes = role === "compiler" ? compiler : "#!/bin/sh\nexit 1\n";
      await writeFile(path, bytes); await chmod(path, 0o755);
      inputs[role] = freeze({path, digest: sha256(bytes)});
    } else {
      await mkdir(path);
      await writeFile(join(path, role === "nodeHeaders" ? "node_api.h" : "approved-input"), `synthetic ${role}\n`);
      inputs[role] = freeze({path, digest: (await digestTree(path, path)).treeDigest});
    }
  }
  const helper = await readFile(new URL("../../../../../../platform/filesystem-custody/scripts/build-native-helper.mjs", import.meta.url));
  const cSource = "/* synthetic native input, not compilable platform evidence */\n";
  await mkdir(join(fixture.root, "packages/platform/filesystem-custody/native"));
  await writeFile(join(fixture.root, NATIVE_SOURCE), cSource);
  await writeFile(join(fixture.root, NATIVE_HELPER), helper);
  await commit(fixture.root);
  const snapshot = await sourceSnapshot(pathToFileURL(fixture.canaryPath).href, await git(fixture.root, "rev-parse", "HEAD"));
  const native = {
    sourceSha: snapshot.head, sourceTreeDigest: snapshot.treeDigest, cSourceDigest: sha256(cSource),
    recipe: process.platform === "linux" ? "linux-x64-clang-shared/v1" : "darwin-arm64-clang-bundle/v1",
    recipeDigest: "0".repeat(64), epoch: "0", deploymentTarget: process.platform === "linux" ? "none" : "13.0",
    environment: freeze({release: release(), version: version(), identityDigest: sha256("synthetic host"),
      installationProvenanceDigest: sha256("synthetic installation"), defaultResolutionDigest: sha256("synthetic defaults")}),
    inputs: freeze(inputs), expectedOutput: freeze({path: "dist/rename-no-replace.node", digest: sha256(artifact), bytes: Buffer.byteLength(artifact)}),
  };
  native.recipeDigest = sha256(JSON.stringify(nativeInvocation(native)));
  const qualification = freeze({...fixture.qualification, profile: "host-bound-native-toolchain/v1",
    nativeHelperDigest: sha256(helper), native: freeze(native)});
  const output = join(fixture.root, "packages/platform/filesystem-custody/dist/rename-no-replace.node");
  await writeFile(output, artifact);
  return {...fixture, qualification, snapshot, marker, output};
};
