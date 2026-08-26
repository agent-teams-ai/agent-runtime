import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNodeExecutableFileObserver,
  createRuntimeInstallationDiscoveryFeature,
} from "../dist/composition.js";

test("discovers distinct binaries and groups symlink and hardlink aliases", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-installation-discovery-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const first = join(root, "bin-a", "codex");
  const second = join(root, "bin-b", "codex");
  const unicodeAliasDirectory = "bin space-e\u0301";
  const symbolicAlias = join(root, unicodeAliasDirectory, "codex");
  const hardAlias = join(root, "bin-d", "codex");
  await Promise.all([
    mkdir(join(root, "bin-a"), { recursive: true }),
    mkdir(join(root, "bin-b"), { recursive: true }),
    mkdir(join(root, unicodeAliasDirectory), { recursive: true }),
    mkdir(join(root, "bin-d"), { recursive: true }),
  ]);
  await writeFile(first, "synthetic-a");
  await writeFile(second, "synthetic-b");
  await Promise.all([chmod(first, 0o755), chmod(second, 0o755)]);
  await symlink(first, symbolicAlias);
  await link(first, hardAlias);
  const [firstCanonical, secondCanonical, hardAliasCanonical] = await Promise.all([
    realpath(first),
    realpath(second),
    realpath(hardAlias),
  ]);

  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: createNodeExecutableFileObserver(),
  });
  const result = await feature.discoverCodexInstallations.execute({
    candidates: [
      { absolutePath: second, canonicalPath: secondCanonical, displayPath: "$HOME/bin-b/codex", required: false, source: "path-entry" },
      { absolutePath: hardAlias, canonicalPath: hardAliasCanonical, displayPath: "$HOME/bin-d/codex", required: false, source: "known-location" },
      { absolutePath: first, canonicalPath: firstCanonical, displayPath: "$HOME/bin-a/codex", required: true, source: "explicit" },
      { absolutePath: symbolicAlias, canonicalPath: firstCanonical, displayPath: `$HOME/${unicodeAliasDirectory}/codex`, required: false, source: "path-entry" },
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
  const [directoryCanonical, nonExecutableCanonical] = await Promise.all([
    realpath(directory),
    realpath(nonExecutable),
  ]);

  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: createNodeExecutableFileObserver(),
  });
  const result = await feature.discoverCodexInstallations.execute({
    candidates: [
      { absolutePath: directory, canonicalPath: directoryCanonical, displayPath: "$HOME/directory", required: true, source: "explicit" },
      { absolutePath: nonExecutable, canonicalPath: nonExecutableCanonical, displayPath: "$HOME/not-executable", required: true, source: "explicit" },
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
  await rm(alias);
  await symlink(second, alias);

  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: createNodeExecutableFileObserver(),
  });
  const result = await feature.discoverCodexInstallations.execute({
    candidates: [{
      absolutePath: alias,
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
