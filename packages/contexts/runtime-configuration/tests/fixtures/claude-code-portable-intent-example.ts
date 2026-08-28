import type {
  InspectClaudeCodeConfigurationResult,
} from "../../src/features/claude-code-configuration-inspection/contracts/claude-code-configuration-inspection.js";

export const claudeCodePortableIntentExample = Object.freeze({
  diagnostics: Object.freeze([]),
  portableIntent: Object.freeze([
    Object.freeze({
      key: "model" as const,
      sourceRef: "claude-source:example",
      value: "sonnet" as const,
    }),
    Object.freeze({
      key: "effortLevel" as const,
      sourceRef: "claude-source:example",
      value: "high" as const,
    }),
  ]),
  sources: Object.freeze([
    Object.freeze({
      displayPath: "$WORKSPACE/.claude/settings.local.json",
      kind: "project-local" as const,
      sourceRef: "claude-source:example",
      status: "applied" as const,
    }),
  ]),
}) satisfies InspectClaudeCodeConfigurationResult;
