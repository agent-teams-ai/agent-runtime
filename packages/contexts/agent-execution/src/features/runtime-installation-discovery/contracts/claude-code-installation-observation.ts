export type ClaudeCodeInstallationCandidateSource =
  | "explicit"
  | "known-location"
  | "path-entry";

export interface ClaudeCodeInstallationCandidate {
  readonly absolutePath: string;
  readonly authorizedFileIdentity?: string;
  readonly canonicalPath: string;
  readonly custodyRoot: {
    readonly absolutePath: string;
    readonly canonicalPath: string;
  };
  readonly displayPath: string;
  readonly required: boolean;
  readonly source: ClaudeCodeInstallationCandidateSource;
}

export interface ClaudeCodeInstallationObservation {
  readonly aliases: readonly {
    readonly displayPath: string;
    readonly source: ClaudeCodeInstallationCandidateSource;
  }[];
  readonly installationRef: string;
  readonly status: "found_unverified";
}

export interface ClaudeCodeInstallationDiagnostic {
  readonly candidateRef?: string;
  readonly code:
    | "candidate_denied"
    | "candidate_invalid"
    | "candidate_unreadable"
    | "candidate_unstable";
}

export interface DiscoverClaudeCodeInstallationsInput {
  readonly candidates: readonly ClaudeCodeInstallationCandidate[];
  readonly observationEpoch: string;
}

export interface DiscoverClaudeCodeInstallationsResult {
  readonly diagnostics: readonly ClaudeCodeInstallationDiagnostic[];
  readonly installations: readonly ClaudeCodeInstallationObservation[];
}

export interface DiscoverClaudeCodeInstallations {
  execute(
    input: DiscoverClaudeCodeInstallationsInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<DiscoverClaudeCodeInstallationsResult>;
}
