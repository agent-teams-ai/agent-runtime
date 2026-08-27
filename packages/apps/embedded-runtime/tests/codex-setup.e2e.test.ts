import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  AgentRuntimeHostDisposalIncompleteError,
  createAgentRuntimeHost,
  createCodexSetupInspectionPlanner,
  createDefaultAgentRuntimeHost,
} from "../dist/composition.js";

const isDeeplyFrozen = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) {
    return true;
  }
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
};

const supportedInspectionPlanner = createCodexSetupInspectionPlanner("darwin");
const unavailableInspectionDependency = (): never => {
  throw new Error("unsupported platform must not reach inspection dependencies");
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
      "personality = 'friendly'",
      "api_key = 'public-placeholder-value'",
    ].join("\n"),
  );
  await writeFile(
    join(home, ".codex", "research.config.toml"),
    "model_reasoning_effort = 'high'\n",
  );
  await writeFile(
    join(workspace, ".codex", "config.toml"),
    "personality = 'pragmatic'\n",
  );

  const host = createDefaultAgentRuntimeHost();
  t.after(() => host.dispose());
  const access = host.bindAccess({
    configurationDialect: "codex-0.134",
    configurationSources: [
      { absolutePath: join(home, ".codex", "config.toml"), kind: "user", workspaceTrusted: true },
      { absolutePath: join(home, ".codex", "research.config.toml"), kind: "external-profile", profileName: "research", workspaceTrusted: true },
      { absolutePath: join(workspace, ".codex", "config.toml"), kind: "workspace", workspaceTrusted: true },
    ],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [aliasBin],
    observationEpoch: "synthetic-epoch-1",
    pathEntries: [bin],
    roots: [
      { absolutePath: home, kind: "home" },
      { absolutePath: workspace, kind: "workspace" },
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
    { key: "model_reasoning_effort", sourceRef: first.sources.find(source => source.kind === "external-profile")?.sourceRef, value: "high" },
    { key: "personality", sourceRef: first.sources.find(source => source.kind === "workspace")?.sourceRef, value: "pragmatic" },
  ]);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, new RegExp(root, "u"));
  assert.doesNotMatch(serialized, /public-placeholder-value/u);
  assert.match(serialized, /\$HOME/u);
  assert.match(serialized, /secret_setting_ignored/u);
  },
);

test(
  "scope binding is copied, cancellation is local, and disposal invalidates handles",
  { skip: process.platform !== "darwin" },
  async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-scope-e2e-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const mutableEntries = [join(root, "bin")];
  await mkdir(mutableEntries[0]!, { recursive: true });
  const host = createDefaultAgentRuntimeHost();
  const access = host.bindAccess({
    configurationDialect: "codex-0.134",
    configurationSources: [],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: mutableEntries,
    roots: [{ absolutePath: root, kind: "home" }],
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
      configurationDialect: "codex-0.134",
      configurationSources: [],
      explicitCodexExecutablePaths: [],
      knownExecutableDirectories: [],
      observationEpoch: "epoch-2",
      pathEntries: [],
      roots: [],
      scopeId: "scope-2",
    }),
    /Host is disposed/u,
  );
  },
);

test(
  "canonicalizes diagnostics and recommends reviewing an invalid native profile",
  { skip: process.platform !== "darwin" },
  async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-diagnostics-e2e-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const config = join(root, "config.toml");
  await writeFile(config, "model = [\n");

  const host = createDefaultAgentRuntimeHost();
  t.after(() => host.dispose());
  const access = host.bindAccess({
    configurationDialect: "codex-0.134",
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
    roots: [{ absolutePath: root, kind: "home" }],
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
  },
);

test("host-owned platform support and denied scopes fail closed", async t => {
  const scope = {
    configurationDialect: "codex-0.134",
    configurationSources: [],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: [],
    roots: [],
    scopeId: "scope-platform",
  } as const;
  const unsupportedHost = createAgentRuntimeHost({
    authorizeSetupInspection: { execute: unavailableInspectionDependency },
    discoverCodexInstallations: { execute: unavailableInspectionDependency },
    inspectCodexConfiguration: { execute: unavailableInspectionDependency },
    planCodexSetupInspection: createCodexSetupInspectionPlanner("linux"),
  });
  t.after(() => unsupportedHost.dispose());
  assert.deepEqual(await unsupportedHost.bindAccess(scope).codexSetup.inspect({}), {
    diagnostics: [],
    status: "unsupported",
  });

  const deniedHost = createAgentRuntimeHost({
    authorizeSetupInspection: {
      async execute() {
        return {
          diagnostics: [{ code: "path_outside_scope", subject: "scope" }],
          status: "denied" as const,
        };
      },
    },
    discoverCodexInstallations: { execute: unavailableInspectionDependency },
    inspectCodexConfiguration: { execute: unavailableInspectionDependency },
    planCodexSetupInspection: supportedInspectionPlanner,
  });
  t.after(() => deniedHost.dispose());
  assert.deepEqual(await deniedHost.bindAccess(scope).codexSetup.inspect({}), {
    diagnostics: [{ code: "path_outside_scope", subject: "scope" }],
    status: "denied",
  });
});

test("snapshots getter-backed input and revokes an in-flight inspection on disposal", async () => {
  let releaseAuthorization: (() => void) | undefined;
  const authorizationGate = new Promise<void>(resolve => {
    releaseAuthorization = resolve;
  });
  const host = createAgentRuntimeHost({
    planCodexSetupInspection: supportedInspectionPlanner,
    authorizeSetupInspection: {
      async execute() {
        await authorizationGate;
        return {
          configurationDialect: "codex-0.134",
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
    configurationDialect: "codex-0.134",
    configurationSources: [],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: [],
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

test("caller cancellation revokes an in-flight inspection even when a dependency ignores it", async t => {
  let discoveryCalls = 0;
  let configurationCalls = 0;
  let releaseAuthorization: (() => void) | undefined;
  const authorizationGate = new Promise<void>(resolve => {
    releaseAuthorization = resolve;
  });
  const host = createAgentRuntimeHost({
    planCodexSetupInspection: supportedInspectionPlanner,
    authorizeSetupInspection: {
      async execute() {
        await authorizationGate;
        return {
          configurationDialect: "codex-0.134",
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
        discoveryCalls += 1;
        return { diagnostics: [], installations: [], observationEpoch: "epoch-1" };
      },
    },
    inspectCodexConfiguration: {
      async execute() {
        configurationCalls += 1;
        return { diagnostics: [], settings: [], sources: [] };
      },
    },
  });
  t.after(() => host.dispose());
  const access = host.bindAccess({
    configurationDialect: "codex-0.134",
    configurationSources: [],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: [],
    roots: [],
    scopeId: "scope-caller-abort",
  });
  const controller = new AbortController();
  const inspection = access.codexSetup.inspect({}, { signal: controller.signal });
  await Promise.resolve();
  controller.abort(new DOMException("caller cancelled", "AbortError"));
  try {
    await assert.rejects(
      Promise.race([
        inspection,
        delay(100, null, { ref: false }).then(() => {
          throw new Error("cancelled inspection remained pending");
        }),
      ]),
      { name: "AbortError" },
    );
  } finally {
    releaseAuthorization?.();
  }
  await host.dispose();
  assert.equal(discoveryCalls, 0);
  assert.equal(configurationCalls, 0);
});

test("disposal tracks every parallel branch after a sibling rejects", async () => {
  let configurationStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => {
    configurationStarted = resolve;
  });
  let releaseConfiguration: (() => void) | undefined;
  const configurationGate = new Promise<void>(resolve => {
    releaseConfiguration = resolve;
  });
  const host = createAgentRuntimeHost({
    planCodexSetupInspection: supportedInspectionPlanner,
    authorizeSetupInspection: {
      async execute() {
        return {
          configurationDialect: "codex-0.134",
          configurationSources: [],
          diagnostics: [],
          installationCandidates: [],
          observationEpoch: "epoch-1",
          status: "authorized" as const,
        };
      },
    },
    discoverCodexInstallations: {
      async execute(_input, options) {
        return new Promise<never>((_resolve, reject) => {
          const abort = (): void => reject(
            options?.signal?.reason ?? new DOMException("cancelled", "AbortError"),
          );
          if (options?.signal?.aborted === true) {
            abort();
            return;
          }
          options?.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    },
    inspectCodexConfiguration: {
      async execute() {
        configurationStarted?.();
        await configurationGate;
        return { diagnostics: [], settings: [], sources: [] };
      },
    },
  });
  const access = host.bindAccess({
    configurationDialect: "codex-0.134",
    configurationSources: [],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: [],
    roots: [],
    scopeId: "scope-parallel-drain",
  });
  const controller = new AbortController();
  const inspection = access.codexSetup.inspect({}, { signal: controller.signal });
  await started;
  controller.abort(new DOMException("caller cancelled", "AbortError"));
  await assert.rejects(inspection, { name: "AbortError" });

  let disposalSettled = false;
  const disposal = host.dispose().then(() => {
    disposalSettled = true;
    return null;
  });
  await delay(25);
  assert.equal(disposalSettled, false);
  releaseConfiguration?.();
  await disposal;
  assert.equal(disposalSettled, true);
});

test("disposal remains bounded when a dependency never settles", async () => {
  let configurationStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => {
    configurationStarted = resolve;
  });
  const host = createAgentRuntimeHost({
    planCodexSetupInspection: supportedInspectionPlanner,
    authorizeSetupInspection: {
      async execute() {
        return {
          configurationDialect: "codex-0.134",
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
        return { diagnostics: [], installations: [], observationEpoch: "epoch-1" };
      },
    },
    inspectCodexConfiguration: {
      async execute() {
        configurationStarted?.();
        return new Promise<never>(() => {
          // Synthetic non-cooperative dependency used to prove the disposal deadline.
        });
      },
    },
  });
  const access = host.bindAccess({
    configurationDialect: "codex-0.134",
    configurationSources: [],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: [],
    roots: [],
    scopeId: "scope-bounded-disposal",
  });
  const inspection = access.codexSetup.inspect({});
  await started;
  const disposal = host.dispose();
  await assert.rejects(inspection, { name: "AbortError" });
  await assert.rejects(
    Promise.race([
      disposal,
      delay(1_500, null, { ref: false }).then(() => {
        throw new Error("Host disposal exceeded its deadline");
      }),
    ]),
    error =>
      error instanceof AgentRuntimeHostDisposalIncompleteError &&
      error.activeCallCount === 1,
  );
  await assert.rejects(host.dispose(), AgentRuntimeHostDisposalIncompleteError);
});

test("a synchronous branch throw cannot escape parallel drain custody", async () => {
  let installationStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => {
    installationStarted = resolve;
  });
  let rejectInstallation: (() => void) | undefined;
  const synchronousFailure = new Error("synthetic synchronous validation failure");
  const host = createAgentRuntimeHost({
    planCodexSetupInspection: supportedInspectionPlanner,
    authorizeSetupInspection: {
      async execute() {
        return {
          configurationDialect: "codex-0.134",
          configurationSources: [],
          diagnostics: [],
          installationCandidates: [],
          observationEpoch: "epoch-1",
          status: "authorized" as const,
        };
      },
    },
    discoverCodexInstallations: {
      execute() {
        installationStarted?.();
        return new Promise<never>((_resolve, reject) => {
          rejectInstallation = () => reject(new Error("synthetic late sibling failure"));
        });
      },
    },
    inspectCodexConfiguration: {
      execute() {
        throw synchronousFailure;
      },
    },
  });
  const access = host.bindAccess({
    configurationDialect: "codex-0.134",
    configurationSources: [],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: [],
    roots: [],
    scopeId: "scope-synchronous-throw",
  });
  const controller = new AbortController();
  const inspection = access.codexSetup.inspect({}, { signal: controller.signal });
  await started;
  controller.abort(new DOMException("caller cancelled", "AbortError"));
  await assert.rejects(inspection, { name: "AbortError" });

  let disposalSettled = false;
  const disposal = host.dispose().then(() => {
    disposalSettled = true;
    return null;
  });
  await delay(25);
  assert.equal(disposalSettled, false);
  rejectInstallation?.();
  await disposal;
  assert.equal(disposalSettled, true);
});

test("product installation references are stable within and isolated across trusted scopes", async t => {
  const host = createAgentRuntimeHost({
    planCodexSetupInspection: supportedInspectionPlanner,
    authorizeSetupInspection: {
      async execute(input) {
        return {
          configurationDialect: "codex-0.134",
          configurationSources: [],
          diagnostics: [],
          installationCandidates: [],
          observationEpoch: input.observationEpoch,
          status: "authorized" as const,
        };
      },
    },
    discoverCodexInstallations: {
      async execute(input) {
        return {
          diagnostics: [],
          installations: [{
            aliases: [{ displayPath: "$HOME/bin/codex", source: "path-entry" as const }],
            installationRef: "context-internal-file-identity",
            status: "found_unverified" as const,
          }],
          observationEpoch: input.observationEpoch,
        };
      },
    },
    inspectCodexConfiguration: {
      async execute() {
        return { diagnostics: [], settings: [], sources: [] };
      },
    },
  });
  t.after(() => host.dispose());
  const bind = (scopeId: string) => host.bindAccess({
    configurationDialect: "codex-0.134",
    configurationSources: [],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "epoch-1",
    pathEntries: [],
    roots: [{ absolutePath: "/synthetic-home", kind: "home" }],
    scopeId,
  });

  const first = await bind("scope-a").codexSetup.inspect({});
  const replay = await bind("scope-a").codexSetup.inspect({});
  const otherScope = await bind("scope-b").codexSetup.inspect({});
  assert.equal(first.status, "observed");
  assert.equal(replay.status, "observed");
  assert.equal(otherScope.status, "observed");
  if (first.status !== "observed" || replay.status !== "observed" || otherScope.status !== "observed") {
    return;
  }
  assert.equal(first.installations[0]?.installationRef, replay.installations[0]?.installationRef);
  assert.notEqual(first.installations[0]?.installationRef, otherScope.installations[0]?.installationRef);
  assert.doesNotMatch(JSON.stringify(first), /context-internal-file-identity/u);
});
