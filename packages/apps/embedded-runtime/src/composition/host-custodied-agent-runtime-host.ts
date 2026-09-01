import {
  createAgentRuntimeHost,
  type AgentRuntimeHost,
  type AgentRuntimeHostDependencies,
} from "./agent-runtime-host.js";
import {
  createHostCustodiedContainedTurn,
  type HostCustodiedContainedTurnDependencies,
} from "./contained-turn-feature-composition.js";

export interface HostCustodiedAgentRuntimeHostDependencies {
  readonly capabilities: Omit<AgentRuntimeHostDependencies, "containedTurn">;
  readonly containedTurn: HostCustodiedContainedTurnDependencies;
}

/** Retains current-provider ownership inside the private Embedded Runtime Host lifetime. */
export const createHostCustodiedAgentRuntimeHost = (
  dependencies: HostCustodiedAgentRuntimeHostDependencies,
): AgentRuntimeHost => {
  const containedTurn = createHostCustodiedContainedTurn(dependencies.containedTurn);
  let ownerDisposed = false;
  const host = createAgentRuntimeHost(Object.freeze({
    claudeCodeSetup: dependencies.capabilities.claudeCodeSetup,
    codexSetup: dependencies.capabilities.codexSetup,
    containedTurn: containedTurn.feature,
  }));
  const dispose = async (): Promise<void> => {
    await host.dispose();
    if (!ownerDisposed) {
      ownerDisposed = true;
      containedTurn.dispose();
    }
  };
  return Object.freeze({
    bindAccess: host.bindAccess.bind(host),
    dispose,
    [Symbol.asyncDispose]: dispose,
  });
};
