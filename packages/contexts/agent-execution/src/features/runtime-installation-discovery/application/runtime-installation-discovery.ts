export type InstallationCandidateSource =
  | "explicit"
  | "known-location"
  | "path-entry";

export interface InstallationCandidate {
  readonly absolutePath: string;
  readonly authorizedFileIdentity?: string;
  readonly canonicalPath: string;
  readonly custodyRoot:
    | {
        readonly absolutePath: string;
        readonly canonicalPath: string;
      }
    | undefined;
  readonly displayPath: string;
  readonly required: boolean;
  readonly source: InstallationCandidateSource;
}

export interface ClaudeCodeInstallationCandidate extends InstallationCandidate {
  readonly candidateIdentity: string;
  readonly custodyRoot: {
    readonly absolutePath: string;
    readonly canonicalPath: string;
  };
  readonly priorityRank: 1 | 2 | 3 | 4 | 5;
}

export interface InstallationAliasObservation {
  readonly displayPath: string;
  readonly source: InstallationCandidateSource;
}

export interface RuntimeInstallationObservation {
  readonly aliases: readonly InstallationAliasObservation[];
  readonly installationRef: string;
  readonly status: "found_unverified";
}

export type RuntimeInstallationDiagnosticCode =
  | "candidate_denied"
  | "candidate_invalid"
  | "candidate_unreadable"
  | "candidate_unstable";

export interface RuntimeInstallationDiagnostic {
  readonly candidate: string;
  readonly code: RuntimeInstallationDiagnosticCode;
}

export interface ClaudeCodeInstallationDiagnostic {
  readonly candidateRef?: string;
  readonly code: RuntimeInstallationDiagnosticCode;
}

export interface DiscoverCodexInstallationsInput {
  readonly candidates: readonly InstallationCandidate[];
  readonly observationEpoch: string;
}

export interface DiscoverCodexInstallationsResult {
  readonly diagnostics: readonly RuntimeInstallationDiagnostic[];
  readonly installations: readonly RuntimeInstallationObservation[];
  readonly observationEpoch: string;
}

export interface DiscoverClaudeCodeInstallationsInput {
  readonly candidates: readonly ClaudeCodeInstallationCandidate[];
  readonly observationEpoch: string;
}

export interface DiscoverClaudeCodeInstallationsResult {
  readonly diagnostics: readonly ClaudeCodeInstallationDiagnostic[];
  readonly installations: readonly RuntimeInstallationObservation[];
}

export interface DiscoveryExecutionOptions {
  readonly signal?: AbortSignal;
}

export interface DiscoverCodexInstallations {
  execute(
    input: DiscoverCodexInstallationsInput,
    options?: DiscoveryExecutionOptions,
  ): Promise<DiscoverCodexInstallationsResult>;
}

export interface DiscoverClaudeCodeInstallations {
  execute(
    input: DiscoverClaudeCodeInstallationsInput,
    options?: DiscoveryExecutionOptions,
  ): Promise<DiscoverClaudeCodeInstallationsResult>;
}
