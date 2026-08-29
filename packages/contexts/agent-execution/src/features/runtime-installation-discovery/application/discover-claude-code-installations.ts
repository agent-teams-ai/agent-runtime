import type {
  ClaudeCodeInstallationCandidate,
  ClaudeCodeInstallationDiagnostic,
  DiscoverClaudeCodeInstallations,
  DiscoverClaudeCodeInstallationsResult,
  RuntimeInstallationObservation,
} from "./runtime-installation-discovery.js";
import type { ExecutableFileObserver } from "./ports/outbound/executable-file-observation.js";
import type { ReferenceDigest } from "./ports/outbound/reference-digest.js";

const MAXIMUM_CANDIDATES = 256;
const MAXIMUM_EXPLICIT_CANDIDATES = 16;
const MAXIMUM_PATH_ENTRY_CANDIDATES = 64;
const MAXIMUM_ALIASES_PER_INSTALLATION = 256;

const diagnosticCode = {
  denied: "candidate_denied",
  invalid: "candidate_invalid",
  unstable: "candidate_unstable",
  unreadable: "candidate_unreadable",
} as const;

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const compareCandidates = (
  left: ClaudeCodeInstallationCandidate,
  right: ClaudeCodeInstallationCandidate,
): number => {
  const priorityDifference = left.priorityRank - right.priorityRank;
  if (priorityDifference !== 0) {
    return priorityDifference;
  }
  return (
    compareText(left.candidateIdentity, right.candidateIdentity) ||
    compareText(left.canonicalPath, right.canonicalPath) ||
    compareText(left.absolutePath, right.absolutePath)
  );
};

const candidateKey = (candidate: ClaudeCodeInstallationCandidate): string =>
  [
    candidate.source,
    candidate.candidateIdentity,
    String(candidate.priorityRank),
    candidate.absolutePath,
    candidate.canonicalPath,
    candidate.authorizedFileIdentity ?? "",
    candidate.custodyRoot.absolutePath,
    candidate.custodyRoot.canonicalPath,
    String(candidate.required),
  ].join("\u0000");

const detachCandidate = (
  candidate: ClaudeCodeInstallationCandidate,
): ClaudeCodeInstallationCandidate =>
  Object.freeze({
    absolutePath: candidate.absolutePath,
    ...(candidate.authorizedFileIdentity === undefined
      ? {}
      : { authorizedFileIdentity: candidate.authorizedFileIdentity }),
    candidateIdentity: candidate.candidateIdentity,
    canonicalPath: candidate.canonicalPath,
    custodyRoot: Object.freeze({
      absolutePath: candidate.custodyRoot.absolutePath,
      canonicalPath: candidate.custodyRoot.canonicalPath,
    }),
    displayPath: candidate.displayPath,
    priorityRank: candidate.priorityRank,
    required: candidate.required,
    source: candidate.source,
  });

interface GroupedInstallation {
  readonly aliases: Array<{
    readonly displayPath: string;
    readonly source: ClaudeCodeInstallationCandidate["source"];
  }>;
  readonly identity: string;
}

const freezeDiagnostic = (
  diagnostic: ClaudeCodeInstallationDiagnostic,
): ClaudeCodeInstallationDiagnostic => Object.freeze(diagnostic);

const freezeResult = (
  diagnostics: ClaudeCodeInstallationDiagnostic[],
  installations: RuntimeInstallationObservation[],
): DiscoverClaudeCodeInstallationsResult =>
  Object.freeze({
    diagnostics: Object.freeze(diagnostics.map(freezeDiagnostic)),
    installations: Object.freeze(
      installations.map(installation =>
        Object.freeze({
          ...installation,
          aliases: Object.freeze(
            installation.aliases.map(alias => Object.freeze(alias)),
          ),
        }),
      ),
    ),
  });

const candidateOverflowRef = (
  candidates: readonly ClaudeCodeInstallationCandidate[],
): string | undefined => {
  if (candidates.length > MAXIMUM_CANDIDATES) {
    return "claude-code-candidate-set:overflow";
  }
  if (
    candidates.filter(candidate => candidate.source === "explicit").length >
    MAXIMUM_EXPLICIT_CANDIDATES
  ) {
    return "claude-code-explicit-candidate-set:overflow";
  }
  if (
    candidates.filter(candidate => candidate.source === "path-entry").length >
    MAXIMUM_PATH_ENTRY_CANDIDATES
  ) {
    return "claude-code-path-entry-candidate-set:overflow";
  }
  return undefined;
};

export const createDiscoverClaudeCodeInstallations = (
  fileObserver: ExecutableFileObserver,
  referenceDigest: ReferenceDigest,
): DiscoverClaudeCodeInstallations => ({
  async execute(input, options): Promise<DiscoverClaudeCodeInstallationsResult> {
    options?.signal?.throwIfAborted();
    if (input.observationEpoch.length === 0) {
      throw new TypeError("observationEpoch must not be empty");
    }
    const overflowRef = candidateOverflowRef(input.candidates);
    if (overflowRef !== undefined) {
      return freezeResult(
        [
          {
            candidateRef: overflowRef,
            code: "candidate_invalid",
          },
        ],
        [],
      );
    }

    const candidates = input.candidates.map(detachCandidate).toSorted(compareCandidates);
    const seenCandidates = new Set<string>();
    const grouped = new Map<string, GroupedInstallation>();
    const diagnostics: ClaudeCodeInstallationDiagnostic[] = [];

    for (const candidate of candidates) {
      options?.signal?.throwIfAborted();
      const key = candidateKey(candidate);
      if (seenCandidates.has(key)) {
        continue;
      }
      seenCandidates.add(key);

      const observation = await fileObserver.observe({
        absolutePath: candidate.absolutePath,
        authorizedFileIdentity: candidate.authorizedFileIdentity,
        custodyBoundary: candidate.custodyRoot,
        expectedCanonicalPath: candidate.canonicalPath,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      options?.signal?.throwIfAborted();

      if (observation.kind === "missing") {
        if (candidate.required) {
          diagnostics.push({
            candidateRef: `claude-code-candidate:${referenceDigest.sha256(candidate.candidateIdentity)}`,
            code: "candidate_invalid",
          });
        }
        continue;
      }
      if (observation.kind !== "found") {
        diagnostics.push({
          candidateRef: `claude-code-candidate:${referenceDigest.sha256(candidate.candidateIdentity)}`,
          code: diagnosticCode[observation.kind],
        });
        continue;
      }

      const installation = grouped.get(observation.identity) ?? {
        aliases: [],
        identity: observation.identity,
      };
      if (installation.aliases.length >= MAXIMUM_ALIASES_PER_INSTALLATION) {
        diagnostics.push({
          candidateRef: `claude-code-candidate:${referenceDigest.sha256(candidate.candidateIdentity)}`,
          code: "candidate_invalid",
        });
        continue;
      }
      if (
        !installation.aliases.some(
          alias =>
            alias.displayPath === candidate.displayPath &&
            alias.source === candidate.source,
        )
      ) {
        installation.aliases.push({
          displayPath: candidate.displayPath,
          source: candidate.source,
        });
      }
      grouped.set(observation.identity, installation);
    }

    const installations = [...grouped.values()].map(installation => ({
      aliases: installation.aliases,
      installationRef: `claude-code-installation:${referenceDigest.sha256(installation.identity)}`,
      status: "found_unverified" as const,
    }));

    return freezeResult(diagnostics, installations);
  },
});
