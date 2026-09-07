import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TrustedRuntimeAccessScope } from "../../dist/composition/trusted-runtime-access-scope.js";

import { randomBytes } from "node:crypto";

import {
  createNodeExecutableFileObserver,
  createRuntimeInstallationDiscoveryFeature,
} from "@agent-teams/agent-execution/composition";
import {
  createClaudeCodeConfigurationInspectionFeature,
  createClaudeCodeConfigurationSemanticClassifierV2,
  createClaudeCodeConfigurationSourceReaderAdapter,
  createCodexConfigurationInspectionFeature,
  createCodexConfigurationSemanticClassifierV1,
  createNodeConfigurationSourceReader,
  createSmolTomlParser,
  createStrictClaudeCodeJsonParser,
} from "@agent-teams/runtime-configuration/composition";
import {
  createNodePathCanonicalizer,
  createSetupInspectionAuthorizationFeature,
} from "@agent-teams/runtime-security/composition";

import { createAgentRuntimeHost, type AgentRuntimeHost } from "../../dist/composition/agent-runtime-host.js";
import { createCodexSetupInspectionPlanner } from "../../dist/composition/codex-setup-inspection-planner.js";
import { createClaudeCodeSetupInspectionPlanner } from "../../dist/composition/claude-code-setup-inspection-planner.js";

// Retained literal wiring from ae103a68. Keep independent of production graph,
// declarations and bindings: this is the behavioral reference for adoption.
export const createDirectReferenceHost = (): AgentRuntimeHost => {
  const security = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: createNodePathCanonicalizer(),
  });
  const execution = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: createNodeExecutableFileObserver(),
  });
  const nodeConfigurationSourceReader = createNodeConfigurationSourceReader();
  const configuration = createCodexConfigurationInspectionFeature({
    parser: createSmolTomlParser(),
    semanticClassifier: createCodexConfigurationSemanticClassifierV1(),
    sourceIdentityKey: randomBytes(32),
    sourceReader: nodeConfigurationSourceReader,
  });
  const claudeConfiguration = createClaudeCodeConfigurationInspectionFeature({
    parser: createStrictClaudeCodeJsonParser(),
    semanticClassifier: createClaudeCodeConfigurationSemanticClassifierV2(),
    sourceIdentityKey: randomBytes(32),
    sourceReader: createClaudeCodeConfigurationSourceReaderAdapter(),
  });

  return createAgentRuntimeHost({
    claudeCodeSetup: {
      authorizeClaudeCodeSetupInspection: security.authorizeClaudeCodeSetupInspection,
      discoverClaudeCodeInstallations: execution.discoverClaudeCodeInstallations,
      inspectClaudeCodeConfiguration: claudeConfiguration,
      planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner(process.platform),
    },
    codexSetup: {
      authorizeSetupInspection: security.authorizeSetupInspection,
      discoverCodexInstallations: execution.discoverCodexInstallations,
      inspectCodexConfiguration: configuration.inspectCodexConfiguration,
      planCodexSetupInspection: createCodexSetupInspectionPlanner(process.platform),
    },
  });
};

// The same contract can be registered against the async default bootstrap.
// Assertions use public outcomes, never graph metadata or cross-host opaque IDs.

export type PassiveHostFactory = () => Promise<AgentRuntimeHost>;

const assertFrozen = (value: unknown): void => {
  if (typeof value !== "object" || value === null) { return; }
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) { assertFrozen(child); }
};

const fixtureScope = (root: string): TrustedRuntimeAccessScope => ({
  codexSetup: {
    configurationDialect: "codex-0.134",
    configurationSources: [{ absolutePath: join(root, "home", ".codex", "config.toml"), kind: "user", workspaceTrusted: true }],
    explicitCodexExecutablePaths: [],
    knownExecutableDirectories: [],
    observationEpoch: "reference-epoch",
    pathEntries: [join(root, "home", "bin")],
    roots: [{ absolutePath: join(root, "home"), kind: "home" }],
    scopeId: "reference-codex",
  },
  claudeCodeSetup: {
    dialect: "claude-code-settings@2026-08-28",
    explicitExecutablePaths: [],
    homeRoot: join(root, "home"),
    observationEpoch: "reference-epoch",
    pathEntries: [join(root, "home", "bin")],
    scopeId: "reference-claude",
    workspaceRoot: join(root, "workspace"),
    workspaceTrusted: true,
  },
});

export const registerPassiveSetupScenarios = (
  label: string,
  createHost: PassiveHostFactory,
): void => {
  test(`${label}: absent and over-limit scopes fail closed for both siblings`, async t => {
    const host = await createHost();
    t.after(() => host.dispose());
    const absent = host.bindAccess({});
    const codex = await absent.codexSetup.inspect({});
    const claude = await absent.claudeCodeSetup.inspect();
    assert.deepEqual(codex, { diagnostics: [{ code: "capability_unavailable" }], status: "unsupported" });
    assert.equal(claude.status, "unsupported");
    assert.deepEqual(claude.diagnostics, [{ code: "capability_unavailable" }]);
    assertFrozen(codex);
    assertFrozen(claude);
    const scope = fixtureScope(join(tmpdir(), "unused-reference-scope"));
    assert.ok(scope.codexSetup && scope.claudeCodeSetup);
    const invalid = host.bindAccess({
      codexSetup: { ...scope.codexSetup, pathEntries: Array(65).fill("unused") },
      claudeCodeSetup: { ...scope.claudeCodeSetup, pathEntries: Array(65).fill("unused") },
    });
    assert.deepEqual((await invalid.codexSetup.inspect({})).diagnostics, [{ code: "access_scope_limit_exceeded" }]);
    assert.deepEqual((await invalid.claudeCodeSetup.inspect()).diagnostics, [{ code: "access_scope_limit_exceeded" }]);
  });

  test(`${label}: cancellation and disposal are local to each fresh host`, async t => {
    const [first, second] = await Promise.all([createHost(), createHost()]);
    t.after(() => Promise.all([first.dispose(), second.dispose()]));
    assert.notEqual(first, second);
    const access = first.bindAccess({});
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(access.codexSetup.inspect({}, { signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(access.claudeCodeSetup.inspect({ signal: controller.signal }), { name: "AbortError" });
    await Promise.all([first.dispose(), first[Symbol.asyncDispose]()]);
    await assert.rejects(access.codexSetup.inspect({}), /Host is disposed/u);
    await assert.rejects(access.claudeCodeSetup.inspect(), /Host is disposed/u);
    assert.throws(() => first.bindAccess({}), /Host is disposed/u);
    assert.equal((await second.bindAccess({}).codexSetup.inspect({})).status, "unsupported");
  });

  test(`${label}: real passive owners inspect synthetic siblings and preserve scope snapshots`, {
    skip: process.platform !== "darwin",
  }, async t => {
    const root = await mkdtemp(join(tmpdir(), "ar-assembly-reference-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await Promise.all([
      mkdir(join(root, "home", "bin"), { recursive: true }),
      mkdir(join(root, "home", ".codex"), { recursive: true }),
      mkdir(join(root, "home", ".claude"), { recursive: true }),
      mkdir(join(root, "workspace"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "home", "bin", "codex"), "inert fixture, never execute", { mode: 0o755 }),
      writeFile(join(root, "home", "bin", "claude"), "inert fixture, never execute", { mode: 0o755 }),
      writeFile(join(root, "home", ".codex", "config.toml"), "model = 'reference-model'\napi_key = 'reference-secret'\n"),
      writeFile(join(root, "home", ".claude", "settings.json"), '{"model":"sonnet"}'),
    ]);
    const host = await createHost();
    t.after(() => host.dispose());
    const scope = fixtureScope(root);
    assert.ok(scope.codexSetup && scope.claudeCodeSetup);
    const mutableEntries = [...scope.codexSetup.pathEntries];
    const access = host.bindAccess({ ...scope, codexSetup: { ...scope.codexSetup, pathEntries: mutableEntries } });
    mutableEntries.push("relative-path-must-not-be-captured");
    const [codex, claude] = await Promise.all([access.codexSetup.inspect({}), access.claudeCodeSetup.inspect()]);
    assert.ok(codex.status === "partial" || codex.status === "observed", JSON.stringify(codex));
    assert.equal(claude.status, "observed", JSON.stringify(claude));
    assert.equal(codex.installations.length, 1);
    assert.equal(claude.installations.length, 1);
    assert.equal(codex.settings.find(setting => setting.key === "model")?.value, "reference-model");
    assert.ok(claude.observedPortableIntent.some(intent => intent.key === "model"));
    assert.deepEqual(await access.codexSetup.inspect({}), codex);
    assert.deepEqual(await access.claudeCodeSetup.inspect(), claude);
    assertFrozen(codex);
    assertFrozen(claude);
    const serialized = JSON.stringify({ codex, claude });
    assert.ok(!serialized.includes(root));
    assert.ok(!serialized.includes("reference-secret"));
    assert.ok(!serialized.includes("relative-path-must-not-be-captured"));
    const onlyCodex = host.bindAccess({ codexSetup: scope.codexSetup });
    const onlyClaude = host.bindAccess({ claudeCodeSetup: scope.claudeCodeSetup });
    assert.deepEqual((await onlyCodex.claudeCodeSetup.inspect()).diagnostics, [{ code: "capability_unavailable" }]);
    assert.deepEqual((await onlyClaude.codexSetup.inspect({})).diagnostics, [{ code: "capability_unavailable" }]);
    assert.deepEqual(await onlyCodex.codexSetup.inspect({}), codex);
    assert.deepEqual(await onlyClaude.claudeCodeSetup.inspect(), claude);

    // Actual security denial, rather than a fabricated denied dependency result.
    const denied = host.bindAccess({ codexSetup: { ...scope.codexSetup, roots: [] } });
    assert.equal((await denied.codexSetup.inspect({})).status, "denied");
    await writeFile(join(root, "home", ".codex", "config.toml"), "model = [\n");
    const malformed = await access.codexSetup.inspect({ nativeProfile: "invalid profile" });
    assert.ok(malformed.diagnostics.some(item => item.code === "config_parse_failed"));
    assert.ok(malformed.diagnostics.some(item => item.code === "native_profile_invalid"));
    await rm(join(root, "home", ".codex", "config.toml"));
    const missing = await access.codexSetup.inspect({});
    assert.ok(missing.status === "partial" || missing.status === "observed");
    assert.deepEqual(missing.sources.map(source => source.status), ["missing"]);
    assert.deepEqual(missing.settings, []);
    await writeFile(join(root, "home", ".claude", "settings.json"), '{"model":');
    const malformedClaude = await access.claudeCodeSetup.inspect();
    assert.ok(malformedClaude.status === "partial" || malformedClaude.status === "observed");
    assert.ok(malformedClaude.sourceObservations.some(source => source.status === "malformed"));
  });
};
