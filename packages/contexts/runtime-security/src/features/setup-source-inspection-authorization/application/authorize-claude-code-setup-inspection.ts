import { createHash } from "node:crypto";

import type {
  AuthorizeClaudeCodeSetupInspection,
  AuthorizedClaudeCodeExecutableCandidate,
  AuthorizedClaudeCodePortableSource,
  ClaudeCodeSetupAuthorizationDiagnostic,
  TrustedClaudeCodeSetupInspectionScope,
} from "../contracts/claude-code-setup-inspection-authorization.js";
import {
  MAX_TOTAL_CANDIDATES,
  prepareClaudeCodeCandidateRequests,
} from "./claude-code-candidate-scope.js";
import {
  canonicalizeClaudeCodeRoots,
  type ClaudeCodeCanonicalRoot,
  compareClaudeCodeText,
  displayClaudeCodePath,
  invalidExistingClaudeCodePath,
  rethrowClaudeCodeCancellation,
  verifyClaudeCodeExecutablePath,
  verifyClaudeCodePathWithinRoot,
} from "./claude-code-path-authorization.js";
import { prepareClaudeCodeSourceRequests } from "./claude-code-source-scope.js";
import { deepFreezeAuthorization } from "./deep-freeze-authorization.js";
import type { PathCanonicalizer } from "./ports/outbound/path-canonicalizer.js";

const MAX_DIAGNOSTICS = 1_024;
const MAX_EPOCH_LENGTH = 256;
const SOURCE_SLOTS = 3;

const sourceDisplayPaths = Object.freeze({
  "project-local": "$WORKSPACE/.claude/settings.local.json",
  "shared-project": "$WORKSPACE/.claude/settings.json",
  user: "$HOME/.claude/settings.json",
} as const);

const candidateIdentity = (
  request: { readonly absolutePath: string; readonly priorityRank: number; readonly source: string },
  canonicalPath: string,
): string => `claude-code-candidate-identity:sha256:${createHash("sha256")
  .update([
    request.source,
    String(request.priorityRank),
    request.absolutePath,
    canonicalPath,
  ].join("\0"))
  .digest("hex")}`;

const authorizeCandidates = async (
  scope: TrustedClaudeCodeSetupInspectionScope,
  roots: readonly ClaudeCodeCanonicalRoot[],
  canonicalizer: PathCanonicalizer,
  signal?: AbortSignal,
): Promise<{
  readonly candidates: readonly AuthorizedClaudeCodeExecutableCandidate[];
  readonly diagnostics: readonly ClaudeCodeSetupAuthorizationDiagnostic[];
}> => {
  const prepared = prepareClaudeCodeCandidateRequests(scope);
  const candidates: AuthorizedClaudeCodeExecutableCandidate[] = [];
  const diagnostics = [...prepared.diagnostics];
  for (const request of prepared.requests) {
    signal?.throwIfAborted();
    try {
      const verified = await verifyClaudeCodeExecutablePath(
        request.absolutePath,
        roots,
        canonicalizer,
        signal,
      );
      if (verified.status === "outside") {
        diagnostics.push({ code: "candidate_denied", safeRef: request.source });
        continue;
      }
      if (verified.status === "unstable") {
        diagnostics.push({ code: "candidate_unstable", safeRef: request.source });
        continue;
      }
      if (invalidExistingClaudeCodePath(verified.observation)) {
        diagnostics.push({
          code: "candidate_invalid",
          safeRef: displayClaudeCodePath(
            request.absolutePath,
            verified.observation.absolutePath,
            verified.root,
          ),
        });
        continue;
      }
      candidates.push({
        absolutePath: request.absolutePath,
        ...(verified.observation.fileIdentity === undefined
          ? {}
          : { authorizedFileIdentity: verified.observation.fileIdentity }),
        candidateIdentity: candidateIdentity(
          request,
          verified.observation.absolutePath,
        ),
        canonicalPath: verified.observation.absolutePath,
        custodyRoot: {
          absolutePath: request.absolutePath,
          canonicalPath: verified.observation.absolutePath,
        },
        displayPath: displayClaudeCodePath(
          request.absolutePath,
          verified.observation.absolutePath,
          verified.root,
        ),
        priorityRank: request.priorityRank,
        source: request.source,
      });
    } catch (error) {
      rethrowClaudeCodeCancellation(error, signal);
      diagnostics.push({ code: "candidate_unreadable", safeRef: request.source });
    }
  }
  const unique = new Map<string, AuthorizedClaudeCodeExecutableCandidate>();
  for (const candidate of candidates.toSorted(
    (left, right) =>
      left.priorityRank - right.priorityRank ||
      compareClaudeCodeText(left.candidateIdentity, right.candidateIdentity),
  )) {
    if (!unique.has(candidate.candidateIdentity)) {
      unique.set(candidate.candidateIdentity, candidate);
    }
  }
  return { candidates: [...unique.values()], diagnostics };
};

const authorizeSources = async (
  scope: TrustedClaudeCodeSetupInspectionScope,
  roots: readonly ClaudeCodeCanonicalRoot[],
  canonicalizer: PathCanonicalizer,
  signal?: AbortSignal,
): Promise<{
  readonly diagnostics: readonly ClaudeCodeSetupAuthorizationDiagnostic[];
  readonly sources: readonly AuthorizedClaudeCodePortableSource[];
}> => {
  const diagnostics: ClaudeCodeSetupAuthorizationDiagnostic[] = [];
  const sources: AuthorizedClaudeCodePortableSource[] = [];
  const requests = prepareClaudeCodeSourceRequests(scope);
  if (requests === undefined) {
    return {
      diagnostics: [{ code: "source_epoch_stale", safeRef: "scope" }],
      sources: (["user", "shared-project", "project-local"] as const).map(kind => ({
        access: "rejected" as const,
        displayPath: sourceDisplayPaths[kind],
        kind,
        observationEpoch: scope.observationEpoch,
      })),
    };
  }
  for (const request of requests) {
    signal?.throwIfAborted();
    if (request.rootKind === "workspace" && !scope.workspaceTrusted) {
      diagnostics.push({ code: "source_untrusted", safeRef: request.kind });
      sources.push({
        access: "untrusted",
        displayPath: sourceDisplayPaths[request.kind],
        kind: request.kind,
        observationEpoch: scope.observationEpoch,
      });
      continue;
    }
    try {
      const verified = await verifyClaudeCodePathWithinRoot(
        request.absolutePath,
        roots,
        canonicalizer,
        request.rootKind,
        signal,
      );
      if (
        verified.status !== "verified" ||
        invalidExistingClaudeCodePath(verified.observation)
      ) {
        diagnostics.push({ code: "source_epoch_stale", safeRef: request.kind });
        sources.push({
          access: "stale",
          displayPath: sourceDisplayPaths[request.kind],
          kind: request.kind,
          observationEpoch: scope.observationEpoch,
        });
        continue;
      }
      sources.push({
        access: "authorized",
        absolutePath: request.absolutePath,
        ...(verified.observation.fileIdentity === undefined
          ? {}
          : { authorizedFileIdentity: verified.observation.fileIdentity }),
        canonicalPath: verified.observation.absolutePath,
        custodyRoot: {
          absolutePath: verified.root.absolutePath,
          canonicalPath: verified.root.canonicalPath,
        },
        displayPath: displayClaudeCodePath(
          request.absolutePath,
          verified.observation.absolutePath,
          verified.root,
        ),
        kind: request.kind,
        observationEpoch: scope.observationEpoch,
      });
    } catch (error) {
      rethrowClaudeCodeCancellation(error, signal);
      diagnostics.push({ code: "source_epoch_stale", safeRef: request.kind });
      sources.push({
        access: "stale",
        displayPath: sourceDisplayPaths[request.kind],
        kind: request.kind,
        observationEpoch: scope.observationEpoch,
      });
    }
  }
  const canonicalCounts = new Map<string, number>();
  for (const source of sources) {
    if (source.access === "authorized") {
      canonicalCounts.set(
        source.canonicalPath,
        (canonicalCounts.get(source.canonicalPath) ?? 0) + 1,
      );
    }
  }
  const duplicate = [...canonicalCounts.values()].some(count => count > 1);
  const boundedSources = sources.map(source =>
    source.access === "authorized" &&
      (canonicalCounts.get(source.canonicalPath) ?? 0) > 1
      ? {
          access: "rejected" as const,
          displayPath: source.displayPath,
          kind: source.kind,
          observationEpoch: source.observationEpoch,
        }
      : source
  );
  return {
    diagnostics: duplicate
      ? [
          ...diagnostics,
          { code: "source_epoch_stale", safeRef: "duplicate-source" },
        ]
      : diagnostics,
    sources: boundedSources,
  };
};

const sortDiagnostics = (
  diagnostics: readonly ClaudeCodeSetupAuthorizationDiagnostic[],
): readonly ClaudeCodeSetupAuthorizationDiagnostic[] =>
  diagnostics
    .toSorted((left, right) =>
      compareClaudeCodeText(
        `${left.code}:${left.safeRef ?? ""}`,
        `${right.code}:${right.safeRef ?? ""}`,
      ),
    )
    .slice(0, MAX_DIAGNOSTICS);

export const createAuthorizeClaudeCodeSetupInspection = (
  canonicalizer: PathCanonicalizer,
): AuthorizeClaudeCodeSetupInspection => ({
  async execute(scope, options) {
    const signal = options?.signal;
    signal?.throwIfAborted();
    const trustedScope: TrustedClaudeCodeSetupInspectionScope = Object.freeze({
      candidatePaths: Object.freeze(scope.candidatePaths
        .slice(0, MAX_TOTAL_CANDIDATES + 1)
        .map(candidate => Object.freeze({
          absolutePath: candidate.absolutePath,
          priorityRank: candidate.priorityRank,
          source: candidate.source,
        }))),
      dialect: scope.dialect,
      homeRoot: scope.homeRoot,
      observationEpoch: scope.observationEpoch,
      sourcePaths: Object.freeze(scope.sourcePaths
        .slice(0, SOURCE_SLOTS + 1)
        .map(source => Object.freeze({
          absolutePath: source.absolutePath,
          kind: source.kind,
        }))),
      workspaceRoot: scope.workspaceRoot,
      workspaceTrusted: scope.workspaceTrusted,
    });
    if (
      trustedScope.dialect !== "claude-code-settings@2026-08-28" ||
      trustedScope.observationEpoch.length === 0 ||
      trustedScope.observationEpoch.length > MAX_EPOCH_LENGTH
    ) {
      return deepFreezeAuthorization({
        diagnostics: [{ code: "source_epoch_stale", safeRef: "scope" }],
        status: "denied",
      });
    }
    const roots = await canonicalizeClaudeCodeRoots(
      trustedScope,
      canonicalizer,
      signal,
    );
    signal?.throwIfAborted();
    if (roots === undefined) {
      return deepFreezeAuthorization({
        diagnostics: [{ code: "source_epoch_stale", safeRef: "scope" }],
        status: "denied",
      });
    }
    const candidates = await authorizeCandidates(
      trustedScope,
      roots,
      canonicalizer,
      signal,
    );
    signal?.throwIfAborted();
    const sources = await authorizeSources(
      trustedScope,
      roots,
      canonicalizer,
      signal,
    );
    signal?.throwIfAborted();
    return deepFreezeAuthorization({
      diagnostics: sortDiagnostics([
        ...candidates.diagnostics,
        ...sources.diagnostics,
      ]),
      executableCandidates: candidates.candidates,
      observationEpoch: trustedScope.observationEpoch,
      sources: sources.sources,
      status: "authorized",
    });
  },
});
