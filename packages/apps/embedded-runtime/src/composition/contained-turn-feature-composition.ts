import {
  createClaudeCurrentKernelOwner,
  createCodexCurrentKernelOwner,
  createContainedTurnFeature,
  createContainedTurnProviderAccessPort,
  createContainedTurnRuntimeSecurityPort,
  type ClaudeCurrentKernelOwner,
  type CodexCurrentKernelOwner,
  type ContainedTurnFeatureDependencies,
  type CreateClaudeCurrentKernelOwnerOptions,
  type CreateCodexCurrentKernelOwnerOptions,
  type OuterContainedTurnProviderAccess,
  type OuterContainedTurnRuntimeSecurityAuthority,
} from "@agent-teams/agent-execution/composition";
import type { ContainedTurnCapabilityBundle } from "./contained-turn-runtime-access.js";
import { disposeAfterContainedTurnConstructionFailure } from "./contained-turn-construction-failure.js";
import {
  snapshotContainedTurnProviderSelection,
  type ContainedTurnProviderSelectionSnapshot,
} from "./contained-turn-provider-selection.js";

export interface ContainedTurnOuterCompositionDependencies
  extends Omit<ContainedTurnFeatureDependencies, "providerAccess" | "security"> {
  readonly providerAccess: OuterContainedTurnProviderAccess;
  readonly security: Readonly<{
    dispatchAuthorityV1: OuterContainedTurnRuntimeSecurityAuthority;
    legacy: Pick<ContainedTurnFeatureDependencies["security"], "authorizeForAcceptance" | "revalidateForDispatch">;
  }>;
}

type HostCustodyAuthority = CreateCodexCurrentKernelOwnerOptions["hostCustody"] &
  CreateClaudeCurrentKernelOwnerOptions["hostCustody"];

export type ContainedTurnHostProviderSelection =
  | Readonly<{
    readonly kind: "claude";
    readonly owner: Omit<CreateClaudeCurrentKernelOwnerOptions, "hostCustody">;
  }>
  | Readonly<{
    readonly kind: "codex";
    readonly owner: Omit<CreateCodexCurrentKernelOwnerOptions, "hostCustody">;
  }>;

export interface HostCustodiedContainedTurnDependencies
  extends Omit<ContainedTurnOuterCompositionDependencies, "custody" | "provider"> {
  /** One operation-scoped authority shared by the custody and provider adapters. */
  readonly hostCustody: HostCustodyAuthority;
  readonly selectedProvider: ContainedTurnHostProviderSelection;
}

export interface HostCustodiedContainedTurnComposition {
  readonly feature: ContainedTurnCapabilityBundle;
  dispose(): void;
}

export interface ContainedTurnProviderOwnerFactories {
  readonly claude: typeof createClaudeCurrentKernelOwner;
  readonly codex: typeof createCodexCurrentKernelOwner;
}

export const PROVIDER_ROUTE_ENFORCEMENT_UNQUALIFIED_REASON =
  "route-enforcement-unqualified" as const;

/**
 * Stable construction failure for provider candidates whose exact Provider
 * Access network route has not been promoted in the qualification registry.
 */
export class ProviderRouteEnforcementUnsupportedError extends Error {
  public readonly reason = PROVIDER_ROUTE_ENFORCEMENT_UNQUALIFIED_REASON;

  public constructor() {
    super(PROVIDER_ROUTE_ENFORCEMENT_UNQUALIFIED_REASON);
    this.name = "ProviderRouteEnforcementUnsupportedError";
    Object.freeze(this);
  }
}

const createSelectedProviderOwner = (
  snapshot: ContainedTurnProviderSelectionSnapshot,
  hostCustody: HostCustodyAuthority,
  factories: ContainedTurnProviderOwnerFactories,
): ClaudeCurrentKernelOwner | CodexCurrentKernelOwner => {
  const selection = snapshot.selection;
  switch (selection.kind) {
    case "claude": {
      const options = {...selection.owner, hostCustody};
      snapshot.assertStable();
      return factories.claude(options);
    }
    case "codex": {
      const options = {...selection.owner, hostCustody};
      snapshot.assertStable();
      return factories.codex(options);
    }
    default: throw new TypeError("Contained turn provider selection is invalid");
  }
};

/** The only cross-context binding from Provider Access into Agent Execution. */
export const createContainedTurnFeatureFromProviderAccess = (
  dependencies: ContainedTurnOuterCompositionDependencies,
): ContainedTurnCapabilityBundle => {
  // Product composition gates candidates before reaching this exact seven-port
  // binding; repository-owned synthetic evidence uses it without claiming qualification.
  const providerAccess = createContainedTurnProviderAccessPort(dependencies.providerAccess);
  return createContainedTurnFeature(Object.freeze({
    operationStore: dependencies.operationStore,
    security: createContainedTurnRuntimeSecurityPort(
      dependencies.security.legacy, dependencies.security.dispatchAuthorityV1,
    ),
    providerAccess,
    workspace: dependencies.workspace,
    artifacts: dependencies.artifacts,
    custody: dependencies.custody,
    provider: dependencies.provider,
  }));
};

/** Internal deterministic candidate seam used only by synthetic tests and live implementation canaries. */
export const composeHostCustodiedContainedTurn = (
  dependencies: HostCustodiedContainedTurnDependencies,
  ownerFactories: ContainedTurnProviderOwnerFactories,
  featureFactory: typeof createContainedTurnFeatureFromProviderAccess,
): HostCustodiedContainedTurnComposition => {
  const selectedProvider = snapshotContainedTurnProviderSelection(dependencies);
  const owner = createSelectedProviderOwner(
    selectedProvider, dependencies.hostCustody, ownerFactories,
  );
  let feature: ContainedTurnCapabilityBundle;
  try {
    feature = featureFactory(Object.freeze({
      operationStore: dependencies.operationStore,
      security: dependencies.security,
      providerAccess: dependencies.providerAccess,
      workspace: dependencies.workspace,
      artifacts: dependencies.artifacts,
      custody: owner.custody,
      provider: owner.provider,
    }));
  } catch (error) {
    return disposeAfterContainedTurnConstructionFailure(error, () => owner.dispose());
  }
  let disposed = false;
  return Object.freeze({
    feature,
    dispose() {
      if (disposed) {return;}
      disposed = true;
      owner.dispose();
    },
  });
};

/** @internal Candidate-only assembly for repository-owned synthetic evidence. */
export const composeCandidateHostCustodiedContainedTurnForImplementationEvidence = (
  dependencies: HostCustodiedContainedTurnDependencies,
): HostCustodiedContainedTurnComposition => composeHostCustodiedContainedTurn(
  dependencies,
  Object.freeze({claude: createClaudeCurrentKernelOwner, codex: createCodexCurrentKernelOwner}),
  createContainedTurnFeatureFromProviderAccess,
);

/**
 * Product/default composition. Codex and Claude remain candidate
 * implementations until an exact enforced-egress route is promoted.
 */
export const createHostCustodiedContainedTurn = (
  _dependencies: HostCustodiedContainedTurnDependencies,
): HostCustodiedContainedTurnComposition => {
  throw new ProviderRouteEnforcementUnsupportedError();
};
