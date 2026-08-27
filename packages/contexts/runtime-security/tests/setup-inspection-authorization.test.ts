import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createNodePathCanonicalizer,
  createSetupInspectionAuthorizationFeature,
} from "../dist/composition.js";

const execFile = promisify(execFileCallback);

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
      { absolutePath: home, kind: "home" },
      { absolutePath: workspace, kind: "workspace" },
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
    roots: [{ absolutePath: allowed, kind: "home" }],
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
      { absolutePath: home, kind: "home" },
      { absolutePath: workspace, kind: "workspace" },
    ],
  });

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {
    return;
  }
  assert.equal(result.configurationSources.length, 0);
  assert.equal(result.diagnostics[0]?.code, "path_outside_scope");
});

test("does not treat a workspace target as trusted user configuration", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-setup-user-workspace-alias-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const workspace = join(home, "workspace");
  await Promise.all([
    mkdir(join(home, ".codex"), { recursive: true }),
    mkdir(join(workspace, ".codex"), { recursive: true }),
  ]);
  const workspaceConfig = join(workspace, ".codex", "untrusted.toml");
  const userAlias = join(home, ".codex", "config.toml");
  await writeFile(workspaceConfig, "model = 'workspace-controlled'\n");
  await symlink(workspaceConfig, userAlias);

  const feature = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: createNodePathCanonicalizer(),
  });
  const result = await feature.authorizeSetupInspection.execute({
    configurationSources: [{
      absolutePath: userAlias,
      kind: "user",
      workspaceTrusted: true,
    }],
    explicitExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-user-workspace-alias",
    pathEntries: [],
    platform: "darwin",
    roots: [
      { absolutePath: home, kind: "home" },
      { absolutePath: workspace, kind: "workspace" },
    ],
  });

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {
    return;
  }
  assert.deepEqual(result.configurationSources, []);
  assert.deepEqual(result.diagnostics, [
    { code: "path_outside_scope", subject: "user-config" },
  ]);
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
      { absolutePath: home, kind: "home" },
      { absolutePath: workspace, kind: "workspace" },
    ],
  });

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {
    return;
  }
  assert.equal(result.installationCandidates[0]?.displayPath, "$WORKSPACE/bin/codex");
});

test("derives deterministic display labels without leaking caller labels or host paths", async t => {
  const outer = await mkdtemp(join(tmpdir(), "ar-setup-display-label-"));
  t.after(() => rm(outer, { force: true, recursive: true }));
  const home = join(outer, "private-home");
  const executable = join(home, "bin", "co\ndex");
  const newlineThenA = join(home, "bin", "\nA");
  const feminineOrdinal = join(home, "bin", "\u{00AA}");
  const backslashName = join(home, "bin", "a\\b");
  const nestedPath = join(home, "bin", "a", "b");
  await Promise.all([
    mkdir(join(home, "bin"), { recursive: true }),
    mkdir(join(home, "bin", "a"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(executable, "synthetic"),
    writeFile(newlineThenA, "synthetic"),
    writeFile(feminineOrdinal, "synthetic"),
    writeFile(backslashName, "synthetic"),
    writeFile(nestedPath, "synthetic"),
  ]);

  const feature = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: createNodePathCanonicalizer(),
  });
  const maliciousLabel = `${outer}\n$WORKSPACE`;
  const roots = [
    { absolutePath: outer, displayName: maliciousLabel, kind: "system" as const },
    { absolutePath: home, displayName: maliciousLabel, kind: "home" as const },
  ];
  const inspect = (orderedRoots: readonly {
    readonly absolutePath: string;
    readonly kind: "home" | "system" | "workspace";
  }[]) =>
    feature.authorizeSetupInspection.execute({
      configurationSources: [],
      explicitExecutablePaths: [
        executable,
        newlineThenA,
        feminineOrdinal,
        backslashName,
        nestedPath,
      ],
      knownExecutableDirectories: [],
      observationEpoch: "epoch-display",
      pathEntries: [],
      platform: "darwin",
      roots: orderedRoots,
    });

  const [first, second] = await Promise.all([
    inspect(roots),
    inspect(roots.toReversed()),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.status, "authorized");
  if (first.status !== "authorized") {
    return;
  }
  const renderedLabels = first.installationCandidates.map(candidate => candidate.displayPath);
  assert.ok(renderedLabels.includes("$HOME/bin/co%{A}dex"));
  assert.ok(renderedLabels.includes("$HOME/bin/%{A}A"));
  assert.ok(renderedLabels.includes("$HOME/bin/%{AA}"));
  assert.ok(renderedLabels.includes("$HOME/bin/a%{5C}b"));
  assert.ok(renderedLabels.includes("$HOME/bin/a/b"));
  assert.equal(new Set(renderedLabels).size, renderedLabels.length);
  assert.equal(renderedLabels.some(label => label.includes(outer)), false);
  assert.equal(renderedLabels.some(label => label.includes(maliciousLabel)), false);
  assert.equal(renderedLabels.some(label => label.includes("\n")), false);
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

test("rejects hard-linked executable and configuration sources", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-setup-hardlink-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const executable = join(root, "codex");
  const executablePeer = join(root, "codex-peer");
  const configuration = join(root, "config.toml");
  const configurationPeer = join(root, "config-peer.toml");
  await writeFile(executable, "synthetic executable");
  await writeFile(configuration, "model = 'gpt-5.6-codex'\n");
  await link(executable, executablePeer);
  await link(configuration, configurationPeer);

  const feature = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: createNodePathCanonicalizer(),
  });
  const result = await feature.authorizeSetupInspection.execute({
    configurationSources: [{
      absolutePath: configuration,
      kind: "user",
      workspaceTrusted: true,
    }],
    explicitExecutablePaths: [executable],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-hardlink",
    pathEntries: [],
    platform: "darwin",
    roots: [{ absolutePath: root, kind: "home" }],
  });

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {
    return;
  }
  assert.deepEqual(result.installationCandidates, []);
  assert.deepEqual(result.configurationSources, []);
  assert.deepEqual(result.diagnostics, [
    { code: "path_outside_scope", subject: "$HOME/codex" },
    { code: "path_outside_scope", subject: "$HOME/config.toml" },
  ]);
});

test(
  "rejects a FIFO without blocking path authorization",
  { skip: process.platform === "win32" },
  async t => {
    const root = await mkdtemp(join(tmpdir(), "ar-setup-fifo-"));
    t.after(() => rm(root, { force: true, recursive: true }));
    const fifo = join(root, "codex");
    await execFile("mkfifo", [fifo]);

    const feature = createSetupInspectionAuthorizationFeature({
      pathCanonicalizer: createNodePathCanonicalizer(),
    });
    const result = await feature.authorizeSetupInspection.execute({
      configurationSources: [{
        absolutePath: fifo,
        kind: "user",
        workspaceTrusted: true,
      }],
      explicitExecutablePaths: [fifo],
      knownExecutableDirectories: [],
      observationEpoch: "epoch-fifo",
      pathEntries: [],
      platform: "darwin",
      roots: [{ absolutePath: root, kind: "home" }],
    });

    assert.equal(result.status, "authorized");
    if (result.status !== "authorized") {
      return;
    }
    assert.deepEqual(result.configurationSources, []);
    assert.deepEqual(result.installationCandidates, []);
    assert.equal(result.diagnostics.length, 2);
    assert.ok(result.diagnostics.every(item => item.code === "path_outside_scope"));
  },
);

test(
  "uses canonical containment when a trusted filesystem changes path casing",
  { skip: process.platform === "win32" },
  async () => {
  const lexicalRoot = "/Synthetic/Home";
  const lexicalCandidate = "/synthetic/home/bin/codex";
  const canonicalRoot = "/Synthetic/Home";
  const canonicalCandidate = "/Synthetic/Home/bin/codex";
  const feature = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path) {
        if (path === lexicalRoot) {
          return {
            absolutePath: canonicalRoot,
            canonicalLocationPath: canonicalRoot,
            exists: true,
            isFile: false,
          };
        }
        assert.equal(path, lexicalCandidate);
        return {
          absolutePath: canonicalCandidate,
          canonicalLocationPath: canonicalCandidate,
          exists: true,
          fileIdentity: "synthetic-file",
          isFile: true,
          linkCount: 1,
        };
      },
    },
  });

  const result = await feature.authorizeSetupInspection.execute({
    configurationSources: [],
    explicitExecutablePaths: [lexicalCandidate],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-case",
    pathEntries: [],
    platform: "darwin",
    roots: [{ absolutePath: lexicalRoot, kind: "home" }],
  });

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {
    return;
  }
  assert.equal(result.installationCandidates[0]?.displayPath, "$HOME/bin/codex");
  },
);

test(
  "does not confuse case-distinct sibling locations on a case-sensitive volume",
  { skip: process.platform === "win32" },
  async () => {
    const lexicalRoot = "/Synthetic/Home";
    const outsideAlias = "/Synthetic/home/codex";
    const canonicalTarget = "/Synthetic/Home/bin/codex";
    const feature = createSetupInspectionAuthorizationFeature({
      pathCanonicalizer: {
        async canonicalize(path) {
          if (path === lexicalRoot) {
            return {
              absolutePath: lexicalRoot,
              canonicalLocationPath: lexicalRoot,
              exists: true,
              isFile: false,
            };
          }
          assert.equal(path, outsideAlias);
          return {
            absolutePath: canonicalTarget,
            canonicalLocationPath: outsideAlias,
            exists: true,
            fileIdentity: "synthetic-file",
            isFile: true,
            linkCount: 1,
          };
        },
      },
    });

    const result = await feature.authorizeSetupInspection.execute({
      configurationSources: [],
      explicitExecutablePaths: [outsideAlias],
      knownExecutableDirectories: [],
      observationEpoch: "epoch-case-sensitive",
      pathEntries: [],
      platform: "darwin",
      roots: [{ absolutePath: lexicalRoot, kind: "home" }],
    });

    assert.equal(result.status, "authorized");
    if (result.status !== "authorized") {
      return;
    }
    assert.deepEqual(result.installationCandidates, []);
    assert.equal(result.diagnostics[0]?.code, "path_outside_scope");
  },
);
