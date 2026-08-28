import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { semanticCorrectionProofsRegistered } from "./claude-code-semantic-correction.e2e.test.ts";

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

assert.equal(semanticCorrectionProofsRegistered, true);

const execFile = promisify(execFileCallback);

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

const syntheticSystemPath = (path: string): boolean =>
  path === "/opt/homebrew" || path.startsWith("/opt/homebrew/") ||
  path === "/usr/local" || path.startsWith("/usr/local/");

const createSyntheticClaudeOwners = (systemInstallations = false) => {
  const nodeCanonicalizer = createNodePathCanonicalizer();
  const security = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path, options) {
        options?.signal?.throwIfAborted();
        if (systemInstallations &&
          (path === "/opt/homebrew/bin/claude" || path === "/usr/local/bin/claude")) {
          return {
            absolutePath: path,
            canonicalLocationPath: path,
            exists: true,
            fileIdentity: `synthetic-system:${path}`,
            isFile: true,
            linkCount: 1,
          };
        }
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
        if (systemInstallations &&
          (path === "/opt/homebrew/bin/claude" || path === "/usr/local/bin/claude")) {
          return { identity: `system-installation:${path}`, kind: "found" as const };
        }
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
  return {
    authorizeClaudeCodeSetupInspection: security.authorizeClaudeCodeSetupInspection,
    discoverClaudeCodeInstallations: execution.discoverClaudeCodeInstallations,
    inspectClaudeCodeConfiguration: configuration,
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin"),
  };
};

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

  const host = createAgentRuntimeHost({
    ...codexDependencies,
    ...createSyntheticClaudeOwners(),
  });
  t.after(() => host.dispose());
  const access = host.bindAccess(runtimeScope(root, claudeScope(home, workspace)));

  const first = await access.claudeCodeSetup.inspect();
  const second = await access.claudeCodeSetup.inspect();
  assert.deepEqual(first, second);
  assert.ok(isDeeplyFrozen(first));
  assert.equal(first.status, "observed", JSON.stringify(first));
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
    diagnostics: [{ code: "unsupported_platform" }],
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

test("reports clean absence and degrades safely without touching the executable canary", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-setup-adversarial-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const executable = join(home, ".local", "bin", "claude");
  const executionCanary = join(root, "execution-canary");
  await Promise.all([
    mkdir(join(home, ".local", "bin"), { recursive: true }),
    mkdir(join(home, ".claude"), { recursive: true }),
    mkdir(join(workspace, ".claude"), { recursive: true }),
  ]);
  const host = createAgentRuntimeHost({
    ...codexDependencies,
    ...createSyntheticClaudeOwners(),
  });
  t.after(() => host.dispose());
  const access = host.bindAccess(runtimeScope(root, claudeScope(home, workspace)));

  const absent = await access.claudeCodeSetup.inspect();
  assert.equal(absent.status, "observed", JSON.stringify(absent));
  assert.deepEqual(absent.installations, []);
  assert.deepEqual(absent.portableIntent, []);
  assert.deepEqual(absent.sourceObservations.map(source => source.status), [
    "missing",
    "missing",
    "missing",
  ]);
  assert.deepEqual(absent.nextActions, ["install_claude_code"]);

  const executableBytes = `#!/bin/sh\nprintf touched > ${executionCanary}\n`;
  const secret = "sk-secret-sentinel-that-must-never-escape";
  await Promise.all([
    writeFile(executable, executableBytes),
    writeFile(join(home, ".claude", "settings.json"), JSON.stringify({
      apiKeyHelper: secret,
      env: { ANTHROPIC_BASE_URL: `https://canary.invalid/${secret}` },
      model: "sonnet",
    })),
    writeFile(join(workspace, ".claude", "settings.local.json"), "{ malformed"),
  ]);
  await chmod(executable, 0o755);

  const degraded = await access.claudeCodeSetup.inspect();
  assert.equal(degraded.status, "partial", JSON.stringify(degraded));
  assert.equal(degraded.installations[0]?.status, "found_unverified");
  assert.deepEqual(degraded.portableIntent, []);
  assert.ok(degraded.diagnostics.some(diagnostic =>
    diagnostic.code === "credential_material_rejected"));
  assert.ok(degraded.diagnostics.some(diagnostic =>
    diagnostic.code === "provider_route_deferred"));
  assert.ok(degraded.diagnostics.some(diagnostic =>
    diagnostic.code === "config_parse_failed"));
  const serialized = JSON.stringify(degraded);
  assert.doesNotMatch(serialized, new RegExp(root, "u"));
  assert.doesNotMatch(serialized, new RegExp(secret, "u"));
  assert.equal(await readFile(executable, "utf8"), executableBytes);
  await assert.rejects(readFile(executionCanary), { code: "ENOENT" });
});

test("traps fetch, DNS, HTTP(S), TCP/TLS, and datagram APIs in an isolated process", async () => {
  const helper = fileURLToPath(new URL(
    "./helpers/claude-network-trap-process.ts",
    import.meta.url,
  ));
  await execFile(process.execPath, [helper], {
    env: Object.freeze({ ...process.env, NODE_OPTIONS: "--no-warnings" }),
    timeout: 10_000,
  });
});

test("detaches owner results and domain-separates deterministic product references", async t => {
  const mutableAliases = [{ displayPath: "$HOME/bin/claude", source: "explicit" as const }];
  const mutableInstallations = [{
    aliases: mutableAliases,
    installationRef: "owner-installation-identity",
    status: "found_unverified" as const,
  }];
  const mutableSources = [{
    displayPath: "$HOME/.claude/settings.json",
    kind: "user" as const,
    sourceRef: "owner-source-identity",
    status: "applied" as const,
  }];
  const mutableIntent: Array<{
    key: "model";
    sourceRef: string;
    value: "opus" | "sonnet";
  }> = [{
    key: "model" as const,
    sourceRef: "owner-source-identity",
    value: "sonnet" as const,
  }];
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
        return { diagnostics: [], installations: mutableInstallations };
      },
    },
    inspectClaudeCodeConfiguration: {
      async execute() {
        return { diagnostics: [], portableIntent: mutableIntent, sources: mutableSources };
      },
    },
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin"),
  });
  t.after(() => host.dispose());
  const scope = runtimeScope(
    "/synthetic",
    claudeScope("/synthetic/home", "/synthetic/workspace"),
  );
  const access = host.bindAccess(scope);
  const first = await access.claudeCodeSetup.inspect();
  const replay = await access.claudeCodeSetup.inspect();
  assert.deepEqual(first, replay);
  assert.ok(isDeeplyFrozen(first));
  assert.equal(first.status, "observed");
  if (first.status !== "observed" || replay.status !== "observed") return;
  const references = [
    first.observationRef,
    first.installations[0]?.installationRef,
    first.sourceObservations[0]?.sourceRef,
  ];
  assert.equal(new Set(references).size, 3);
  assert.match(references[0] ?? "", /^claude-code-setup-observation:/u);
  assert.match(references[1] ?? "", /^claude-code-setup-installation:/u);
  assert.match(references[2] ?? "", /^claude-code-setup-source:/u);
  mutableAliases[0]!.displayPath = "mutated alias";
  mutableInstallations.length = 0;
  mutableSources[0]!.displayPath = "mutated source";
  mutableIntent[0]!.value = "opus";
  assert.equal(first.installations[0]?.aliases[0]?.displayPath, "$HOME/bin/claude");
  assert.equal(first.sourceObservations[0]?.displayPath, "$HOME/.claude/settings.json");
  assert.equal(first.portableIntent[0]?.value, "sonnet");

  const otherScope = runtimeScope("/synthetic", {
    ...claudeScope("/synthetic/home", "/synthetic/workspace"),
    scopeId: "other-claude-scope",
  });
  const isolated = await host.bindAccess(otherScope).claudeCodeSetup.inspect();
  assert.equal(isolated.status, "observed");
  if (isolated.status === "observed") {
    assert.notEqual(first.observationRef, isolated.observationRef);
  }
});

test("honors cancellation before and during every composition stage", async () => {
  const scope = runtimeScope(
    "/synthetic",
    claudeScope("/synthetic/home", "/synthetic/workspace"),
  );
  let plannerCalls = 0;
  const preCancelledHost = createAgentRuntimeHost({
    ...codexDependencies,
    authorizeClaudeCodeSetupInspection: { execute: unavailable },
    discoverClaudeCodeInstallations: { execute: unavailable },
    inspectClaudeCodeConfiguration: { execute: unavailable },
    planClaudeCodeSetupInspection: {
      plan() {
        plannerCalls += 1;
        return { status: "unsupported" as const };
      },
    },
  });
  const preCancelled = new AbortController();
  preCancelled.abort(new DOMException("cancelled before inspection", "AbortError"));
  await assert.rejects(
    preCancelledHost.bindAccess(scope).claudeCodeSetup.inspect({ signal: preCancelled.signal }),
    { name: "AbortError" },
  );
  assert.equal(plannerCalls, 0);
  await preCancelledHost.dispose();

  const plannerCancelled = new AbortController();
  let authorizationCalls = 0;
  const darwinPlanner = createClaudeCodeSetupInspectionPlanner("darwin");
  const plannerCancellationHost = createAgentRuntimeHost({
    ...codexDependencies,
    authorizeClaudeCodeSetupInspection: {
      async execute(_input, options) {
        authorizationCalls += 1;
        options?.signal?.throwIfAborted();
        throw new Error("aborted authorization must not continue");
      },
    },
    discoverClaudeCodeInstallations: { execute: unavailable },
    inspectClaudeCodeConfiguration: { execute: unavailable },
    planClaudeCodeSetupInspection: {
      plan() {
        plannerCancelled.abort(new DOMException("cancelled during planning", "AbortError"));
        return { status: "unsupported" as const };
      },
    },
  });
  await assert.rejects(
    plannerCancellationHost.bindAccess(scope).claudeCodeSetup.inspect({
      signal: plannerCancelled.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(authorizationCalls, 0);
  await plannerCancellationHost.dispose();

  let authorizationStarted: (() => void) | undefined;
  const authorizationStart = new Promise<void>(resolve => {
    authorizationStarted = resolve;
  });
  let releaseAuthorization: (() => void) | undefined;
  const authorizationGate = new Promise<void>(resolve => {
    releaseAuthorization = resolve;
  });
  let postAuthorizationCalls = 0;
  const authorizationHost = createAgentRuntimeHost({
    ...codexDependencies,
    authorizeClaudeCodeSetupInspection: {
      async execute() {
        authorizationStarted?.();
        await authorizationGate;
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
        postAuthorizationCalls += 1;
        return { diagnostics: [], installations: [] };
      },
    },
    inspectClaudeCodeConfiguration: {
      async execute() {
        postAuthorizationCalls += 1;
        return { diagnostics: [], portableIntent: [], sources: [] };
      },
    },
    planClaudeCodeSetupInspection: darwinPlanner,
  });
  const authorizationController = new AbortController();
  const duringAuthorization = authorizationHost.bindAccess(scope).claudeCodeSetup.inspect({
    signal: authorizationController.signal,
  });
  await authorizationStart;
  authorizationController.abort(new DOMException("cancelled during authorization", "AbortError"));
  await assert.rejects(duringAuthorization, { name: "AbortError" });
  releaseAuthorization?.();
  await authorizationHost.dispose();
  assert.equal(postAuthorizationCalls, 0);

  let branchStarts = 0;
  let branchesStarted: (() => void) | undefined;
  const branchStart = new Promise<void>(resolve => {
    branchesStarted = resolve;
  });
  let releaseBranches: (() => void) | undefined;
  const branchGate = new Promise<void>(resolve => {
    releaseBranches = resolve;
  });
  const waitInBranch = async (): Promise<void> => {
    branchStarts += 1;
    if (branchStarts === 2) branchesStarted?.();
    await branchGate;
  };
  const branchHost = createAgentRuntimeHost({
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
        await waitInBranch();
        return { diagnostics: [], installations: [] };
      },
    },
    inspectClaudeCodeConfiguration: {
      async execute() {
        await waitInBranch();
        return { diagnostics: [], portableIntent: [], sources: [] };
      },
    },
    planClaudeCodeSetupInspection: darwinPlanner,
  });
  const branchController = new AbortController();
  const duringBranches = branchHost.bindAccess(scope).claudeCodeSetup.inspect({
    signal: branchController.signal,
  });
  await branchStart;
  branchController.abort(new DOMException("cancelled during parallel owners", "AbortError"));
  await assert.rejects(duringBranches, { name: "AbortError" });
  let disposalSettled = false;
  const disposal = branchHost.dispose().then(() => {
    disposalSettled = true;
  });
  await Promise.resolve();
  assert.equal(disposalSettled, false);
  releaseBranches?.();
  await disposal;
});

test("runs Codex and Claude inspections concurrently without cross-cancellation", async t => {
  let ownerStarts = 0;
  let bothStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => {
    bothStarted = resolve;
  });
  let releaseOwners: (() => void) | undefined;
  const ownerGate = new Promise<void>(resolve => {
    releaseOwners = resolve;
  });
  const startOwner = async (): Promise<void> => {
    ownerStarts += 1;
    if (ownerStarts === 2) bothStarted?.();
    await ownerGate;
  };
  const host = createAgentRuntimeHost({
    authorizeSetupInspection: {
      async execute(input) {
        await startOwner();
        return {
          configurationDialect: "codex-0.134" as const,
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
          installations: [],
          observationEpoch: input.observationEpoch,
        };
      },
    },
    inspectCodexConfiguration: {
      async execute() {
        return { diagnostics: [], settings: [], sources: [] };
      },
    },
    planCodexSetupInspection: {
      plan() {
        return {
          diagnostics: [],
          installationCandidates: [],
          status: "planned" as const,
        };
      },
    },
    authorizeClaudeCodeSetupInspection: {
      async execute() {
        await startOwner();
        return {
          diagnostics: [],
          executableCandidates: [],
          observationEpoch: "claude-epoch-1",
          sources: [],
          status: "authorized" as const,
        };
      },
    },
    discoverClaudeCodeInstallations: {
      async execute() {
        return { diagnostics: [], installations: [] };
      },
    },
    inspectClaudeCodeConfiguration: {
      async execute() {
        return { diagnostics: [], portableIntent: [], sources: [] };
      },
    },
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin"),
  });
  t.after(() => host.dispose());
  const access = host.bindAccess(runtimeScope(
    "/synthetic",
    claudeScope("/synthetic/home", "/synthetic/workspace"),
  ));
  const cancelledClaude = new AbortController();
  const claudeInspection = access.claudeCodeSetup.inspect({ signal: cancelledClaude.signal });
  const codexInspection = access.codexSetup.inspect({});
  await started;
  cancelledClaude.abort(new DOMException("cancel only Claude", "AbortError"));
  await assert.rejects(claudeInspection, { name: "AbortError" });
  releaseOwners?.();
  const codex = await codexInspection;
  assert.ok(codex.status === "observed" || codex.status === "partial", JSON.stringify(codex));
  const recoveredClaude = await access.claudeCodeSetup.inspect();
  assert.equal(recoveredClaude.status, "observed");
});
