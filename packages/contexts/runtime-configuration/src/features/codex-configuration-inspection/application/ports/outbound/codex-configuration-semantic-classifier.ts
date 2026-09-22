export const codexConfigurationSemanticClassifierContract =
  "codex-configuration-semantic-classifier/v1" as const;

/** The complete application diagnostic vocabulary accepted from a classifier.
 * This is a classifier-port contract, not the transport diagnostic declaration.
 * The inbound adapter keeps the independently owned application and transport
 * declarations aligned without making this outbound port depend on either. */
export type CodexConfigurationSemanticDiagnosticCode =
  | "config_bom_rejected"
  | "config_invalid_utf8"
  | "config_parse_failed"
  | "config_too_large"
  | "config_unreadable"
  | "configuration_dialect_unsupported"
  | "executable_setting_deferred"
  | "profile_missing"
  | "provider_access_setting_deferred"
  | "secret_setting_ignored"
  | "security_setting_deferred"
  | "setting_type_unsupported"
  | "setting_value_unsupported"
  | "source_epoch_stale"
  | "source_precedence_conflict"
  | "unknown_setting_ignored";

export type CodexConfigurationSemanticSettingKey =
  | "model"
  | "model_reasoning_effort"
  | "personality";

export interface CodexConfigurationSemanticDiagnostic {
  readonly code: CodexConfigurationSemanticDiagnosticCode;
  readonly setting?: string;
}

export interface CodexConfigurationSemanticSetting {
  readonly key: CodexConfigurationSemanticSettingKey;
  readonly value: string;
}

export interface CodexConfigurationSemanticClassification {
  readonly diagnostics: readonly CodexConfigurationSemanticDiagnostic[];
  readonly settings: readonly CodexConfigurationSemanticSetting[];
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
