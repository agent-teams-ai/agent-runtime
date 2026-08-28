import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBuildClaudeCodeSetupView } from "../dist/application/build-claude-code-setup-view.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("freezes the prospective provider-specific no-product-input Claude contract", async () => {
  const declaration = await readFile(
    join(packageRoot, "dist", "contracts", "runtime-access.d.ts"),
    "utf8",
  );
  assert.match(
    declaration,
    /interface ClaudeCodeRuntimeAccessHandle[\s\S]*?claudeCodeSetup: ClaudeCodeRuntimeSetupQueries/u,
  );
  assert.match(
    declaration,
    /interface ClaudeCodeRuntimeSetupQueries[\s\S]*?inspect\(options\?: \{[\s\S]*?signal\?: AbortSignal/u,
  );
  assert.doesNotMatch(
    declaration.match(/interface ClaudeCodeRuntimeSetupQueries[\s\S]*?\n\}/u)?.[0] ?? "",
    /nativeProfile|input:/u,
  );
  assert.match(declaration, /managedPolicy: "unobserved"/u);
  assert.match(declaration, /sessionOverrides: "unobserved"/u);
  assert.match(declaration, /interactiveShellPath: "unobserved"/u);
  assert.match(declaration, /"capability_unavailable"/u);
  assert.match(declaration, /"access_scope_limit_exceeded"/u);
  assert.match(declaration, /modelCompatibility: "unobserved"/u);
  assert.match(declaration, /kind: "provider-default"/u);
  assert.match(declaration, /kind: "exact-name"/u);
  assert.match(declaration, /form: "provider-deployment" \| "unclassified-selector"/u);
  assert.match(declaration, /contract: "claude-code-observed-source-plan\/v1"/u);
  assert.doesNotMatch(declaration, /"max"/u);
});

test("the real host composition owns the complete Claude dependency contract", async () => {
  const [source, declaration, scopeDeclaration] = await Promise.all([
    readFile(join(packageRoot, "src", "composition", "agent-runtime-host.ts"), "utf8"),
    readFile(join(packageRoot, "dist", "composition", "agent-runtime-host.d.ts"), "utf8"),
    readFile(
      join(packageRoot, "dist", "composition", "trusted-runtime-access-scope.d.ts"),
      "utf8",
    ),
  ]);
  assert.doesNotMatch(source, /child_process|fetch|node:(?:http|https|net|tls)|process\.(?:env|cwd)/u);
  assert.match(declaration, /type ClaudeCodeSetupCapabilityBundle = BuildClaudeCodeSetupViewDependencies/u);
  assert.match(declaration, /type CodexSetupCapabilityBundle = BuildCodexSetupViewDependencies/u);
  assert.match(
    declaration,
    /interface AgentRuntimeHostDependencies[\s\S]*?readonly claudeCodeSetup: ClaudeCodeSetupCapabilityBundle;[\s\S]*?readonly codexSetup: CodexSetupCapabilityBundle;/u,
  );
  assert.doesNotMatch(
    declaration.match(/interface AgentRuntimeHostDependencies[\s\S]*?\n\}/u)?.[0] ?? "",
    /\?:/u,
  );
  assert.match(source, /snapshotAgentRuntimeHostDependencies\(dependencies\)/u);
  assert.match(source, /createBuildClaudeCodeSetupView\([\s\S]*?capabilityDependencies\.claudeCodeSetup/u);
  const runtimeScope = scopeDeclaration.match(
    /interface TrustedRuntimeAccessScope[\s\S]*?\n\}/u,
  )?.[0] ?? "";
  assert.match(runtimeScope, /readonly claudeCodeSetup\?: TrustedClaudeCodeSetupScope/u);
  assert.match(runtimeScope, /readonly codexSetup\?: TrustedCodexSetupScope/u);
  assert.doesNotMatch(runtimeScope, /configurationDialect|observationEpoch|scopeId/u);
});

test("production declarations contain no test-only Claude contract seam or example", async () => {
  const [compositionDeclaration, configurationDeclaration] = await Promise.all([
    readFile(join(packageRoot, "dist", "composition.d.ts"), "utf8"),
    readFile(resolve(packageRoot, "../../contexts/runtime-configuration/dist/index.d.ts"), "utf8"),
  ]);
  assert.doesNotMatch(
    `${compositionDeclaration}\n${configurationDeclaration}`,
    /ContractSpine|PORTABLE_INTENT_EXAMPLE/u,
  );
  await assert.rejects(
    access(join(packageRoot, "src", "composition", "claude-code-contract-spine.ts")),
    { code: "ENOENT" },
  );
});

test("composes the private callable without provider execution or ambient input", async () => {
  const source = await readFile(
    join(packageRoot, "src", "composition", "agent-runtime-host.ts"),
    "utf8",
  );
  assert.match(source, /claudeCodeSetup/u);
  assert.doesNotMatch(
    source,
    /ClaudeCodeSetupNotImplementedError|child_process|fetch|process\.(?:env|cwd)|claude --version|claude doctor/u,
  );
});

const trustedScope = Object.freeze({
  dialect: "claude-code-settings@2026-08-28" as const,
  explicitExecutablePaths: Object.freeze([]),
  homeRoot: "/synthetic/home",
  observationEpoch: "epoch",
  pathEntries: Object.freeze([]),
  scopeId: "scope",
  workspaceRoot: "/synthetic/workspace",
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

test("deduplicates owner diagnostics on their public source reference", async () => {
  const inspect = createBuildClaudeCodeSetupView({
    authorizeClaudeCodeSetupInspection: {
      async execute() {
        return {
          ...emptyConfiguration(),
          canonicalRoots: [],
          diagnostics: [
            { code: "source_untrusted" as const, safeRef: "user" },
            { code: "source_epoch_stale" as const, safeRef: "user" },
            { code: "source_untrusted" as const, safeRef: "scope" },
          ],
          executableCandidates: [],
          observationEpoch: "epoch",
          sources: [],
          status: "authorized" as const,
        };
      },
    },
    discoverClaudeCodeInstallations: {
      async execute() { return { diagnostics: [], installations: [] }; },
    },
    inspectClaudeCodeConfiguration: {
      async execute() {
        return {
          ...emptyConfiguration(),
          diagnostics: [
            { code: "source_untrusted" as const, safeRef: "private-user-source" },
            { code: "config_unreadable" as const, safeRef: "private-user-source" },
          ],
          sources: [{
            displayPath: "$HOME/.claude/settings.json",
            role: "user" as const,
            selectionBasis: "static-preview" as const,
            sourceRef: "private-user-source",
            status: "rejected" as const,
          }],
        };
      },
    },
    planClaudeCodeSetupInspection: {
      plan() {
        return {
          candidatePaths: [],
          dialect: "claude-code-settings@2026-08-28" as const,
          sourcePaths: [],
          status: "planned" as const,
        };
      },
    },
  }, new Uint8Array(32).fill(3));

  const first = await inspect(trustedScope);
  const second = await inspect(trustedScope);
  assert.deepEqual(first, second);
  assert.equal(first.status, "partial");
  if (first.status !== "partial") { return; }
  const publicSourceReference = first.sourceObservations[0]?.sourceRef;
  assert.match(publicSourceReference ?? "", /^claude-code-setup-source:[a-f0-9]{64}$/u);
  assert.deepEqual(first.diagnostics, [
    { code: "config_unreadable", safeRef: publicSourceReference },
    { code: "source_epoch_stale", safeRef: publicSourceReference },
    { code: "source_untrusted", safeRef: publicSourceReference },
    { code: "source_untrusted", safeRef: "scope" },
  ]);
  assert.doesNotMatch(JSON.stringify(first), /private-user-source/u);
});

test("projects only declared public fields from hostile configuration owner results", async () => {
  const sentinelValues = [
    "sentinel-deferred-extra",
    "sentinel-intent-extra",
    "sentinel-selection-extra",
    "sentinel-source-model-extra",
  ] as const;
  const ownerSourceRef = "private-owner-source";
  const inspect = createBuildClaudeCodeSetupView({
    authorizeClaudeCodeSetupInspection: {
      async execute() {
        return {
          canonicalRoots: [], diagnostics: [], executableCandidates: [], observationEpoch: "epoch",
          sources: [], status: "authorized" as const,
        };
      },
    },
    discoverClaudeCodeInstallations: {
      async execute() { return { diagnostics: [], installations: [] }; },
    },
    inspectClaudeCodeConfiguration: {
      async execute() {
        return {
          deferredObservations: [
            {
              extraDeferredField: sentinelValues[0], form: "provider-deployment" as const,
              key: "model" as const, sourceRef: ownerSourceRef, status: "deferred" as const,
            },
            {
              extraDeferredField: sentinelValues[0], form: "unclassified-selector" as const,
              key: "model" as const, sourceRef: ownerSourceRef, status: "deferred" as const,
            },
          ],
          diagnostics: [],
          observedPortableIntent: [
            {
              extraIntentField: sentinelValues[1], key: "model" as const,
              selection: {
                extraSelectionField: sentinelValues[2], kind: "provider-default" as const,
              },
              sourceRef: ownerSourceRef,
            },
            {
              extraIntentField: sentinelValues[1], key: "model" as const,
              selection: {
                extraSelectionField: sentinelValues[2], kind: "alias" as const,
                value: "sonnet" as const,
              },
              sourceRef: ownerSourceRef,
            },
            {
              extraIntentField: sentinelValues[1], key: "model" as const,
              selection: {
                extraSelectionField: sentinelValues[2], kind: "exact-name" as const,
                value: "synthetic-model",
              },
              sourceRef: ownerSourceRef,
            },
            {
              extraIntentField: sentinelValues[1], key: "effortLevel" as const,
              sourceRef: ownerSourceRef, value: "high" as const,
            },
          ],
          sourceModel: {
            ...emptyConfiguration().sourceModel,
            extraSourceModelField: sentinelValues[3],
          },
          sources: [{
            displayPath: "$HOME/.claude/settings.json", role: "user" as const,
            selectionBasis: "static-preview" as const, sourceRef: ownerSourceRef,
            status: "applied" as const,
          }],
        };
      },
    },
    planClaudeCodeSetupInspection: {
      plan() {
        return {
          candidatePaths: [], dialect: "claude-code-settings@2026-08-28" as const,
          sourcePaths: [], status: "planned" as const,
        };
      },
    },
  }, new Uint8Array(32).fill(7));

  const result = await inspect(trustedScope);
  assert.equal(result.status, "observed");
  if (result.status !== "observed") { return; }
  const sourceRef = result.sourceObservations[0]!.sourceRef;
  assert.deepEqual(result.deferredObservations, [
    { form: "provider-deployment", key: "model", sourceRef, status: "deferred" },
    { form: "unclassified-selector", key: "model", sourceRef, status: "deferred" },
  ]);
  assert.deepEqual(result.observedPortableIntent, [
    { key: "model", selection: { kind: "provider-default" }, sourceRef },
    { key: "model", selection: { kind: "alias", value: "sonnet" }, sourceRef },
    { key: "model", selection: { kind: "exact-name", value: "synthetic-model" }, sourceRef },
    { key: "effortLevel", sourceRef, value: "high" },
  ]);
  assert.deepEqual(result.sourceModel, emptyConfiguration().sourceModel);
  const serialized = JSON.stringify(result);
  for (const sentinel of sentinelValues) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
});

test("applies the public diagnostic budget after deterministic normalization", async () => {
  const candidateDiagnostics = Array.from({ length: 1_025 }, (_, index) => ({
    candidateRef: `candidate-${index.toString().padStart(4, "0")}`,
    code: "candidate_invalid" as const,
  }));
  const inspect = createBuildClaudeCodeSetupView({
    authorizeClaudeCodeSetupInspection: {
      async execute() {
        return {
          canonicalRoots: [], diagnostics: [], executableCandidates: [], observationEpoch: "epoch",
          sources: [], status: "authorized" as const,
        };
      },
    },
    discoverClaudeCodeInstallations: {
      async execute() { return { diagnostics: candidateDiagnostics, installations: [] }; },
    },
    inspectClaudeCodeConfiguration: {
      async execute() { return emptyConfiguration(); },
    },
    planClaudeCodeSetupInspection: {
      plan() {
        return {
          candidatePaths: [], dialect: "claude-code-settings@2026-08-28" as const,
          sourcePaths: [], status: "planned" as const,
        };
      },
    },
  }, new Uint8Array(32).fill(5));

  const first = await inspect(trustedScope);
  const second = await inspect(trustedScope);
  assert.equal(first.status, "partial");
  if (first.status !== "partial" || second.status !== "partial") { return; }
  assert.equal(first.diagnostics.length, 1_024);
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.deepEqual(first.diagnostics, first.diagnostics.toSorted((left, right) =>
    `${left.code}:${left.safeRef ?? ""}`.localeCompare(`${right.code}:${right.safeRef ?? ""}`)));
});
