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
    id: "claude-code-reliability-qualification",
    revision: "dbbb1c8fe585d3df6ff0251265d70086409aa99a",
  }),
  Object.freeze({
    id: "closed-capability-bundle-hardening",
    revision: "ff82eb593bad665937bae5ffdf10593f4179387d",
  }),
  Object.freeze({
    id: "provider-symmetric-access-scopes",
    revision: "089ee44e9ccc43336ca32bd6a7be07b71d995e48",
  }),
  Object.freeze({
    id: "provider-symmetric-scope-contract-evidence",
    revision: "d490a2308be1b777931d2de0df7196d6b5f128a4",
  }),
  Object.freeze({
    id: "contained-turn-private-access",
    revision: "82800ba50e1060d9c93176a2a6ddb2bc0928fb00",
  }),
  Object.freeze({
    id: "contained-turn-platform-canaries",
    revision: "735f2422d2095a6a9eefbb9491d5dc369bc7e49f",
  }),
  Object.freeze({
    id: "contained-turn-v1-integration",
    revision: "51f6b18989b0c2274eecd8961658a15a3d947cf3",
  }),
]);

export const benchmarkSourceRevision = "d490a2308be1b777931d2de0df7196d6b5f128a4";

export const sourceRevisionArtifactDigests = Object.freeze({
  fixtures: Object.freeze({
    fileCount: 16,
    sha256: "f7622733c0b0ed79457e2decd3ef0a83aedcd5b38da5bac2bfbb9ce221e04703",
  }),
  sources: Object.freeze({
    fileCount: 265,
    sha256: "1ff7311628b25725215f31ac3954d463b9879f402bb367246a6ec964f3291639",
  }),
  tests: Object.freeze({
    fileCount: 98,
    sha256: "51ae596ec60b23082cdbf77dbde51f7564725f00fcfe1f5a466695da081b6811",
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
    jobId: "ar-l0-requal-trace-20260828-final-r1",
    sourceRevision: "d490a2308be1b777931d2de0df7196d6b5f128a4",
    execution,
    prompt: "You are a read-only architecture benchmark worker. Inspect the Agent Runtime repository at exact commit d490a2308be1b777931d2de0df7196d6b5f128a4. Start a monotonic timer before inspection. Do not edit files, install dependencies, run providers, launch agents, or access user projects.\n\nLocate and verify: (1) the product owner and private Runtime Setup API, (2) createAgentRuntimeHost and createDefaultAgentRuntimeHost, (3) complete required Codex and Claude Code capability bundles, (4) symmetric optional codexSetup and claudeCodeSetup trusted scope sections, (5) owner-local adapters, feature factories, use cases, authorization, and result contracts. Expected ownership: embedded-runtime owns private API, provider-neutral trusted scope envelope, composition, and disposal; runtime-security owns authorization; agent-execution owns installation observation; runtime-configuration owns provider configuration inspection. Verify that application/contracts do not import module runtime, container, registry, Cordis, Awilix, or Foundation runtime types.\n\nReturn only strict JSON with: sourceRevision, elapsedSeconds, filesRead, searches, ownerMatrixPass, compositionRootPass, bundleClosurePass, symmetricScopesPass, frameworkLeakFound, evidence (array of paths/symbols), verdict (HOLD or FAIL), and concise reason. HOLD means the exact code remains valid L0 Pure DI evidence and does not prove a need for L1-L3.",
    promptEncoding: "utf8-lf-terminated",
    promptSha256: "ca6df4d0c273c0e4e9587cadcb8d2514fea2bde8574a0cd29b2f73fe467e3ec7",
    retainedEnvelopeSha256: "f45def4c80424a7df427161092f8687c018537628d578d34b812a732f8ac1225",
  }),
  Object.freeze({
    id: "fail-closed-binding-diagnostics",
    jobId: "ar-l0-requal-gates-20260828-final-r1",
    sourceRevision: "d490a2308be1b777931d2de0df7196d6b5f128a4",
    execution,
    prompt: "You are a read-only fail-closed benchmark worker. Inspect Agent Runtime at exact commit d490a2308be1b777931d2de0df7196d6b5f128a4. Start a monotonic timer before inspection. Do not edit files, install dependencies, run providers, launch agents, or access user projects.\n\nVerify from source and focused tests that: (1) missing, partial, malformed, accessor-hostile, and unknown AgentRuntimeHost dependency bindings fail synchronously before bindAccess publishes a handle; (2) Codex and Claude dependency bundles are both required and snapshotted; (3) absent codexSetup or claudeCodeSetup scope returns typed capability_unavailable without downstream calls; (4) malformed/over-limit provider scope returns access_scope_limit_exceeded; (5) Codex-only and Claude-only grants are isolated; (6) composition defects are not converted into authorization denial. Focus on packages/apps/embedded-runtime/tests/capability-bundle-contract.test.ts, runtime-access-boundaries.e2e.test.ts, and src/composition/agent-runtime-host.ts.\n\nReturn only strict JSON with: sourceRevision, elapsedSeconds, filesRead, searches, closedDependenciesPass, unknownBindingPass, accessorSnapshotPass, beforeBindAccessPass, absentScopePass, invalidScopePass, providerIsolationPass, denialSeparationPass, focusedTestPathPass, repeatedNeutralProblemFound, evidence (array of test titles and source symbols), verdict (HOLD or FAIL), and concise reason. HOLD requires every pass field true and no repeated neutral composition problem.",
    promptEncoding: "utf8-lf-terminated",
    promptSha256: "30273fa92243b29877d9318d68153183c682e46be96ea638446d62049253149b",
    retainedEnvelopeSha256: "5f413b7f220ce55e5f93622281c275d131aaa683868b37ce7d8c43ffb96c0a93",
  }),
  Object.freeze({
    id: "prospective-opencode-sibling-capability",
    jobId: "ar-l0-requal-change-20260828-final-r1",
    sourceRevision: "d490a2308be1b777931d2de0df7196d6b5f128a4",
    execution,
    prompt: "You are a read-only prospective change benchmark worker. Inspect Agent Runtime at exact commit d490a2308be1b777931d2de0df7196d6b5f128a4. Start a monotonic timer before inspection. Plan, but do not implement, an OpenCode passive Runtime Setup sibling capability following the current Codex and Claude Code patterns, required closed dependency bundles, and symmetric provider scope envelope. Do not edit files, install dependencies, run providers, launch agents, or access user projects.\n\nIdentify product owners, concrete files that would change, composition files, estimated composition glue LOC, reusable behavior fixtures/tests, and every binding fact tuple: consumer factory, dependency slot, provider symbol, scope/lifetime, authority owner. Evaluate whether this third provider proves repeated neutral binding drift, whether a small product-local helper is enough, or whether it justifies a dynamic module graph. Do not invent runtime selection or lifecycle needs.\n\nReturn only strict JSON with: sourceRevision, elapsedSeconds, filesRead, searches, owners, proposedFiles, compositionFileCount, estimatedGlueLoc, reusableFixturePercent, bindingFacts, duplicateBindingFactsFound, incorrectEditRisk, repeatedNeutralProblemFound, architectureFreezeRequired, verdict (HOLD, GO_L1, or FAIL), and concise reason. GO_L1 requires a concrete repeated neutral problem demonstrated by the exact source, not future preference.",
    promptEncoding: "utf8-lf-terminated",
    promptSha256: "f01af93933bbdbaec48179c831d0ec6d9b18395202eef9b9d1828d3e646ac3b1",
    retainedEnvelopeSha256: "43638a875172a0a1fd59fb6ce60e29c7c263b5e4d1a3c291ba6fce48ce1ae598",
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
      path: "packages/contexts/runtime-configuration/src/features/claude-code-configuration-inspection/adapters/outbound/claude-code-configuration-semantic-classifier-v2.ts",
      symbols: Object.freeze(["createClaudeCodeConfigurationSemanticClassifierV2"]),
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
    "packages/platform/filesystem-custody/src",
  ]),
  tests: Object.freeze([
    "packages/apps/embedded-runtime/tests",
    "packages/contexts/agent-execution/tests",
    "packages/contexts/runtime-configuration/tests",
    "packages/contexts/runtime-security/tests",
    "packages/platform/filesystem-custody/tests",
  ]),
});
