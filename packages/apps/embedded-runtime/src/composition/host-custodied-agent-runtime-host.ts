import { bindContainedTurnCapabilityAuthority } from "./contained-turn-authority-capability.js";
import {
  createAgentRuntimeHost,
  type AgentRuntimeHost,
  type AgentRuntimeHostDependencies,
} from "./agent-runtime-host.js";
import {
  createHostCustodiedContainedTurn,
  type HostCustodiedContainedTurnComposition,
  type HostCustodiedContainedTurnDependencies,
  type LinuxCodexDeploymentContainedTurnDependencies,
} from "./contained-turn-feature-composition.js";
import { disposeAfterContainedTurnConstructionFailure } from "./contained-turn-construction-failure.js";

export interface HostCustodiedAgentRuntimeHostDependencies {
  readonly authorityRevision: string;
  readonly capabilities: Omit<AgentRuntimeHostDependencies, "containedTurn">;
  readonly containedTurn: HostCustodiedContainedTurnDependencies;
}

/** Package-private Linux deployment input. The public Host dependency record
 * deliberately excludes product-owned infrastructure. */
export type LinuxCodexDeploymentAgentRuntimeHostDependencies = Readonly<
  Omit<HostCustodiedAgentRuntimeHostDependencies, "containedTurn"> & {
    readonly containedTurn: LinuxCodexDeploymentContainedTurnDependencies;
  }
>;

type ContainedTurnCompositionFactory = (
  dependencies: HostCustodiedContainedTurnDependencies,
) => HostCustodiedContainedTurnComposition;

/** Internal deterministic seam for construction-order and cleanup verification. */
export const composeHostCustodiedAgentRuntimeHost = (
  dependencies: HostCustodiedAgentRuntimeHostDependencies,
  containedTurnFactory: ContainedTurnCompositionFactory,
  hostFactory: typeof createAgentRuntimeHost,
): AgentRuntimeHost => {
  const containedTurn = containedTurnFactory(dependencies.containedTurn);
  let ownerDisposed = false;
  let host: AgentRuntimeHost;
  try {
    host = hostFactory(Object.freeze({
      claudeCodeSetup: dependencies.capabilities.claudeCodeSetup,
      codexSetup: dependencies.capabilities.codexSetup,
      containedTurn: bindContainedTurnCapabilityAuthority(containedTurn.feature, dependencies.authorityRevision),
    }));
  } catch (error) {
    return disposeAfterContainedTurnConstructionFailure(error, () => { containedTurn.dispose(); });
  }
  const dispose = async (): Promise<void> => {
    // Fence preparation and delegated creators synchronously, before durable
    // cancellation can suspend. Retain custody until shutdown proves release safe.
    containedTurn.sealAdmission();
    await host.dispose();
    if (!ownerDisposed) {
      containedTurn.dispose();
      ownerDisposed = true;
    }
  };
  return Object.freeze({
    bindAccess: host.bindAccess.bind(host),
    dispose,
    [Symbol.asyncDispose]: dispose,
  });
};

/** Retains current-provider ownership inside the private Embedded Runtime Host lifetime. */
export const createHostCustodiedAgentRuntimeHost = (
  dependencies: HostCustodiedAgentRuntimeHostDependencies,
): AgentRuntimeHost => composeHostCustodiedAgentRuntimeHost(
  dependencies,
  createHostCustodiedContainedTurn,
  createAgentRuntimeHost,
);

/** Typed package-private entrypoint for the existing Linux deployment root. */
export const createLinuxCodexDeploymentAgentRuntimeHost = (
  dependencies: LinuxCodexDeploymentAgentRuntimeHostDependencies,
): AgentRuntimeHost => composeHostCustodiedAgentRuntimeHost(
  dependencies,
  createHostCustodiedContainedTurn,
  createAgentRuntimeHost,
);
