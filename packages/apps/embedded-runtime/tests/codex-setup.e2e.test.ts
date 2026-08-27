import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAgentRuntimeHost,
  createDefaultAgentRuntimeHost,
} from "../dist/composition.js";

const isDeeplyFrozen = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) {
    return true;
  }
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
};

test(
  "inspects a synthetic Codex setup deterministically without leaking paths or secrets",
  { skip: process.platform !== "darwin" },
  async t => {
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
      { absolutePath: join(home, ".codex", "config.toml"), kind: "user", workspaceTrusted: true },
      { absolutePath: join(workspace, ".codex", "config.toml"), kind: "workspace", workspaceTrusted: true },
    ],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [aliasBin],
    observationEpoch: "synthetic-epoch-1",
    pathEntries: [bin],
    platform: process.platform,
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
  },
);

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

test("canonicalizes diagnostics and recommends reviewing an invalid native profile", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-diagnostics-e2e-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const config = join(root, "config.toml");
  await writeFile(config, "model = [\n");

  const host = createDefaultAgentRuntimeHost();
  t.after(() => host.dispose());
  const access = host.bindAccess({
    configurationSources: [
      {
        absolutePath: config,
        kind: "user",
        workspaceTrusted: true,
      },
    ],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-diagnostics",
    pathEntries: [],
    platform: "darwin",
    roots: [{ absolutePath: root, displayName: "$HOME", kind: "home" }],
    scopeId: "scope-diagnostics",
  });

  const result = await access.codexSetup.inspect({ nativeProfile: "invalid profile" });
  assert.equal(result.status, "partial");
  if (result.status === "denied" || result.status === "unsupported") {
    return;
  }
  assert.deepEqual(
    result.diagnostics.map(item => item.code),
    ["config_parse_failed", "native_profile_invalid"],
  );
  assert.deepEqual(result.nextActions, ["install_codex", "review_configuration"]);
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

test("snapshots getter-backed input and revokes an in-flight inspection on disposal", async () => {
  let releaseAuthorization: (() => void) | undefined;
  const authorizationGate = new Promise<void>(resolve => {
    releaseAuthorization = resolve;
  });
  const host = createAgentRuntimeHost({
    authorizeSetupInspection: {
      async execute() {
        await authorizationGate;
        return {
          configurationSources: [],
          diagnostics: [],
          installationCandidates: [],
          observationEpoch: "epoch-1",
          status: "authorized" as const,
        };
      },
    },
    discoverCodexInstallations: {
      async execute() {
        return {
          diagnostics: [],
          installations: [],
          observationEpoch: "epoch-1",
        };
      },
    },
    inspectCodexConfiguration: {
      async execute() {
        return { diagnostics: [], settings: [], sources: [] };
      },
    },
  });
  const access = host.bindAccess({
    configurationSources: [],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: [],
    platform: "darwin",
    roots: [],
    scopeId: "scope-1",
  });
  let getterReads = 0;
  const input = Object.defineProperty({}, "nativeProfile", {
    enumerable: true,
    get() {
      getterReads += 1;
      return getterReads === 1 ? "invalid profile" : undefined;
    },
  });

  const inspection = access.codexSetup.inspect(input);
  await Promise.resolve();
  const disposal = host.dispose();
  releaseAuthorization?.();

  await assert.rejects(inspection, { name: "AbortError" });
  await disposal;
  assert.equal(getterReads, 1);
});
