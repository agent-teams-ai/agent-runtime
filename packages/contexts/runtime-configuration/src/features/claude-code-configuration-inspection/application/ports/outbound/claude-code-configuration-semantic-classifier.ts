import type {
  ClaudeCodeConfigurationDiagnostic,
  ClaudeCodeConfigurationDialect,
  PortableClaudeCodeIntent,
} from "../../../contracts/claude-code-configuration-inspection.js";

export interface ClassifyClaudeCodeConfigurationResult {
  readonly definitions: readonly PortableClaudeCodeIntent[];
  readonly diagnostics: readonly ClaudeCodeConfigurationDiagnostic[];
  readonly definedPortableKeys: readonly ("model" | "effortLevel")[];
  readonly taintedPortableKeys: readonly ("model" | "effortLevel")[];
}

export interface ClaudeCodeConfigurationSemanticClassifier {
  classify(
    dialect: ClaudeCodeConfigurationDialect,
    data: Readonly<Record<string, unknown>>,
  ): ClassifyClaudeCodeConfigurationResult;
}
