import { createHash } from "node:crypto";

import type {
  ClaudeCodeInstallationCandidate,
  ClaudeCodeInstallationDiagnostic,
  ClaudeCodeInstallationObservation,
  DiscoverClaudeCodeInstallations,
  DiscoverClaudeCodeInstallationsResult,
} from "../contracts/claude-code-installation-observation.js";
import type { ExecutableFileObserver } from "./ports/outbound/executable-file-observation.js";

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

const sourceRank = {
  explicit: 0,
  "path-entry": 1,
  "known-location": 2,
} as const;

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const hashRef = (domain: string, value: string): string =>
  `${domain}:${createHash("sha256").update(value).digest("hex")}`;

const installationRef = (identity: string): string =>
  hashRef("claude-code-installation", identity);

const candidateRef = (candidate: ClaudeCodeInstallationCandidate): string =>
  hashRef(
    "claude-code-candidate",
    `${candidate.source}\u0000${candidate.displayPath}`,
  );

const knownLocationRank = (displayPath: string): number => {
  if (
    displayPath === "$HOME/.local/bin/claude" ||
    displayPath === "~/.local/bin/claude"
  ) {
    return 0;
  }
  if (displayPath === "/opt/homebrew/bin/claude") {
    return 1;
  }
  if (displayPath === "/usr/local/bin/claude") {
    return 2;
  }
  return 3;
};

const compareCandidates = (
  left: ClaudeCodeInstallationCandidate,
  right: ClaudeCodeInstallationCandidate,
): number => {
  const sourceDifference = sourceRank[left.source] - sourceRank[right.source];
  if (sourceDifference !== 0) {
    return sourceDifference;
  }
  if (left.source === "known-location" && right.source === "known-location") {
    const locationDifference =
      knownLocationRank(left.displayPath) - knownLocationRank(right.displayPath);
    if (locationDifference !== 0) {
      return locationDifference;
    }
  }
  return (
    compareText(left.displayPath, right.displayPath) ||
    compareText(left.canonicalPath, right.canonicalPath) ||
    compareText(left.absolutePath, right.absolutePath)
  );
};

const candidateKey = (candidate: ClaudeCodeInstallationCandidate): string =>
  [
    candidate.source,
    candidate.displayPath,
    candidate.absolutePath,
    candidate.canonicalPath,
    candidate.authorizedFileIdentity ?? "",
    candidate.custodyRoot.absolutePath,
    candidate.custodyRoot.canonicalPath,
    String(candidate.required),
  ].join("\u0000");

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
  installations: ClaudeCodeInstallationObservation[],
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

    const candidates = input.candidates.toSorted(compareCandidates);
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

      const observation = await fileObserver.observe(
        candidate.absolutePath,
        candidate.canonicalPath,
        candidate.authorizedFileIdentity,
        candidate.custodyRoot,
        options,
      );
      options?.signal?.throwIfAborted();

      if (observation.kind === "missing") {
        if (candidate.required) {
          diagnostics.push({
            candidateRef: candidateRef(candidate),
            code: "candidate_invalid",
          });
        }
        continue;
      }
      if (observation.kind !== "found") {
        diagnostics.push({
          candidateRef: candidateRef(candidate),
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
          candidateRef: candidateRef(candidate),
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
      installationRef: installationRef(installation.identity),
      status: "found_unverified" as const,
    }));

    return freezeResult(diagnostics, installations);
  },
});
