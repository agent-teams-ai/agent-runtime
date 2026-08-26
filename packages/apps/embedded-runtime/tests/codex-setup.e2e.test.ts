import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDefaultAgentRuntimeHost } from "../dist/composition.js";

const isDeeplyFrozen = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) {
    return true;
  }
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
};

test("inspects a synthetic Codex setup deterministically without leaking paths or secrets", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-setup-e2e-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "synthetic-home");
  const workspace = join(root, "synthetic-workspace");
  const bin = join(home, "bin");
  const aliasBin = join(home, "alias-bin");
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(aliasBin, { recursive: true }),
    mkdir(join(home, ".codex"), { recursive: true }),
    mkdir(join(workspace, ".codex"), { recursive: true }),
  ]);
  const executable = join(bin, "codex");
  await writeFile(executable, "synthetic executable - never run");
  await chmod(executable, 0o755);
  await symlink(executable, join(aliasBin, "codex"));
  await writeFile(
    join(home, ".codex", "config.toml"),
    [
      "model = 'gpt-5.6-codex'",
      "personality = 'concise'",
      "api_key = 'synthetic-secret-must-not-leak'",
      "[profiles.research]",
      "model_reasoning_effort = 'xhigh'",
    ].join("\n"),
  );
  await writeFile(
    join(workspace, ".codex", "config.toml"),
    "personality = 'pragmatic'\n",
  );

  const host = createDefaultAgentRuntimeHost();
  t.after(() => host.dispose());
  const access = host.bindAccess({
    configurationSources: [
      { absolutePath: join(home, ".codex", "config.toml"), kind: "user", precedence: 10, workspaceTrusted: true },
      { absolutePath: join(workspace, ".codex", "config.toml"), kind: "workspace", precedence: 20, workspaceTrusted: true },
    ],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [aliasBin],
    observationEpoch: "synthetic-epoch-1",
    pathEntries: [bin],
    platform: "darwin",
    roots: [
      { absolutePath: home, displayName: "$HOME", kind: "home" },
      { absolutePath: workspace, displayName: "$WORKSPACE", kind: "workspace" },
    ],
    scopeId: "synthetic-scope",
  });

  const first = await access.codexSetup.inspect({ nativeProfile: "research" });
  const second = await access.codexSetup.inspect({ nativeProfile: "research" });
  assert.deepEqual(first, second);
  assert.ok(isDeeplyFrozen(first));
  assert.equal(first.status, "partial");
  if (first.status === "denied" || first.status === "unsupported") {
    return;
  }
  assert.equal(first.installations.length, 1);
  assert.equal(first.installations[0]?.aliases.length, 2);
  assert.deepEqual(first.settings, [
    { key: "model", sourceRef: first.sources.find(source => source.kind === "user")?.sourceRef, value: "gpt-5.6-codex" },
    { key: "model_reasoning_effort", sourceRef: first.sources.find(source => source.kind === "user")?.sourceRef, value: "xhigh" },
    { key: "personality", sourceRef: first.sources.find(source => source.kind === "workspace")?.sourceRef, value: "pragmatic" },
  ]);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, new RegExp(root, "u"));
  assert.doesNotMatch(serialized, /synthetic-secret-must-not-leak/u);
  assert.match(serialized, /\$HOME/u);
  assert.match(serialized, /secret_setting_ignored/u);
});

test("scope binding is copied, cancellation is local, and disposal invalidates handles", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-scope-e2e-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const mutableEntries = [join(root, "bin")];
  await mkdir(mutableEntries[0]!, { recursive: true });
  const host = createDefaultAgentRuntimeHost();
  const access = host.bindAccess({
    configurationSources: [],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: mutableEntries,
    platform: "darwin",
    roots: [{ absolutePath: root, displayName: "$HOME", kind: "home" }],
    scopeId: "scope-1",
  });
  mutableEntries.push("relative-path-that-must-not-enter-bound-scope");

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    access.codexSetup.inspect({}, { signal: controller.signal }),
    { name: "AbortError" },
  );
  const result = await access.codexSetup.inspect({});
  assert.equal(result.status, "partial");
  assert.ok(!result.diagnostics.some(item => item.code === "relative_path_entry"));

  await host.dispose();
  await host.dispose();
  await assert.rejects(access.codexSetup.inspect({}), /Host is disposed/u);
  assert.throws(
    () => host.bindAccess({
      configurationSources: [],
      explicitCodexExecutablePaths: [],
      knownExecutableDirectories: [],
      observationEpoch: "epoch-2",
      pathEntries: [],
      platform: "darwin",
      roots: [],
      scopeId: "scope-2",
    }),
    /Host is disposed/u,
  );
});

test("unsupported and denied scopes fail closed", async t => {
  const host = createDefaultAgentRuntimeHost();
  t.after(() => host.dispose());
  const unsupported = host.bindAccess({
    configurationSources: [],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: [],
    platform: "linux",
    roots: [],
    scopeId: "scope-linux",
  });
  assert.deepEqual(await unsupported.codexSetup.inspect({}), {
    diagnostics: [],
    status: "unsupported",
  });

  const denied = host.bindAccess({
    configurationSources: [],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "",
    pathEntries: [],
    platform: "darwin",
    roots: [],
    scopeId: "scope-denied",
  });
  assert.equal((await denied.codexSetup.inspect({})).status, "denied");
});
