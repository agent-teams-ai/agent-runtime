import type {
  ClaudeCodeConfigurationDiagnostic,
  ClaudeCodeConfigurationDialect,
  ClaudeCodeDeferredModelObservation,
  ClaudeCodeEffort,
  ClaudeCodeModelSelection,
} from "../../../contracts/claude-code-configuration-inspection.js";

export const claudeCodeConfigurationSemanticClassifierContract =
  "claude-code-portable-intent@2" as const;

export type PortableClaudeCodeDefinition =
  | { readonly key: "model"; readonly selection: ClaudeCodeModelSelection }
  | { readonly key: "effortLevel"; readonly value: ClaudeCodeEffort };

export type DeferredClaudeCodeDefinition = Omit<ClaudeCodeDeferredModelObservation, "sourceRef">;

export interface ClassifyClaudeCodeConfigurationResult {
  readonly definitions: readonly PortableClaudeCodeDefinition[];
  readonly deferredObservations: readonly DeferredClaudeCodeDefinition[];
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
