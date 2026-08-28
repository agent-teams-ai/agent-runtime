import { isAbsolute, join, resolve } from "node:path";

import type {
  AuthorizedClaudeCodeExecutableCandidate,
  ClaudeCodeSetupAuthorizationDiagnostic,
  TrustedClaudeCodeSetupInspectionScope,
} from "../contracts/claude-code-setup-inspection-authorization.js";

export interface ClaudeCodeCandidateRequest {
  readonly absolutePath: string;
  readonly priorityRank: 1 | 2 | 3 | 4 | 5;
  readonly source: AuthorizedClaudeCodeExecutableCandidate["source"];
}

const MAX_EXPLICIT_PATHS = 16;
const MAX_PATH_ENTRIES = 64;
export const MAX_TOTAL_CANDIDATES = 256;
const MAX_PATH_LENGTH = 16_384;

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const pathIsBoundedAbsolute = (path: string): boolean =>
  path.length > 0 &&
  path.length <= MAX_PATH_LENGTH &&
  !path.includes("\0") &&
  isAbsolute(path);

export const prepareClaudeCodeCandidateRequests = (
  scope: TrustedClaudeCodeSetupInspectionScope,
): {
  readonly diagnostics: readonly ClaudeCodeSetupAuthorizationDiagnostic[];
  readonly requests: readonly ClaudeCodeCandidateRequest[];
} => {
  const diagnostics: ClaudeCodeSetupAuthorizationDiagnostic[] = [];
  if (
    scope.candidatePaths.filter(candidate => candidate.source === "explicit").length >
      MAX_EXPLICIT_PATHS ||
    scope.candidatePaths.filter(candidate => candidate.source === "path-entry").length >
      MAX_PATH_ENTRIES ||
    scope.candidatePaths.length > MAX_TOTAL_CANDIDATES
  ) {
    return {
      diagnostics: [{ code: "candidate_invalid", safeRef: "candidate-budget" }],
      requests: [],
    };
  }
  const expectedKnownLocations = [
    {
      absolutePath: resolve(join(scope.homeRoot, ".local", "bin", "claude")),
      priorityRank: 3,
    },
    { absolutePath: "/opt/homebrew/bin/claude", priorityRank: 4 },
    { absolutePath: "/usr/local/bin/claude", priorityRank: 5 },
  ] as const;
  const knownLocations = scope.candidatePaths.filter(candidate =>
    candidate.source === "known-location"
  );
  const knownLocationsAreBound =
    knownLocations.length === expectedKnownLocations.length &&
    expectedKnownLocations.every(expected =>
      knownLocations.filter(candidate =>
        candidate.absolutePath === expected.absolutePath &&
        candidate.priorityRank === expected.priorityRank
      ).length === 1
    );
  if (!knownLocationsAreBound) {
    diagnostics.push({ code: "candidate_invalid", safeRef: "candidate-scope" });
  }
  const requests: ClaudeCodeCandidateRequest[] = [];
  for (const candidate of scope.candidatePaths) {
    const rankMatchesSource =
      (candidate.source === "explicit" && candidate.priorityRank === 1) ||
      (candidate.source === "path-entry" && candidate.priorityRank === 2) ||
      (candidate.source === "known-location" &&
        candidate.priorityRank >= 3 && candidate.priorityRank <= 5);
    const knownLocationIsBound = candidate.source !== "known-location" ||
      expectedKnownLocations.some(expected =>
        candidate.absolutePath === expected.absolutePath &&
        candidate.priorityRank === expected.priorityRank
      );
    if (
      !pathIsBoundedAbsolute(candidate.absolutePath) ||
      !rankMatchesSource ||
      !knownLocationIsBound
    ) {
      diagnostics.push({ code: "candidate_invalid", safeRef: candidate.source });
      continue;
    }
    requests.push({
      absolutePath: resolve(candidate.absolutePath),
      priorityRank: candidate.priorityRank,
      source: candidate.source,
    });
  }
  const byLexicalPath = new Map<string, ClaudeCodeCandidateRequest>();
  for (const request of requests.toSorted(
    (left, right) =>
      left.priorityRank - right.priorityRank ||
      compareText(left.absolutePath, right.absolutePath),
  )) {
    if (!byLexicalPath.has(request.absolutePath)) {
      byLexicalPath.set(request.absolutePath, request);
    }
  }
  return { diagnostics, requests: [...byLexicalPath.values()] };
};
