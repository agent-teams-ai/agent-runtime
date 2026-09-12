/** Application-owned inspection models.
 *
 * These mirror what the use case needs, not what a caller transports. The
 * external contract in `contracts/` is a separate declaration with its own
 * compatibility story, and an inbound adapter maps between the two. Keeping them
 * apart is what lets the contract change a field name, add an optional field or
 * accept a looser input shape without the use case moving. */

export type CodexSettingKey = "model" | "model_reasoning_effort" | "personality";

export type CodexSourceKind = "external-profile" | "user" | "workspace";

export interface CodexSourceSelection {
  readonly absolutePath: string;
  readonly authorizedFileIdentity?: string;
  readonly canonicalPath: string;
  readonly custodyRoot: {
    readonly absolutePath: string;
    readonly canonicalPath: string;
  };
  readonly displayPath: string;
  readonly kind: CodexSourceKind;
  readonly observationEpoch: string;
  readonly profileName?: string;
  /** Zero-based, closest-to-outermost project configuration order from Codex. */
  readonly workspaceLayer?: number;
}

export interface CodexInspectionRequest {
  readonly dialect: string;
  readonly identityScope: string;
  readonly nativeProfile?: string;
  readonly observationEpoch: string;
  readonly sources: readonly CodexSourceSelection[];
}

export interface CodexSettingObservation {
  readonly key: CodexSettingKey;
  readonly sourceRef: string;
  readonly value: string;
}

export type CodexSourceStatus =
  | "applied"
  | "malformed"
  | "missing"
  | "rejected"
  | "stale"
  | "unreadable";

export interface CodexSourceObservation {
  readonly displayPath: string;
  readonly kind: CodexSourceKind;
  readonly semanticDigest?: string;
  readonly sourceRef: string;
  readonly status: CodexSourceStatus;
}

export type CodexInspectionDiagnosticCode =
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

export interface CodexInspectionDiagnostic {
  readonly code: CodexInspectionDiagnosticCode;
  readonly setting?: string;
  readonly sourceRef?: string;
}

export interface CodexInspectionOutcome {
  readonly diagnostics: readonly CodexInspectionDiagnostic[];
  readonly settings: readonly CodexSettingObservation[];
  readonly sources: readonly CodexSourceObservation[];
}

export interface InspectCodexConfigurationUseCase {
  execute(
    request: CodexInspectionRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CodexInspectionOutcome>;
}
