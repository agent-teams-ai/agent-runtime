export const claudeCodeConfigurationSemanticClassifierContract =
  "claude-code-portable-intent@2" as const;

/** Classifier-facing application contracts are declared at the consuming port.
 * They intentionally do not alias the similarly shaped transport declarations. */
export type ClaudeCodeSemanticClassifierDialect = "claude-code-settings@2026-08-28";

export type PortableClaudeCodeModelName =
  | "best"
  | "fable"
  | "sonnet"
  | "opus"
  | "haiku"
  | "sonnet[1m]"
  | "opus[1m]"
  | "opusplan";

export type PortableClaudeCodeModelSelection =
  | { readonly kind: "provider-default" }
  | { readonly kind: "alias"; readonly value: PortableClaudeCodeModelName }
  | { readonly kind: "exact-name"; readonly value: string };

export type PortableClaudeCodeEffortLevel = "low" | "medium" | "high" | "xhigh";

export type PortableClaudeCodeDefinition =
  | { readonly key: "model"; readonly selection: PortableClaudeCodeModelSelection }
  | { readonly key: "effortLevel"; readonly value: PortableClaudeCodeEffortLevel };

export interface DeferredClaudeCodeDefinition {
  readonly form: "provider-deployment" | "unclassified-selector";
  readonly key: "model";
  readonly status: "deferred";
}

export type ClaudeCodeSemanticClassifierDiagnosticCode =
  | "configuration_dialect_unsupported"
  | "config_duplicate_key"
  | "config_invalid_utf8"
  | "config_parse_failed"
  | "config_too_large"
  | "config_unreadable"
  | "credential_material_rejected"
  | "provider_route_deferred"
  | "secret_setting_rejected"
  | "setting_type_unsupported"
  | "setting_value_unsupported"
  | "source_epoch_stale"
  | "source_inventory_overflow"
  | "source_plan_invalid"
  | "source_plan_unsupported"
  | "source_total_too_large"
  | "source_untrusted";

export interface ClaudeCodeSemanticClassifierDiagnostic {
  readonly code: ClaudeCodeSemanticClassifierDiagnosticCode;
  readonly safeRef?: string;
}

export interface ClassifyClaudeCodeConfigurationResult {
  readonly definitions: readonly PortableClaudeCodeDefinition[];
  readonly deferredObservations: readonly DeferredClaudeCodeDefinition[];
  readonly diagnostics: readonly ClaudeCodeSemanticClassifierDiagnostic[];
  readonly definedPortableKeys: readonly ("model" | "effortLevel")[];
  readonly taintedPortableKeys: readonly ("model" | "effortLevel")[];
}

export interface ClaudeCodeConfigurationSemanticClassifier {
  readonly contract: typeof claudeCodeConfigurationSemanticClassifierContract;
  readonly revision: string;
  classify(
    dialect: ClaudeCodeSemanticClassifierDialect,
    data: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal },
  ): ClassifyClaudeCodeConfigurationResult;
  supportsDialect(dialect: string): boolean;
}
