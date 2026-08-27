import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNodePathCanonicalizer,
  createSetupInspectionAuthorizationFeature,
} from "../dist/composition.js";

test("authorizes exact synthetic paths and rejects ambient expansion", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-setup-authorization-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all([
    mkdir(join(home, "bin"), { recursive: true }),
    mkdir(join(home, ".codex"), { recursive: true }),
    mkdir(join(workspace, ".codex"), { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
  await writeFile(join(home, "bin", "codex"), "synthetic");
  await writeFile(join(home, ".codex", "config.toml"), "model = 'gpt'");
  await writeFile(join(workspace, ".codex", "config.toml"), "model = 'gpt'");
  await writeFile(join(outside, "codex"), "synthetic");

  const feature = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: createNodePathCanonicalizer(),
  });
  const result = await feature.authorizeSetupInspection.execute({
    configurationSources: [
      { absolutePath: join(home, ".codex", "config.toml"), kind: "user", workspaceTrusted: true },
      { absolutePath: join(workspace, ".codex", "config.toml"), kind: "workspace", workspaceTrusted: false },
    ],
    explicitExecutablePaths: [join(outside, "codex")],
    knownExecutableDirectories: [join(home, "bin")],
    observationEpoch: "epoch-1",
    pathEntries: ["", "relative-bin", join(home, "bin")],
    platform: "darwin",
    roots: [
      { absolutePath: home, displayName: "$HOME", kind: "home" },
      { absolutePath: workspace, displayName: "$WORKSPACE", kind: "workspace" },
    ],
  });

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {
    return;
  }
  assert.equal(result.configurationSources.length, 1);
  assert.ok(result.configurationSources[0]?.displayPath.startsWith("$HOME/"));
  assert.equal(result.installationCandidates.length, 2);
  assert.deepEqual(
    result.diagnostics.map(item => item.code).toSorted(),
    ["empty_path_entry", "path_outside_scope", "relative_path_entry", "source_untrusted"],
  );
});

test("rejects a symlink that resolves outside authorized roots", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-setup-symlink-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  await Promise.all([mkdir(allowed), mkdir(outside)]);
  const target = join(outside, "codex");
  const alias = join(allowed, "codex");
  await writeFile(target, "synthetic");
  await symlink(target, alias);

  const feature = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: createNodePathCanonicalizer(),
  });
  const result = await feature.authorizeSetupInspection.execute({
    configurationSources: [],
    explicitExecutablePaths: [alias],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: [],
    platform: "darwin",
    roots: [{ absolutePath: allowed, displayName: "$HOME/bin", kind: "home" }],
  });
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {
    return;
  }
  assert.equal(result.installationCandidates.length, 0);
  assert.equal(result.diagnostics[0]?.code, "path_outside_scope");
});

test("binds configuration sources to their matching root kind", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-setup-cross-root-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const workspace = join(home, "workspace");
  await Promise.all([
    mkdir(join(home, ".codex"), { recursive: true }),
    mkdir(join(workspace, ".codex"), { recursive: true }),
  ]);
  const privateUserConfig = join(home, ".codex", "private.toml");
  const workspaceAlias = join(workspace, ".codex", "config.toml");
  await writeFile(privateUserConfig, "model = 'gpt-private'\n");
  await symlink(privateUserConfig, workspaceAlias);

  const feature = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: createNodePathCanonicalizer(),
  });
  const result = await feature.authorizeSetupInspection.execute({
    configurationSources: [{
      absolutePath: workspaceAlias,
      kind: "workspace",
      workspaceTrusted: true,
    }],
    explicitExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: [],
    platform: "darwin",
    roots: [
      { absolutePath: home, displayName: "$HOME", kind: "home" },
      { absolutePath: workspace, displayName: "$WORKSPACE", kind: "workspace" },
    ],
  });

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {
    return;
  }
  assert.equal(result.configurationSources.length, 0);
  assert.equal(result.diagnostics[0]?.code, "path_outside_scope");
});

test("uses the most-specific root for deterministic display paths", async t => {
  const home = await mkdtemp(join(tmpdir(), "ar-setup-specific-root-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const workspace = join(home, "workspace");
  const executable = join(workspace, "bin", "codex");
  await mkdir(join(workspace, "bin"), { recursive: true });
  await writeFile(executable, "synthetic");

  const feature = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: createNodePathCanonicalizer(),
  });
  const result = await feature.authorizeSetupInspection.execute({
    configurationSources: [],
    explicitExecutablePaths: [executable],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: [],
    platform: "darwin",
    roots: [
      { absolutePath: home, displayName: "$HOME", kind: "home" },
      { absolutePath: workspace, displayName: "$WORKSPACE", kind: "workspace" },
    ],
  });

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {
    return;
  }
  assert.equal(result.installationCandidates[0]?.displayPath, "$WORKSPACE/bin/codex");
});

test("fails closed on unsupported platform", async () => {
  const feature = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: createNodePathCanonicalizer(),
  });
  const result = await feature.authorizeSetupInspection.execute({
    configurationSources: [],
    explicitExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: [],
    platform: "linux",
    roots: [],
  });
  assert.deepEqual(result, { diagnostics: [], status: "unsupported" });
});
