import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNodeExecutableFileObserver,
  createRuntimeInstallationDiscoveryFeature,
} from "@agent-teams/agent-execution/composition";
import {
  createClaudeCodeConfigurationInspectionFeature,
  createClaudeCodeConfigurationSemanticClassifierV1,
  createClaudeCodeConfigurationSourceReaderAdapter,
  createNodeConfigurationSourceReader,
  createStrictClaudeCodeJsonParser,
} from "@agent-teams/runtime-configuration/composition";
import {
  createNodePathCanonicalizer,
  createSetupInspectionAuthorizationFeature,
} from "@agent-teams/runtime-security/composition";

import {
  createAgentRuntimeHost,
  createClaudeCodeSetupInspectionPlanner,
  createCodexSetupInspectionPlanner,
} from "../dist/composition.js";

const unavailable = (): never => {
  throw new Error("dependency must not be reached");
};

const codexDependencies = Object.freeze({
  authorizeSetupInspection: { execute: unavailable },
  discoverCodexInstallations: { execute: unavailable },
  inspectCodexConfiguration: { execute: unavailable },
  planCodexSetupInspection: createCodexSetupInspectionPlanner("linux"),
});

const runtimeScope = (
  root: string,
  claudeCodeSetup: {
    readonly dialect: "claude-code-settings@2026-08-28";
    readonly explicitExecutablePaths: readonly string[];
    readonly homeRoot: string;
    readonly observationEpoch: string;
    readonly pathEntries: readonly string[];
    readonly scopeId: string;
    readonly workspaceRoot: string;
    readonly workspaceTrusted: boolean;
  },
) => ({
  claudeCodeSetup,
  configurationDialect: "codex-0.134" as const,
  configurationSources: [],
  explicitCodexExecutablePaths: [],
  knownExecutableDirectories: [],
  observationEpoch: "codex-epoch",
  pathEntries: [],
  roots: [{ absolutePath: root, kind: "home" as const }],
  scopeId: "codex-scope",
});

const claudeScope = (homeRoot: string, workspaceRoot: string) => ({
  dialect: "claude-code-settings@2026-08-28" as const,
  explicitExecutablePaths: [],
  homeRoot,
  observationEpoch: "claude-epoch-1",
  pathEntries: [],
  scopeId: "claude-scope-1",
  workspaceRoot,
  workspaceTrusted: true,
});

const isDeeplyFrozen = (value: unknown): boolean =>
  typeof value !== "object" || value === null ||
  (Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen));

test("crosses all four owner layers for a synthetic macOS setup without executing Claude", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-setup-e2e-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const executable = join(home, ".local", "bin", "claude");
  await Promise.all([
    mkdir(join(home, ".local", "bin"), { recursive: true }),
    mkdir(join(home, ".claude"), { recursive: true }),
    mkdir(join(workspace, ".claude"), { recursive: true }),
  ]);
  await writeFile(executable, "synthetic provider bytes that must never execute");
  await chmod(executable, 0o755);
  await Promise.all([
    writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ model: "sonnet" })),
    writeFile(join(workspace, ".claude", "settings.json"), JSON.stringify({ effortLevel: "low" })),
    writeFile(join(workspace, ".claude", "settings.local.json"), JSON.stringify({ effortLevel: "high" })),
  ]);

  const nodeCanonicalizer = createNodePathCanonicalizer();
  const syntheticSystemPath = (path: string): boolean =>
    path === "/opt/homebrew" || path.startsWith("/opt/homebrew/") ||
    path === "/usr/local" || path.startsWith("/usr/local/");
  const security = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path, options) {
        options?.signal?.throwIfAborted();
        return syntheticSystemPath(path)
          ? { absolutePath: path, canonicalLocationPath: path, exists: false }
          : nodeCanonicalizer.canonicalize(path, options);
      },
    },
  });
  const nodeExecutableObserver = createNodeExecutableFileObserver();
  const execution = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      async observe(path, expectedPath, identity, custodyRoot, options) {
        options?.signal?.throwIfAborted();
        return syntheticSystemPath(path)
          ? { kind: "missing" as const }
          : nodeExecutableObserver.observe(
            path,
            expectedPath,
            identity,
            custodyRoot,
            options,
          );
      },
    },
  });
  const sourceReader = createNodeConfigurationSourceReader();
  const configuration = createClaudeCodeConfigurationInspectionFeature({
    parser: createStrictClaudeCodeJsonParser(),
    semanticClassifier: createClaudeCodeConfigurationSemanticClassifierV1(),
    sourceIdentityKey: new Uint8Array(32).fill(7),
    sourceReader: createClaudeCodeConfigurationSourceReaderAdapter(sourceReader),
  });
  const host = createAgentRuntimeHost({
    ...codexDependencies,
    authorizeClaudeCodeSetupInspection: security.authorizeClaudeCodeSetupInspection,
    discoverClaudeCodeInstallations: execution.discoverClaudeCodeInstallations,
    inspectClaudeCodeConfiguration: configuration,
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin"),
  });
  t.after(() => host.dispose());
  const access = host.bindAccess(runtimeScope(root, claudeScope(home, workspace)));

  const first = await access.claudeCodeSetup.inspect();
  const second = await access.claudeCodeSetup.inspect();
  assert.deepEqual(first, second);
  assert.ok(isDeeplyFrozen(first));
  assert.equal(first.status, "observed", JSON.stringify(first));
  if (first.status === "denied" || first.status === "unsupported") return;
  assert.equal(first.installations.length, 1);
  assert.equal(first.installations[0]?.status, "found_unverified");
  assert.deepEqual(first.portableIntent.map(item => [item.key, item.value]), [
    ["effortLevel", "high"],
    ["model", "sonnet"],
  ]);
  assert.deepEqual(first.expectedLimitations, {
    interactiveShellPath: "unobserved",
    managedPolicy: "unobserved",
    sessionOverrides: "unobserved",
  });
  assert.deepEqual(first.nextActions, []);
  assert.equal(await access.codexSetup.inspect({}).then(result => result.status), "unsupported");
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, new RegExp(root, "u"));
  assert.doesNotMatch(serialized, /synthetic provider bytes/u);
  assert.match(first.observationRef, /^claude-code-setup-observation:[a-f0-9]{64}$/u);
  assert.match(first.installations[0]?.installationRef ?? "", /^claude-code-setup-installation:[a-f0-9]{64}$/u);
  for (const source of first.sourceObservations) {
    assert.match(source.sourceRef, /^claude-code-setup-source:[a-f0-9]{64}$/u);
  }
});

test("returns unsupported and denied before downstream filesystem work", async t => {
  const scope = runtimeScope("/synthetic", claudeScope("/synthetic/home", "/synthetic/workspace"));
  const unsupportedHost = createAgentRuntimeHost({
    ...codexDependencies,
    authorizeClaudeCodeSetupInspection: { execute: unavailable },
    discoverClaudeCodeInstallations: { execute: unavailable },
    inspectClaudeCodeConfiguration: { execute: unavailable },
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("linux"),
  });
  t.after(() => unsupportedHost.dispose());
  assert.deepEqual(await unsupportedHost.bindAccess(scope).claudeCodeSetup.inspect(), {
    diagnostics: [],
    expectedLimitations: {
      interactiveShellPath: "unobserved",
      managedPolicy: "unobserved",
      sessionOverrides: "unobserved",
    },
    status: "unsupported",
  });

  const deniedHost = createAgentRuntimeHost({
    ...codexDependencies,
    authorizeClaudeCodeSetupInspection: {
      async execute() {
        return {
          diagnostics: [{ code: "source_epoch_stale" as const, safeRef: "scope" }],
          status: "denied" as const,
        };
      },
    },
    discoverClaudeCodeInstallations: { execute: unavailable },
    inspectClaudeCodeConfiguration: { execute: unavailable },
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin"),
  });
  t.after(() => deniedHost.dispose());
  assert.equal(await deniedHost.bindAccess(scope).claudeCodeSetup.inspect().then(result => result.status), "denied");
});

test("waits for both parallel owner branches and HMAC-maps candidate diagnostics", async t => {
  let releaseConfiguration: (() => void) | undefined;
  const configurationGate = new Promise<void>(resolve => { releaseConfiguration = resolve; });
  let configurationSettled = false;
  const host = createAgentRuntimeHost({
    ...codexDependencies,
    authorizeClaudeCodeSetupInspection: {
      async execute() {
        return {
          diagnostics: [],
          executableCandidates: [],
          observationEpoch: "epoch",
          sources: [],
          status: "authorized" as const,
        };
      },
    },
    discoverClaudeCodeInstallations: {
      async execute() {
        throw new Error("synthetic discovery failure");
      },
    },
    inspectClaudeCodeConfiguration: {
      async execute() {
        await configurationGate;
        configurationSettled = true;
        return { diagnostics: [], portableIntent: [], sources: [] };
      },
    },
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin"),
  });
  t.after(() => host.dispose());
  const inspection = host.bindAccess(runtimeScope("/synthetic", claudeScope("/synthetic/home", "/synthetic/workspace"))).claudeCodeSetup.inspect();
  let inspectionSettled = false;
  inspection.then(
    () => { inspectionSettled = true; },
    () => { inspectionSettled = true; },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(inspectionSettled, false);
  releaseConfiguration?.();
  await assert.rejects(inspection, /synthetic discovery failure/u);
  assert.equal(configurationSettled, true);

  const diagnosticHost = createAgentRuntimeHost({
    ...codexDependencies,
    authorizeClaudeCodeSetupInspection: {
      async execute() {
        return { diagnostics: [], executableCandidates: [], observationEpoch: "epoch", sources: [], status: "authorized" as const };
      },
    },
    discoverClaudeCodeInstallations: {
      async execute() {
        return { diagnostics: [{ code: "candidate_invalid" as const, candidateRef: "internal/raw/candidate" }], installations: [] };
      },
    },
    inspectClaudeCodeConfiguration: {
      async execute() { return { diagnostics: [], portableIntent: [], sources: [] }; },
    },
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin"),
  });
  t.after(() => diagnosticHost.dispose());
  const diagnostic = await diagnosticHost.bindAccess(runtimeScope("/synthetic", claudeScope("/synthetic/home", "/synthetic/workspace"))).claudeCodeSetup.inspect();
  assert.equal(diagnostic.status, "partial");
  assert.doesNotMatch(JSON.stringify(diagnostic), /internal\/raw\/candidate/u);
  assert.match(diagnostic.diagnostics[0]?.safeRef ?? "", /^claude-code-setup-installation:[a-f0-9]{64}$/u);
});

test("isolates caller cancellation and invalidates Claude handles on bounded idempotent disposal", async () => {
  let branchCalls = 0;
  const cancellable = async (_input: unknown, options?: { readonly signal?: AbortSignal }) => {
    branchCalls += 1;
    if (branchCalls > 2) return;
    const signal = options?.signal;
    signal?.throwIfAborted();
    await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const host = createAgentRuntimeHost({
    ...codexDependencies,
    authorizeClaudeCodeSetupInspection: {
      async execute() {
        return { diagnostics: [], executableCandidates: [], observationEpoch: "epoch", sources: [], status: "authorized" as const };
      },
    },
    discoverClaudeCodeInstallations: {
      async execute(input, options) {
        await cancellable(input, options);
        return { diagnostics: [], installations: [] };
      },
    },
    inspectClaudeCodeConfiguration: {
      async execute(input, options) {
        await cancellable(input, options);
        return { diagnostics: [], portableIntent: [], sources: [] };
      },
    },
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin"),
  });
  const access = host.bindAccess(runtimeScope("/synthetic", claudeScope("/synthetic/home", "/synthetic/workspace")));
  const controller = new AbortController();
  const cancelled = access.claudeCodeSetup.inspect({ signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  const recovered = await access.claudeCodeSetup.inspect();
  assert.equal(recovered.status, "observed");

  branchCalls = 0;
  const inFlight = access.claudeCodeSetup.inspect();
  await Promise.resolve();
  const firstDisposal = host.dispose();
  const secondDisposal = host.dispose();
  assert.strictEqual(firstDisposal, secondDisposal);
  await assert.rejects(inFlight, { name: "AbortError" });
  await firstDisposal;
  await assert.rejects(access.claudeCodeSetup.inspect(), /Host is disposed/u);
  assert.throws(
    () => host.bindAccess(runtimeScope("/synthetic", claudeScope("/synthetic/home", "/synthetic/workspace"))),
    /Host is disposed/u,
  );
});
