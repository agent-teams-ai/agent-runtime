export const CLAUDE_CODE_SETTINGS_DIALECT = "claude-code-settings@2026-08-28" as const;

export const CLAUDE_CODE_MODEL_ALIASES = [
  "default",
  "best",
  "fable",
  "sonnet",
  "opus",
  "haiku",
  "sonnet[1m]",
  "opus[1m]",
  "opusplan",
] as const;

export const CLAUDE_CODE_EFFORT_VALUES = ["low", "medium", "high", "xhigh"] as const;

export const CLAUDE_CODE_CONFIGURATION_BUDGETS = Object.freeze({
  arrayItems: 1_024,
  bytesPerSource: 128 * 1_024,
  classifierValueLength: 256,
  depth: 16,
  diagnostics: 1_024,
  keyLength: 256,
  nodes: 4_096,
  objectKeys: 1_024,
  sourceSlots: 3,
  stringLength: 16_384,
});

export type ClaudeCodeConfigurationDialect = typeof CLAUDE_CODE_SETTINGS_DIALECT;
export type ClaudeCodeModelAlias = typeof CLAUDE_CODE_MODEL_ALIASES[number];
export type ClaudeCodeEffort = typeof CLAUDE_CODE_EFFORT_VALUES[number];
export type ClaudeCodeConfigurationSourceKind = "user" | "shared-project" | "project-local";

interface ClaudeCodeConfigurationSourceEvidence {
  readonly displayPath: string;
  readonly kind: ClaudeCodeConfigurationSourceKind;
  readonly observationEpoch: string;
}

export type ClaudeCodeConfigurationSource =
  | (ClaudeCodeConfigurationSourceEvidence & {
      readonly access: "authorized";
      readonly absolutePath: string;
      readonly authorizedFileIdentity?: string;
      readonly canonicalPath: string;
      readonly custodyRoot: {
        readonly absolutePath: string;
        readonly canonicalPath: string;
      };
    })
  | (ClaudeCodeConfigurationSourceEvidence & {
      readonly access: "rejected" | "stale" | "untrusted";
    });

export interface ClaudeCodeSourceObservation {
  readonly displayPath: string;
  readonly kind: ClaudeCodeConfigurationSourceKind;
  readonly semanticDigest?: string;
  readonly sourceRef: string;
  readonly status: "applied" | "malformed" | "missing" | "rejected" | "stale" | "unreadable";
}

export type PortableClaudeCodeIntent =
  | { readonly key: "model"; readonly sourceRef: string; readonly value: ClaudeCodeModelAlias }
  | { readonly key: "effortLevel"; readonly sourceRef: string; readonly value: ClaudeCodeEffort };

export type ClaudeCodeConfigurationDiagnosticCode =
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
  | "source_untrusted";

export interface ClaudeCodeConfigurationDiagnostic {
  readonly code: ClaudeCodeConfigurationDiagnosticCode;
  readonly safeRef?: string;
}

export interface InspectClaudeCodeConfigurationInput {
  readonly dialect: ClaudeCodeConfigurationDialect;
  readonly identityScope: string;
  readonly observationEpoch: string;
  readonly sources: readonly ClaudeCodeConfigurationSource[];
}

export interface InspectClaudeCodeConfigurationResult {
  readonly diagnostics: readonly ClaudeCodeConfigurationDiagnostic[];
  readonly portableIntent: readonly PortableClaudeCodeIntent[];
  readonly sources: readonly ClaudeCodeSourceObservation[];
}

export interface InspectClaudeCodeConfiguration {
  execute(
    input: InspectClaudeCodeConfigurationInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<InspectClaudeCodeConfigurationResult>;
}
