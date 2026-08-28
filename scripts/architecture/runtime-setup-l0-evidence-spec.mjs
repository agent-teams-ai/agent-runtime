export const changes = Object.freeze([
  Object.freeze({
    id: "codex-initial-slice",
    revision: "f277cd55640c892f8bef3384407b73f2f366f434",
  }),
  Object.freeze({
    id: "codex-boundary-hardening",
    revision: "3c4dcddc70e6b70c8e457a22235843368cc90dd9",
  }),
  Object.freeze({
    id: "claude-code-sibling-slice",
    revision: "493c6c37e247f021fc110c5fc624b72f1502d743",
  }),
  Object.freeze({
    id: "closed-capability-bundle-hardening",
    revision: "7be998237a4c262bee9c4198d554b43cd2757ac6",
  }),
]);

export const sourceRevisionArtifactDigests = Object.freeze({
  fixtures: Object.freeze({
    fileCount: 4,
    sha256: "64fa47c95f70c283e22ae3b413927c1cb5966644fa627fd952904df0b6f488a5",
  }),
  sources: Object.freeze({
    fileCount: 57,
    sha256: "69a87dab3f5031581db980daa0e38142ce8187328de2243262b197ec52054b42",
  }),
  tests: Object.freeze({
    fileCount: 23,
    sha256: "9a528a517aa7d7ad5ecfdb87690fc74181e0b0a2739b1d8d9f6f81b4055bf26f",
  }),
});

const execution = Object.freeze({
  editMode: "read-only",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
  serviceTier: "fast",
});

export const prospectiveBenchmarks = Object.freeze([
  Object.freeze({
    id: "owner-and-composition-root-navigation",
    jobId: "ar-l0-final-trace-20260828-r2",
    sourceRevision: "7be998237a4c262bee9c4198d554b43cd2757ac6",
    execution,
    prompt: "Read-only prospective benchmark on exact Agent Runtime commit 7be998237a4c262bee9c4198d554b43cd2757ac6. Start a monotonic timer before repository inspection. Locate, without changing files: (1) product owner and private API for Runtime Setup, (2) createAgentRuntimeHost and createDefaultAgentRuntimeHost, (3) complete Codex and Claude Code capability bundles, (4) owner-local adapters, feature factories, use cases, authorization, and observable result contracts. Expected owner matrix: embedded-runtime owns private API/trusted scope/composition/disposal; runtime-security authorization; agent-execution installation observation; runtime-configuration provider config inspection. Expected root: packages/apps/embedded-runtime/src/composition/agent-runtime-host.ts. Return only strict JSON with sourceRevision, elapsedSeconds, filesRead, searches, ownerMatrixPass, compositionRootPass, bundleClosurePass, frameworkLeakFound, evidence (paths/symbols), verdict (HOLD or FAIL), and concise reason. HOLD means no measured need for L1-L3; do not recommend a framework from preference.",
    promptEncoding: "utf8-lf-terminated",
    promptSha256: "0b9d4a0ca504cea882e392b6dad01b8ddb8cca13505d317421979e87c2ed1ba3",
    retainedEnvelopeSha256: "f194aa2da5cd0dda838c7d49275eb177d2a43b257c2880212604536178d62193",
  }),
  Object.freeze({
    id: "fail-closed-binding-diagnostics",
    jobId: "ar-l0-final-gates-20260828-r2",
    sourceRevision: "7be998237a4c262bee9c4198d554b43cd2757ac6",
    execution,
    prompt: "Read-only prospective benchmark on exact Agent Runtime commit 7be998237a4c262bee9c4198d554b43cd2757ac6. Verify from source and focused tests that a missing inspectCodexConfiguration dependency and an unknown binding fail synchronously before bindAccess publishes a handle, and that composition defects are not converted into authorization denial. Focused oracle: packages/apps/embedded-runtime/tests/capability-bundle-contract.test.ts. Also inspect packages/apps/embedded-runtime/src/composition/agent-runtime-host.ts. Do not change or run provider processes. Return only strict JSON with sourceRevision, elapsedSeconds, filesRead, searches, missingDependencyPass, unknownBindingPass, beforeBindAccessPass, denialSeparationPass, focusedTestPathPass, evidence (test titles and source symbols), repeatedNeutralProblemFound, verdict (HOLD or FAIL), and concise reason. L1-L3 remain HOLD unless a concrete repeated neutral composition problem is proven.",
    promptEncoding: "utf8-lf-terminated",
    promptSha256: "a0da88eec5a8789e12660451242b8167c1d2bdf8767b84c5b04b80f11dd97898",
    retainedEnvelopeSha256: "623cf905372f2b8776cc9460de94c7f17f93c84657aeadf2810ac75e1773bc26",
  }),
  Object.freeze({
    id: "prospective-opencode-sibling-capability",
    jobId: "ar-l0-final-change-20260828-r2",
    sourceRevision: "7be998237a4c262bee9c4198d554b43cd2757ac6",
    execution,
    prompt: "Read-only prospective change benchmark on exact Agent Runtime commit 7be998237a4c262bee9c4198d554b43cd2757ac6. Plan, but do not implement, an OpenCode passive Runtime Setup sibling capability following current Codex and Claude Code patterns. Identify product owners, files that would change, composition files, estimated composition glue LOC, behavior fixtures/tests reusable, and every binding fact tuple (consumer factory + dependency slot + provider symbol + scope/lifetime + authority owner). Evaluate whether the task proves repeated neutral binding drift or is ordinary product-owned Pure DI. Do not invent runtime selection or lifecycle needs. Return only strict JSON with sourceRevision, elapsedSeconds, filesRead, searches, owners, proposedFiles, compositionFileCount, estimatedGlueLoc, reusableFixturePercent, bindingFacts, duplicateBindingFactsFound, incorrectEditRisk, verdict (HOLD or GO_L1), and concise reason. GO_L1 requires a concrete repeated neutral problem, not hypothetical future scale.",
    promptEncoding: "utf8-lf-terminated",
    promptSha256: "bd643192a60f7f342ab450ca4abed2259c9691f11b9bf3d1510e4cd5c8ebb886",
    retainedEnvelopeSha256: "973f2067fd4b2a0d88fadb354518de52a0d72d23491d1a719ac15dfd11f63c6d",
  }),
]);

export const ownership = Object.freeze([
  Object.freeze({
    owner: "embedded-runtime",
    responsibility: "private API, trusted scope, cross-context composition, and Host disposal",
  }),
  Object.freeze({
    owner: "runtime-security",
    responsibility: "setup-inspection authorization",
  }),
  Object.freeze({
    owner: "agent-execution",
    responsibility: "runtime installation observation",
  }),
  Object.freeze({
    owner: "runtime-configuration",
    responsibility: "provider-specific configuration inspection",
  }),
]);

export const traces = Object.freeze({
  construction: Object.freeze([
    Object.freeze({
      owner: "embedded-runtime",
      path: "packages/apps/embedded-runtime/src/composition/agent-runtime-host.ts",
      symbols: Object.freeze(["createDefaultAgentRuntimeHost", "createAgentRuntimeHost"]),
    }),
    Object.freeze({
      owner: "agent-execution",
      path: "packages/contexts/agent-execution/src/features/runtime-installation-discovery/adapters/outbound/node-executable-file-observer.ts",
      symbols: Object.freeze(["createNodeExecutableFileObserver"]),
    }),
    Object.freeze({
      owner: "agent-execution",
      path: "packages/contexts/agent-execution/src/features/runtime-installation-discovery/composition/feature-module-factory.ts",
      symbols: Object.freeze(["createRuntimeInstallationDiscoveryFeature"]),
    }),
    Object.freeze({
      owner: "runtime-security",
      path: "packages/contexts/runtime-security/src/features/setup-source-inspection-authorization/adapters/outbound/node-path-canonicalizer.ts",
      symbols: Object.freeze(["createNodePathCanonicalizer"]),
    }),
    Object.freeze({
      owner: "runtime-security",
      path: "packages/contexts/runtime-security/src/features/setup-source-inspection-authorization/composition/feature-module-factory.ts",
      symbols: Object.freeze(["createSetupInspectionAuthorizationFeature"]),
    }),
    Object.freeze({
      owner: "runtime-configuration",
      path: "packages/contexts/runtime-configuration/src/features/codex-configuration-inspection/adapters/outbound/node-configuration-source-reader.ts",
      symbols: Object.freeze(["createNodeConfigurationSourceReader"]),
    }),
    Object.freeze({
      owner: "runtime-configuration",
      path: "packages/contexts/runtime-configuration/src/features/codex-configuration-inspection/adapters/outbound/smol-toml-parser.ts",
      symbols: Object.freeze(["createSmolTomlParser"]),
    }),
    Object.freeze({
      owner: "runtime-configuration",
      path: "packages/contexts/runtime-configuration/src/features/codex-configuration-inspection/adapters/outbound/codex-configuration-semantic-classifier-v1.ts",
      symbols: Object.freeze(["createCodexConfigurationSemanticClassifierV1"]),
    }),
    Object.freeze({
      owner: "runtime-configuration",
      path: "packages/contexts/runtime-configuration/src/features/codex-configuration-inspection/composition/feature-module-factory.ts",
      symbols: Object.freeze(["createCodexConfigurationInspectionFeature"]),
    }),
    Object.freeze({
      owner: "runtime-configuration",
      path: "packages/contexts/runtime-configuration/src/features/claude-code-configuration-inspection/adapters/outbound/claude-code-configuration-source-reader-adapter.ts",
      symbols: Object.freeze(["createClaudeCodeConfigurationSourceReaderAdapter"]),
    }),
    Object.freeze({
      owner: "runtime-configuration",
      path: "packages/contexts/runtime-configuration/src/features/claude-code-configuration-inspection/adapters/outbound/strict-claude-code-json-parser.ts",
      symbols: Object.freeze(["createStrictClaudeCodeJsonParser"]),
    }),
    Object.freeze({
      owner: "runtime-configuration",
      path: "packages/contexts/runtime-configuration/src/features/claude-code-configuration-inspection/adapters/outbound/claude-code-configuration-semantic-classifier-v1.ts",
      symbols: Object.freeze(["createClaudeCodeConfigurationSemanticClassifierV1"]),
    }),
    Object.freeze({
      owner: "runtime-configuration",
      path: "packages/contexts/runtime-configuration/src/features/claude-code-configuration-inspection/composition/feature-module-factory.ts",
      symbols: Object.freeze(["createClaudeCodeConfigurationInspectionFeature"]),
    }),
    Object.freeze({
      owner: "embedded-runtime",
      path: "packages/apps/embedded-runtime/src/composition/codex-setup-inspection-planner.ts",
      symbols: Object.freeze(["createCodexSetupInspectionPlanner"]),
    }),
    Object.freeze({
      owner: "embedded-runtime",
      path: "packages/apps/embedded-runtime/src/composition/claude-code-setup-inspection-planner.ts",
      symbols: Object.freeze(["createClaudeCodeSetupInspectionPlanner"]),
    }),
  ]),
  invocations: Object.freeze({
    claudeCode: Object.freeze([
      Object.freeze({
        owner: "embedded-runtime",
        path: "packages/apps/embedded-runtime/src/contracts/runtime-access.ts",
        symbols: Object.freeze(["RuntimeAccessHandle", "ClaudeCodeRuntimeSetupQueries"]),
      }),
      Object.freeze({
        owner: "embedded-runtime",
        path: "packages/apps/embedded-runtime/src/application/build-claude-code-setup-view.ts",
        symbols: Object.freeze(["createBuildClaudeCodeSetupView"]),
      }),
      Object.freeze({
        owner: "runtime-security",
        path: "packages/contexts/runtime-security/src/features/setup-source-inspection-authorization/application/authorize-claude-code-setup-inspection.ts",
        symbols: Object.freeze(["createAuthorizeClaudeCodeSetupInspection"]),
      }),
      Object.freeze({
        owner: "agent-execution",
        path: "packages/contexts/agent-execution/src/features/runtime-installation-discovery/application/discover-claude-code-installations.ts",
        symbols: Object.freeze(["createDiscoverClaudeCodeInstallations"]),
      }),
      Object.freeze({
        owner: "runtime-configuration",
        path: "packages/contexts/runtime-configuration/src/features/claude-code-configuration-inspection/application/inspect-claude-code-configuration.ts",
        symbols: Object.freeze(["createInspectClaudeCodeConfiguration"]),
      }),
    ]),
    codex: Object.freeze([
      Object.freeze({
        owner: "embedded-runtime",
        path: "packages/apps/embedded-runtime/src/contracts/runtime-access.ts",
        symbols: Object.freeze(["RuntimeAccessHandle", "CodexRuntimeSetupQueries"]),
      }),
      Object.freeze({
        owner: "embedded-runtime",
        path: "packages/apps/embedded-runtime/src/application/build-codex-setup-view.ts",
        symbols: Object.freeze(["createBuildCodexSetupView"]),
      }),
      Object.freeze({
        owner: "runtime-security",
        path: "packages/contexts/runtime-security/src/features/setup-source-inspection-authorization/application/authorize-setup-inspection.ts",
        symbols: Object.freeze(["createAuthorizeSetupInspection"]),
      }),
      Object.freeze({
        owner: "agent-execution",
        path: "packages/contexts/agent-execution/src/features/runtime-installation-discovery/application/discover-codex-installations.ts",
        symbols: Object.freeze(["createDiscoverCodexInstallations"]),
      }),
      Object.freeze({
        owner: "runtime-configuration",
        path: "packages/contexts/runtime-configuration/src/features/codex-configuration-inspection/application/inspect-codex-configuration.ts",
        symbols: Object.freeze(["createInspectCodexConfiguration"]),
      }),
    ]),
  }),
});

export const evidenceRoots = Object.freeze({
  fixtures: Object.freeze([
    "packages/contexts/agent-execution/tests/fixtures",
    "packages/contexts/runtime-configuration/tests/fixtures",
    "packages/contexts/runtime-security/tests/fixtures",
  ]),
  sources: Object.freeze([
    "packages/apps/embedded-runtime/src",
    "packages/contexts/agent-execution/src",
    "packages/contexts/runtime-configuration/src",
    "packages/contexts/runtime-security/src",
  ]),
  tests: Object.freeze([
    "packages/apps/embedded-runtime/tests",
    "packages/contexts/agent-execution/tests",
    "packages/contexts/runtime-configuration/tests",
    "packages/contexts/runtime-security/tests",
  ]),
});
