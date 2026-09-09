import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

// Only the explicitly listed public HMAC identity domains are renamed. All fields, semantic array
// ordering, statuses, diagnostics, limitations and semantic digests survive.
// A bijection per domain preserves repeated-reference relationships, including
// diagnostic subjects/safeRefs. Maps persist across calls on the paired Hosts.
const opaqueIdentity = /^(codex-setup-observation|codex-installation|codex-config-source|claude-code-setup-source|claude-code-setup-installation|claude-code-setup-observation):[a-f0-9]{64}$/u;
// The configuration inspector creates these with its fresh sourceIdentityKey;
// build-claude-code-setup-view forwards them unchanged in sourceModel. Keep
// domain, version and algorithm exact, and accept only the corresponding field.
const sourceModelIdentity = {
  collectorRef: /^(claude-code-collector\/v2:hmac-sha256):[a-f0-9]{64}$/u,
  topologyRef: /^(claude-code-topology\/v2:hmac-sha256):[a-f0-9]{64}$/u,
};
type ClaudeOutcome = Extract<Awaited<ReturnType<ReturnType<AgentRuntimeHost["bindAccess"]>["claudeCodeSetup"]["inspect"]>>, { sourceObservations: unknown }>;

const compareText = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;

const anchor = (source: ClaudeOutcome["sourceObservations"][number]) =>
  JSON.stringify([source.role, source.selectionBasis, source.displayPath]);
const diagnosticKey = (item: { code: string; safeRef?: string }) => `${item.code}:${item.safeRef ?? ""}`;

// Configuration buildResult sorts sources by its private keyed sourceRef; the
// public view re-HMACs that ref without re-sorting. Thus public lexical order
// cannot be checked. Retain its observable relationship: intent/deferred groups
// follow sourceObservations order, with exact ordering within each group.
const canonicalClaudeSources = (result: ClaudeOutcome): ClaudeOutcome => {
  const rank = new Map(result.sourceObservations.map((source, index) => [source.sourceRef, index]));
  assert.equal(rank.size, result.sourceObservations.length, "unique Claude source identities");
  for (const items of [result.observedPortableIntent, result.deferredObservations]) {
    let previous = -1;
    for (const item of items) {
      const current = rank.get(item.sourceRef);
      assert.ok(current !== undefined && current >= previous, "Claude source group order follows source observations");
      previous = current;
    }
  }
  const sources = result.sourceObservations.toSorted((a, b) => compareText(anchor(a), anchor(b)));
  assert.equal(new Set(sources.map(anchor)).size, sources.length, "unambiguous Claude source anchors");
  const canonicalRank = new Map(sources.map((source, index) => [source.sourceRef, index]));
  const order = (a: { sourceRef: string }, b: { sourceRef: string }) =>
    canonicalRank.get(a.sourceRef)! - canonicalRank.get(b.sourceRef)!;
  return {
    ...result, sourceObservations: sources,
    observedPortableIntent: result.observedPortableIntent.toSorted(order),
    deferredObservations: result.deferredObservations.toSorted(order),
  };
};

export const outcomeNormalizer = () => {
  const domains = new Map<string, Map<string, string>>();
  const normalize = (value: unknown, field = ""): unknown => {
    const sourceModelPattern = field === "collectorRef" || field === "topologyRef"
      ? sourceModelIdentity[field] : undefined;
    if (typeof value === "string" && (
      (["observationRef", "installationRef", "sourceRef", "subject", "safeRef"].includes(field)
        && opaqueIdentity.test(value)) || sourceModelPattern?.test(value))) {
      const domain = value.slice(0, value.lastIndexOf(":"));
      let identities = domains.get(domain);
      if (!identities) { identities = new Map(); domains.set(domain, identities); }
      if (!identities.has(value)) { identities.set(value, `${domain}:opaque-${identities.size}`); }
      return identities.get(value);
    }
    if (Array.isArray(value)) { return value.map(child => normalize(child, field)); }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child, key)]));
    }
    return value;
  };
  return (value: unknown): unknown => {
    if (typeof value !== "object" || value === null || !("sourceObservations" in value)) {
      return normalize(value);
    }
    const result = canonicalClaudeSources(value as ClaudeOutcome);
    // Seed the bijection by semantic source anchor before diagnostic/intent refs.
    normalize(result.sourceObservations);
    // Public view normalizes diagnostics by code then the public keyed safeRef.
    assert.deepEqual(result.diagnostics, result.diagnostics.toSorted((a, b) =>
      compareText(diagnosticKey(a), diagnosticKey(b))), "Claude diagnostic keyed order");
    const normalized = normalize(result) as ClaudeOutcome;
    return { ...normalized, diagnostics: normalized.diagnostics.toSorted((a, b) =>
      compareText(diagnosticKey(a), diagnosticKey(b))) };
  };
};

export const createExactParityHost = async (createCandidate: PassiveHostFactory): Promise<AgentRuntimeHost> => {
  const candidate = await createCandidate();
  const reference = createDirectReferenceHost();
  const actual = outcomeNormalizer();
  const expected = outcomeNormalizer();
  const compare = <T>(result: T, baseline: T): T => {
    assertFrozen(result);
    assertFrozen(baseline);
    assert.deepEqual(actual(result), expected(baseline), "complete direct/Assembly observable parity");
    return result;
  };
  const dispose = async () => { await Promise.all([candidate.dispose(), reference.dispose()]); };
  return {
    dispose,
    [Symbol.asyncDispose]: dispose,
    bindAccess(scope) {
      const access = candidate.bindAccess(scope);
      const direct = reference.bindAccess(scope);
      return {
        ...access,
        codexSetup: { async inspect(request, options) {
          const [result, baseline] = await Promise.all([
            access.codexSetup.inspect(request, options), direct.codexSetup.inspect(request, options),
          ]);
          return compare(result, baseline);
        } },
        claudeCodeSetup: { async inspect(options) {
          const [result, baseline] = await Promise.all([
            access.claudeCodeSetup.inspect(options), direct.claudeCodeSetup.inspect(options),
          ]);
          return compare(result, baseline);
        } },
      };
    },
  };
};

const assertFrozen = (value: unknown): void => {
  if (typeof value !== "object" || value === null) { return; }
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) { assertFrozen(child); }
};

export const fixtureScope = (root: string): TrustedRuntimeAccessScope => ({
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
  createCandidate: PassiveHostFactory,
): void => {
  const createHost = () => createExactParityHost(createCandidate);
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

  test(`${label}: valid scopes compare complete platform outcomes`, async t => {
    const root = await mkdtemp(join(tmpdir(), "ar-assembly-platform-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const host = await createHost();
    t.after(() => host.dispose());
    const access = host.bindAccess(fixtureScope(root));
    await access.codexSetup.inspect({});
    await access.claudeCodeSetup.inspect();
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

  registerFilesystemScenario(label, createHost);
};

const registerFilesystemScenario = (label: string, createHost: PassiveHostFactory): void => {
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
    const deniedClaude = host.bindAccess({ claudeCodeSetup: {
      ...scope.claudeCodeSetup, workspaceRoot: scope.claudeCodeSetup.homeRoot,
    } });
    const deniedClaudeResult = await deniedClaude.claudeCodeSetup.inspect();
    assert.equal(deniedClaudeResult.status, "denied");
    assertFrozen(deniedClaudeResult);
    assert.ok(!JSON.stringify(deniedClaudeResult).includes(root));
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

    // Ordinary authorized files reach the real readers, which reject their size.
    await Promise.all([
      writeFile(join(root, "home", ".codex", "config.toml"), Buffer.alloc(128 * 1024 + 1, 0x20)),
      writeFile(join(root, "home", ".claude", "settings.json"), Buffer.alloc(128 * 1024 + 1, 0x20)),
    ]);
    const [largeCodex, largeClaude] = await Promise.all([access.codexSetup.inspect({}), access.claudeCodeSetup.inspect()]);
    assert.ok(largeCodex.status === "partial");
    assert.ok(largeClaude.status === "partial");
    const largeCodexSource = largeCodex.sources.find(source => source.status === "unreadable");
    assert.ok(largeCodexSource);
    assert.ok(largeCodex.diagnostics.some(item => item.code === "config_too_large" && item.subject === largeCodexSource.sourceRef));
    const largeClaudeSource = largeClaude.sourceObservations.find(source => source.role === "user" && source.status === "unreadable");
    assert.ok(largeClaudeSource);
    assert.ok(largeClaude.diagnostics.some(item => item.code === "config_too_large" && item.safeRef === largeClaudeSource.sourceRef));
    assert.ok(largeCodex.sources.some(source => source.status === "unreadable"));
    assert.ok(largeClaude.sourceObservations.some(source => source.status === "unreadable"));
    assert.deepEqual(largeCodex.settings, []);
    assert.deepEqual(largeClaude.observedPortableIntent, []);
    assertFrozen(largeCodex);
    assertFrozen(largeClaude);
    assert.ok(!JSON.stringify({ largeCodex, largeClaude }).includes(root));
    assert.deepEqual(await access.codexSetup.inspect({}), largeCodex);
    assert.deepEqual(await access.claudeCodeSetup.inspect(), largeClaude);

    // Execute-bit rejection belongs to the observer, including when run as root.
    await Promise.all([
      writeFile(join(root, "home", ".codex", "config.toml"), "model = 'reference-model'\n"),
      writeFile(join(root, "home", ".claude", "settings.json"), '{"model":"sonnet"}'),
      chmod(join(root, "home", "bin", "codex"), 0o644),
      chmod(join(root, "home", "bin", "claude"), 0o644),
    ]);
    const [invalidCodex, invalidClaude] = await Promise.all([access.codexSetup.inspect({}), access.claudeCodeSetup.inspect()]);
    assert.ok(invalidCodex.status === "partial");
    assert.ok(invalidClaude.status === "partial");
    assert.ok(invalidCodex.diagnostics.some(item => item.code === "candidate_invalid"));
    assert.ok(invalidClaude.diagnostics.some(item => item.code === "candidate_invalid"));
    assert.deepEqual(invalidCodex.installations, []);
    assert.deepEqual(invalidClaude.installations, []);
    assert.equal(invalidCodex.settings.find(setting => setting.key === "model")?.value, "reference-model");
    assert.ok(invalidClaude.observedPortableIntent.some(intent => intent.key === "model"));
    assertFrozen(invalidCodex);
    assertFrozen(invalidClaude);
    assert.ok(!JSON.stringify({ invalidCodex, invalidClaude }).includes(root));
    assert.deepEqual(await access.codexSetup.inspect({}), invalidCodex);
    assert.deepEqual(await access.claudeCodeSetup.inspect(), invalidClaude);
  });
};
