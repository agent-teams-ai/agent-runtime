import type { InspectClaudeCodeConfigurationResult } from
  "../../src/features/claude-code-configuration-inspection/contracts/claude-code-configuration-inspection.js";

export const claudeCodePortableIntentExample = Object.freeze({
  deferredObservations: Object.freeze([]), diagnostics: Object.freeze([]),
  observedPortableIntent: Object.freeze([
    Object.freeze({
      key: "model" as const, selection: Object.freeze({ kind: "alias" as const, value: "sonnet" as const }),
      sourceRef: "claude-source:example",
    }),
    Object.freeze({ key: "effortLevel" as const, sourceRef: "claude-source:example", value: "high" as const }),
  ]),
  sourceModel: Object.freeze({
    claim: "observed-files-only" as const, classifierRevision: "claude-code-settings-2026-08-28-semantic-classifier/2",
    collectorRef: "claude-collector:example", compatibility: "unqualified" as const,
    contract: "claude-code-observed-source-plan/v1" as const,
    dialect: "claude-code-settings@2026-08-28" as const, precedence: "not-evaluated" as const,
    topologyRef: "claude-topology:example",
  }),
  sources: Object.freeze([Object.freeze({
    displayPath: "$CLAUDE_OBSERVED/project-local/caller-explicit/settings.json",
    role: "project-local" as const, selectionBasis: "caller-explicit" as const,
    sourceRef: "claude-source:example", status: "applied" as const,
  })]),
}) satisfies InspectClaudeCodeConfigurationResult;
