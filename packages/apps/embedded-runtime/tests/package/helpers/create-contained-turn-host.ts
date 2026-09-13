import { createAgentRuntimeHost as createBoundHost } from "../../../dist/composition/agent-runtime-host.js";
import {
  bindContainedTurnCapabilityAuthority,
  type AgentRuntimeHostDependencies,
  type ContainedTurnCapabilityBundle,
} from "../../../dist/composition.js";

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
