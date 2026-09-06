import type { CustodiedSdkProcessLauncher, HostCustodyLaunchPlan } from "./custodied-provider-process.js";

/** Node path projection stays in Host custody; provider code supplies only the
 * retained plan. Delegated start still validates exact cwd/argv/environment.
 */
export const startHostCustodyLaunch = (
  launcher: CustodiedSdkProcessLauncher, custodyRef: string, plan: HostCustodyLaunchPlan, signal: AbortSignal,
) => launcher.start(custodyRef, {
  arguments: plan.arguments, command: plan.executablePath,
  cwd: plan.containmentProfile === "strict-linux-cgroup-v2" ? "/proc/self/fd/4" :
    (plan as HostCustodyLaunchPlan & {readonly workspaceRef: string}).workspaceRef,
  environment: plan.environment, signal,
});
