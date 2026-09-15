import {randomUUID} from "node:crypto";
import type {LiveCustody} from "./node-provider-process-custody-state.js";
import {NodeCustodiedSdkProcess} from "./host-custody-process-tree.js";
import {launchGuardedProvider} from "./node-provider-process-custody-launch.js";
import {DescriptorAuthorityAcquisitionError} from "./host-custody-launch-failure.js";
import {assertRetainedWorkspaceAuthority, closeRetainedWorkspaceAuthority} from "./private-host-custody-reservation.js";
import {sha256} from "./host-custody-launch.js";
import {bindCooperativeProcessGroupGuardian} from "./host-custody-posix-process-group.js";
import {acknowledgeProviderSpawn} from "./node-provider-process-custody-spawn-acknowledgement.js";
import type {ProcessCustodyRuntimeProfile} from "./host-custody-runtime-profile.js";
type SpawnOptions = Omit<Parameters<typeof launchGuardedProvider>[0], "arguments" | "environment" | "live" | "workspaceDescriptorPath" | "writeAfterMs"> &
  Parameters<typeof acknowledgeProviderSpawn>[2] & {readonly containmentProfile: ProcessCustodyRuntimeProfile["containmentProfile"]};
export function spawnNodeCustodiedProcess(live: LiveCustody, arguments_: readonly string[],
  environment: Readonly<Record<string, string>>, options: SpawnOptions): NodeCustodiedSdkProcess {
  live.httpReservation.assertActive();
  if (live.sealed) {throw new Error("Host Custody reservation is sealed");}
  if (live.child !== undefined || live.spawnAcknowledgement !== undefined) {
    if (live.sdkProcess instanceof NodeCustodiedSdkProcess) {return live.sdkProcess;}
    throw new Error("Host Custody process start is already in flight");
  }
  if (
    live.plan === undefined ||
    live.executable === undefined ||
    live.privatePaths === undefined ||
    live.workspace === undefined
  ) {
    throw new Error("Host Custody launch reservation is incomplete");
  }
  if (live.retainedWorkspaceAuthority !== undefined) {assertRetainedWorkspaceAuthority(live);}
  // A thrown admitted launch cannot itself prove that no process started.
  const spawnStatusBeforeLaunch = live.spawnStatus;
  live.spawnStatus = "ambiguous";
  let launched: ReturnType<typeof launchGuardedProvider>;
  try {
    launched = launchGuardedProvider({
      arguments: arguments_,
      environment,
      live,
      maxDiagnosticBytes: options.maxDiagnosticBytes,
      maxStderrBytes: options.maxStderrBytes,
      maxStdinBytes: options.maxStdinBytes,
      maxStdoutBytes: options.maxStdoutBytes,
      monotonicNow: options.monotonicNow,
      onAbort: () => {options.onAbort();},
      onOverflow: () => {options.onOverflow();},
      spawnAcknowledgementAfterMs: options.spawnAcknowledgementAfterMs,
      stdoutHighWaterBytes: options.stdoutHighWaterBytes,
      writeAfterMs: options.spawnAcknowledgementAfterMs,
      ...(live.retainedWorkspaceAuthority === undefined ? {} : {
        workspaceDescriptorPath: live.retainedWorkspaceAuthority.descriptorPath,
      }),
    });
    // Retain every returned resource before descriptor release or observation
    // can fail. Containment must still own a launch whose start call rejects.
    live.launchAuthority = launched.authority;
    live.guardian = launched.guardian;
    live.child = launched.child;
    live.exit = launched.exit;
    live.process = launched.process;
    live.sdkProcess = launched.sdkProcess;
    live.stderr = launched.stderr;
    live.stdout = launched.stdout;
    live.spawnStatus = "ambiguous";
  } catch (error) {
    // Descriptor authority acquisition refuses before the guardian constructor,
    // whose first statement spawns. Only that class proves no process exists,
    // so only it retracts the mark, back to the classification the reservation
    // already held. Every other refusal keeps the honest ambiguous evidence.
    if (error instanceof DescriptorAuthorityAcquisitionError) {live.spawnStatus = spawnStatusBeforeLaunch;}
    throw error;
  } finally {
    closeRetainedWorkspaceAuthority(live);
  }
  live.childProcessInstanceSha256 = sha256(randomUUID());
  live.executable = launched.authority.executable;
  if (options.containmentProfile === "cooperative-darwin-posix-process-group") {
    bindCooperativeProcessGroupGuardian(live.residueAuthority, launched.guardian);
  }
  live.spawnAcknowledgement = acknowledgeProviderSpawn(live, launched.guardian, {
    hostLifecycleGenerationSha256: options.hostLifecycleGenerationSha256,
    identityObservationAfterMs: options.identityObservationAfterMs,
    monotonicNow: options.monotonicNow,
    onStartFailure: () => options.onStartFailure(),
    processIdentityObserver: options.processIdentityObserver,
    spawnAcknowledgementAfterMs: options.spawnAcknowledgementAfterMs,
    spawnAcknowledgementObserver: options.spawnAcknowledgementObserver,
  });
  return launched.sdkProcess;
}
