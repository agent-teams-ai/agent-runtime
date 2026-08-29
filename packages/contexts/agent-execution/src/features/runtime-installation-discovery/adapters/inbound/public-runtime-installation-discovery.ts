import type {
  DiscoverClaudeCodeInstallations as InternalDiscoverClaudeCodeInstallations,
  DiscoverCodexInstallations as InternalDiscoverCodexInstallations,
} from "../../application/runtime-installation-discovery.js";
import type {
  ClaudeCodeInstallationCandidate,
  DiscoverClaudeCodeInstallations,
  DiscoverClaudeCodeInstallationsInput,
  DiscoverClaudeCodeInstallationsResult,
} from "../../contracts/claude-code-installation-observation.js";
import type {
  DiscoverCodexInstallations,
  DiscoverCodexInstallationsInput,
  DiscoverCodexInstallationsResult,
  InstallationCandidate,
} from "../../contracts/runtime-installation-observation.js";

const mapCustodyRoot = (root: {
  readonly absolutePath: string;
  readonly canonicalPath: string;
}) => ({
  absolutePath: root.absolutePath,
  canonicalPath: root.canonicalPath,
});

const mapCandidate = (candidate: InstallationCandidate) => ({
  absolutePath: candidate.absolutePath,
  ...(candidate.authorizedFileIdentity === undefined
    ? {}
    : { authorizedFileIdentity: candidate.authorizedFileIdentity }),
  canonicalPath: candidate.canonicalPath,
  custodyRoot:
    candidate.custodyRoot === undefined
      ? candidate.custodyRoot
      : mapCustodyRoot(candidate.custodyRoot),
  displayPath: candidate.displayPath,
  required: candidate.required,
  source: candidate.source,
});

const mapClaudeCandidate = (candidate: ClaudeCodeInstallationCandidate) => ({
  ...mapCandidate(candidate),
  candidateIdentity: candidate.candidateIdentity,
  priorityRank: candidate.priorityRank,
});

const mapInstallations = (
  installations: readonly {
    readonly aliases: readonly {
      readonly displayPath: string;
      readonly source: "explicit" | "known-location" | "path-entry";
    }[];
    readonly installationRef: string;
    readonly status: "found_unverified";
  }[],
) =>
  installations.map(installation => ({
    aliases: installation.aliases.map(alias => ({ ...alias })),
    installationRef: installation.installationRef,
    status: installation.status,
  }));

export const mapDiscoverCodexInstallations = (
  useCase: InternalDiscoverCodexInstallations,
): DiscoverCodexInstallations =>
  Object.freeze({
    async execute(
      input: DiscoverCodexInstallationsInput,
      options?: { readonly signal?: AbortSignal },
    ): Promise<DiscoverCodexInstallationsResult> {
      options?.signal?.throwIfAborted();
      const result = await useCase.execute(
        {
          candidates: input.candidates.map(mapCandidate),
          observationEpoch: input.observationEpoch,
        },
        options,
      );
      return {
        diagnostics: result.diagnostics.map(diagnostic => ({ ...diagnostic })),
        installations: mapInstallations(result.installations),
        observationEpoch: result.observationEpoch,
      };
    },
  });

export const mapDiscoverClaudeCodeInstallations = (
  useCase: InternalDiscoverClaudeCodeInstallations,
): DiscoverClaudeCodeInstallations =>
  Object.freeze({
    async execute(
      input: DiscoverClaudeCodeInstallationsInput,
      options?: { readonly signal?: AbortSignal },
    ): Promise<DiscoverClaudeCodeInstallationsResult> {
      options?.signal?.throwIfAborted();
      const result = await useCase.execute(
        {
          candidates: input.candidates.map(mapClaudeCandidate),
          observationEpoch: input.observationEpoch,
        },
        options,
      );
      return Object.freeze({
        diagnostics: Object.freeze(
          result.diagnostics.map(diagnostic => Object.freeze({ ...diagnostic })),
        ),
        installations: Object.freeze(
          mapInstallations(result.installations).map(installation =>
            Object.freeze({
              ...installation,
              aliases: Object.freeze(
                installation.aliases.map(alias => Object.freeze(alias)),
              ),
            }),
          ),
        ),
      });
    },
  });
