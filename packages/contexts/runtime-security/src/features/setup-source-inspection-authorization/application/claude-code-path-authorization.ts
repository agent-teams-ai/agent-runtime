import { isAbsolute, relative, resolve, sep } from "node:path";

import type { TrustedClaudeCodeSetupInspectionScope } from "../contracts/claude-code-setup-inspection-authorization.js";
import type {
  CanonicalPathObservation,
  PathCanonicalizer,
} from "./ports/outbound/path-canonicalizer.js";

export type ClaudeCodeRootKind = "home" | "homebrew" | "local" | "workspace";

export interface ClaudeCodeCanonicalRoot {
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly kind: ClaudeCodeRootKind;
}

const MAX_PATH_LENGTH = 16_384;
const ROOT_SLOTS = 4;
const fixedSystemRoots = Object.freeze([
  { absolutePath: "/opt/homebrew", kind: "homebrew" as const },
  { absolutePath: "/usr/local", kind: "local" as const },
]);

const rootLabels: Readonly<Record<ClaudeCodeRootKind, string>> = {
  home: "$HOME",
  homebrew: "$HOMEBREW",
  local: "$LOCAL",
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
  roots: readonly ClaudeCodeCanonicalRoot[],
): ClaudeCodeCanonicalRoot | undefined =>
  roots
    .filter(root => contains(root.canonicalPath, path))
    .toSorted(
      (left, right) =>
        right.canonicalPath.length - left.canonicalPath.length ||
        compareClaudeCodeText(rootLabels[left.kind], rootLabels[right.kind]) ||
        compareClaudeCodeText(left.canonicalPath, right.canonicalPath),
    )[0];

const selectSameRoot = (
  observation: CanonicalPathObservation,
  roots: readonly ClaudeCodeCanonicalRoot[],
  expectedKind?: ClaudeCodeRootKind,
): ClaudeCodeCanonicalRoot | undefined => {
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

const cancellationOptions = (
  signal?: AbortSignal,
): { readonly signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

const custodyOptions = (
  root: ClaudeCodeCanonicalRoot,
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

export type VerifiedClaudeCodePath =
  | {
      readonly observation: CanonicalPathObservation;
      readonly root: ClaudeCodeCanonicalRoot;
      readonly status: "verified";
    }
  | { readonly status: "outside" }
  | { readonly status: "unstable" };

export const compareClaudeCodeText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

export const displayClaudeCodePath = (
  lexicalPath: string,
  canonicalPath: string,
  root: ClaudeCodeCanonicalRoot,
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

export const rethrowClaudeCodeCancellation = (
  error: unknown,
  signal?: AbortSignal,
): void => {
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

export const canonicalizeClaudeCodeRoots = async (
  scope: TrustedClaudeCodeSetupInspectionScope,
  canonicalizer: PathCanonicalizer,
  signal?: AbortSignal,
): Promise<readonly ClaudeCodeCanonicalRoot[] | undefined> => {
  const requests: readonly {
    readonly absolutePath: string;
    readonly kind: ClaudeCodeRootKind;
  }[] = [
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
  const roots: ClaudeCodeCanonicalRoot[] = [];
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
    rethrowClaudeCodeCancellation(error, signal);
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

export const verifyClaudeCodePathWithinRoot = async (
  lexicalPath: string,
  roots: readonly ClaudeCodeCanonicalRoot[],
  canonicalizer: PathCanonicalizer,
  expectedKind?: ClaudeCodeRootKind,
  signal?: AbortSignal,
): Promise<VerifiedClaudeCodePath> => {
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

export const invalidExistingClaudeCodePath = (
  observation: CanonicalPathObservation,
): boolean =>
  observation.exists &&
  (
    observation.isFile !== true ||
    observation.fileIdentity === undefined ||
    (observation.linkCount ?? 0) !== 1
  );
