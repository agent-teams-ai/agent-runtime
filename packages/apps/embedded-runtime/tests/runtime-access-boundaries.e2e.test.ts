import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentRuntimeHost,
  createDefaultAgentRuntimeHost,
  TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS,
} from "../dist/composition.js";

const expectedLimitations = {
  interactiveShellPath: "unobserved",
  managedPolicy: "unobserved",
  modelCompatibility: "unobserved",
  sessionOverrides: "unobserved",
} as const;

const emptyClaudeConfiguration = () => ({
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

const values = (length: number, prefix: string): string[] =>
  Array.from({ length }, (_, index) => `/${prefix}-${index}`);

const withMutatingLength = <T>(items: T[]): T[] => {
  let lengthReads = 0;
  return new Proxy(items, {
    get(target, property, receiver) {
      if (property === "length") {
        lengthReads += 1;
        return lengthReads === 1 ? target.length : target.length + 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
};

const runtimeScope = (withClaude = true) => ({
  ...(withClaude ? { claudeCodeSetup: {
    dialect: "claude-code-settings@2026-08-28" as const,
    explicitExecutablePaths: values(
      TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.claudeCodeSetup.explicitExecutablePaths,
      "claude-explicit",
    ),
    homeRoot: "/home",
    observationEpoch: "claude-epoch",
    pathEntries: values(
      TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.claudeCodeSetup.pathEntries,
      "claude-path",
    ),
    scopeId: "claude-scope",
    workspaceRoot: "/workspace",
    workspaceTrusted: true,
  } } : {}),
  configurationDialect: "codex-0.134" as const,
  configurationSources: Array.from(
    { length: TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.configurationSources },
    (_, index) => ({
      absolutePath: `/configuration-${index}`,
      kind: "user" as const,
      workspaceTrusted: true,
    }),
  ),
  explicitCodexExecutablePaths: values(
    TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.explicitExecutablePaths,
    "codex-explicit",
  ),
  knownExecutableDirectories: values(
    TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.knownExecutableDirectories,
    "codex-known",
  ),
  observationEpoch: "codex-epoch",
  pathEntries: values(TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.pathEntries, "codex-path"),
  roots: Array.from(
    { length: TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.roots },
    (_, index) => ({ absolutePath: `/root-${index}`, kind: "home" as const }),
  ),
  scopeId: "codex-scope",
});

const createDependencies = () => {
  const calls = {
    claudeAuthorization: 0,
    claudeConfiguration: 0,
    claudeDiscovery: 0,
    claudePlanner: 0,
    codexAuthorization: 0,
    codexConfiguration: 0,
    codexDiscovery: 0,
    codexPlanner: 0,
  };
  return {
    calls,
    dependencies: {
      authorizeClaudeCodeSetupInspection: {
        async execute() {
          calls.claudeAuthorization += 1;
          return {
            diagnostics: [], executableCandidates: [], observationEpoch: "claude-epoch",
            sources: [], status: "authorized" as const,
          };
        },
      },
      authorizeSetupInspection: {
        async execute() {
          calls.codexAuthorization += 1;
          return {
            configurationSources: [], diagnostics: [], installationCandidates: [],
            observationEpoch: "codex-epoch", status: "authorized" as const,
          };
        },
      },
      discoverClaudeCodeInstallations: {
        async execute() {
          calls.claudeDiscovery += 1;
          return { diagnostics: [], installations: [] };
        },
      },
      discoverCodexInstallations: {
        async execute() {
          calls.codexDiscovery += 1;
          return { diagnostics: [], installations: [] };
        },
      },
      inspectClaudeCodeConfiguration: {
        async execute() {
          calls.claudeConfiguration += 1;
          return emptyClaudeConfiguration();
        },
      },
      inspectCodexConfiguration: {
        async execute() {
          calls.codexConfiguration += 1;
          return { diagnostics: [], settings: [], sources: [] };
        },
      },
      planClaudeCodeSetupInspection: {
        plan() {
          calls.claudePlanner += 1;
          return {
            candidatePaths: [], dialect: "claude-code-settings@2026-08-28" as const,
            sourcePaths: [], status: "planned" as const,
          };
        },
      },
      planCodexSetupInspection: {
        plan() {
          calls.codexPlanner += 1;
          return { diagnostics: [], installationCandidates: [], status: "planned" as const };
        },
      },
    },
  };
};

const isDeeplyFrozen = (value: unknown): boolean =>
  typeof value !== "object" || value === null ||
  (Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen));

test("accepts every collection at its limit and reaches provider-specific owners", async t => {
  const { calls, dependencies } = createDependencies();
  const host = createAgentRuntimeHost(dependencies);
  t.after(() => host.dispose());
  const access = host.bindAccess(runtimeScope());

  assert.match((await access.codexSetup.inspect({})).status, /^(?:observed|partial)$/u);
  assert.match((await access.claudeCodeSetup.inspect()).status, /^(?:observed|partial)$/u);
  assert.deepEqual(Object.values(calls), Object.values(calls).map(() => 1));
});

test("returns frozen redacted overflow outcomes before any downstream call", async t => {
  const { calls, dependencies } = createDependencies();
  const host = createAgentRuntimeHost(dependencies);
  t.after(() => host.dispose());
  const scope = runtimeScope();
  scope.pathEntries.push("/sensitive-codex-overflow");
  scope.claudeCodeSetup?.explicitExecutablePaths.push("/sensitive-claude-overflow");
  const access = host.bindAccess(scope);

  const codex = await access.codexSetup.inspect({});
  const claude = await access.claudeCodeSetup.inspect();
  assert.deepEqual(codex, {
    diagnostics: [{ code: "access_scope_limit_exceeded" }],
    status: "unsupported",
  });
  assert.deepEqual(claude, {
    diagnostics: [{ code: "access_scope_limit_exceeded" }],
    expectedLimitations,
    status: "unsupported",
  });
  assert.ok(isDeeplyFrozen(codex) && isDeeplyFrozen(claude));
  assert.deepEqual(Object.values(calls), Object.values(calls).map(() => 0));
  assert.doesNotMatch(JSON.stringify([codex, claude]), /sensitive/u);
});

test("accepts 128-character Claude scope identifiers at the product boundary", async t => {
  const { calls, dependencies } = createDependencies();
  const host = createAgentRuntimeHost(dependencies);
  t.after(() => host.dispose());
  const scope = runtimeScope();
  Object.assign(scope.claudeCodeSetup!, {
    observationEpoch: "o".repeat(128),
    scopeId: "s".repeat(128),
  });

  assert.match(
    (await host.bindAccess(scope).claudeCodeSetup.inspect()).status,
    /^(?:observed|partial)$/u,
  );
  assert.equal(calls.claudePlanner, 1);
  assert.equal(calls.claudeAuthorization, 1);
  assert.equal(calls.claudeDiscovery, 1);
  assert.equal(calls.claudeConfiguration, 1);
});

test("rejects invalid Claude scope identifiers before downstream calls", async t => {
  const cases = [
    ["observationEpoch", "o".repeat(129)],
    ["scopeId", "s".repeat(129)],
    ["observationEpoch", ""],
    ["scopeId", ""],
    ["observationEpoch", "epoch\u0000control"],
    ["scopeId", "scope\u0000control"],
  ] as const;

  for (const [field, value] of cases) {
    await t.test(`${field} rejects ${value.length === 129 ? "129 characters" : value.length === 0 ? "empty text" : "control characters"}`, async () => {
      const { calls, dependencies } = createDependencies();
      const host = createAgentRuntimeHost(dependencies);
      const scope = runtimeScope();
      Object.assign(scope.claudeCodeSetup!, { [field]: value });
      try {
        assert.deepEqual(
          await host.bindAccess(scope).claudeCodeSetup.inspect(),
          {
            diagnostics: [{ code: "access_scope_limit_exceeded" }],
            expectedLimitations,
            status: "unsupported",
          },
        );
        assert.deepEqual(
          [
            calls.claudePlanner,
            calls.claudeAuthorization,
            calls.claudeDiscovery,
            calls.claudeConfiguration,
          ],
          [0, 0, 0, 0],
        );
      } finally {
        await host.dispose();
      }
    });
  }
});

test("rejects over-limit strings and scope mutation without downstream calls", async t => {
  const { calls, dependencies } = createDependencies();
  const host = createAgentRuntimeHost(dependencies);
  t.after(() => host.dispose());

  const stringScope = runtimeScope();
  Object.assign(stringScope.configurationSources[0]!, {
    kind: "external-profile",
    profileName: "sensitive".repeat(
      TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.text.profileName + 1,
    ),
  });
  Object.assign(stringScope.claudeCodeSetup!, {
    scopeId: "sensitive".repeat(
      TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.claudeCodeSetup.text.scopeId + 1,
    ),
  });
  const stringAccess = host.bindAccess(stringScope);

  const mutationScope = runtimeScope();
  mutationScope.pathEntries = withMutatingLength(mutationScope.pathEntries);
  mutationScope.claudeCodeSetup!.pathEntries = withMutatingLength(
    mutationScope.claudeCodeSetup!.pathEntries,
  );
  const mutationAccess = host.bindAccess(mutationScope);

  for (const result of [
    await stringAccess.codexSetup.inspect({}),
    await stringAccess.claudeCodeSetup.inspect(),
    await mutationAccess.codexSetup.inspect({}),
    await mutationAccess.claudeCodeSetup.inspect(),
  ]) {
    assert.equal(result.status, "unsupported");
    assert.deepEqual(result.diagnostics, [{ code: "access_scope_limit_exceeded" }]);
    assert.ok(isDeeplyFrozen(result));
    assert.doesNotMatch(JSON.stringify(result), /sensitive/u);
  }
  assert.deepEqual(Object.values(calls), Object.values(calls).map(() => 0));
});

test("distinguishes missing Claude dependencies and scope as capability unavailable", async t => {
  const first = createDependencies();
  const {
    authorizeClaudeCodeSetupInspection: _authorization,
    discoverClaudeCodeInstallations: _discovery,
    inspectClaudeCodeConfiguration: _configuration,
    planClaudeCodeSetupInspection: _planner,
    ...codexDependencies
  } = first.dependencies;
  const missingDependenciesHost = createAgentRuntimeHost(codexDependencies);
  const second = createDependencies();
  const missingScopeHost = createAgentRuntimeHost(second.dependencies);
  t.after(() => Promise.all([missingDependenciesHost.dispose(), missingScopeHost.dispose()]));

  for (const result of [
    await missingDependenciesHost.bindAccess(runtimeScope()).claudeCodeSetup.inspect(),
    await missingScopeHost.bindAccess(runtimeScope(false)).claudeCodeSetup.inspect(),
  ]) {
    assert.deepEqual(result, {
      diagnostics: [{ code: "capability_unavailable" }],
      expectedLimitations,
      status: "unsupported",
    });
    assert.ok(isDeeplyFrozen(result));
    assert.doesNotMatch(JSON.stringify(result), /source_epoch_stale/u);
  }
  assert.equal(first.calls.claudePlanner, 0);
  assert.equal(second.calls.claudePlanner, 0);
});

test("unavailable capability preserves cancellation, disposal, and default-host behavior", async t => {
  const { dependencies } = createDependencies();
  const {
    authorizeClaudeCodeSetupInspection: _authorization,
    discoverClaudeCodeInstallations: _discovery,
    inspectClaudeCodeConfiguration: _configuration,
    planClaudeCodeSetupInspection: _planner,
    ...codexDependencies
  } = dependencies;
  const host = createAgentRuntimeHost(codexDependencies);
  const access = host.bindAccess(runtimeScope());
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(access.claudeCodeSetup.inspect({ signal: cancelled.signal }), {
    name: "AbortError",
  });
  await host.dispose();
  await assert.rejects(access.claudeCodeSetup.inspect(), /Host is disposed/u);

  const defaultHost = createDefaultAgentRuntimeHost();
  t.after(() => defaultHost.dispose());
  assert.deepEqual(
    await defaultHost.bindAccess(runtimeScope(false)).claudeCodeSetup.inspect(),
    {
      diagnostics: [{ code: "capability_unavailable" }],
      expectedLimitations,
      status: "unsupported",
    },
  );
});
