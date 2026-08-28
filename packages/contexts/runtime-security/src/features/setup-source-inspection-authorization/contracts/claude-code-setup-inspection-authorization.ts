export type ClaudeCodePortableSourceKind =
  | "user"
  | "shared-project"
  | "project-local";

export interface TrustedClaudeCodeSetupInspectionScope {
  readonly candidatePaths: readonly {
    readonly absolutePath: string;
    readonly priorityRank: 1 | 2 | 3 | 4 | 5;
    readonly source: "explicit" | "known-location" | "path-entry";
  }[];
  readonly dialect: "claude-code-settings@2026-08-28";
  readonly homeRoot: string;
  readonly observationEpoch: string;
  readonly sourcePaths: readonly {
    readonly absolutePath: string;
    readonly kind: ClaudeCodePortableSourceKind;
  }[];
  readonly workspaceRoot: string;
  readonly workspaceTrusted: boolean;
}

interface ClaudeCodePortableSourceEvidence {
  readonly displayPath: string;
  readonly kind: ClaudeCodePortableSourceKind;
  readonly observationEpoch: string;
}

export type AuthorizedClaudeCodePortableSource =
  | (ClaudeCodePortableSourceEvidence & {
      readonly access: "authorized";
      readonly absolutePath: string;
      readonly authorizedFileIdentity?: string;
      readonly canonicalPath: string;
      readonly custodyRoot: {
        readonly absolutePath: string;
        readonly canonicalPath: string;
      };
    })
  | (ClaudeCodePortableSourceEvidence & {
      readonly access: "rejected" | "stale" | "untrusted";
    });

export interface AuthorizedClaudeCodeCanonicalRoot {
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly kind: "home" | "workspace";
}

export interface AuthorizedClaudeCodeExecutableCandidate {
  readonly absolutePath: string;
  readonly authorizedFileIdentity?: string;
  readonly candidateIdentity: string;
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
      readonly canonicalRoots: readonly AuthorizedClaudeCodeCanonicalRoot[];
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
