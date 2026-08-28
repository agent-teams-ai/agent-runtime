import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  AuthorizeClaudeCodeSetupInspection,
  AuthorizedClaudeCodeExecutableCandidate,
  AuthorizedClaudeCodePortableSource,
  ClaudeCodePortableSourceKind,
  ClaudeCodeSetupAuthorizationDiagnostic,
  TrustedClaudeCodeSetupInspectionScope,
} from "../contracts/claude-code-setup-inspection-authorization.js";
import type {
  CanonicalPathObservation,
  PathCanonicalizer,
} from "./ports/outbound/path-canonicalizer.js";

type RootKind = "home" | "system" | "workspace";

interface CanonicalRoot {
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly kind: RootKind;
}

interface CandidateRequest {
  readonly absolutePath: string;
  readonly priorityRank: 1 | 2 | 3 | 4 | 5;
  readonly source: AuthorizedClaudeCodeExecutableCandidate["source"];
}

const MAX_EXPLICIT_PATHS = 16;
const MAX_PATH_ENTRIES = 64;
const MAX_TOTAL_CANDIDATES = 256;
const MAX_DIAGNOSTICS = 1_024;
const MAX_PATH_LENGTH = 16_384;
const MAX_EPOCH_LENGTH = 256;
const ROOT_SLOTS = 4;
const SOURCE_SLOTS = 3;
const fixedSystemRoots = Object.freeze(["/opt/homebrew", "/usr/local"] as const);

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const rootLabels: Readonly<Record<RootKind, string>> = {
  home: "$HOME",
  system: "$SYSTEM",
  workspace: "$WORKSPACE",
};

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
    ...fixedSystemRoots.map(absolutePath => ({ absolutePath, kind: "system" as const })),
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

const makeCandidateRequests = (
  scope: TrustedClaudeCodeSetupInspectionScope,
): {
  readonly diagnostics: readonly ClaudeCodeSetupAuthorizationDiagnostic[];
  readonly requests: readonly CandidateRequest[];
} => {
  const diagnostics: ClaudeCodeSetupAuthorizationDiagnostic[] = [];
  if (
    scope.explicitExecutablePaths.length > MAX_EXPLICIT_PATHS ||
    scope.pathEntries.length > MAX_PATH_ENTRIES
  ) {
    return {
      diagnostics: [{ code: "candidate_invalid", safeRef: "candidate-budget" }],
      requests: [],
    };
  }
  const requests: CandidateRequest[] = [];
  for (const path of scope.explicitExecutablePaths) {
    if (!pathIsBoundedAbsolute(path)) {
      diagnostics.push({ code: "candidate_invalid", safeRef: "explicit-path" });
    } else {
      requests.push({
        absolutePath: resolve(path),
        priorityRank: 1,
        source: "explicit",
      });
    }
  }
  for (const entry of scope.pathEntries) {
    if (!pathIsBoundedAbsolute(entry)) {
      diagnostics.push({ code: "candidate_invalid", safeRef: "path-entry" });
    } else {
      const candidatePath = join(resolve(entry), "claude");
      if (!pathIsBoundedAbsolute(candidatePath)) {
        diagnostics.push({ code: "candidate_invalid", safeRef: "path-entry" });
        continue;
      }
      requests.push({
        absolutePath: candidatePath,
        priorityRank: 2,
        source: "path-entry",
      });
    }
  }
  const fixedRequests: readonly CandidateRequest[] = [
    {
      absolutePath: join(resolve(scope.homeRoot), ".local", "bin", "claude"),
      priorityRank: 3,
      source: "known-location",
    },
    {
      absolutePath: "/opt/homebrew/bin/claude",
      priorityRank: 4,
      source: "known-location",
    },
    {
      absolutePath: "/usr/local/bin/claude",
      priorityRank: 5,
      source: "known-location",
    },
  ];
  for (const request of fixedRequests) {
    if (!pathIsBoundedAbsolute(request.absolutePath)) {
      return {
        diagnostics: [{ code: "candidate_invalid", safeRef: "candidate-budget" }],
        requests: [],
      };
    }
    requests.push(request);
  }
  if (requests.length > MAX_TOTAL_CANDIDATES) {
    return {
      diagnostics: [{ code: "candidate_invalid", safeRef: "candidate-budget" }],
      requests: [],
    };
  }
  const byLexicalPath = new Map<string, CandidateRequest>();
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

const authorizeCandidates = async (
  scope: TrustedClaudeCodeSetupInspectionScope,
  roots: readonly CanonicalRoot[],
  canonicalizer: PathCanonicalizer,
  signal?: AbortSignal,
): Promise<{
  readonly candidates: readonly AuthorizedClaudeCodeExecutableCandidate[];
  readonly diagnostics: readonly ClaudeCodeSetupAuthorizationDiagnostic[];
}> => {
  const prepared = makeCandidateRequests(scope);
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
      compareText(left.displayPath, right.displayPath) ||
      compareText(left.canonicalPath, right.canonicalPath),
  )) {
    const key = `${candidate.canonicalPath}\0${candidate.displayPath}`;
    if (!unique.has(key)) {
      unique.set(key, candidate);
    }
  }
  return { candidates: [...unique.values()], diagnostics };
};

const sourceRequests = (
  scope: TrustedClaudeCodeSetupInspectionScope,
): readonly {
  readonly absolutePath: string;
  readonly kind: ClaudeCodePortableSourceKind;
  readonly rootKind: "home" | "workspace";
}[] => [
  {
    absolutePath: join(resolve(scope.homeRoot), ".claude", "settings.json"),
    kind: "user",
    rootKind: "home",
  },
  {
    absolutePath: join(resolve(scope.workspaceRoot), ".claude", "settings.json"),
    kind: "shared-project",
    rootKind: "workspace",
  },
  {
    absolutePath: join(resolve(scope.workspaceRoot), ".claude", "settings.local.json"),
    kind: "project-local",
    rootKind: "workspace",
  },
];

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
  const requests = sourceRequests(scope);
  if (
    requests.length !== SOURCE_SLOTS ||
    requests.some(request => !pathIsBoundedAbsolute(request.absolutePath))
  ) {
    return {
      diagnostics: [{ code: "source_epoch_stale", safeRef: "scope" }],
      sources: [],
    };
  }
  for (const request of requests) {
    signal?.throwIfAborted();
    if (request.rootKind === "workspace" && !scope.workspaceTrusted) {
      diagnostics.push({ code: "source_untrusted", safeRef: request.kind });
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
        continue;
      }
      sources.push({
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
    }
  }
  const canonicalPaths = new Set<string>();
  const duplicate = sources.some(source => {
    if (canonicalPaths.has(source.canonicalPath)) {
      return true;
    }
    canonicalPaths.add(source.canonicalPath);
    return false;
  });
  return duplicate
    ? {
        diagnostics: [
          ...diagnostics,
          { code: "source_epoch_stale", safeRef: "duplicate-source" },
        ],
        sources: [],
      }
    : { diagnostics, sources };
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
      dialect: scope.dialect,
      explicitExecutablePaths: Object.freeze(
        scope.explicitExecutablePaths.slice(0, MAX_EXPLICIT_PATHS + 1),
      ),
      homeRoot: scope.homeRoot,
      observationEpoch: scope.observationEpoch,
      pathEntries: Object.freeze(
        scope.pathEntries.slice(0, MAX_PATH_ENTRIES + 1),
      ),
      workspaceRoot: scope.workspaceRoot,
      workspaceTrusted: scope.workspaceTrusted,
    });
    if (
      trustedScope.dialect !== "claude-code-settings@2026-08-28" ||
      trustedScope.observationEpoch.length === 0 ||
      trustedScope.observationEpoch.length > MAX_EPOCH_LENGTH
    ) {
      return {
        diagnostics: [{ code: "source_epoch_stale", safeRef: "scope" }],
        status: "denied",
      };
    }
    const roots = await canonicalizeRoots(trustedScope, canonicalizer, signal);
    signal?.throwIfAborted();
    if (roots === undefined) {
      return {
        diagnostics: [{ code: "source_epoch_stale", safeRef: "scope" }],
        status: "denied",
      };
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
    return {
      diagnostics: sortDiagnostics([
        ...candidates.diagnostics,
        ...sources.diagnostics,
      ]),
      executableCandidates: candidates.candidates,
      observationEpoch: trustedScope.observationEpoch,
      sources: sources.sources,
      status: "authorized",
    };
  },
});
