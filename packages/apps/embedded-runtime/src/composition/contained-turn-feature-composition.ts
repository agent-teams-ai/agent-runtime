import {
  createContainedTurnFeature,
  createContainedTurnProviderAccessPort,
  createContainedTurnRuntimeSecurityPort,
  type ContainedTurnFeatureDependencies,
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
