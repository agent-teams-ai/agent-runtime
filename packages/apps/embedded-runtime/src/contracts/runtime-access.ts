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
  readonly contentDigest?: string;
  readonly displayPath: string;
  readonly kind: "user" | "workspace";
  readonly sourceRef: string;
  readonly status: "applied" | "malformed" | "missing" | "stale" | "unreadable";
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
  | "source_epoch_stale"
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
      readonly status: "complete" | "partial";
    };

export interface CodexRuntimeSetupQueries {
  inspect(
    input: InspectCodexRuntimeSetup,
    options?: { readonly signal?: AbortSignal },
  ): Promise<InspectCodexRuntimeSetupOutcome>;
}

export interface RuntimeAccessHandle {
  readonly codexSetup: CodexRuntimeSetupQueries;
}
