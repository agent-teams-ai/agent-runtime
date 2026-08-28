import { createHmac } from "node:crypto";

import type {
  ClaudeCodeInstallationCandidate,
  DiscoverClaudeCodeInstallations,
} from "@agent-teams/agent-execution";
import {
  CLAUDE_CODE_CONFIGURATION_BUDGETS,
  type ClaudeCodeConfigurationSource,
  type InspectClaudeCodeConfiguration,
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
  modelCompatibility: "unobserved" as const,
  sessionOverrides: "unobserved" as const,
});

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
  sourceIndex: number,
): ClaudeCodeConfigurationSource => {
  const rootId = source.kind === "user" ? "declared-home-root" : "declared-workspace-root";
  const common = {
    displayPath: source.displayPath,
    observationEpoch: source.observationEpoch,
    role: source.kind,
    selectionBasis: "static-preview" as const,
    sourceId: `static-source-${sourceIndex + 1}`,
    trust: source.kind === "user" ? "user" as const :
      source.access === "untrusted" ? "workspace-untrusted" as const : "workspace-trusted" as const,
  };
  return source.access === "authorized"
  ? {
      access: "authorized",
      absolutePath: source.absolutePath,
      ...(source.authorizedFileIdentity === undefined
        ? {}
        : { authorizedFileIdentity: source.authorizedFileIdentity }),
      canonicalPath: source.canonicalPath,
      custodyRoot: { ...source.custodyRoot, rootId },
      ...common,
    }
  : {
      access: source.access,
      custodyRootRef: rootId,
      ...common,
    };
};

const mapAuthorizationDiagnostic = (
  diagnostic: ClaudeCodeSetupAuthorizationDiagnostic,
  publicSourceReference?: ReadonlyMap<string, string>,
): ClaudeCodeSetupDiagnostic => ({
  code: diagnostic.code,
  ...(diagnostic.safeRef === undefined
    ? {}
    : { safeRef: publicSourceReference?.get(diagnostic.safeRef) ?? diagnostic.safeRef }),
});

const normalizeDiagnostics = (
  candidates: readonly ClaudeCodeSetupDiagnostic[],
): readonly ClaudeCodeSetupDiagnostic[] => [...new Map(candidates.map(diagnostic => [
  `${diagnostic.code}:${diagnostic.safeRef ?? ""}`,
  diagnostic,
])).values()].toSorted((left, right) => compareText(
  `${left.code}:${left.safeRef ?? ""}`,
  `${right.code}:${right.safeRef ?? ""}`,
)).slice(0, CLAUDE_CODE_CONFIGURATION_BUDGETS.diagnostics);

type AuthorizedInspection = Extract<
  Awaited<ReturnType<AuthorizeClaudeCodeSetupInspection["execute"]>>,
  { readonly status: "authorized" }
>;
type InstallationInspection = Awaited<ReturnType<DiscoverClaudeCodeInstallations["execute"]>>;
type ConfigurationInspection = Awaited<ReturnType<InspectClaudeCodeConfiguration["execute"]>>;

interface ProjectionInput {
  readonly authorization: AuthorizedInspection;
  readonly configuration: ConfigurationInspection;
  readonly installations: InstallationInspection;
  readonly referenceKey: Uint8Array;
  readonly scope: TrustedClaudeCodeSetupScope;
}

const projectObservedSetup = ({
  authorization, configuration, installations, referenceKey, scope,
}: ProjectionInput): InspectClaudeCodeRuntimeSetupOutcome => {
    const deferredConfiguration = configuration.deferredObservations;
    const observedConfiguration = configuration.observedPortableIntent;
    const sourceModel = configuration.sourceModel;
    const sourceReferences = new Map(configuration.sources.map(source => [
      source.sourceRef,
      hmacRef(referenceKey, "claude-code-setup-source", scope, source.sourceRef),
    ]));
    const mapSafeRef = (safeRef?: string): string | undefined =>
      safeRef === undefined
        ? undefined
        : sourceReferences.get(safeRef) ??
          hmacRef(referenceKey, "claude-code-setup-source", scope, safeRef);
    const referencesByRole = Map.groupBy(configuration.sources, source => source.role);
    const publicSourceReference = new Map<string, string>();
    for (const [role, sources] of referencesByRole) {
      if (sources.length === 1) {publicSourceReference.set(role, mapSafeRef(sources[0]!.sourceRef)!);}
    }
    const diagnosticCandidates: ClaudeCodeSetupDiagnostic[] = [
      ...authorization.diagnostics.map(diagnostic =>
        mapAuthorizationDiagnostic(diagnostic, publicSourceReference)),
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
    ];
    const diagnostics = normalizeDiagnostics(diagnosticCandidates);

    const nextActions = new Set<
      "install_claude_code" | "review_configuration" | "trust_workspace"
    >();
    if (installations.installations.length === 0) {
      nextActions.add("install_claude_code");
    }
    if (configuration.diagnostics.length > 0) {
      nextActions.add("review_configuration");
    }
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
      observationRef: hmacRef(referenceKey, "claude-code-setup-observation", scope, JSON.stringify({
        sourceModel,
        sources: configuration.sources.map(source => ({
          semanticDigest: source.semanticDigest ?? null, sourceRef: source.sourceRef, status: source.status,
        })),
      })),
      deferredObservations: deferredConfiguration.map(observation => ({
        ...observation,
        sourceRef: sourceReferences.get(observation.sourceRef) ??
          hmacRef(referenceKey, "claude-code-setup-source", scope, observation.sourceRef),
      })),
      observedPortableIntent: observedConfiguration.map(intent => ({
        ...intent,
        ...(intent.key === "model" ? { selection: { ...intent.selection } } : {}),
        sourceRef: sourceReferences.get(intent.sourceRef) ??
          hmacRef(referenceKey, "claude-code-setup-source", scope, intent.sourceRef),
      })),
      sourceObservations: configuration.sources.map(source => ({
        displayPath: source.displayPath,
        role: source.role,
        selectionBasis: source.selectionBasis,
        ...(source.semanticDigest === undefined ? {} : { semanticDigest: source.semanticDigest }),
        sourceRef: sourceReferences.get(source.sourceRef) ??
          hmacRef(referenceKey, "claude-code-setup-source", scope, source.sourceRef),
        status: source.status,
      })),
      sourceModel: { ...sourceModel },
      status: diagnostics.length === 0 ? "observed" : "partial",
    });
};

const inspectClaudeCodeSetup = async (
  scope: TrustedClaudeCodeSetupScope,
  dependencies: BuildClaudeCodeSetupViewDependencies,
  referenceKey: Uint8Array,
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
  const authorization = await dependencies.authorizeClaudeCodeSetupInspection.execute({
    candidatePaths: plan.candidatePaths, dialect: plan.dialect, homeRoot: scope.homeRoot,
    observationEpoch: scope.observationEpoch, sourcePaths: plan.sourcePaths,
    workspaceRoot: scope.workspaceRoot, workspaceTrusted: scope.workspaceTrusted,
  }, options);
  options?.signal?.throwIfAborted();
  if (authorization.status === "denied") {
    return deepFreeze({
      diagnostics: authorization.diagnostics.map(diagnostic => mapAuthorizationDiagnostic(diagnostic)),
      expectedLimitations,
      status: "denied",
    });
  }
  const installationCandidates = authorization.executableCandidates.map(mapCandidate);
  const configurationSources = authorization.sources.map(mapSource);
  const configurationRoots = [
    { absolutePath: scope.homeRoot, canonicalPath: scope.homeRoot, rootId: "declared-home-root" },
    { absolutePath: scope.workspaceRoot, canonicalPath: scope.workspaceRoot, rootId: "declared-workspace-root" },
  ].map(root => {
    const source = configurationSources.find(candidate =>
      candidate.access === "authorized" && candidate.custodyRoot.rootId === root.rootId);
    return source?.access === "authorized" ? source.custodyRoot : root;
  });
  const [installationSettlement, configurationSettlement] = await Promise.allSettled([
    invokeAsPromise(() => dependencies.discoverClaudeCodeInstallations.execute({
      candidates: installationCandidates, observationEpoch: authorization.observationEpoch,
    }, options)),
    invokeAsPromise(() => dependencies.inspectClaudeCodeConfiguration.execute({
      dialect: plan.dialect, identityScope: scope.scopeId,
      sourcePlan: {
        claim: "observed-files-only",
        collector: {
          bundleId: "embedded-runtime-static-planner-v2", id: "embedded-runtime",
          observationEpoch: authorization.observationEpoch, platform: "darwin", version: "2",
        },
        contract: "claude-code-observed-source-plan/v1",
        roots: configurationRoots,
        sources: configurationSources,
      },
    }, options)),
  ]);
  if (installationSettlement.status === "rejected") {throw installationSettlement.reason;}
  if (configurationSettlement.status === "rejected") {throw configurationSettlement.reason;}
  return projectObservedSetup({
    authorization, configuration: configurationSettlement.value,
    installations: installationSettlement.value, referenceKey, scope,
  });
};

export const createBuildClaudeCodeSetupView = (
  dependencies: BuildClaudeCodeSetupViewDependencies,
  opaqueReferenceKey: Uint8Array,
) => {
  if (opaqueReferenceKey.byteLength < 32) {
    throw new TypeError("opaqueReferenceKey must contain at least 32 bytes");
  }
  const referenceKey = Uint8Array.from(opaqueReferenceKey);
  return (
    scope: TrustedClaudeCodeSetupScope,
    options?: { readonly signal?: AbortSignal },
  ): Promise<InspectClaudeCodeRuntimeSetupOutcome> =>
    inspectClaudeCodeSetup(scope, dependencies, referenceKey, options);
};
