export type PortableCodexSettingKey =
  | "model"
  | "model_reasoning_effort"
  | "personality";

export interface CodexConfigurationSource {
  readonly absolutePath: string;
  readonly authorizedFileIdentity?: string;
  readonly canonicalPath: string;
  readonly displayPath: string;
  readonly kind: "user" | "workspace";
  readonly observationEpoch: string;
}

export interface InspectCodexConfigurationInput {
  readonly identityScope: string;
  readonly nativeProfile?: string;
  readonly observationEpoch: string;
  readonly sources: readonly CodexConfigurationSource[];
}

export interface PortableCodexSettingObservation {
  readonly key: PortableCodexSettingKey;
  readonly sourceRef: string;
  readonly value: string;
}

export interface CodexConfigurationSourceObservation {
  readonly displayPath: string;
  readonly kind: "user" | "workspace";
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

export interface CodexConfigurationDiagnostic {
  readonly code:
    | "config_bom_rejected"
    | "config_invalid_utf8"
    | "config_parse_failed"
    | "config_too_large"
    | "config_unreadable"
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
  readonly setting?: string;
  readonly sourceRef?: string;
}

export interface InspectCodexConfigurationResult {
  readonly diagnostics: readonly CodexConfigurationDiagnostic[];
  readonly settings: readonly PortableCodexSettingObservation[];
  readonly sources: readonly CodexConfigurationSourceObservation[];
}

export interface InspectCodexConfiguration {
  execute(
    input: InspectCodexConfigurationInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<InspectCodexConfigurationResult>;
}
