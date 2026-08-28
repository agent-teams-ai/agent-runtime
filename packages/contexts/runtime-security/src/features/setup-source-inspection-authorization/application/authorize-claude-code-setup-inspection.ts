import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
import { prepareClaudeCodeSourceRequests } from "./claude-code-source-scope.js";
import { deepFreezeAuthorization } from "./deep-freeze-authorization.js";
import type {
  CanonicalPathObservation,
  PathCanonicalizer,
} from "./ports/outbound/path-canonicalizer.js";

type RootKind = "home" | "homebrew" | "local" | "workspace";

interface CanonicalRoot {
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly kind: RootKind;
}

const MAX_DIAGNOSTICS = 1_024;
const MAX_PATH_LENGTH = 16_384;
const MAX_EPOCH_LENGTH = 256;
const ROOT_SLOTS = 4;
const SOURCE_SLOTS = 3;
const fixedSystemRoots = Object.freeze([
  { absolutePath: "/opt/homebrew", kind: "homebrew" as const },
  { absolutePath: "/usr/local", kind: "local" as const },
]);

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const rootLabels: Readonly<Record<RootKind, string>> = {
  home: "$HOME",
  homebrew: "$HOMEBREW",
  local: "$LOCAL",
  workspace: "$WORKSPACE",
};

const sourceDisplayPaths = Object.freeze({
  "project-local": "$WORKSPACE/.claude/settings.local.json",
  "shared-project": "$WORKSPACE/.claude/settings.json",
  user: "$HOME/.claude/settings.json",
} as const);

const safePathSegment = (value: string): string =>
  [...value]
    .map(character =>
      /^[A-Za-z0-9._-]$/u.test(character)
        ? character
        : `%{${character.codePointAt(0)?.toString(16).toUpperCase() ?? "0"}}`,
    )
    .join("");

const contains = (root: string, candidate: string): boolean => {
  const remainder = relative(root, candidate);
  return remainder === "" ||
    (
      remainder !== ".." &&
      !remainder.startsWith(`..${sep}`) &&
      !isAbsolute(remainder)
    );
};

const pathIsBoundedAbsolute = (path: string): boolean =>
  path.length > 0 &&
  path.length <= MAX_PATH_LENGTH &&
  !path.includes("\0") &&
  isAbsolute(path);

const selectContainingRoot = (
  path: string,
  roots: readonly CanonicalRoot[],
): CanonicalRoot | undefined =>
  roots
    .filter(root => contains(root.canonicalPath, path))
    .toSorted(
      (left, right) =>
        right.canonicalPath.length - left.canonicalPath.length ||
        compareText(rootLabels[left.kind], rootLabels[right.kind]) ||
        compareText(left.canonicalPath, right.canonicalPath),
    )[0];

const selectSameRoot = (
  observation: CanonicalPathObservation,
  roots: readonly CanonicalRoot[],
  expectedKind?: RootKind,
): CanonicalRoot | undefined => {
  const locationRoot = selectContainingRoot(
    observation.canonicalLocationPath,
    roots,
  );
  const targetRoot = selectContainingRoot(observation.absolutePath, roots);
  return locationRoot === targetRoot &&
    (expectedKind === undefined || locationRoot?.kind === expectedKind)
    ? locationRoot
    : undefined;
};

const observationsEqual = (
  left: CanonicalPathObservation,
  right: CanonicalPathObservation,
): boolean =>
  left.absolutePath === right.absolutePath &&
  left.canonicalLocationPath === right.canonicalLocationPath &&
  left.exists === right.exists &&
  left.fileIdentity === right.fileIdentity &&
  left.isFile === right.isFile &&
  left.linkCount === right.linkCount;

const displayPath = (
  lexicalPath: string,
  canonicalPath: string,
  root: CanonicalRoot,
): string => {
  const lexicalRoot = resolve(root.absolutePath);
  const suffix = contains(lexicalRoot, lexicalPath)
    ? relative(lexicalRoot, lexicalPath)
    : relative(root.canonicalPath, canonicalPath);
  const safeSuffix = suffix
    .split(sep)
    .filter(Boolean)
    .map(safePathSegment)
    .join("/");
  return safeSuffix.length === 0
    ? rootLabels[root.kind]
    : `${rootLabels[root.kind]}/${safeSuffix}`;
};

const cancellationOptions = (
  signal?: AbortSignal,
): { readonly signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

const custodyOptions = (
  root: CanonicalRoot,
  signal?: AbortSignal,
): {
  readonly custodyBoundary: {
    readonly absolutePath: string;
    readonly canonicalPath: string;
  };
  readonly signal?: AbortSignal;
} => ({
  custodyBoundary: {
    absolutePath: resolve(root.absolutePath),
    canonicalPath: root.canonicalPath,
  },
  ...(signal === undefined ? {} : { signal }),
});

const rethrowCancellation = (error: unknown, signal?: AbortSignal): void => {
  signal?.throwIfAborted();
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  ) {
    throw error;
  }
};

const canonicalize = async (
  canonicalizer: PathCanonicalizer,
  path: string,
  options?: Parameters<PathCanonicalizer["canonicalize"]>[1],
): Promise<CanonicalPathObservation> => {
  options?.signal?.throwIfAborted();
  const observation = await canonicalizer.canonicalize(path, options);
  options?.signal?.throwIfAborted();
  return observation;
};

const canonicalizeRoots = async (
  scope: TrustedClaudeCodeSetupInspectionScope,
  canonicalizer: PathCanonicalizer,
  signal?: AbortSignal,
): Promise<readonly CanonicalRoot[] | undefined> => {
  const requests: readonly { readonly absolutePath: string; readonly kind: RootKind }[] = [
    { absolutePath: scope.homeRoot, kind: "home" },
    { absolutePath: scope.workspaceRoot, kind: "workspace" },
    ...fixedSystemRoots,
  ];
  if (
    requests.length !== ROOT_SLOTS ||
    requests.some(root => !pathIsBoundedAbsolute(root.absolutePath))
  ) {
    return undefined;
  }
  const roots: CanonicalRoot[] = [];
  try {
    for (const request of requests) {
      signal?.throwIfAborted();
      const first = await canonicalize(
        canonicalizer,
        request.absolutePath,
        cancellationOptions(signal),
      );
      const observation = await canonicalize(
        canonicalizer,
        request.absolutePath,
        {
          custodyBoundary: {
            absolutePath: resolve(request.absolutePath),
            canonicalPath: first.absolutePath,
          },
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (!observationsEqual(first, observation)) {
        return undefined;
      }
      roots.push({
        absolutePath: resolve(request.absolutePath),
        canonicalPath: observation.absolutePath,
        kind: request.kind,
      });
    }
  } catch (error) {
    rethrowCancellation(error, signal);
    return undefined;
  }
  const duplicate = roots.some((root, index) =>
    roots.some((candidate, candidateIndex) =>
      index !== candidateIndex &&
      (
        candidate.absolutePath === root.absolutePath ||
        candidate.canonicalPath === root.canonicalPath
      )
    ),
  );
  return duplicate ? undefined : roots;
};

type VerifiedPath =
  | {
      readonly observation: CanonicalPathObservation;
      readonly root: CanonicalRoot;
      readonly status: "verified";
    }
  | { readonly status: "outside" }
  | { readonly status: "unstable" };

const verifyWithinRoot = async (
  lexicalPath: string,
  roots: readonly CanonicalRoot[],
  canonicalizer: PathCanonicalizer,
  expectedKind?: RootKind,
  signal?: AbortSignal,
): Promise<VerifiedPath> => {
  const first = await canonicalize(
    canonicalizer,
    lexicalPath,
    cancellationOptions(signal),
  );
  const firstRoot = selectSameRoot(first, roots, expectedKind);
  if (firstRoot === undefined) {
    return { status: "outside" };
  }
  const second = await canonicalize(
    canonicalizer,
    lexicalPath,
    custodyOptions(firstRoot, signal),
  );
  const secondRoot = selectSameRoot(second, roots, expectedKind);
  if (secondRoot !== firstRoot || !observationsEqual(first, second)) {
    return { status: "unstable" };
  }
  return { observation: second, root: firstRoot, status: "verified" };
};

const invalidExistingPath = (observation: CanonicalPathObservation): boolean =>
  observation.exists &&
  (
    observation.isFile !== true ||
    observation.fileIdentity === undefined ||
    (observation.linkCount ?? 0) !== 1
  );

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
  roots: readonly CanonicalRoot[],
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
      const verified = await verifyWithinRoot(
        request.absolutePath,
        roots,
        canonicalizer,
        undefined,
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
      if (invalidExistingPath(verified.observation)) {
        diagnostics.push({
          code: "candidate_invalid",
          safeRef: displayPath(
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
          absolutePath: verified.root.absolutePath,
          canonicalPath: verified.root.canonicalPath,
        },
        displayPath: displayPath(
          request.absolutePath,
          verified.observation.absolutePath,
          verified.root,
        ),
        priorityRank: request.priorityRank,
        source: request.source,
      });
    } catch (error) {
      rethrowCancellation(error, signal);
      diagnostics.push({ code: "candidate_unreadable", safeRef: request.source });
    }
  }
  const unique = new Map<string, AuthorizedClaudeCodeExecutableCandidate>();
  for (const candidate of candidates.toSorted(
    (left, right) =>
      left.priorityRank - right.priorityRank ||
      compareText(left.candidateIdentity, right.candidateIdentity),
  )) {
    if (!unique.has(candidate.candidateIdentity)) {
      unique.set(candidate.candidateIdentity, candidate);
    }
  }
  return { candidates: [...unique.values()], diagnostics };
};

const authorizeSources = async (
  scope: TrustedClaudeCodeSetupInspectionScope,
  roots: readonly CanonicalRoot[],
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
      const verified = await verifyWithinRoot(
        request.absolutePath,
        roots,
        canonicalizer,
        request.rootKind,
        signal,
      );
      if (
        verified.status !== "verified" ||
        invalidExistingPath(verified.observation)
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
        displayPath: displayPath(
          request.absolutePath,
          verified.observation.absolutePath,
          verified.root,
        ),
        kind: request.kind,
        observationEpoch: scope.observationEpoch,
      });
    } catch (error) {
      rethrowCancellation(error, signal);
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
      compareText(
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
    const roots = await canonicalizeRoots(trustedScope, canonicalizer, signal);
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
