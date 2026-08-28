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
  assert.doesNotMatch(declaration, /"max"/u);
});

test("the real host composition owns the complete Claude dependency contract", async () => {
  const source = await readFile(
    join(packageRoot, "src", "composition", "agent-runtime-host.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /child_process|fetch|node:(?:http|https|net|tls)|process\.(?:env|cwd)/u);
  assert.match(source, /interface AgentRuntimeHostDependencies extends BuildCodexSetupViewDependencies/u);
  for (const dependency of [
    "authorizeClaudeCodeSetupInspection",
    "discoverClaudeCodeInstallations",
    "inspectClaudeCodeConfiguration",
    "planClaudeCodeSetupInspection",
  ]) {
    assert.match(source, new RegExp(`readonly ${dependency}\\?: BuildClaudeCodeSetupViewDependencies`, "u"));
  }
  assert.match(source, /createBuildClaudeCodeSetupView\([\s\S]*?BuildClaudeCodeSetupViewDependencies/u);
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

test("deduplicates owner diagnostics on their public source reference", async () => {
  const inspect = createBuildClaudeCodeSetupView({
    authorizeClaudeCodeSetupInspection: {
      async execute() {
        return {
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
          diagnostics: [
            { code: "source_untrusted" as const, safeRef: "private-user-source" },
            { code: "config_unreadable" as const, safeRef: "private-user-source" },
          ],
          portableIntent: [],
          sources: [{
            displayPath: "$HOME/.claude/settings.json",
            kind: "user" as const,
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

test("applies the public diagnostic budget after deterministic normalization", async () => {
  const candidateDiagnostics = Array.from({ length: 1_025 }, (_, index) => ({
    candidateRef: `candidate-${index.toString().padStart(4, "0")}`,
    code: "candidate_invalid" as const,
  }));
  const inspect = createBuildClaudeCodeSetupView({
    authorizeClaudeCodeSetupInspection: {
      async execute() {
        return {
          diagnostics: [], executableCandidates: [], observationEpoch: "epoch",
          sources: [], status: "authorized" as const,
        };
      },
    },
    discoverClaudeCodeInstallations: {
      async execute() { return { diagnostics: candidateDiagnostics, installations: [] }; },
    },
    inspectClaudeCodeConfiguration: {
      async execute() { return { diagnostics: [], portableIntent: [], sources: [] }; },
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
