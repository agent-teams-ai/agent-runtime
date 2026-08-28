import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNodeExecutableFileObserver,
  createRuntimeInstallationDiscoveryFeature,
} from "@agent-teams/agent-execution/composition";
import {
  createClaudeCodeConfigurationInspectionFeature,
  createClaudeCodeConfigurationSemanticClassifierV2,
  createClaudeCodeConfigurationSourceReaderAdapter,
  createNodeConfigurationSourceReader,
  createStrictClaudeCodeJsonParser,
} from "@agent-teams/runtime-configuration/composition";
import {
  createNodePathCanonicalizer,
  createSetupInspectionAuthorizationFeature,
} from "@agent-teams/runtime-security/composition";

import {
  createClaudeCodeSetupInspectionPlanner,
  createCodexSetupInspectionPlanner,
} from "../dist/composition.js";
import { createAgentRuntimeHost } from "./helpers/create-agent-runtime-host.ts";

export const semanticCorrectionProofsRegistered = true;

const unavailable = (): never => {
  throw new Error("dependency must not be reached");
};

const codexDependencies = Object.freeze({
  authorizeSetupInspection: { execute: unavailable },
  discoverCodexInstallations: { execute: unavailable },
  inspectCodexConfiguration: { execute: unavailable },
  planCodexSetupInspection: createCodexSetupInspectionPlanner("linux"),
});

const claudeScope = (homeRoot: string, workspaceRoot: string) => ({
  dialect: "claude-code-settings@2026-08-28" as const,
  explicitExecutablePaths: [],
  homeRoot,
  observationEpoch: "claude-epoch-1",
  pathEntries: [],
  scopeId: "claude-correction-scope",
  workspaceRoot,
  workspaceTrusted: true,
});

const emptyConfiguration = () => ({
  deferredObservations: [], diagnostics: [], observedPortableIntent: [],
  sourceModel: {
    claim: "observed-files-only" as const,
    classifierRevision: "claude-code-settings-2026-08-28-semantic-classifier/2",
    collectorRef: "collector-ref", compatibility: "unqualified" as const,
    contract: "claude-code-observed-source-plan/v1" as const,
    dialect: "claude-code-settings@2026-08-28" as const,
    precedence: "not-evaluated" as const, topologyRef: "topology-ref",
  },
  sources: [],
});

const runtimeScope = (root: string, setup: ReturnType<typeof claudeScope>) => ({
  claudeCodeSetup: setup,
  codexSetup: {
    configurationDialect: "codex-0.134" as const,
    configurationSources: [],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "codex-epoch",
    pathEntries: [],
    roots: [{ absolutePath: root, kind: "home" as const }],
    scopeId: "codex-correction-scope",
  },
});

const isSystemPath = (path: string): boolean =>
  path === "/opt/homebrew" || path.startsWith("/opt/homebrew/") ||
  path === "/usr/local" || path.startsWith("/usr/local/");

const createFourOwnerDependencies = () => {
  const nodeCanonicalizer = createNodePathCanonicalizer();
  const authorization = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path, options) {
        options?.signal?.throwIfAborted();
        if (path === "/opt/homebrew/bin/claude" || path === "/usr/local/bin/claude") {
          return {
            absolutePath: path,
            canonicalLocationPath: path,
            exists: true,
            fileIdentity: `system-file:${path}`,
            isFile: true,
            linkCount: 1,
          };
        }
        return isSystemPath(path)
          ? { absolutePath: path, canonicalLocationPath: path, exists: false }
          : nodeCanonicalizer.canonicalize(path, options);
      },
    },
  });
  const nodeObserver = createNodeExecutableFileObserver();
  const discovery = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      async observe(request) {
        request.signal?.throwIfAborted();
        if (request.absolutePath === "/opt/homebrew/bin/claude" || request.absolutePath === "/usr/local/bin/claude") {
          return { identity: `system-installation:${request.absolutePath}`, kind: "found" as const };
        }
        return nodeObserver.observe(request);
      },
    },
  });
  const configuration = createClaudeCodeConfigurationInspectionFeature({
    parser: createStrictClaudeCodeJsonParser(),
    semanticClassifier: createClaudeCodeConfigurationSemanticClassifierV2(),
    sourceIdentityKey: new Uint8Array(32).fill(11),
    sourceReader: createClaudeCodeConfigurationSourceReaderAdapter(
      createNodeConfigurationSourceReader(),
    ),
  });
  return {
    authorizeClaudeCodeSetupInspection: authorization.authorizeClaudeCodeSetupInspection,
    discoverClaudeCodeInstallations: discovery.discoverClaudeCodeInstallations,
    inspectClaudeCodeConfiguration: configuration,
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin"),
  };
};

test("keeps rejected higher source slots and simultaneous system locations across all four owners", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-precedence-e2e-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(join(home, ".claude"), { recursive: true }),
    mkdir(join(workspace, ".claude"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(home, ".claude", "settings.json"), JSON.stringify({
      effortLevel: "high",
      model: "sonnet",
    })),
    writeFile(join(workspace, ".claude", "settings.json"), "untrusted higher sentinel"),
    writeFile(join(workspace, ".claude", "settings.local.json"), "untrusted highest sentinel"),
  ]);
  const host = createAgentRuntimeHost({
    ...codexDependencies,
    ...createFourOwnerDependencies(),
  });
  t.after(() => host.dispose());
  const setup = { ...claudeScope(home, workspace), workspaceTrusted: false };
  const result = await host.bindAccess(runtimeScope(root, setup)).claudeCodeSetup.inspect();

  assert.equal(result.status, "partial", JSON.stringify(result));
  if (result.status !== "partial") {
    return;
  }
  assert.deepEqual(result.observedPortableIntent.map(intent => intent.key === "model"
    ? { key: intent.key, selection: intent.selection }
    : { key: intent.key, value: intent.value }), [
    { key: "effortLevel", value: "high" },
    { key: "model", selection: { kind: "alias", value: "sonnet" } },
  ]);
  const userSourceRef = result.sourceObservations.find(source => source.role === "user")?.sourceRef;
  assert.ok(result.observedPortableIntent.every(intent => intent.sourceRef === userSourceRef));
  assert.deepEqual(result.sourceObservations.map(source => [source.role, source.status]).toSorted(), [
    ["project-local", "rejected"],
    ["shared-project", "rejected"],
    ["user", "applied"],
  ]);
  assert.deepEqual(
    result.installations.map(installation => installation.aliases[0]?.displayPath),
    ["$HOMEBREW/bin/claude", "$LOCAL/bin/claude"],
  );
  assert.notEqual(result.installations[0]?.installationRef,
    result.installations[1]?.installationRef);
  assert.doesNotMatch(JSON.stringify(result), /untrusted (?:higher|highest) sentinel/u);
});

test("isolates cancellation between two concurrent Claude callers", async t => {
  let starts = 0;
  let allStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => {
    allStarted = resolve;
  });
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const waitForOwner = async (options?: { readonly signal?: AbortSignal }): Promise<void> => {
    starts += 1;
    if (starts === 4) {
      allStarted?.();
    }
    const signal = options?.signal;
    signal?.throwIfAborted();
    await Promise.race([
      gate,
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
    signal?.throwIfAborted();
  };
  const host = createAgentRuntimeHost({
    ...codexDependencies,
    authorizeClaudeCodeSetupInspection: {
      async execute() {
        return {
          canonicalRoots: [],
          diagnostics: [],
          executableCandidates: [],
          observationEpoch: "claude-epoch-1",
          sources: [],
          status: "authorized" as const,
        };
      },
    },
    discoverClaudeCodeInstallations: {
      async execute(_input, options) {
        await waitForOwner(options);
        return { diagnostics: [], installations: [] };
      },
    },
    inspectClaudeCodeConfiguration: {
      async execute(_input, options) {
        await waitForOwner(options);
        return emptyConfiguration();
      },
    },
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin"),
  });
  t.after(() => host.dispose());
  const access = host.bindAccess(runtimeScope(
    "/synthetic",
    claudeScope("/synthetic/home", "/synthetic/workspace"),
  ));
  const firstController = new AbortController();
  const first = access.claudeCodeSetup.inspect({ signal: firstController.signal });
  const second = access.claudeCodeSetup.inspect();
  await started;
  firstController.abort(new DOMException("cancel first Claude caller", "AbortError"));
  await assert.rejects(first, { name: "AbortError" });
  release?.();
  assert.equal((await second).status, "observed");
});

test("settles symmetric owner failures and reports them in stable sibling order", async t => {
  const createFailureHost = (discoveryFailure: boolean, configurationFailure: boolean) =>
    createAgentRuntimeHost({
      ...codexDependencies,
      authorizeClaudeCodeSetupInspection: {
        async execute() {
          return {
            canonicalRoots: [],
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
          if (discoveryFailure) {
            throw new Error("symmetric discovery failure");
          }
          return { diagnostics: [], installations: [] };
        },
      },
      inspectClaudeCodeConfiguration: {
        async execute() {
          if (configurationFailure) {
            throw new Error("symmetric configuration failure");
          }
          return emptyConfiguration();
        },
      },
      planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin"),
    });
  const configurationFailureHost = createFailureHost(false, true);
  const siblingFailureHost = createFailureHost(true, true);
  t.after(() => Promise.all([
    configurationFailureHost.dispose(),
    siblingFailureHost.dispose(),
  ]));
  const scope = runtimeScope(
    "/synthetic",
    claudeScope("/synthetic/home", "/synthetic/workspace"),
  );

  await assert.rejects(
    configurationFailureHost.bindAccess(scope).claudeCodeSetup.inspect(),
    /symmetric configuration failure/u,
  );
  await assert.rejects(
    siblingFailureHost.bindAccess(scope).claudeCodeSetup.inspect(),
    /symmetric discovery failure/u,
  );
});
