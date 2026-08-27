export type InstallationCandidateSource =
  | "explicit"
  | "known-location"
  | "path-entry";

export interface InstallationCandidate {
  readonly absolutePath: string;
  readonly authorizedFileIdentity?: string;
  readonly canonicalPath: string;
  readonly custodyRoot: {
    readonly absolutePath: string;
    readonly canonicalPath: string;
  };
  readonly displayPath: string;
  readonly required: boolean;
  readonly source: InstallationCandidateSource;
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

export interface RuntimeInstallationDiagnostic {
  readonly candidate: string;
  readonly code:
    | "candidate_denied"
    | "candidate_invalid"
    | "candidate_unstable"
    | "candidate_unreadable";
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

export interface DiscoverCodexInstallations {
  execute(
    input: DiscoverCodexInstallationsInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<DiscoverCodexInstallationsResult>;
}
