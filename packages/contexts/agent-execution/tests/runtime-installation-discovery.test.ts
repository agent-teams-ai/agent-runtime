import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNodeExecutableFileObserver,
  createRuntimeInstallationDiscoveryFeature,
} from "../dist/composition.js";

const fileIdentity = async (path: string): Promise<string> => {
  const observation = await stat(path);
  return `${observation.dev}:${observation.ino}`;
};

test("discovers distinct binaries and groups symlink and hardlink aliases", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-installation-discovery-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const first = join(root, "bin-a", "codex");
  const second = join(root, "bin-b", "codex");
  const unicodeAliasDirectory = "bin space-e\u0301";
  const symbolicAlias = join(root, unicodeAliasDirectory, "codex");
  const secondSymbolicAlias = join(root, "bin-d", "codex");
  await Promise.all([
    mkdir(join(root, "bin-a"), { recursive: true }),
    mkdir(join(root, "bin-b"), { recursive: true }),
    mkdir(join(root, unicodeAliasDirectory), { recursive: true }),
    mkdir(join(root, "bin-d"), { recursive: true }),
  ]);
  await writeFile(first, "synthetic-a");
  await writeFile(second, "synthetic-b");
  await Promise.all([chmod(first, 0o755), chmod(second, 0o755)]);
  await Promise.all([
    symlink(first, symbolicAlias),
    symlink(first, secondSymbolicAlias),
  ]);
  const [firstCanonical, secondCanonical, secondAliasCanonical, firstIdentity, secondIdentity] = await Promise.all([
    realpath(first),
    realpath(second),
    realpath(secondSymbolicAlias),
    fileIdentity(first),
    fileIdentity(second),
  ]);

  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: createNodeExecutableFileObserver(),
  });
  const result = await feature.discoverCodexInstallations.execute({
    candidates: [
      { absolutePath: second, authorizedFileIdentity: secondIdentity, canonicalPath: secondCanonical, displayPath: "$HOME/bin-b/codex", required: false, source: "path-entry" },
      { absolutePath: secondSymbolicAlias, authorizedFileIdentity: firstIdentity, canonicalPath: secondAliasCanonical, displayPath: "$HOME/bin-d/codex", required: false, source: "known-location" },
      { absolutePath: first, authorizedFileIdentity: firstIdentity, canonicalPath: firstCanonical, displayPath: "$HOME/bin-a/codex", required: true, source: "explicit" },
      { absolutePath: symbolicAlias, authorizedFileIdentity: firstIdentity, canonicalPath: firstCanonical, displayPath: `$HOME/${unicodeAliasDirectory}/codex`, required: false, source: "path-entry" },
    ],
    observationEpoch: "epoch-1",
  });

  assert.equal(result.installations.length, 2);
  assert.deepEqual(
    result.installations.map(item => item.aliases.length).toSorted(),
    [1, 3],
  );
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.installations.every(item => item.status === "found_unverified"));
  assert.ok(
    result.installations.some(item =>
      item.aliases.some(alias => alias.displayPath.includes(unicodeAliasDirectory)),
    ),
  );
});

test("reports invalid required candidates without executing them", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-installation-invalid-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = join(root, "directory");
  const nonExecutable = join(root, "not-executable");
  const broken = join(root, "broken");
  const cyclic = join(root, "cyclic");
  const cyclicPeer = join(root, "cyclic-peer");
  await mkdir(directory);
  await writeFile(nonExecutable, "synthetic");
  await symlink(join(root, "missing-target"), broken);
  await symlink(cyclicPeer, cyclic);
  await symlink(cyclic, cyclicPeer);
  const [directoryCanonical, nonExecutableCanonical, directoryIdentity, nonExecutableIdentity] = await Promise.all([
    realpath(directory),
    realpath(nonExecutable),
    fileIdentity(directory),
    fileIdentity(nonExecutable),
  ]);

  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: createNodeExecutableFileObserver(),
  });
  const result = await feature.discoverCodexInstallations.execute({
    candidates: [
      { absolutePath: directory, authorizedFileIdentity: directoryIdentity, canonicalPath: directoryCanonical, displayPath: "$HOME/directory", required: true, source: "explicit" },
      { absolutePath: nonExecutable, authorizedFileIdentity: nonExecutableIdentity, canonicalPath: nonExecutableCanonical, displayPath: "$HOME/not-executable", required: true, source: "explicit" },
      { absolutePath: broken, canonicalPath: broken, displayPath: "$HOME/broken", required: true, source: "explicit" },
      { absolutePath: cyclic, canonicalPath: cyclic, displayPath: "$HOME/cyclic", required: true, source: "explicit" },
    ],
    observationEpoch: "epoch-1",
  });

  assert.equal(result.installations.length, 0);
  assert.deepEqual(
    result.diagnostics.map(item => item.code),
    ["candidate_invalid", "candidate_invalid", "candidate_invalid", "candidate_invalid"],
  );
});

test("rejects a candidate whose alias changed after authorization", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-installation-race-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const first = join(root, "codex-first");
  const second = join(root, "codex-second");
  const alias = join(root, "codex");
  await Promise.all([
    writeFile(first, "synthetic-a"),
    writeFile(second, "synthetic-b"),
  ]);
  await Promise.all([chmod(first, 0o755), chmod(second, 0o755)]);
  await symlink(first, alias);
  const firstCanonical = await realpath(first);
  const authorizedFileIdentity = await fileIdentity(first);
  await rm(alias);
  await symlink(second, alias);

  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: createNodeExecutableFileObserver(),
  });
  const result = await feature.discoverCodexInstallations.execute({
    candidates: [{
      absolutePath: alias,
      authorizedFileIdentity,
      canonicalPath: firstCanonical,
      displayPath: "$HOME/codex",
      required: true,
      source: "explicit",
    }],
    observationEpoch: "epoch-1",
  });

  assert.equal(result.installations.length, 0);
  assert.equal(result.diagnostics[0]?.code, "candidate_unstable");
});

test("rejects a different executable installed at the authorized canonical path", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-installation-identity-race-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const executable = join(root, "codex");
  await writeFile(executable, "authorized");
  await chmod(executable, 0o755);
  const canonicalPath = await realpath(executable);
  const authorizedFileIdentity = await fileIdentity(executable);
  await rm(executable);
  await writeFile(executable, "replacement");
  await chmod(executable, 0o755);

  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: createNodeExecutableFileObserver(),
  });
  const result = await feature.discoverCodexInstallations.execute({
    candidates: [{
      absolutePath: executable,
      authorizedFileIdentity,
      canonicalPath,
      displayPath: "$HOME/codex",
      required: true,
      source: "explicit",
    }],
    observationEpoch: "epoch-1",
  });

  assert.equal(result.installations.length, 0);
  assert.equal(result.diagnostics[0]?.code, "candidate_unstable");
});

test("propagates local AbortSignal cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: createNodeExecutableFileObserver(),
  });
  await assert.rejects(
    feature.discoverCodexInstallations.execute(
      { candidates: [], observationEpoch: "epoch-1" },
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
});
