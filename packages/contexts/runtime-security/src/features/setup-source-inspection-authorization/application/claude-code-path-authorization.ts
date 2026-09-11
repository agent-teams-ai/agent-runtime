import type { TrustedClaudeCodeSetupInspectionScope } from "../contracts/claude-code-setup-inspection-authorization.js";
import type { PathAlgebra } from "./ports/outbound/path-algebra.js";
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

export const invalidExistingClaudeCodePath = (
  observation: CanonicalPathObservation,
): boolean =>
  observation.exists &&
  (
    observation.isFile !== true ||
    observation.fileIdentity === undefined ||
    (observation.linkCount ?? 0) !== 1
  );

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

const contains = (pathAlgebra: PathAlgebra, root: string, candidate: string): boolean => {
  const remainder = pathAlgebra.relative(root, candidate);
  return remainder === "" ||
    (
      remainder !== ".." &&
      !remainder.startsWith(`..${pathAlgebra.sep}`) &&
      !pathAlgebra.isAbsolute(remainder)
    );
};

const pathIsBoundedAbsolute = (pathAlgebra: PathAlgebra, path: string): boolean =>
  path.length > 0 &&
  path.length <= MAX_PATH_LENGTH &&
  !path.includes("\0") &&
  pathAlgebra.isAbsolute(path);

const selectContainingRoot = (
  pathAlgebra: PathAlgebra,
  path: string,
  roots: readonly ClaudeCodeCanonicalRoot[],
): ClaudeCodeCanonicalRoot | undefined =>
  roots
    .filter(root => contains(pathAlgebra, root.canonicalPath, path))
    .toSorted(
      (left, right) =>
        right.canonicalPath.length - left.canonicalPath.length ||
        compareClaudeCodeText(rootLabels[left.kind], rootLabels[right.kind]) ||
        compareClaudeCodeText(left.canonicalPath, right.canonicalPath),
    )[0];

const selectContainingLexicalRoot = (
  pathAlgebra: PathAlgebra,
  path: string,
  roots: readonly ClaudeCodeCanonicalRoot[],
): ClaudeCodeCanonicalRoot | undefined =>
  roots
    .filter(root => contains(pathAlgebra, pathAlgebra.resolve(root.absolutePath), path))
    .toSorted(
      (left, right) =>
        right.absolutePath.length - left.absolutePath.length ||
        compareClaudeCodeText(rootLabels[left.kind], rootLabels[right.kind]) ||
        compareClaudeCodeText(left.absolutePath, right.absolutePath),
    )[0];

const selectSameRoot = (
  pathAlgebra: PathAlgebra,
  observation: CanonicalPathObservation,
  roots: readonly ClaudeCodeCanonicalRoot[],
  expectedKind?: ClaudeCodeRootKind,
): ClaudeCodeCanonicalRoot | undefined => {
  const locationRoot = selectContainingRoot(pathAlgebra, observation.canonicalLocationPath, roots);
  const targetRoot = selectContainingRoot(pathAlgebra, observation.absolutePath, roots);
  return locationRoot === targetRoot &&
    (expectedKind === undefined || locationRoot?.kind === expectedKind)
    ? locationRoot
    : undefined;
};

const custodyOptions = (
  pathAlgebra: PathAlgebra,
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
    absolutePath: pathAlgebra.resolve(root.absolutePath),
    canonicalPath: root.canonicalPath,
  },
  ...(signal === undefined ? {} : { signal }),
});

const executableCustodyOptions = (
  absolutePath: string,
  canonicalPath: string,
  signal?: AbortSignal,
): {
  readonly custodyBoundary: {
    readonly absolutePath: string;
    readonly canonicalPath: string;
  };
  readonly signal?: AbortSignal;
} => ({
  custodyBoundary: { absolutePath, canonicalPath },
  ...(signal === undefined ? {} : { signal }),
});

export const displayClaudeCodePath = (
  pathAlgebra: PathAlgebra,
  lexicalPath: string,
  canonicalPath: string,
  root: ClaudeCodeCanonicalRoot,
): string => {
  const lexicalRoot = pathAlgebra.resolve(root.absolutePath);
  const suffix = contains(pathAlgebra, lexicalRoot, lexicalPath)
    ? pathAlgebra.relative(lexicalRoot, lexicalPath)
    : pathAlgebra.relative(root.canonicalPath, canonicalPath);
  const safeSuffix = suffix
    .split(pathAlgebra.sep)
    .filter(Boolean)
    .map(safePathSegment)
    .join("/");
  return safeSuffix.length === 0
    ? rootLabels[root.kind]
    : `${rootLabels[root.kind]}/${safeSuffix}`;
};

export const canonicalizeClaudeCodeRoots = async (
  pathAlgebra: PathAlgebra,
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
    requests.some(root => !pathIsBoundedAbsolute(pathAlgebra, root.absolutePath))
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
        cancellationOptions(signal),
      );
      if (!observationsEqual(first, observation)) {
        return undefined;
      }
      roots.push({
        absolutePath: pathAlgebra.resolve(request.absolutePath),
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
  dependencies: Readonly<{ canonicalizer: PathCanonicalizer; pathAlgebra: PathAlgebra }>,
  lexicalPath: string,
  roots: readonly ClaudeCodeCanonicalRoot[],
  expectedKind?: ClaudeCodeRootKind,
  signal?: AbortSignal,
): Promise<VerifiedClaudeCodePath> => {
  const { canonicalizer, pathAlgebra } = dependencies;
  const first = await canonicalize(
    canonicalizer,
    lexicalPath,
    cancellationOptions(signal),
  );
  const firstRoot = selectSameRoot(pathAlgebra, first, roots, expectedKind);
  if (firstRoot === undefined) {
    return { status: "outside" };
  }
  if (invalidExistingClaudeCodePath(first)) {
    return { observation: first, root: firstRoot, status: "verified" };
  }
  const second = await canonicalize(
    canonicalizer,
    lexicalPath,
    custodyOptions(pathAlgebra, firstRoot, signal),
  );
  const secondRoot = selectSameRoot(pathAlgebra, second, roots, expectedKind);
  if (secondRoot !== firstRoot || !observationsEqual(first, second)) {
    return { status: "unstable" };
  }
  return { observation: second, root: firstRoot, status: "verified" };
};

export const verifyClaudeCodeExecutablePath = async (
  pathAlgebra: PathAlgebra,
  lexicalPath: string,
  roots: readonly ClaudeCodeCanonicalRoot[],
  canonicalizer: PathCanonicalizer,
  signal?: AbortSignal,
): Promise<VerifiedClaudeCodePath> => {
  const lexicalRoot = selectContainingLexicalRoot(pathAlgebra, lexicalPath, roots);
  if (lexicalRoot === undefined) {
    return { status: "outside" };
  }
  const first = await canonicalize(
    canonicalizer,
    lexicalPath,
    cancellationOptions(signal),
  );
  if (invalidExistingClaudeCodePath(first)) {
    return { observation: first, root: lexicalRoot, status: "verified" };
  }
  const second = await canonicalize(
    canonicalizer,
    lexicalPath,
    executableCustodyOptions(lexicalPath, first.absolutePath, signal),
  );
  if (!observationsEqual(first, second)) {
    return { status: "unstable" };
  }
  return { observation: second, root: lexicalRoot, status: "verified" };
};
