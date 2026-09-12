import type {
  CodexInspectionDiagnostic,
  CodexSettingKey,
} from "../../models/codex-inspection-models.js";

export const codexConfigurationSemanticClassifierContract =
  "codex-configuration-semantic-classifier/v1" as const;

export interface CodexConfigurationSemanticClassification {
  readonly diagnostics: readonly Pick<
    CodexInspectionDiagnostic,
    "code" | "setting"
  >[];
  readonly settings: readonly {
    readonly key: CodexSettingKey;
    readonly value: string;
  }[];
}

export interface CodexConfigurationSemanticClassifier {
  readonly contract: typeof codexConfigurationSemanticClassifierContract;
  readonly revision: string;
  classify(
    dialect: string,
    document: Readonly<Record<string, unknown>>,
  ): CodexConfigurationSemanticClassification;
  supportsDialect(dialect: string): boolean;
}
