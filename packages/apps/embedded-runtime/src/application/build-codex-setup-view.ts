import { createHmac } from "node:crypto";

import type {
  DiscoverCodexInstallations,
  InstallationCandidate,
} from "@agent-teams/agent-execution";
import type {
  CodexConfigurationSource,
  InspectCodexConfiguration,
} from "@agent-teams/runtime-configuration";
import type {
  AuthorizeSetupInspection,
  AuthorizedConfigurationSource,
  AuthorizedInstallationCandidate,
} from "@agent-teams/runtime-security";

import type {
  CodexSetupDiagnostic,
  InspectCodexRuntimeSetup,
  InspectCodexRuntimeSetupOutcome,
} from "../contracts/runtime-access.js";
import type { TrustedRuntimeAccessScope } from "./trusted-runtime-access-scope.js";

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

const observationRef = (
  opaqueReferenceKey: Uint8Array,
  scope: TrustedRuntimeAccessScope,
): string =>
  `codex-setup-observation:${createHmac("sha256", opaqueReferenceKey)
    .update(JSON.stringify([
      "codex-setup-observation",
      scope.scopeId,
      scope.observationEpoch,
    ]))
    .digest("hex")}`;

const installationObservationRef = (
  opaqueReferenceKey: Uint8Array,
  scope: TrustedRuntimeAccessScope,
  internalInstallationRef: string,
): string =>
  `codex-installation:${createHmac("sha256", opaqueReferenceKey)
    .update(JSON.stringify([
      "codex-installation-observation",
      scope.scopeId,
      scope.observationEpoch,
      internalInstallationRef,
    ]))
    .digest("hex")}`;

const mapInstallationCandidate = (
  candidate: AuthorizedInstallationCandidate,
): InstallationCandidate => ({
  absolutePath: candidate.absolutePath,
  ...(candidate.authorizedFileIdentity === undefined
    ? {}
    : { authorizedFileIdentity: candidate.authorizedFileIdentity }),
  canonicalPath: candidate.canonicalPath,
  custodyRoot: candidate.custodyRoot,
  displayPath: candidate.displayPath,
  required: candidate.required,
  source: candidate.source,
});

const mapConfigurationSource = (
  source: AuthorizedConfigurationSource,
): CodexConfigurationSource => ({
  absolutePath: source.absolutePath,
  ...(source.authorizedFileIdentity === undefined
    ? {}
    : { authorizedFileIdentity: source.authorizedFileIdentity }),
  canonicalPath: source.canonicalPath,
  custodyRoot: source.custodyRoot,
  displayPath: source.displayPath,
  kind: source.kind,
  observationEpoch: source.observationEpoch,
});

export const createBuildCodexSetupView = (
  dependencies: BuildCodexSetupViewDependencies,
  opaqueReferenceKey: Uint8Array,
) => {
  if (opaqueReferenceKey.byteLength < 32) {
    throw new TypeError("opaqueReferenceKey must contain at least 32 bytes");
  }
  const referenceKey = Uint8Array.from(opaqueReferenceKey);
  return async (
    scope: TrustedRuntimeAccessScope,
    input: InspectCodexRuntimeSetup,
    options?: { readonly signal?: AbortSignal },
  ): Promise<InspectCodexRuntimeSetupOutcome> => {
    const requestedNativeProfile = input.nativeProfile;
    const nativeProfile =
      requestedNativeProfile === undefined ||
      (typeof requestedNativeProfile === "string" &&
        nativeProfilePattern.test(requestedNativeProfile))
        ? requestedNativeProfile
        : undefined;
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

    const installationCandidates = authorization.installationCandidates.map(
      mapInstallationCandidate,
    );
    const configurationSources = authorization.configurationSources.map(
      mapConfigurationSource,
    );

    const diagnostics: CodexSetupDiagnostic[] = authorization.diagnostics.map(
      diagnostic => ({
        code: diagnostic.code,
        ...(diagnostic.subject === undefined
          ? {}
          : { subject: diagnostic.subject }),
      }),
    );
    if (requestedNativeProfile !== undefined && nativeProfile === undefined) {
      diagnostics.push({ code: "native_profile_invalid" });
    }

    const [installationSettlement, configurationSettlement] = await Promise.allSettled([
      dependencies.discoverCodexInstallations.execute(
        {
          candidates: installationCandidates,
          observationEpoch: authorization.observationEpoch,
        },
        options,
      ),
      dependencies.inspectCodexConfiguration.execute(
        {
          identityScope: scope.scopeId,
          observationEpoch: authorization.observationEpoch,
          sources: configurationSources,
          ...(nativeProfile === undefined ? {} : { nativeProfile }),
        },
        options,
      ),
    ]);
    if (installationSettlement.status === "rejected") {
      throw installationSettlement.reason;
    }
    if (configurationSettlement.status === "rejected") {
      throw configurationSettlement.reason;
    }
    const installations = installationSettlement.value;
    const configuration = configurationSettlement.value;

    diagnostics.push(
      ...installations.diagnostics.map(diagnostic => ({
        code: diagnostic.code,
        subject: diagnostic.candidate,
      })),
      ...configuration.diagnostics.map(diagnostic => ({
        code: diagnostic.code,
        ...(diagnostic.setting === undefined && diagnostic.sourceRef === undefined
          ? {}
          : { subject: diagnostic.setting ?? diagnostic.sourceRef }),
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
        installationRef: installationObservationRef(
          referenceKey,
          scope,
          installation.installationRef,
        ),
        status: installation.status,
      })),
      nextActions: [...nextActions].toSorted(),
      observationRef: observationRef(referenceKey, scope),
      settings: configuration.settings.map(setting => ({ ...setting })),
      sources: configuration.sources.map(source => ({ ...source })),
      status:
        installations.installations.length > 0 && sortedDiagnostics.length === 0
          ? "complete"
          : "partial",
    });
  };
};
