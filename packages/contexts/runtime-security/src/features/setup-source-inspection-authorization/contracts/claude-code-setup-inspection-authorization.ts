export type ClaudeCodePortableSourceKind =
  | "user"
  | "shared-project"
  | "project-local";

export interface TrustedClaudeCodeSetupInspectionScope {
  readonly dialect: "claude-code-settings@2026-08-28";
  readonly explicitExecutablePaths: readonly string[];
  readonly homeRoot: string;
  readonly observationEpoch: string;
  readonly pathEntries: readonly string[];
  readonly workspaceRoot: string;
  readonly workspaceTrusted: boolean;
}

export interface AuthorizedClaudeCodePortableSource {
  readonly absolutePath: string;
  readonly authorizedFileIdentity?: string;
  readonly canonicalPath: string;
  readonly custodyRoot: {
    readonly absolutePath: string;
    readonly canonicalPath: string;
  };
  readonly displayPath: string;
  readonly kind: ClaudeCodePortableSourceKind;
  readonly observationEpoch: string;
}

export interface AuthorizedClaudeCodeExecutableCandidate {
  readonly absolutePath: string;
  readonly authorizedFileIdentity?: string;
  readonly canonicalPath: string;
  readonly custodyRoot: {
    readonly absolutePath: string;
    readonly canonicalPath: string;
  };
  readonly displayPath: string;
  readonly priorityRank: 1 | 2 | 3 | 4 | 5;
  readonly source: "explicit" | "known-location" | "path-entry";
}

export interface ClaudeCodeSetupAuthorizationDiagnostic {
  readonly code:
    | "candidate_denied"
    | "candidate_invalid"
    | "candidate_unreadable"
    | "candidate_unstable"
    | "source_untrusted"
    | "source_epoch_stale";
  readonly safeRef?: string;
}

export type AuthorizeClaudeCodeSetupInspectionResult =
  | {
      readonly diagnostics: readonly ClaudeCodeSetupAuthorizationDiagnostic[];
      readonly status: "denied";
    }
  | {
      readonly diagnostics: readonly ClaudeCodeSetupAuthorizationDiagnostic[];
      readonly executableCandidates: readonly AuthorizedClaudeCodeExecutableCandidate[];
      readonly observationEpoch: string;
      readonly sources: readonly AuthorizedClaudeCodePortableSource[];
      readonly status: "authorized";
    };

export interface AuthorizeClaudeCodeSetupInspection {
  execute(
    scope: TrustedClaudeCodeSetupInspectionScope,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AuthorizeClaudeCodeSetupInspectionResult>;
}
