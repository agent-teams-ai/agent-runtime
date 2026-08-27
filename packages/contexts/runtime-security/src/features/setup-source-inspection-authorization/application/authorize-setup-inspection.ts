import { isAbsolute, join, relative, resolve } from "node:path";

import type {
  AuthorizeSetupInspection,
  AuthorizeSetupInspectionInput,
  AuthorizedConfigurationSource,
  AuthorizedInstallationCandidate,
  SetupAuthorizationDiagnostic,
  TrustedSetupPathRoot,
} from "../contracts/setup-inspection-authorization.js";
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

const contains = (root: string, candidate: string): boolean => {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
};

const selectRoot = (
  lexicalPath: string,
  canonicalPath: string,
  roots: readonly CanonicalRoot[],
  expectedKind?: CanonicalRoot["kind"],
): CanonicalRoot | undefined =>
  roots
    .filter(
      root =>
        (expectedKind === undefined || root.kind === expectedKind) &&
        contains(resolve(root.absolutePath), lexicalPath) &&
        contains(root.canonicalPath, canonicalPath),
    )
    .toSorted(
      (left, right) =>
        right.canonicalPath.length - left.canonicalPath.length ||
        right.absolutePath.length - left.absolutePath.length ||
        compareText(left.displayName, right.displayName),
    )[0];

const displayPath = (candidate: string, root: CanonicalRoot): string => {
  const suffix = relative(resolve(root.absolutePath), candidate);
  return suffix === "" ? root.displayName : `${root.displayName}/${suffix}`;
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

const canonicalizeRoots = async (
  input: AuthorizeSetupInspectionInput,
  canonicalizer: PathCanonicalizer,
  signal?: AbortSignal,
): Promise<readonly CanonicalRoot[] | undefined> => {
  const roots: CanonicalRoot[] = [];
  try {
    for (const root of input.roots) {
      signal?.throwIfAborted();
      if (!isAbsolute(root.absolutePath)) {
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

const authorizeExecutable = async (
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
  const lexicalPath = resolve(request.absolutePath);
  let canonicalPath: string;
  let authorizedFileIdentity: string | undefined;
  let hardLinked = false;
  try {
    const canonical = await dependencies.canonicalizer.canonicalize(
      lexicalPath,
      cancellationOptions(signal),
    );
    canonicalPath = canonical.absolutePath;
    authorizedFileIdentity = canonical.fileIdentity;
    hardLinked = canonical.isFile === true && (canonical.linkCount ?? 0) > 1;
  } catch (error) {
    rethrowCancellation(error, signal);
    return { code: "path_outside_scope", subject: "unreadable-path" };
  }
  const root = selectRoot(lexicalPath, canonicalPath, dependencies.roots);
  if (root === undefined || hardLinked) {
    return {
      code: "path_outside_scope",
      subject: root === undefined ? "unscoped-path" : displayPath(lexicalPath, root),
    };
  }
  return {
    absolutePath: lexicalPath,
    ...(authorizedFileIdentity === undefined ? {} : { authorizedFileIdentity }),
    canonicalPath,
    displayPath: displayPath(lexicalPath, root),
    required: request.required,
    source: request.source,
  };
};

const collectInstallationCandidates = async (
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

  for (const entry of input.pathEntries) {
    if (entry.length === 0) {
      diagnostics.push({ code: "empty_path_entry", subject: "PATH" });
    } else if (!isAbsolute(entry)) {
      diagnostics.push({ code: "relative_path_entry", subject: "PATH" });
    } else {
      requests.push({
        absolutePath: join(entry, "codex"),
        required: false,
        source: "path-entry",
      });
    }
  }
  for (const directory of input.knownExecutableDirectories) {
    if (!isAbsolute(directory)) {
      diagnostics.push({ code: "relative_path_entry", subject: "known-location" });
    } else {
      requests.push({
        absolutePath: join(directory, "codex"),
        required: false,
        source: "known-location",
      });
    }
  }
  for (const absolutePath of input.explicitExecutablePaths) {
    if (!isAbsolute(absolutePath)) {
      diagnostics.push({ code: "relative_path_entry", subject: "explicit" });
    } else {
      requests.push({ absolutePath, required: true, source: "explicit" });
    }
  }

  const installationCandidates: AuthorizedInstallationCandidate[] = [];
  for (const request of requests) {
    const result = await authorizeExecutable(
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
    if (!isAbsolute(source.absolutePath)) {
      diagnostics.push({ code: "path_outside_scope", subject: `${source.kind}-config` });
      continue;
    }
    const lexicalPath = resolve(source.absolutePath);
    let canonicalPath: string;
    let authorizedFileIdentity: string | undefined;
    let hardLinked = false;
    try {
      const canonical = await canonicalizer.canonicalize(
        lexicalPath,
        cancellationOptions(signal),
      );
      canonicalPath = canonical.absolutePath;
      authorizedFileIdentity = canonical.fileIdentity;
      hardLinked = canonical.isFile === true && (canonical.linkCount ?? 0) > 1;
    } catch (error) {
      rethrowCancellation(error, signal);
      diagnostics.push({ code: "path_outside_scope", subject: `${source.kind}-config` });
      continue;
    }
    const expectedRootKind = source.kind === "user" ? "home" : "workspace";
    const root = selectRoot(lexicalPath, canonicalPath, roots, expectedRootKind);
    if (root === undefined || hardLinked) {
      diagnostics.push({
        code: "path_outside_scope",
        subject:
          root === undefined
            ? `${source.kind}-config`
            : displayPath(lexicalPath, root),
      });
      continue;
    }
    configurationSources.push({
      absolutePath: lexicalPath,
      ...(authorizedFileIdentity === undefined ? {} : { authorizedFileIdentity }),
      canonicalPath,
      displayPath: displayPath(lexicalPath, root),
      kind: source.kind,
      observationEpoch: input.observationEpoch,
    });
  }
  return { configurationSources, diagnostics };
};

export const createAuthorizeSetupInspection = (
  canonicalizer: PathCanonicalizer,
): AuthorizeSetupInspection => ({
  async execute(input, options) {
    if (input.platform !== "darwin") {
      return { diagnostics: [], status: "unsupported" };
    }
    if (input.observationEpoch.length === 0 || input.roots.length === 0) {
      return {
        diagnostics: [{ code: "path_outside_scope", subject: "scope" }],
        status: "denied",
      };
    }

    const roots = await canonicalizeRoots(input, canonicalizer, options?.signal);
    if (roots === undefined) {
      return {
        diagnostics: [{ code: "path_outside_scope", subject: "scope" }],
        status: "denied",
      };
    }
    const installations = await collectInstallationCandidates(
      input,
      roots,
      canonicalizer,
      options?.signal,
    );
    const configuration = await collectConfigurationSources(
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
