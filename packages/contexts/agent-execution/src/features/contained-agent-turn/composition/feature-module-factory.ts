import { createContainedTurnEngine } from "../application/contained-turn-engine.js";
import type {
  ContainedTurnArtifactPort,
  ContainedTurnOperationStore,
  ContainedTurnProviderPort,
  ContainedTurnSecurityPort,
  ContainedTurnWorkspacePort,
  ProviderProcessCustodyPort,
} from "../application/ports/outbound/contained-turn-ports.js";

export interface ContainedTurnFeatureDependencies {
  readonly operationStore: ContainedTurnOperationStore;
  readonly security: ContainedTurnSecurityPort;
  readonly workspace: ContainedTurnWorkspacePort;
  readonly artifacts: ContainedTurnArtifactPort;
  readonly custody: ProviderProcessCustodyPort;
  readonly provider: ContainedTurnProviderPort;
}

export const createContainedTurnFeature = (
  dependencies: ContainedTurnFeatureDependencies,
) => createContainedTurnEngine(Object.freeze({
  operationStore: dependencies.operationStore,
  security: dependencies.security,
  workspace: dependencies.workspace,
  artifacts: dependencies.artifacts,
  custody: dependencies.custody,
  provider: dependencies.provider,
}));
