import type { DockerContainerObservation, DockerContainerStateFacts } from "./docker-engine-port.js";

export type DockerMutationOperation = "kill" | "remove" | "start" | "stop";

export const isTerminalState = (state: DockerContainerStateFacts): boolean =>
  !state.running && !state.paused && !state.restarting && (state.status === "dead" || state.status === "exited") &&
  state.hostPid === 0 && state.finishedAt !== "0001-01-01T00:00:00Z";

export const isTerminalObservation = (observation: DockerContainerObservation): boolean =>
  observation.existence === "present" && isTerminalState(observation.state);

export const mutationPostconditionSatisfied = (
  operation: DockerMutationOperation,
  observation: DockerContainerObservation,
): boolean => operation === "remove"
  ? observation.existence === "absent"
  : observation.existence === "present" && (operation === "start"
    ? observation.state.running && !observation.state.paused && !observation.state.restarting &&
      observation.state.status === "running"
    : isTerminalState(observation.state));
