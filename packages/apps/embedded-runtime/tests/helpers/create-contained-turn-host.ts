import {
  bindContainedTurnCapabilityAuthority,
  createAgentRuntimeHost as createBoundHost,
  type AgentRuntimeHostDependencies,
  type ContainedTurnCapabilityBundle,
} from "../../dist/composition.js";

/** Synthetic fixtures explicitly select their owner revision at composition. */
export const createAgentRuntimeHost = (
  dependencies: Omit<AgentRuntimeHostDependencies, "containedTurn"> & {
    readonly containedTurn?: ContainedTurnCapabilityBundle;
  },
) => createBoundHost({
  ...dependencies,
  ...(dependencies.containedTurn === undefined ? {} : {
    containedTurn: bindContainedTurnCapabilityAuthority(
      dependencies.containedTurn, "runtime-access-authority:fixture",
    ),
  }),
});
