import type {
  ClaudeCodeConfigurationDiagnostic,
  ClaudeCodeConfigurationDialect,
  ClaudeCodeEffort,
  ClaudeCodeModelAlias,
} from "../../../contracts/claude-code-configuration-inspection.js";

export const claudeCodeConfigurationSemanticClassifierContract =
  "claude-code-portable-intent@1" as const;

export type PortableClaudeCodeDefinition =
  | { readonly key: "model"; readonly value: ClaudeCodeModelAlias }
  | { readonly key: "effortLevel"; readonly value: ClaudeCodeEffort };

export interface ClassifyClaudeCodeConfigurationResult {
  readonly definitions: readonly PortableClaudeCodeDefinition[];
  readonly diagnostics: readonly ClaudeCodeConfigurationDiagnostic[];
  readonly definedPortableKeys: readonly ("model" | "effortLevel")[];
  readonly taintedPortableKeys: readonly ("model" | "effortLevel")[];
}

export interface ClaudeCodeConfigurationSemanticClassifier {
  readonly contract: typeof claudeCodeConfigurationSemanticClassifierContract;
  readonly revision: string;
  classify(
    dialect: ClaudeCodeConfigurationDialect,
    data: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal },
  ): ClassifyClaudeCodeConfigurationResult;
  supportsDialect(dialect: string): boolean;
}
