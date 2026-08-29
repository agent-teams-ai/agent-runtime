import {
  createContainedTurnFeature,
  createContainedTurnProviderAccessPort,
  type ContainedTurnFeatureDependencies,
  type OuterContainedTurnProviderAccess,
} from "@agent-teams/agent-execution/composition";
import type { ContainedTurnFeatureApi } from "@agent-teams/agent-execution";

export interface ContainedTurnOuterCompositionDependencies
  extends Omit<ContainedTurnFeatureDependencies, "providerAccess"> {
  readonly providerAccess: OuterContainedTurnProviderAccess;
}

/** The only cross-context binding from Provider Access into Agent Execution. */
export const createContainedTurnFeatureFromProviderAccess = (
  dependencies: ContainedTurnOuterCompositionDependencies,
): ContainedTurnFeatureApi => createContainedTurnFeature(Object.freeze({
  operationStore: dependencies.operationStore,
  security: dependencies.security,
  providerAccess: createContainedTurnProviderAccessPort(dependencies.providerAccess),
  workspace: dependencies.workspace,
  artifacts: dependencies.artifacts,
  custody: dependencies.custody,
  provider: dependencies.provider,
}));
