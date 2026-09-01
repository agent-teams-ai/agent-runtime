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
import type { ContainedTurnFeatureApi } from "@agent-teams/agent-execution";

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
  readonly feature: ContainedTurnFeatureApi;
  dispose(): void;
}
/** The only cross-context binding from Provider Access into Agent Execution. */
export const createContainedTurnFeatureFromProviderAccess = (
  dependencies: ContainedTurnOuterCompositionDependencies,
): ContainedTurnFeatureApi => createContainedTurnFeature(Object.freeze({
  operationStore: dependencies.operationStore,
  security: createContainedTurnRuntimeSecurityPort(
    dependencies.security.legacy, dependencies.security.dispatchAuthorityV1,
  ),
  providerAccess: createContainedTurnProviderAccessPort(dependencies.providerAccess),
  workspace: dependencies.workspace,
  artifacts: dependencies.artifacts,
  custody: dependencies.custody,
  provider: dependencies.provider,
}));

/** Product-owned outer assembly for one explicitly selected provider and one Host Custody authority. */
export const createHostCustodiedContainedTurn = (
  dependencies: HostCustodiedContainedTurnDependencies,
): HostCustodiedContainedTurnComposition => {
  const owner: ClaudeCurrentKernelOwner | CodexCurrentKernelOwner =
    dependencies.selectedProvider.kind === "claude"
      ? createClaudeCurrentKernelOwner({
        ...dependencies.selectedProvider.owner,
        hostCustody: dependencies.hostCustody,
      })
      : createCodexCurrentKernelOwner({
        ...dependencies.selectedProvider.owner,
        hostCustody: dependencies.hostCustody,
      });
  const feature = createContainedTurnFeatureFromProviderAccess(Object.freeze({
    operationStore: dependencies.operationStore,
    security: dependencies.security,
    providerAccess: dependencies.providerAccess,
    workspace: dependencies.workspace,
    artifacts: dependencies.artifacts,
    custody: owner.custody,
    provider: owner.provider,
  }));
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
