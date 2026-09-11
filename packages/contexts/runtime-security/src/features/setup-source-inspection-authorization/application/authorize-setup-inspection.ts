import type {
  AuthorizeSetupInspection,
  AuthorizeSetupInspectionInput,
  AuthorizedConfigurationSource,
  AuthorizedInstallationCandidate,
  SetupAuthorizationDiagnostic,
  TrustedSetupPathRoot,
} from "../contracts/setup-inspection-authorization.js";
import type { PathAlgebra } from "./ports/outbound/path-algebra.js";
import type { PathCanonicalizer } from "./ports/outbound/path-canonicalizer.js";

interface CanonicalRoot extends TrustedSetupPathRoot {
  readonly canonicalPath: string;
}

interface AuthorizationCollections {
  readonly configurationSources: readonly AuthorizedConfigurationSource[];
  readonly diagnostics: readonly SetupAuthorizationDiagnostic[];
  readonly installationCandidates: readonly AuthorizedInstallationCandidate[];
}

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const rootLabels: Readonly<Record<TrustedSetupPathRoot["kind"], string>> = {
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

const contains = (pathAlgebra: PathAlgebra, root: string, candidate: string): boolean => {
  const remainder = pathAlgebra.relative(root, candidate);
  return remainder === "" ||
    (
      remainder !== ".." &&
      !remainder.startsWith(`..${pathAlgebra.sep}`) &&
      !pathAlgebra.isAbsolute(remainder)
    );
};

const selectContainingRoot = (
  pathAlgebra: PathAlgebra,
  canonicalPath: string,
  roots: readonly CanonicalRoot[],
): CanonicalRoot | undefined =>
  roots
    .filter(root => contains(pathAlgebra, root.canonicalPath, canonicalPath))
    .toSorted(
      (left, right) =>
        right.canonicalPath.length - left.canonicalPath.length ||
        right.absolutePath.length - left.absolutePath.length ||
        compareText(rootLabels[left.kind], rootLabels[right.kind]),
    )[0];

const selectRoot = (
  pathAlgebra: PathAlgebra,
  canonicalLocationPath: string,
  canonicalPath: string,
  roots: readonly CanonicalRoot[],
  expectedKind?: CanonicalRoot["kind"],
): CanonicalRoot | undefined => {
  const locationRoot = selectContainingRoot(pathAlgebra, canonicalLocationPath, roots);
  const targetRoot = selectContainingRoot(pathAlgebra, canonicalPath, roots);
  return locationRoot === targetRoot &&
    (expectedKind === undefined || locationRoot?.kind === expectedKind)
    ? locationRoot
    : undefined;
};

const displayPath = (
  pathAlgebra: PathAlgebra,
  lexicalPath: string,
  canonicalPath: string,
  root: CanonicalRoot,
): string => {
  const lexicalRoot = pathAlgebra.resolve(root.absolutePath);
  const suffix = contains(pathAlgebra, lexicalRoot, lexicalPath)
    ? pathAlgebra.relative(lexicalRoot, lexicalPath)
    : pathAlgebra.relative(root.canonicalPath, canonicalPath);
  const label = rootLabels[root.kind];
  const safeSuffix = suffix
    .split("/")
    .map(safePathSegment)
    .join("/");
  return safeSuffix === "" ? label : `${label}/${safeSuffix}`;
};

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

const cancellationOptions = (
  signal?: AbortSignal,
): { readonly signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

const custodyOptions = (
  pathAlgebra: PathAlgebra,
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
    absolutePath: pathAlgebra.resolve(root.absolutePath),
    canonicalPath: root.canonicalPath,
  },
  ...(signal === undefined ? {} : { signal }),
});

const canonicalizeRoots = async (
  pathAlgebra: PathAlgebra,
  input: AuthorizeSetupInspectionInput,
  canonicalizer: PathCanonicalizer,
  signal?: AbortSignal,
): Promise<readonly CanonicalRoot[] | undefined> => {
  const roots: CanonicalRoot[] = [];
  try {
    for (const root of input.roots) {
      signal?.throwIfAborted();
      if (!pathAlgebra.isAbsolute(root.absolutePath)) {
        return undefined;
      }
      const canonical = await canonicalizer.canonicalize(
        root.absolutePath,
        cancellationOptions(signal),
      );
      roots.push({ ...root, canonicalPath: canonical.absolutePath });
    }
  } catch (error) {
    rethrowCancellation(error, signal);
    return undefined;
  }
  const duplicateCanonicalRoot = roots.some((root, index) =>
    roots.some(
      (candidate, candidateIndex) =>
        candidateIndex !== index &&
        candidate.canonicalPath === root.canonicalPath &&
        candidate.kind !== root.kind,
    ),
  );
  return duplicateCanonicalRoot ? undefined : roots;
};

const canonicalizeWithinRoot = async (
  dependencies: Readonly<{ canonicalizer: PathCanonicalizer; pathAlgebra: PathAlgebra }>,
  lexicalPath: string,
  roots: readonly CanonicalRoot[],
  expectedKind?: CanonicalRoot["kind"],
  signal?: AbortSignal,
): Promise<
  | {
      readonly canonical: Awaited<ReturnType<PathCanonicalizer["canonicalize"]>>;
      readonly root: CanonicalRoot;
    }
  | undefined
> => {
  const { canonicalizer, pathAlgebra } = dependencies;
  const observed = await canonicalizer.canonicalize(
    lexicalPath,
    cancellationOptions(signal),
  );
  const observedRoot = selectRoot(
    pathAlgebra,
    observed.canonicalLocationPath,
    observed.absolutePath,
    roots,
    expectedKind,
  );
  if (observedRoot === undefined) {
    return undefined;
  }
  if (
    observed.exists &&
    (
      observed.isFile !== true ||
      (observed.linkCount ?? 0) > 1
    )
  ) {
    return { canonical: observed, root: observedRoot };
  }
  const canonical = await canonicalizer.canonicalize(
    lexicalPath,
    custodyOptions(pathAlgebra, observedRoot, signal),
  );
  const verifiedRoot = selectRoot(
    pathAlgebra,
    canonical.canonicalLocationPath,
    canonical.absolutePath,
    roots,
    expectedKind,
  );
  return verifiedRoot === observedRoot
    ? { canonical, root: observedRoot }
    : undefined;
};

const authorizeExecutable = async (
  pathAlgebra: PathAlgebra,
  request: Readonly<{
    absolutePath: string;
    required: boolean;
    source: AuthorizedInstallationCandidate["source"];
  }>,
  dependencies: Readonly<{
    canonicalizer: PathCanonicalizer;
    roots: readonly CanonicalRoot[];
  }>,
  signal?: AbortSignal,
): Promise<AuthorizedInstallationCandidate | SetupAuthorizationDiagnostic> => {
  signal?.throwIfAborted();
  const lexicalPath = pathAlgebra.resolve(request.absolutePath);
  let canonicalPath: string;
  let authorizedFileIdentity: string | undefined;
  let hardLinked = false;
  let nonRegular = false;
  let root: CanonicalRoot | undefined;
  try {
    const verified = await canonicalizeWithinRoot(
      { canonicalizer: dependencies.canonicalizer, pathAlgebra },
      lexicalPath,
      dependencies.roots,
      undefined,
      signal,
    );
    if (verified === undefined) {
      return { code: "path_outside_scope", subject: "unscoped-path" };
    }
    const canonical = verified.canonical;
    root = verified.root;
    canonicalPath = canonical.absolutePath;
    authorizedFileIdentity = canonical.fileIdentity;
    hardLinked = canonical.isFile === true && (canonical.linkCount ?? 0) > 1;
    nonRegular = canonical.exists && canonical.isFile !== true;
  } catch (error) {
    rethrowCancellation(error, signal);
    return { code: "path_outside_scope", subject: "unreadable-path" };
  }
  if (root === undefined || hardLinked || nonRegular) {
    return {
      code: "path_outside_scope",
      subject:
        root === undefined
          ? "unscoped-path"
          : displayPath(pathAlgebra, lexicalPath, canonicalPath, root),
    };
  }
  return {
    absolutePath: lexicalPath,
    ...(authorizedFileIdentity === undefined ? {} : { authorizedFileIdentity }),
    canonicalPath,
    custodyRoot: {
      absolutePath: pathAlgebra.resolve(root.absolutePath),
      canonicalPath: root.canonicalPath,
    },
    displayPath: displayPath(pathAlgebra, lexicalPath, canonicalPath, root),
    required: request.required,
    source: request.source,
  };
};

const collectInstallationCandidates = async (
  pathAlgebra: PathAlgebra,
  input: AuthorizeSetupInspectionInput,
  roots: readonly CanonicalRoot[],
  canonicalizer: PathCanonicalizer,
  signal?: AbortSignal,
): Promise<Pick<AuthorizationCollections, "diagnostics" | "installationCandidates">> => {
  const diagnostics: SetupAuthorizationDiagnostic[] = [];
  const requests: Array<{
    readonly absolutePath: string;
    readonly required: boolean;
    readonly source: AuthorizedInstallationCandidate["source"];
  }> = [];

  for (const candidate of input.installationCandidates) {
    if (!pathAlgebra.isAbsolute(candidate.absolutePath)) {
      diagnostics.push({
        code: candidate.absolutePath.length === 0
          ? "empty_path_entry"
          : "relative_path_entry",
        subject: candidate.source,
      });
    } else {
      requests.push(candidate);
    }
  }

  const installationCandidates: AuthorizedInstallationCandidate[] = [];
  for (const request of requests) {
    const result = await authorizeExecutable(
      pathAlgebra,
      request,
      { canonicalizer, roots },
      signal,
    );
    if ("code" in result) {
      diagnostics.push(result);
    } else {
      installationCandidates.push(result);
    }
  }
  return { diagnostics, installationCandidates };
};

const collectConfigurationSources = async (
  pathAlgebra: PathAlgebra,
  input: AuthorizeSetupInspectionInput,
  roots: readonly CanonicalRoot[],
  canonicalizer: PathCanonicalizer,
  signal?: AbortSignal,
): Promise<Pick<AuthorizationCollections, "configurationSources" | "diagnostics">> => {
  const diagnostics: SetupAuthorizationDiagnostic[] = [];
  const configurationSources: AuthorizedConfigurationSource[] = [];
  for (const source of input.configurationSources) {
    signal?.throwIfAborted();
    if (source.kind === "workspace" && !source.workspaceTrusted) {
      diagnostics.push({ code: "source_untrusted", subject: "workspace-config" });
      continue;
    }
    if (!pathAlgebra.isAbsolute(source.absolutePath)) {
      diagnostics.push({ code: "path_outside_scope", subject: `${source.kind}-config` });
      continue;
    }
    const lexicalPath = pathAlgebra.resolve(source.absolutePath);
    const expectedRootKind = source.kind === "workspace" ? "workspace" : "home";
    let canonicalPath: string;
    let authorizedFileIdentity: string | undefined;
    let hardLinked = false;
    let nonRegular = false;
    let root: CanonicalRoot | undefined;
    try {
      const verified = await canonicalizeWithinRoot(
        { canonicalizer, pathAlgebra },
        lexicalPath,
        roots,
        expectedRootKind,
        signal,
      );
      if (verified === undefined) {
        diagnostics.push({ code: "path_outside_scope", subject: `${source.kind}-config` });
        continue;
      }
      const canonical = verified.canonical;
      root = verified.root;
      canonicalPath = canonical.absolutePath;
      authorizedFileIdentity = canonical.fileIdentity;
      hardLinked = canonical.isFile === true && (canonical.linkCount ?? 0) > 1;
      nonRegular = canonical.exists && canonical.isFile !== true;
    } catch (error) {
      rethrowCancellation(error, signal);
      diagnostics.push({ code: "path_outside_scope", subject: `${source.kind}-config` });
      continue;
    }
    if (root === undefined || hardLinked || nonRegular) {
      diagnostics.push({
        code: "path_outside_scope",
        subject:
          root === undefined
            ? `${source.kind}-config`
            : displayPath(pathAlgebra, lexicalPath, canonicalPath, root),
      });
      continue;
    }
    configurationSources.push({
      absolutePath: lexicalPath,
      ...(authorizedFileIdentity === undefined ? {} : { authorizedFileIdentity }),
      canonicalPath,
      custodyRoot: {
        absolutePath: pathAlgebra.resolve(root.absolutePath),
        canonicalPath: root.canonicalPath,
      },
      displayPath: displayPath(pathAlgebra, lexicalPath, canonicalPath, root),
      kind: source.kind,
      observationEpoch: input.observationEpoch,
      ...(source.profileName === undefined ? {} : { profileName: source.profileName }),
      ...(source.workspaceLayer === undefined
        ? {}
        : { workspaceLayer: source.workspaceLayer }),
    });
  }
  return { configurationSources, diagnostics };
};

export const createAuthorizeSetupInspection = (
  canonicalizer: PathCanonicalizer,
  pathAlgebra: PathAlgebra,
): AuthorizeSetupInspection => ({
  async execute(input, options) {
    if (input.observationEpoch.length === 0 || input.roots.length === 0) {
      return {
        diagnostics: [{ code: "path_outside_scope", subject: "scope" }],
        status: "denied",
      };
    }

    const roots = await canonicalizeRoots(pathAlgebra, input, canonicalizer, options?.signal);
    if (roots === undefined) {
      return {
        diagnostics: [{ code: "path_outside_scope", subject: "scope" }],
        status: "denied",
      };
    }
    const installations = await collectInstallationCandidates(
      pathAlgebra,
      input,
      roots,
      canonicalizer,
      options?.signal,
    );
    const configuration = await collectConfigurationSources(
      pathAlgebra,
      input,
      roots,
      canonicalizer,
      options?.signal,
    );

    return {
      configurationSources: configuration.configurationSources.toSorted(
        (left, right) => compareText(left.canonicalPath, right.canonicalPath),
      ),
      diagnostics: [
        ...installations.diagnostics,
        ...configuration.diagnostics,
      ].toSorted((left, right) =>
        compareText(`${left.code}:${left.subject}`, `${right.code}:${right.subject}`),
      ),
      installationCandidates: installations.installationCandidates.toSorted(
        (left, right) => compareText(left.displayPath, right.displayPath),
      ),
      observationEpoch: input.observationEpoch,
      status: "authorized",
    };
  },
});
