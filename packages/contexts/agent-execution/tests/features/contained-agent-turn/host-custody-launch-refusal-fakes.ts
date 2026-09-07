import {
  DescriptorAuthorityAcquisitionError,
  GuardianConstructionError,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch-failure.js";

export type LaunchRefusalKind = "descriptor-authority" | "guardian-construction" | "unclassified";

interface ObservedLaunch {
  readonly live: {readonly spawnStatus: string};
}

let refusalKind: LaunchRefusalKind = "descriptor-authority";
let duringLaunch: ((observation: ObservedLaunch) => void) | undefined;
let launchCalls = 0;

// Only the guarded launch is synthetic. Reservation, admitted start, spawn
// classification, containment and evidence remain the real production code.
export const launchGuardedProvider = (options: ObservedLaunch): never => {
  launchCalls += 1;
  duringLaunch?.(options);
  if (refusalKind === "descriptor-authority") {throw new DescriptorAuthorityAcquisitionError();}
  if (refusalKind === "guardian-construction") {throw new GuardianConstructionError();}
  throw new Error("synthetic unclassified launch failure");
};

export const refusals = Object.freeze({
  launchCalls: () => launchCalls,
  onLaunch(callback: (observation: ObservedLaunch) => void) {duringLaunch = callback;},
  reset(kind: LaunchRefusalKind) {refusalKind = kind; duringLaunch = undefined; launchCalls = 0;},
});
