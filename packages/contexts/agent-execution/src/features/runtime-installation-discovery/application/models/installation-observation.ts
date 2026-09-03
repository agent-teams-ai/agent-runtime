export type InstallationCandidateSource =
  | "explicit"
  | "known-location"
  | "path-entry";

export interface InstallationCustodyBoundary {
  readonly absolutePath: string;
  readonly canonicalPath: string;
}

export interface CodexInstallationCandidate {
  readonly absolutePath: string;
  readonly authorizedFileIdentity?: string;
  readonly canonicalPath: string;
  readonly custodyRoot: InstallationCustodyBoundary;
  readonly displayPath: string;
  readonly required: boolean;
  readonly source: InstallationCandidateSource;
}

export interface ClaudeCodeInstallationCandidate
  extends CodexInstallationCandidate {
  readonly candidateIdentity: string;
  readonly priorityRank: 1 | 2 | 3 | 4 | 5;
}

export interface InstallationAliasObservation {
  readonly displayPath: string;
  readonly source: InstallationCandidateSource;
}

export interface InstallationObservation {
  readonly aliases: readonly InstallationAliasObservation[];
  readonly installationRef: string;
  readonly status: "found_unverified";
}

export type InstallationDiagnosticCode =
  | "candidate_denied"
  | "candidate_invalid"
  | "candidate_unreadable"
  | "candidate_unstable";

export interface CodexInstallationDiagnostic {
  readonly candidate: string;
  readonly code: InstallationDiagnosticCode;
}

export interface ClaudeCodeInstallationDiagnostic {
  readonly candidateRef?: string;
  readonly code: InstallationDiagnosticCode;
}

export interface DiscoverCodexInstallationsInput {
  readonly candidates: readonly CodexInstallationCandidate[];
  readonly observationEpoch: string;
}

export interface DiscoverCodexInstallationsResult {
  readonly diagnostics: readonly CodexInstallationDiagnostic[];
  readonly installations: readonly InstallationObservation[];
  readonly observationEpoch: string;
}

export interface DiscoverCodexInstallations {
  execute(
    input: DiscoverCodexInstallationsInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<DiscoverCodexInstallationsResult>;
}

export interface DiscoverClaudeCodeInstallationsInput {
  readonly candidates: readonly ClaudeCodeInstallationCandidate[];
  readonly observationEpoch: string;
}

export interface DiscoverClaudeCodeInstallationsResult {
  readonly diagnostics: readonly ClaudeCodeInstallationDiagnostic[];
  readonly installations: readonly InstallationObservation[];
}

export interface DiscoverClaudeCodeInstallations {
  execute(
    input: DiscoverClaudeCodeInstallationsInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<DiscoverClaudeCodeInstallationsResult>;
}
