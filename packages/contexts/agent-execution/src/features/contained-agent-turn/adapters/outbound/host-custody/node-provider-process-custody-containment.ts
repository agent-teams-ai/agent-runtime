import { containCustody, containedResult, identityBase, notStartedIdentity, strictClosure, unprovenResult, type ContainmentResult } from "./host-custody-evidence.js";
import { sha256 } from "./host-custody-launch.js";
import { quarantinePrivateRootForReconciliation } from "./host-custody-private-root.js";
import { isCompleteProvedNoStart, type LiveCustody } from "./node-provider-process-custody-state.js";
import { readDarwinNativeExecutionStatus, readDarwinNativeNoStart, readDarwinNativeExecution } from "./darwin-attempt-owner-selection.js";
import { DeferredNativeProviderProcess } from "./deferred-native-sdk-process.js";
import { boundedPromise } from "./host-custody-stdio.js";

/** Contain one retained reservation; the core owns single-flight publication. */
export async function containNodeCustody(
  live: LiveCustody,
  input: { readonly attemptId: string; readonly custodyRef?: string; readonly operationId: string },
  options: Parameters<typeof containCustody>[2],
): Promise<ContainmentResult> {
  live.sealed = true;
  live.httpReservation.cutoff();
  live.containmentDeadline ??= options.monotonicNow() + options.containmentAfterMs;
  try {
    if (live.nativeExecutionLease !== undefined) {
      return await containNativeCustody(live, input, options);
    }
    if (live.spawnStatus === "ambiguous" && live.guardian === undefined) {
      // Reentrant abort may precede the synchronous launch's resource return.
      // If it throws instead, keep custody for reconciliation: the no-guardian
      // no-start cleanup path has no evidence for this admitted launch.
      await Promise.resolve();
      if (live.guardian === undefined) {return unprovenResult("stable-guardian-unavailable", input, live);}
    }
    if (live.residueAllocation === "uncertain") {
      return unprovenResult("operation-cgroup-release-unproven", input, live);
    }
    return await containCustody(live, input, {
      containmentAfterMs: options.containmentAfterMs,
      drainAfterMs: options.drainAfterMs,
      forceKillAfterMs: options.forceKillAfterMs,
      hostLifecycleGenerationSha256: options.hostLifecycleGenerationSha256,
      monotonicNow: options.monotonicNow,
      terminateAfterMs: options.terminateAfterMs,
    });
  } finally {
    if (live.fingerprint?.containmentProfile === "cooperative-darwin-posix-process-group" &&
        !isCompleteProvedNoStart(live)) {
      quarantinePrivateRootForReconciliation(live);
    }
  }
}

async function containNativeCustody(live: LiveCustody, input: Parameters<typeof containNodeCustody>[1], options: Parameters<typeof containNodeCustody>[2]): Promise<ContainmentResult> {
  if (live.nativeExecutionLease === undefined) {throw new TypeError("Native execution lease unavailable");}
  const process = live.process;
  try {
    await live.httpReservation.cutoffNativeExecution(live.nativeExecutionLease);
    if (!(process instanceof DeferredNativeProviderProcess) || live.exit === undefined) {
      const remaining = Math.max(1, live.containmentDeadline! - options.monotonicNow());
      await boundedPromise(readDarwinNativeExecutionStatus(live.nativeExecutionLease), remaining);
      if (readDarwinNativeNoStart(live.nativeExecutionLease) === undefined) {
        return unprovenResult("stable-guardian-unavailable", input, live);
      }
      live.spawnStatus = "never-started"; live.guardianNoStartAcknowledged = true;
      live.identity = notStartedIdentity(options.hostLifecycleGenerationSha256);
      live.closureEvidence = strictClosure("not-started", "cooperative-darwin-posix-process-group");
      live.evidenceSealed = true;
      const result = containedResult(live, "never-started"); live.contained = result; return result;
    }
    const remaining = Math.max(1, live.containmentDeadline! - options.monotonicNow());
    const completed = await boundedPromise(Promise.all([live.exit, process.drained]), remaining);
    const execution = readDarwinNativeExecution(live.nativeExecutionLease);
    if (completed === undefined || execution === undefined || execution.image.child === undefined) {
      return unprovenResult("posix-process-group-close-unproven", input, live);
    }
    const [exit] = completed; const child = execution.image.child;
    live.nativeExit = exit; live.nativeStdout = process.evidence("stdout"); live.nativeStderr = process.evidence("stderr");
    live.spawnStatus = "acknowledged"; live.childProcessInstanceSha256 = sha256(JSON.stringify(child));
    live.identity = Object.freeze({...identityBase(live, options.hostLifecycleGenerationSha256), pid: child.pid, pgid: child.pgid,
      proofRef: `native-darwin:${execution.image.attestation}`, status: "proved" as const});
    live.closureEvidence = Object.freeze({limitations: Object.freeze([] as const),
      profile: "native-darwin-attempt-owner" as const, status: "closed" as const});
    live.evidenceSealed = true;
    const result = containedResult(live, "native-darwin-attempt-owner"); live.contained = result; return result;
  } catch {return unprovenResult("posix-process-group-close-unproven", input, live);}
}
