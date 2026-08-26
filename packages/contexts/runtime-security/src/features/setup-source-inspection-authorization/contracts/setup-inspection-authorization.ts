export type SetupPathRootKind = "home" | "system" | "workspace";

export interface TrustedSetupPathRoot {
  readonly absolutePath: string;
  readonly displayName: string;
  readonly kind: SetupPathRootKind;
}

export interface TrustedConfigurationSource {
  readonly absolutePath: string;
  readonly kind: "user" | "workspace";
  readonly precedence: number;
  readonly workspaceTrusted: boolean;
}

export interface AuthorizeSetupInspectionInput {
  readonly configurationSources: readonly TrustedConfigurationSource[];
  readonly explicitExecutablePaths: readonly string[];
  readonly knownExecutableDirectories: readonly string[];
  readonly observationEpoch: string;
  readonly pathEntries: readonly string[];
  readonly platform: string;
  readonly roots: readonly TrustedSetupPathRoot[];
}

export interface AuthorizedInstallationCandidate {
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly displayPath: string;
  readonly required: boolean;
  readonly source: "explicit" | "known-location" | "path-entry";
}

export interface AuthorizedConfigurationSource {
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly displayPath: string;
  readonly kind: "user" | "workspace";
  readonly observationEpoch: string;
  readonly precedence: number;
  readonly sourceRef: string;
}

export interface SetupAuthorizationDiagnostic {
  readonly code:
    | "empty_path_entry"
    | "path_outside_scope"
    | "relative_path_entry"
    | "source_untrusted";
  readonly subject: string;
}

export type AuthorizeSetupInspectionResult =
  | {
      readonly diagnostics: readonly SetupAuthorizationDiagnostic[];
      readonly status: "denied" | "unsupported";
    }
  | {
      readonly configurationSources: readonly AuthorizedConfigurationSource[];
      readonly diagnostics: readonly SetupAuthorizationDiagnostic[];
      readonly installationCandidates: readonly AuthorizedInstallationCandidate[];
      readonly observationEpoch: string;
      readonly status: "authorized";
    };

export interface AuthorizeSetupInspection {
  execute(
    input: AuthorizeSetupInspectionInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AuthorizeSetupInspectionResult>;
}
