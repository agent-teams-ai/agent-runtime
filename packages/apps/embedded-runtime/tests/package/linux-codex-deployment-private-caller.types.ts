import {
  createLinuxCodexDeploymentAgentRuntimeHost,
  type LinuxCodexDeploymentAgentRuntimeHostDependencies,
} from "../../dist/composition/host-custodied-agent-runtime-host.js";

type ContainedTurn = LinuxCodexDeploymentAgentRuntimeHostDependencies["containedTurn"];
type Infrastructure = ContainedTurn["linuxCodexDeployment"];

declare const hostDependencies: Omit<LinuxCodexDeploymentAgentRuntimeHostDependencies, "containedTurn">;
declare const containedTurn: Omit<ContainedTurn, "linuxCodexDeployment">;
declare const infrastructure: Omit<Infrastructure, "currentPolicy">;
declare const currentPolicy: ReturnType<Infrastructure["currentPolicy"]>;

const host = createLinuxCodexDeploymentAgentRuntimeHost({
  ...hostDependencies,
  containedTurn: {
    ...containedTurn,
    linuxCodexDeployment: {
      ...infrastructure,
      currentPolicy(acknowledged) {
        const typed: Parameters<Infrastructure["currentPolicy"]>[0] = acknowledged;
        void typed;
        return currentPolicy;
      },
    },
  },
});

void host;
