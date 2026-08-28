import { createHmac } from "node:crypto";

import type {
  ClaudeCodeInstallationCandidate,
  DiscoverClaudeCodeInstallations,
} from "@agent-teams/agent-execution";
import type {
  ClaudeCodeConfigurationSource,
  InspectClaudeCodeConfiguration,
} from "@agent-teams/runtime-configuration";
import type {
  AuthorizeClaudeCodeSetupInspection,
  AuthorizedClaudeCodeExecutableCandidate,
  AuthorizedClaudeCodePortableSource,
  ClaudeCodeSetupAuthorizationDiagnostic,
} from "@agent-teams/runtime-security";

import type { ClaudeCodeSetupInspectionPlanner } from "./ports/outbound/claude-code-setup-inspection-planner.js";
import type { TrustedClaudeCodeSetupScope } from "./trusted-claude-code-setup-scope.js";
import type {
  ClaudeCodeSetupDiagnostic,
  InspectClaudeCodeRuntimeSetupOutcome,
} from "../contracts/runtime-access.js";

export interface BuildClaudeCodeSetupViewDependencies {
  readonly authorizeClaudeCodeSetupInspection: AuthorizeClaudeCodeSetupInspection;
  readonly discoverClaudeCodeInstallations: DiscoverClaudeCodeInstallations;
  readonly inspectClaudeCodeConfiguration: InspectClaudeCodeConfiguration;
  readonly planClaudeCodeSetupInspection: ClaudeCodeSetupInspectionPlanner;
}

const expectedLimitations = Object.freeze({
  interactiveShellPath: "unobserved" as const,
  managedPolicy: "unobserved" as const,
  sessionOverrides: "unobserved" as const,
});

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

const invokeAsPromise = <T>(operation: () => Promise<T>): Promise<T> =>
  Promise.resolve().then(operation);

const hmacRef = (
  key: Uint8Array,
  domain: "claude-code-setup-observation" | "claude-code-setup-installation" | "claude-code-setup-source",
  scope: TrustedClaudeCodeSetupScope,
  identity?: string,
): string => `${domain}:${createHmac("sha256", key)
  .update(JSON.stringify([domain, scope.scopeId, scope.observationEpoch, identity ?? ""]))
  .digest("hex")}`;

const mapCandidate = (
  candidate: AuthorizedClaudeCodeExecutableCandidate,
): ClaudeCodeInstallationCandidate => ({
  absolutePath: candidate.absolutePath,
  ...(candidate.authorizedFileIdentity === undefined
    ? {}
    : { authorizedFileIdentity: candidate.authorizedFileIdentity }),
  candidateIdentity: candidate.candidateIdentity,
  canonicalPath: candidate.canonicalPath,
  custodyRoot: { ...candidate.custodyRoot },
  displayPath: candidate.displayPath,
  priorityRank: candidate.priorityRank,
  required: candidate.source === "explicit",
  source: candidate.source,
});

const mapSource = (
  source: AuthorizedClaudeCodePortableSource,
): ClaudeCodeConfigurationSource => source.access === "authorized"
  ? {
      access: "authorized",
      absolutePath: source.absolutePath,
      ...(source.authorizedFileIdentity === undefined
        ? {}
        : { authorizedFileIdentity: source.authorizedFileIdentity }),
      canonicalPath: source.canonicalPath,
      custodyRoot: { ...source.custodyRoot },
      displayPath: source.displayPath,
      kind: source.kind,
      observationEpoch: source.observationEpoch,
    }
  : {
      access: source.access,
      displayPath: source.displayPath,
      kind: source.kind,
      observationEpoch: source.observationEpoch,
    };

const mapAuthorizationDiagnostic = (
  diagnostic: ClaudeCodeSetupAuthorizationDiagnostic,
): ClaudeCodeSetupDiagnostic => ({
  code: diagnostic.code,
  ...(diagnostic.safeRef === undefined ? {} : { safeRef: diagnostic.safeRef }),
});

export const createBuildClaudeCodeSetupView = (
  dependencies: BuildClaudeCodeSetupViewDependencies,
  opaqueReferenceKey: Uint8Array,
) => {
  if (opaqueReferenceKey.byteLength < 32) {
    throw new TypeError("opaqueReferenceKey must contain at least 32 bytes");
  }
  const referenceKey = Uint8Array.from(opaqueReferenceKey);
  return async (
    scope: TrustedClaudeCodeSetupScope,
    options?: { readonly signal?: AbortSignal },
  ): Promise<InspectClaudeCodeRuntimeSetupOutcome> => {
    options?.signal?.throwIfAborted();
    const plan = dependencies.planClaudeCodeSetupInspection.plan(scope);
    options?.signal?.throwIfAborted();
    if (plan.status === "unsupported") {
      return deepFreeze({
        diagnostics: [{ code: "unsupported_platform" }],
        expectedLimitations,
        status: "unsupported",
      });
    }

    const authorization = await dependencies.authorizeClaudeCodeSetupInspection.execute(
      {
        candidatePaths: plan.candidatePaths,
        dialect: plan.dialect,
        homeRoot: scope.homeRoot,
        observationEpoch: scope.observationEpoch,
        sourcePaths: plan.sourcePaths,
        workspaceRoot: scope.workspaceRoot,
        workspaceTrusted: scope.workspaceTrusted,
      },
      options,
    );
    options?.signal?.throwIfAborted();
    if (authorization.status === "denied") {
      return deepFreeze({
        diagnostics: authorization.diagnostics.map(mapAuthorizationDiagnostic),
        expectedLimitations,
        status: "denied",
      });
    }

    const installationCandidates = authorization.executableCandidates.map(mapCandidate);
    const configurationSources = authorization.sources.map(mapSource);
    const [installationSettlement, configurationSettlement] = await Promise.allSettled([
      invokeAsPromise(() => dependencies.discoverClaudeCodeInstallations.execute({
        candidates: installationCandidates,
        observationEpoch: authorization.observationEpoch,
      }, options)),
      invokeAsPromise(() => dependencies.inspectClaudeCodeConfiguration.execute({
        dialect: plan.dialect,
        identityScope: scope.scopeId,
        observationEpoch: authorization.observationEpoch,
        sources: configurationSources,
      }, options)),
    ]);
    if (installationSettlement.status === "rejected") throw installationSettlement.reason;
    if (configurationSettlement.status === "rejected") throw configurationSettlement.reason;

    const installations = installationSettlement.value;
    const configuration = configurationSettlement.value;
    const sourceReferences = new Map(configuration.sources.map(source => [
      source.sourceRef,
      hmacRef(referenceKey, "claude-code-setup-source", scope, source.sourceRef),
    ]));
    const mapSafeRef = (safeRef?: string): string | undefined =>
      safeRef === undefined
        ? undefined
        : sourceReferences.get(safeRef) ??
          hmacRef(referenceKey, "claude-code-setup-source", scope, safeRef);
    const diagnostics: ClaudeCodeSetupDiagnostic[] = [
      ...authorization.diagnostics.map(mapAuthorizationDiagnostic),
      ...installations.diagnostics.map(diagnostic => ({
        code: diagnostic.code,
        ...(diagnostic.candidateRef === undefined
          ? {}
          : {
              safeRef: hmacRef(
                referenceKey,
                "claude-code-setup-installation",
                scope,
                diagnostic.candidateRef,
              ),
            }),
      })),
      ...configuration.diagnostics.map(diagnostic => {
        const safeRef = mapSafeRef(diagnostic.safeRef);
        return {
          code: diagnostic.code,
          ...(safeRef === undefined ? {} : { safeRef }),
        };
      }),
    ].toSorted((left, right) => compareText(
      `${left.code}:${left.safeRef ?? ""}`,
      `${right.code}:${right.safeRef ?? ""}`,
    ));

    const nextActions = new Set<
      "install_claude_code" | "review_configuration" | "trust_workspace"
    >();
    if (installations.installations.length === 0) nextActions.add("install_claude_code");
    if (configuration.diagnostics.length > 0) nextActions.add("review_configuration");
    if (diagnostics.some(diagnostic => diagnostic.code === "source_untrusted")) {
      nextActions.add("trust_workspace");
    }

    return deepFreeze({
      diagnostics,
      expectedLimitations,
      installations: installations.installations.map(installation => ({
        aliases: installation.aliases.map(alias => ({ ...alias })),
        installationRef: hmacRef(
          referenceKey,
          "claude-code-setup-installation",
          scope,
          installation.installationRef,
        ),
        status: installation.status,
      })),
      nextActions: [...nextActions].toSorted(),
      observationRef: hmacRef(referenceKey, "claude-code-setup-observation", scope),
      portableIntent: configuration.portableIntent.map(intent => ({
        ...intent,
        sourceRef: sourceReferences.get(intent.sourceRef) ??
          hmacRef(referenceKey, "claude-code-setup-source", scope, intent.sourceRef),
      })),
      sourceObservations: configuration.sources.map(source => ({
        displayPath: source.displayPath,
        kind: source.kind,
        sourceRef: sourceReferences.get(source.sourceRef) ??
          hmacRef(referenceKey, "claude-code-setup-source", scope, source.sourceRef),
        status: source.status,
      })),
      status: diagnostics.length === 0 ? "observed" : "partial",
    });
  };
};
