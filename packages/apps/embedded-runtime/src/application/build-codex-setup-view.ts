import { createHash } from "node:crypto";

import type {
  DiscoverCodexInstallations,
  InstallationCandidate,
} from "@agent-teams/agent-execution";
import type {
  CodexConfigurationSource,
  InspectCodexConfiguration,
} from "@agent-teams/runtime-configuration";
import type { AuthorizeSetupInspection } from "@agent-teams/runtime-security";

import type {
  CodexSetupDiagnostic,
  InspectCodexRuntimeSetup,
  InspectCodexRuntimeSetupOutcome,
} from "../contracts/runtime-access.js";
import type { TrustedRuntimeAccessScope } from "../composition/trusted-runtime-access-scope.js";

export interface BuildCodexSetupViewDependencies {
  readonly authorizeSetupInspection: AuthorizeSetupInspection;
  readonly discoverCodexInstallations: DiscoverCodexInstallations;
  readonly inspectCodexConfiguration: InspectCodexConfiguration;
}

const nativeProfilePattern = /^[A-Za-z0-9_-]{1,64}$/u;

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
};

const observationRef = (scope: TrustedRuntimeAccessScope): string =>
  `codex-setup-observation:${createHash("sha256")
    .update(`${scope.scopeId}\0${scope.observationEpoch}`)
    .digest("hex")}`;

export const createBuildCodexSetupView = (
  dependencies: BuildCodexSetupViewDependencies,
) =>
  async (
    scope: TrustedRuntimeAccessScope,
    input: InspectCodexRuntimeSetup,
    options?: { readonly signal?: AbortSignal },
  ): Promise<InspectCodexRuntimeSetupOutcome> => {
    options?.signal?.throwIfAborted();
    const authorization = await dependencies.authorizeSetupInspection.execute(
      {
        configurationSources: scope.configurationSources,
        explicitExecutablePaths: scope.explicitCodexExecutablePaths,
        knownExecutableDirectories: scope.knownExecutableDirectories,
        observationEpoch: scope.observationEpoch,
        pathEntries: scope.pathEntries,
        platform: scope.platform,
        roots: scope.roots,
      },
      options,
    );
    if (authorization.status !== "authorized") {
      return deepFreeze({
        diagnostics: authorization.diagnostics.map(diagnostic => ({
          code: diagnostic.code,
          ...(diagnostic.subject === undefined
            ? {}
            : { subject: diagnostic.subject }),
        })),
        status: authorization.status,
      });
    }

    const installationCandidates: InstallationCandidate[] =
      authorization.installationCandidates.map(candidate => ({
        absolutePath: candidate.absolutePath,
        canonicalPath: candidate.canonicalPath,
        displayPath: candidate.displayPath,
        required: candidate.required,
        source: candidate.source,
      }));
    const configurationSources: CodexConfigurationSource[] =
      authorization.configurationSources.map(source => ({
        absolutePath: source.absolutePath,
        canonicalPath: source.canonicalPath,
        displayPath: source.displayPath,
        kind: source.kind,
        observationEpoch: source.observationEpoch,
        precedence: source.precedence,
        sourceRef: source.sourceRef,
      }));

    const diagnostics: CodexSetupDiagnostic[] = authorization.diagnostics.map(
      diagnostic => ({
        code: diagnostic.code,
        ...(diagnostic.subject === undefined
          ? {}
          : { subject: diagnostic.subject }),
      }),
    );
    const nativeProfile =
      input.nativeProfile === undefined || nativeProfilePattern.test(input.nativeProfile)
        ? input.nativeProfile
        : undefined;
    if (input.nativeProfile !== undefined && nativeProfile === undefined) {
      diagnostics.push({ code: "native_profile_invalid" });
    }

    const [installations, configuration] = await Promise.all([
      dependencies.discoverCodexInstallations.execute(
        {
          candidates: installationCandidates,
          observationEpoch: authorization.observationEpoch,
        },
        options,
      ),
      dependencies.inspectCodexConfiguration.execute(
        {
          observationEpoch: authorization.observationEpoch,
          sources: configurationSources,
          ...(nativeProfile === undefined ? {} : { nativeProfile }),
        },
        options,
      ),
    ]);

    diagnostics.push(
      ...installations.diagnostics.map(diagnostic => ({
        code: diagnostic.code,
        subject: diagnostic.candidate,
      })),
      ...configuration.diagnostics.map(diagnostic => ({
        code: diagnostic.code,
        subject: diagnostic.setting ?? diagnostic.sourceRef,
      })),
    );
    const sortedDiagnostics = diagnostics.toSorted((left, right) =>
      compareText(
        `${left.code}:${left.subject ?? ""}`,
        `${right.code}:${right.subject ?? ""}`,
      ),
    );

    const nextActions = new Set<
      "install_codex" | "review_configuration" | "trust_workspace"
    >();
    if (installations.installations.length === 0) {
      nextActions.add("install_codex");
    }
    if (
      configuration.diagnostics.length > 0 ||
      diagnostics.some(item => item.code === "native_profile_invalid")
    ) {
      nextActions.add("review_configuration");
    }
    if (authorization.diagnostics.some(item => item.code === "source_untrusted")) {
      nextActions.add("trust_workspace");
    }

    return deepFreeze({
      diagnostics: sortedDiagnostics,
      installations: installations.installations.map(installation => ({
        aliases: installation.aliases.map(alias => ({ ...alias })),
        installationRef: installation.installationRef,
        status: installation.status,
      })),
      nextActions: [...nextActions].toSorted(),
      observationRef: observationRef(scope),
      settings: configuration.settings.map(setting => ({ ...setting })),
      sources: configuration.sources.map(source => ({ ...source })),
      status:
        installations.installations.length > 0 && sortedDiagnostics.length === 0
          ? "complete"
          : "partial",
    });
  };
