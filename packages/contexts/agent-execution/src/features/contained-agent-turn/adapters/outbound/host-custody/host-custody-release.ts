import { snapshotEvidence, unprovenResult } from "./host-custody-evidence.js";
import {
  deletePrivateRootAfterProvedNoStart,
  quarantinePrivateRoot,
  quarantinePrivateRootForReconciliation,
} from "./host-custody-private-root.js";
import type { CustodyTombstone, LiveCustody } from "./node-provider-process-custody-state.js";
import { boundedPromise } from "./host-custody-stdio.js";

export interface HostCustodyReleaseInput {
  readonly attemptId: string;
  readonly custodyRef?: string;
  readonly operationId: string;
  readonly receiptRef: string;
}

export type HostCustodyReleaseOutcome =
  | { readonly kind: "released" }
  | { readonly evidenceRef: string; readonly kind: "unproven" };

interface HostCustodyReleaseState {
  readonly byAttempt: Map<string, LiveCustody>;
  readonly byRef: Map<string, LiveCustody>;
  readonly cleanupAfterMs: number;
  readonly maxTombstones: number;
  readonly monotonicNow: () => number;
  readonly tombstonesByAttempt: Map<string, CustodyTombstone>;
  readonly tombstonesByRef: Map<string, CustodyTombstone>;
}

const selected = <Value>(
  input: HostCustodyReleaseInput,
  byAttempt: Map<string, Value>,
  byRef: Map<string, Value>,
): Value | undefined => input.custodyRef === undefined
  ? byAttempt.get(input.attemptId)
  : byRef.get(input.custodyRef);

const releaseTombstone = (
  tombstone: CustodyTombstone,
  input: HostCustodyReleaseInput,
): HostCustodyReleaseOutcome =>
  tombstone.receiptRef === input.receiptRef &&
  tombstone.attemptId === input.attemptId &&
  tombstone.operationId === input.operationId
    ? Object.freeze({ kind: "released" })
    : unprovenResult("release-conflict", input);

const liveReleasePrecondition = (live: LiveCustody | undefined, input: HostCustodyReleaseInput): live is LiveCustody =>
  live?.contained?.receiptRef === input.receiptRef &&
  live.attemptId === input.attemptId &&
  live.operationId === input.operationId &&
  live.evidenceSealed;

const forgetLiveHandles = (live: LiveCustody): void => {
  delete live.child;
  delete live.exit;
  delete live.process;
  delete live.sdkProcess;
  delete live.stderr;
  delete live.stdout;
  live.launchAuthority?.close();
  delete live.launchAuthority;
  delete live.residueAuthority;
};

const closeLiveCustody = async (
  state: HostCustodyReleaseState,
  live: LiveCustody,
  input: HostCustodyReleaseInput,
): Promise<HostCustodyReleaseOutcome> => {
  const cooperativeDarwin = live.fingerprint?.containmentProfile === "cooperative-darwin-posix-process-group";
  const provedNoStart = (live.spawnStatus === "never-started" || live.spawnStatus === "error-before-start") &&
    live.closureEvidence.status === "not-started" && live.identity.status === "not-started" &&
    live.evidenceSealed && (live.spawnStatus === "never-started" || live.guardianNoStartAcknowledged === true);
  if (cooperativeDarwin && !provedNoStart) {
    if (!quarantinePrivateRootForReconciliation(live)) {
      return unprovenResult("private-root-quarantine-unproven", input, live);
    }
    return unprovenResult("darwin-cooperative-reconciliation-required", input, live);
  }
  live.cleanupDeadline ??= state.monotonicNow() + state.cleanupAfterMs;
  const privateRootClosed = cooperativeDarwin
    ? deletePrivateRootAfterProvedNoStart(live)
    : quarantinePrivateRoot(live);
  if (state.monotonicNow() >= live.cleanupDeadline || !privateRootClosed) {
    delete live.cleanupDeadline;
    return unprovenResult("private-root-quarantine-unproven", input, live);
  }
  const cgroupClosed = await boundedPromise(
    live.residueAuthority?.close() ?? Promise.resolve(false),
    Math.max(1, live.cleanupDeadline - state.monotonicNow()),
  );
  if (cgroupClosed !== true || state.monotonicNow() >= live.cleanupDeadline) {
    delete live.cleanupDeadline;
    return unprovenResult(
      cooperativeDarwin
        ? "posix-process-group-release-unproven"
        : "operation-cgroup-release-unproven",
      input,
      live,
    );
  }
  const tombstone: CustodyTombstone = Object.freeze({
    attemptId: live.attemptId,
    custodyRef: live.custodyRef,
    evidence: snapshotEvidence(live),
    inputIdentitySha256: live.inputIdentitySha256,
    operationId: live.operationId,
    receiptRef: input.receiptRef,
  });
  state.tombstonesByAttempt.set(live.attemptId, tombstone);
  state.tombstonesByRef.set(live.custodyRef, tombstone);
  state.byAttempt.delete(live.attemptId);
  state.byRef.delete(live.custodyRef);
  forgetLiveHandles(live);
  return Object.freeze({ kind: "released" });
};

export const releaseHostCustody = async (
  state: HostCustodyReleaseState,
  input: HostCustodyReleaseInput,
): Promise<HostCustodyReleaseOutcome> => {
  const tombstone = selected(input, state.tombstonesByAttempt, state.tombstonesByRef);
  if (tombstone !== undefined) {return releaseTombstone(tombstone, input);}
  const live = selected(input, state.byAttempt, state.byRef);
  if (!liveReleasePrecondition(live, input)) {return unprovenResult("release-precondition", input, live);}
  if (state.tombstonesByAttempt.size >= state.maxTombstones) {
    return unprovenResult("release-retention-capacity", input, live);
  }
  return closeLiveCustody(state, live, input);
};
