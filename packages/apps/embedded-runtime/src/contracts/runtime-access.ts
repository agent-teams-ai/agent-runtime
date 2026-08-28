export interface InspectCodexRuntimeSetup {
  readonly nativeProfile?: string;
}

export interface CodexSetupInstallationView {
  readonly aliases: readonly {
    readonly displayPath: string;
    readonly source: "explicit" | "known-location" | "path-entry";
  }[];
  readonly installationRef: string;
  readonly status: "found_unverified";
}

export interface CodexSetupSourceView {
  readonly displayPath: string;
  readonly kind: "external-profile" | "user" | "workspace";
  readonly semanticDigest?: string;
  readonly sourceRef: string;
  readonly status:
    | "applied"
    | "malformed"
    | "missing"
    | "rejected"
    | "stale"
    | "unreadable";
}

export interface CodexSetupSettingView {
  readonly key: "model" | "model_reasoning_effort" | "personality";
  readonly sourceRef: string;
  readonly value: string;
}

export type CodexSetupDiagnosticCode =
  | "candidate_denied"
  | "candidate_invalid"
  | "candidate_unreadable"
  | "candidate_unstable"
  | "config_bom_rejected"
  | "config_invalid_utf8"
  | "config_parse_failed"
  | "config_too_large"
  | "config_unreadable"
  | "configuration_dialect_unsupported"
  | "empty_path_entry"
  | "executable_setting_deferred"
  | "native_profile_invalid"
  | "path_outside_scope"
  | "profile_missing"
  | "provider_access_setting_deferred"
  | "relative_path_entry"
  | "secret_setting_ignored"
  | "security_setting_deferred"
  | "setting_type_unsupported"
  | "setting_value_unsupported"
  | "source_epoch_stale"
  | "source_precedence_conflict"
  | "source_untrusted"
  | "unknown_setting_ignored";

export interface CodexSetupDiagnostic {
  readonly code: CodexSetupDiagnosticCode;
  readonly subject?: string;
}

export type InspectCodexRuntimeSetupOutcome =
  | {
      readonly diagnostics: readonly CodexSetupDiagnostic[];
      readonly status: "denied" | "unsupported";
    }
  | {
      readonly diagnostics: readonly CodexSetupDiagnostic[];
      readonly installations: readonly CodexSetupInstallationView[];
      readonly nextActions: readonly (
        | "install_codex"
        | "review_configuration"
        | "trust_workspace"
      )[];
      readonly observationRef: string;
      readonly settings: readonly CodexSetupSettingView[];
      readonly sources: readonly CodexSetupSourceView[];
      readonly status: "observed" | "partial";
    };

export interface CodexRuntimeSetupQueries {
  inspect(
    input: InspectCodexRuntimeSetup,
    options?: { readonly signal?: AbortSignal },
  ): Promise<InspectCodexRuntimeSetupOutcome>;
}

export type ClaudeCodeSetupDiagnosticCode =
  | "candidate_denied"
  | "candidate_invalid"
  | "candidate_unreadable"
  | "candidate_unstable"
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
  | "source_untrusted"
  | "source_epoch_stale"
  | "unsupported_platform";

export interface ClaudeCodeSetupDiagnostic {
  readonly code: ClaudeCodeSetupDiagnosticCode;
  readonly safeRef?: string;
}

export interface ClaudeCodeSetupInstallationView {
  readonly aliases: readonly {
    readonly displayPath: string;
    readonly source: "explicit" | "known-location" | "path-entry";
  }[];
  readonly installationRef: string;
  readonly status: "found_unverified";
}

export type ClaudeCodePortableIntentView =
  | {
      readonly key: "model";
      readonly sourceRef: string;
      readonly value: "default" | "best" | "fable" | "sonnet" | "opus" | "haiku" | "sonnet[1m]" | "opus[1m]" | "opusplan";
    }
  | {
      readonly key: "effortLevel";
      readonly sourceRef: string;
      readonly value: "low" | "medium" | "high" | "xhigh";
    };

export interface ClaudeCodeSetupSourceObservationView {
  readonly displayPath: string;
  readonly kind: "user" | "shared-project" | "project-local";
  readonly sourceRef: string;
  readonly status: "applied" | "malformed" | "missing" | "rejected" | "stale" | "unreadable";
}

export interface ClaudeCodeSetupExpectedLimitations {
  readonly interactiveShellPath: "unobserved";
  readonly managedPolicy: "unobserved";
  readonly sessionOverrides: "unobserved";
}

interface ClaudeCodeSetupOutcomeBase {
  readonly diagnostics: readonly ClaudeCodeSetupDiagnostic[];
  readonly expectedLimitations: ClaudeCodeSetupExpectedLimitations;
}

export type InspectClaudeCodeRuntimeSetupOutcome =
  | (ClaudeCodeSetupOutcomeBase & { readonly status: "denied" | "unsupported" })
  | (ClaudeCodeSetupOutcomeBase & {
      readonly installations: readonly ClaudeCodeSetupInstallationView[];
      readonly nextActions: readonly ("install_claude_code" | "review_configuration" | "trust_workspace")[];
      readonly observationRef: string;
      readonly portableIntent: readonly ClaudeCodePortableIntentView[];
      readonly sourceObservations: readonly ClaudeCodeSetupSourceObservationView[];
      readonly status: "observed" | "partial";
    });

export interface ClaudeCodeRuntimeSetupQueries {
  inspect(
    options?: { readonly signal?: AbortSignal },
  ): Promise<InspectClaudeCodeRuntimeSetupOutcome>;
}

/** Prospective private handle shape; the contract spine does not compose it yet. */
export interface ClaudeCodeRuntimeAccessHandle {
  readonly claudeCodeSetup: ClaudeCodeRuntimeSetupQueries;
}

export interface RuntimeAccessHandle {
  readonly codexSetup: CodexRuntimeSetupQueries;
}
