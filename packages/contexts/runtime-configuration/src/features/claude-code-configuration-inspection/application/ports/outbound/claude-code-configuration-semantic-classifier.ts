import type { ClaudeCodeDialect, ClaudeCodeEffortLevel } from "../../models/claude-code-vocabulary.js";
import type {
  ClaudeCodeDeferredModelObservation,
  ClaudeCodeInspectionDiagnostic,
  ClaudeCodeModelSelection,
} from "../../models/claude-code-inspection-models.js";

export const claudeCodeConfigurationSemanticClassifierContract =
  "claude-code-portable-intent@2" as const;

export type PortableClaudeCodeDefinition =
  | { readonly key: "model"; readonly selection: ClaudeCodeModelSelection }
  | { readonly key: "effortLevel"; readonly value: ClaudeCodeEffortLevel };

export type DeferredClaudeCodeDefinition = Omit<ClaudeCodeDeferredModelObservation, "sourceRef">;

export interface ClassifyClaudeCodeConfigurationResult {
  readonly definitions: readonly PortableClaudeCodeDefinition[];
  readonly deferredObservations: readonly DeferredClaudeCodeDefinition[];
  readonly diagnostics: readonly ClaudeCodeInspectionDiagnostic[];
  readonly definedPortableKeys: readonly ("model" | "effortLevel")[];
  readonly taintedPortableKeys: readonly ("model" | "effortLevel")[];
}

export interface ClaudeCodeConfigurationSemanticClassifier {
  readonly contract: typeof claudeCodeConfigurationSemanticClassifierContract;
  readonly revision: string;
  classify(
    dialect: ClaudeCodeDialect,
    data: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal },
  ): ClassifyClaudeCodeConfigurationResult;
  supportsDialect(dialect: string): boolean;
}
