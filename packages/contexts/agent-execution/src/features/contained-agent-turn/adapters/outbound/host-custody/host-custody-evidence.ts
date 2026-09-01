/* oxlint-disable max-lines -- custody closure evidence remains below the 600-line production limit. */
import { createHash } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  CustodiedProviderProcessExit,
  HostCustodyClosureEvidence,
  HostCustodyContainmentProfile,
  HostCustodyEvidence,
  HostCustodyLaunchFingerprintEvidence,
  HostCustodyProcessIdentityEvidence,
  HostCustodyProcessIdentityProof,
} from "./custodied-provider-process.js";
import { DARWIN_COOPERATIVE_CUSTODY_LIMITATIONS } from "./custodied-provider-process.js";
import { canonicalJson, sha256, type ExecutableObservation } from "./host-custody-launch.js";
import type { SpawnStatus } from "./host-custody-process-tree.js";
import type { StableProcessGroupGuardian } from "./host-custody-stable-guardian.js";
import {
  waitForIngressFinal,
  type HostStderrIngress,
  type HostStdoutIngress,
} from "./host-custody-stdio.js";

const EMPTY_SHA256 = createHash("sha256").digest("hex");

export type ContainmentResult =
  | { readonly kind: "contained"; readonly receiptRef: string }
  | { readonly evidenceRef: string; readonly kind: "unproven" };

export type HostCustodyUnprovenReason =
  | "containment-deadline-unavailable"
  | "darwin-cooperative-reconciliation-required"
  | "ingress-incomplete"
  | "ingress-overflow"
  | "launch-fingerprint-unavailable"
  | "missing"
  | "no-start-evidence-unsealed"
  | "no-start-ingress-unsealed"
  | "opening-deadline-exceeded"
  | "operation-cgroup-close-unproven"
  | "operation-cgroup-kill-unproven"
  | "operation-cgroup-release-unproven"
  | "posix-process-group-close-unproven"
  | "posix-process-group-kill-unproven"
  | "posix-process-group-release-unproven"
  | "operation-residue-remains"
  | "operation-residue-unproven"
  | "owner-deadline-exceeded"
  | "private-root-quarantine-unproven"
  | "release-conflict"
  | "release-precondition"
  | "release-retention-capacity"
  | "spawn-acknowledgement-ambiguous"
  | "spawn-acknowledgement-deadline-exceeded"
  | "spawn-error-before-start"
  | "stable-guardian-exit-unproven"
  | "stable-guardian-unavailable";

export interface HostCustodyEvidenceState {
  readonly attemptId: string;
  readonly childProcessInstanceSha256?: string;
  readonly closureEvidence: HostCustodyClosureEvidence;
  readonly custodyRef: string;
  readonly evidenceSealed: boolean;
  readonly executable?: ExecutableObservation;
  readonly fingerprint?: HostCustodyLaunchFingerprintEvidence;
  readonly guardian?: StableProcessGroupGuardian;
  readonly guardianNoStartAcknowledged?: boolean;
  readonly identity: HostCustodyProcessIdentityEvidence;
  readonly operationId: string;
  readonly privateRootClosure: { readonly identitySha256: string; readonly status: "active" | "deleted" | "quarantined" | "unproven" };
  readonly sealed: boolean;
  readonly spawnStatus: SpawnStatus;
  readonly stderr?: HostStderrIngress;
  readonly stdout?: HostStdoutIngress;
}

export const strictClosure = (
  status: HostCustodyClosureEvidence["status"],
  profile: HostCustodyContainmentProfile = "strict-linux-cgroup-v2",
): HostCustodyClosureEvidence => profile === "strict-linux-cgroup-v2"
  ? Object.freeze({ limitations: Object.freeze([] as const), profile, status })
  : Object.freeze({
    limitations: DARWIN_COOPERATIVE_CUSTODY_LIMITATIONS,
    profile,
    status,
  });

export const identityBase = (
  live: Pick<HostCustodyEvidenceState, "childProcessInstanceSha256" | "executable" | "fingerprint">,
  hostLifecycleGenerationSha256: string,
): Omit<HostCustodyProcessIdentityEvidence, "status"> => ({
  binarySha256: live.executable?.digest ?? EMPTY_SHA256,
  childProcessInstanceSha256: live.childProcessInstanceSha256 ?? EMPTY_SHA256,
  hostLifecycleGenerationSha256,
  planSha256: live.fingerprint?.planSha256 ?? EMPTY_SHA256,
});

export const notStartedIdentity = (
  hostLifecycleGenerationSha256: string,
): HostCustodyProcessIdentityEvidence => Object.freeze({
  binarySha256: EMPTY_SHA256,
  childProcessInstanceSha256: EMPTY_SHA256,
  hostLifecycleGenerationSha256,
  planSha256: EMPTY_SHA256,
  status: "not-started",
});

export const snapshotEvidence = (live: HostCustodyEvidenceState): HostCustodyEvidence => {
  const notStarted = Object.freeze({ bytes: 0, sha256: EMPTY_SHA256, status: "not-started" as const });
  if (live.fingerprint === undefined) {throw new Error("Host Custody fingerprint is unavailable");}
  const guardianExit = live.guardian?.guardianExitObservation;
  const providerExit = live.guardian?.providerExit;
  return Object.freeze({
    closure: live.closureEvidence,
    fingerprint: live.fingerprint,
    guardianExit: guardianExit === undefined
      ? Object.freeze({ status: "unobserved" as const })
      : Object.freeze({ code: guardianExit.code, signal: guardianExit.signal, status: "observed" as const }),
    identity: live.identity,
    privateRoot: live.privateRootClosure,
    providerExit: live.guardianNoStartAcknowledged === true ||
        (live.spawnStatus === "never-started" && live.closureEvidence.status === "not-started")
      ? Object.freeze({ status: "not-started" as const })
      : providerExit === undefined
        ? Object.freeze({ status: "unobserved" as const })
        : Object.freeze({ code: providerExit.code, signal: providerExit.signal, status: "observed" as const }),
    sealed: live.evidenceSealed,
    spawn: live.spawnStatus,
    stderr: live.stderr?.snapshot() ?? notStarted,
    stdout: live.stdout?.snapshot() ?? notStarted,
  });
};

export const containedResult = (
  live: HostCustodyEvidenceState,
  observation: "never-started" | "strict-linux-cgroup-v2",
): Extract<ContainmentResult, { readonly kind: "contained" }> => {
  const evidence = snapshotEvidence(live);
  const receiptIdentity = [
    live.operationId,
    live.attemptId,
    live.custodyRef,
    live.fingerprint?.fingerprintSha256,
    live.identity,
    evidence.stdout,
    evidence.stderr,
    evidence.closure,
    observation,
    evidence.providerExit,
    evidence.guardianExit,
  ] as const;
  return Object.freeze({
    kind: "contained",
    receiptRef: `urn:agent-runtime:host-${live.closureEvidence.profile === "cooperative-darwin-posix-process-group"
      ? "cooperative-closure"
      : "strict-closure"}:${sha256(canonicalJson(receiptIdentity))}`,
  });
};

export const unprovenResult = (
  reason: HostCustodyUnprovenReason,
  input: { readonly attemptId: string; readonly custodyRef?: string; readonly operationId: string },
  live?: HostCustodyEvidenceState,
): Extract<ContainmentResult, { readonly kind: "unproven" }> => {
  const identity = [
    reason,
    sha256(input.operationId),
    sha256(input.attemptId),
    input.custodyRef === undefined ? undefined : sha256(input.custodyRef),
    live?.fingerprint?.fingerprintSha256,
    live?.spawnStatus,
    live?.identity.status,
    live?.stdout?.snapshot(),
    live?.stderr?.snapshot(),
  ] as const;
  return Object.freeze({
    evidenceRef: `urn:agent-runtime:host-custody-unproven:${reason}:${sha256(canonicalJson(identity))}`,
    kind: "unproven",
  });
};

interface ContainmentState extends HostCustodyEvidenceState {
  child?: ChildProcessWithoutNullStreams;
  closureEvidence: HostCustodyClosureEvidence;
  contained?: Extract<ContainmentResult, { readonly kind: "contained" }>;
  evidenceSealed: boolean;
  exit?: Promise<CustodiedProviderProcessExit>;
  identity: HostCustodyProcessIdentityEvidence;
  identityProof?: Promise<HostCustodyProcessIdentityProof | undefined>;
  opening: Promise<void>;
  containmentDeadline?: number;
  privateRootClosure: { readonly identitySha256: string; readonly status: "active" | "deleted" | "quarantined" | "unproven" };
  residueAuthority?: import("./host-custody-cgroup-v2.js").OperationResidueAuthority;
  signalAuthorized: boolean;
  spawnAcknowledgement?: Promise<SpawnStatus>;
}

interface ContainmentOptions {
  readonly containmentAfterMs: number;
  readonly drainAfterMs: number;
  readonly forceKillAfterMs: number;
  readonly hostLifecycleGenerationSha256: string;
  readonly monotonicNow: () => number;
  readonly terminateAfterMs: number;
}

const DEADLINE_EXCEEDED = Symbol("host-custody-deadline-exceeded");
const FINALITY_FAILED = Symbol("host-custody-finality-failed");
const PHASE_TIMEOUT = Symbol("host-custody-phase-timeout");

type DeadlineAwait<Value> = Value | typeof DEADLINE_EXCEEDED | typeof PHASE_TIMEOUT;
type FinalityAwait<Value> = DeadlineAwait<Value> | typeof FINALITY_FAILED;

const deadlineOpen = (deadline: number, options: ContainmentOptions): boolean =>
  deadline - options.monotonicNow() > 0;

const awaitWithDeadline = async <Value>(
  promise: (maximumMs: number) => Promise<Value>,
  deadline: number,
  options: ContainmentOptions,
  phaseMaximumMs = Number.POSITIVE_INFINITY,
): Promise<DeadlineAwait<Value>> => {
  const remainingBefore = deadline - options.monotonicNow();
  if (remainingBefore <= 0) {return DEADLINE_EXCEEDED;}
  const maximumMs = Math.min(remainingBefore, phaseMaximumMs);
  const timeout = Symbol("host-custody-phase-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: { readonly kind: "value"; readonly value: Value } | typeof timeout;
  try {
    result = await Promise.race([
      promise(maximumMs).then(
        value => ({ kind: "value" as const, value }),
        error => {throw error;},
      ),
      new Promise<typeof timeout>(resolve => {timer = setTimeout(() => resolve(timeout), maximumMs);}),
    ]);
  } finally {
    if (timer !== undefined) {clearTimeout(timer);}
  }
  if (deadline - options.monotonicNow() <= 0) {return DEADLINE_EXCEEDED;}
  return result === timeout ? PHASE_TIMEOUT : result.value;
};

const invokeFinalityWithDeadline = async <Value>(
  promise: () => Promise<Value>,
  deadline: number,
  options: ContainmentOptions,
  phaseMaximumMs = Number.POSITIVE_INFINITY,
): Promise<FinalityAwait<Value>> => {
  let invoked: Promise<Value>;
  try {
    invoked = promise();
  } catch {
    return FINALITY_FAILED;
  }
  const observed = invoked.then<Value, typeof FINALITY_FAILED>(
    value => value,
    () => FINALITY_FAILED,
  );
  if (!deadlineOpen(deadline, options)) {
    return DEADLINE_EXCEEDED;
  }
  return awaitWithDeadline(() => observed, deadline, options, phaseMaximumMs);
};

type ClosureAttempt =
  | { readonly kind: "closed"; readonly observation: "cooperative-darwin-posix-process-group" | "never-started" | "strict-linux-cgroup-v2" }
  | { readonly kind: "unproven"; readonly reason: HostCustodyUnprovenReason }
  | undefined;

const spawnAcknowledgementFailure = async (
  live: ContainmentState,
  containmentDeadline: number,
  options: ContainmentOptions,
): Promise<HostCustodyUnprovenReason | undefined> => {
  const acknowledgement = live.spawnAcknowledgement;
  if (acknowledgement === undefined) {return;}
  const acknowledged = await awaitWithDeadline(
    () => acknowledgement, containmentDeadline, options,
  );
  if (acknowledged === DEADLINE_EXCEEDED) {return "owner-deadline-exceeded";}
  if (acknowledged === PHASE_TIMEOUT) {return "spawn-acknowledgement-deadline-exceeded";}
  return undefined;
};

const noStartIngressFailure = async (
  live: ContainmentState,
  containmentDeadline: number,
  options: ContainmentOptions,
): Promise<HostCustodyUnprovenReason | undefined> => {
  if (live.spawnStatus !== "error-before-start") {return;}
  const drained = await awaitWithDeadline(
    maximumMs => waitForIngressFinal(live, maximumMs, options.monotonicNow),
    containmentDeadline,
    options,
    options.drainAfterMs,
  );
  if (drained === DEADLINE_EXCEEDED) {return "owner-deadline-exceeded";}
  return drained === true ? undefined : "no-start-ingress-unsealed";
};

const noStartResidueFailure = async (
  live: ContainmentState,
  containmentDeadline: number,
  options: ContainmentOptions,
): Promise<HostCustodyUnprovenReason | undefined> => {
  const residueAuthority = live.residueAuthority;
  if (residueAuthority === undefined) {return;}
  const closed = await awaitWithDeadline(
    () => residueAuthority.close(), containmentDeadline, options,
  );
  if (closed === DEADLINE_EXCEEDED) {return "owner-deadline-exceeded";}
  return closed === true ? undefined : live.fingerprint?.containmentProfile === "cooperative-darwin-posix-process-group"
    ? "posix-process-group-close-unproven"
    : "operation-cgroup-close-unproven";
};

const settleNoGuardianContainment = async (
  live: ContainmentState,
  containmentDeadline: number,
  options: ContainmentOptions,
): Promise<ClosureAttempt> => {
  const ingressFailure = await noStartIngressFailure(live, containmentDeadline, options);
  if (!deadlineOpen(containmentDeadline, options)) {return { kind: "unproven", reason: "owner-deadline-exceeded" };}
  if (ingressFailure !== undefined) {return { kind: "unproven", reason: ingressFailure };}
  const residueFailure = await noStartResidueFailure(live, containmentDeadline, options);
  if (!deadlineOpen(containmentDeadline, options)) {return { kind: "unproven", reason: "owner-deadline-exceeded" };}
  if (residueFailure !== undefined) {return { kind: "unproven", reason: residueFailure };}
  if (!deadlineOpen(containmentDeadline, options)) {return { kind: "unproven", reason: "owner-deadline-exceeded" };}
  live.closureEvidence = strictClosure("not-started", live.fingerprint?.containmentProfile);
  live.identity = Object.freeze({
    ...identityBase(live, options.hostLifecycleGenerationSha256),
    status: "not-started",
  });
  const stdoutStatus = live.stdout?.snapshot().status;
  const stderrStatus = live.stderr?.snapshot().status;
  live.evidenceSealed = live.stdout === undefined && live.stderr === undefined ||
    live.stdout?.settled === true && live.stderr?.settled === true &&
    stdoutStatus === "complete" && stderrStatus === "complete";
  if (!live.evidenceSealed) {return { kind: "unproven", reason: "no-start-evidence-unsealed" };}
  return { kind: "closed", observation: "never-started" };
};

const settleNonAcknowledgedContainment = async (
  live: ContainmentState,
  options: ContainmentOptions,
): Promise<ClosureAttempt> => {
  const containmentDeadline = live.containmentDeadline;
  if (containmentDeadline === undefined) {return { kind: "unproven", reason: "containment-deadline-unavailable" };}
  const opened = await awaitWithDeadline(
    () => live.opening.then(() => true, () => true), containmentDeadline, options,
  );
  if (opened === DEADLINE_EXCEEDED) {return { kind: "unproven", reason: "owner-deadline-exceeded" };}
  if (opened !== true) {return { kind: "unproven", reason: "opening-deadline-exceeded" };}
  const acknowledgementFailure = await spawnAcknowledgementFailure(live, containmentDeadline, options);
  if (!deadlineOpen(containmentDeadline, options)) {return { kind: "unproven", reason: "owner-deadline-exceeded" };}
  if (acknowledgementFailure !== undefined) {return { kind: "unproven", reason: acknowledgementFailure };}
  if (live.fingerprint === undefined) {return { kind: "unproven", reason: "launch-fingerprint-unavailable" };}
  if (live.spawnStatus === "acknowledged") {return;}
  if (live.guardian !== undefined) {return;}
  return settleNoGuardianContainment(live, containmentDeadline, options);
};

const terminateStableGuardianGroup = async (
  live: ContainmentState,
  options: ContainmentOptions,
): Promise<
  | { readonly kind: "contained" }
  | { readonly kind: "unproven"; readonly reason: HostCustodyUnprovenReason }
> => {
  const guardian = live.guardian;
  const containmentDeadline = live.containmentDeadline;
  if (containmentDeadline === undefined) {return { kind: "unproven", reason: "containment-deadline-unavailable" };}
  if (!deadlineOpen(containmentDeadline, options)) {return { kind: "unproven", reason: "owner-deadline-exceeded" };}
  live.stdout?.releaseBackpressureForClosure();
  const termination = guardian === undefined
    ? { kind: "unproven" as const, reason: "stable-guardian-unavailable" as const }
    : await terminateGuardian(live, guardian, containmentDeadline, options);
  const killedResult = await invokeFinalityWithDeadline(
    () => live.residueAuthority?.killAll() ?? Promise.resolve(false),
    containmentDeadline,
    options,
    options.forceKillAfterMs,
  );
  const killed = killedResult === DEADLINE_EXCEEDED ||
      killedResult === FINALITY_FAILED ||
      killedResult === PHASE_TIMEOUT
    ? undefined
    : killedResult;
  const killInvocationFailed = killedResult === FINALITY_FAILED || killedResult === PHASE_TIMEOUT;
  const guardianClosed = guardian === undefined
    ? PHASE_TIMEOUT
    : await awaitWithDeadline(
      () => guardian.guardianExit.then(() => true), containmentDeadline, options, options.forceKillAfterMs,
    );
  const residueFailure = await residueClosureFailure(
    live, killed, killInvocationFailed, containmentDeadline, options,
  );
  if (!deadlineOpen(containmentDeadline, options)) {return { kind: "unproven", reason: "owner-deadline-exceeded" };}
  if (termination.kind === "unproven") {return termination;}
  if (killedResult === DEADLINE_EXCEEDED || guardianClosed === DEADLINE_EXCEEDED) {
    return { kind: "unproven", reason: "owner-deadline-exceeded" };
  }
  if (guardianClosed !== true) {return { kind: "unproven", reason: "stable-guardian-exit-unproven" };}
  if (!deadlineOpen(containmentDeadline, options)) {return { kind: "unproven", reason: "owner-deadline-exceeded" };}
  if (residueFailure !== undefined) {return { kind: "unproven", reason: residueFailure };}
  const ingressFailure = await ingressClosureFailure(live, containmentDeadline, options);
  if (!deadlineOpen(containmentDeadline, options)) {return { kind: "unproven", reason: "owner-deadline-exceeded" };}
  if (ingressFailure !== undefined) {return { kind: "unproven", reason: ingressFailure };}
  return { kind: "contained" };
};

const terminateGuardian = async (
  live: ContainmentState,
  guardian: StableProcessGroupGuardian,
  containmentDeadline: number,
  options: ContainmentOptions,
): Promise<
  | { readonly kind: "terminated" }
  | { readonly kind: "unproven"; readonly reason: HostCustodyUnprovenReason }
> => {
  const signaled = await awaitWithDeadline(
    () => guardian.signalGroup("SIGTERM"), containmentDeadline, options, options.terminateAfterMs,
  );
  if (signaled === DEADLINE_EXCEEDED) {return { kind: "unproven", reason: "owner-deadline-exceeded" };}

  let providerExit: DeadlineAwait<CustodiedProviderProcessExit> = PHASE_TIMEOUT;
  if (live.exit !== undefined && live.guardianNoStartAcknowledged !== true) {
    providerExit = await awaitWithDeadline(
      () => live.exit!, containmentDeadline, options, options.terminateAfterMs,
    );
    if (providerExit === DEADLINE_EXCEEDED) {return { kind: "unproven", reason: "owner-deadline-exceeded" };}
  }
  if (providerExit === PHASE_TIMEOUT && live.guardianNoStartAcknowledged !== true) {
    const killedProvider = await awaitWithDeadline(
      () => guardian.signalProvider("SIGKILL"), containmentDeadline, options, options.forceKillAfterMs,
    );
    if (killedProvider === DEADLINE_EXCEEDED) {return { kind: "unproven", reason: "owner-deadline-exceeded" };}
    if (live.exit !== undefined) {
      providerExit = await awaitWithDeadline(
        () => live.exit!, containmentDeadline, options, options.forceKillAfterMs,
      );
      if (providerExit === DEADLINE_EXCEEDED) {return { kind: "unproven", reason: "owner-deadline-exceeded" };}
    }
  }
  if (
    providerExit !== PHASE_TIMEOUT &&
    live.guardianNoStartAcknowledged !== true
  ) {
    await awaitWithDeadline(
      maximumMs => waitForIngressFinal(live, maximumMs, options.monotonicNow),
      containmentDeadline,
      options,
      options.drainAfterMs,
    );
  }
  return { kind: "terminated" };
};

const residueClosureFailure = async (
  live: ContainmentState,
  killed: boolean | undefined,
  killInvocationFailed: boolean,
  containmentDeadline: number,
  options: ContainmentOptions,
): Promise<HostCustodyUnprovenReason | undefined> => {
  const residue = await invokeFinalityWithDeadline(
    () => live.residueAuthority?.proveEmpty(containmentDeadline, options.monotonicNow) ?? Promise.resolve("unproven" as const),
    containmentDeadline,
    options,
  );
  if (residue === DEADLINE_EXCEEDED) {return "owner-deadline-exceeded";}
  const killUnproven = live.fingerprint?.containmentProfile === "cooperative-darwin-posix-process-group"
    ? "posix-process-group-kill-unproven" as const
    : "operation-cgroup-kill-unproven" as const;
  if (killInvocationFailed) {return killUnproven;}
  if (residue === FINALITY_FAILED || residue === PHASE_TIMEOUT) {return "operation-residue-unproven";}
  if (residue === "empty") {return undefined;}
  if (killed !== true) {return killUnproven;}
  return residue === "residue" ? "operation-residue-remains" : "operation-residue-unproven";
};

const ingressClosureFailure = async (
  live: ContainmentState,
  containmentDeadline: number,
  options: ContainmentOptions,
): Promise<HostCustodyUnprovenReason | undefined> => {
  const drained = await awaitWithDeadline(
    maximumMs => waitForIngressFinal(live, maximumMs, options.monotonicNow),
    containmentDeadline,
    options,
    options.drainAfterMs,
  );
  if (drained === DEADLINE_EXCEEDED) {return "owner-deadline-exceeded";}
  const stdoutStatus = live.stdout?.snapshot().status;
  const stderrStatus = live.stderr?.snapshot().status;
  if (drained === true && stdoutStatus === "complete" && stderrStatus === "complete") {return undefined;}
  return stdoutStatus === "overflow" || stderrStatus === "overflow" ? "ingress-overflow" : "ingress-incomplete";
};

// oxlint-disable-next-line complexity -- ordered fail-closed closure phases remain explicit.
export const containCustody = async (
  live: ContainmentState,
  input: { readonly attemptId: string; readonly custodyRef?: string; readonly operationId: string },
  options: ContainmentOptions,
): Promise<ContainmentResult> => {
  const containmentDeadline = live.containmentDeadline;
  if (containmentDeadline === undefined) {return unprovenResult("containment-deadline-unavailable", input, live);}
  if (!deadlineOpen(containmentDeadline, options)) {return unprovenResult("owner-deadline-exceeded", input, live);}
  const early = await settleNonAcknowledgedContainment(live, options);
  if (!deadlineOpen(containmentDeadline, options)) {return unprovenResult("owner-deadline-exceeded", input, live);}
  if (early?.kind === "unproven") {return unprovenResult(early.reason, input, live);}

  let observation = early?.observation;
  if (observation === undefined) {
    live.signalAuthorized = false;
    const outcome = await terminateStableGuardianGroup(live, options);
    if (!deadlineOpen(containmentDeadline, options)) {return unprovenResult("owner-deadline-exceeded", input, live);}
    if (outcome.kind === "unproven") {return unprovenResult(outcome.reason, input, live);}
    observation = live.guardianNoStartAcknowledged === true
      ? "never-started"
      : live.fingerprint?.containmentProfile ?? "strict-linux-cgroup-v2";
    live.evidenceSealed = live.stdout?.settled === true && live.stderr?.settled === true &&
      live.stdout.snapshot().status === "complete" && live.stderr.snapshot().status === "complete";
  }

  if (observation === "never-started") {
    live.closureEvidence = strictClosure("not-started", live.fingerprint?.containmentProfile);
    live.identity = Object.freeze({
      ...identityBase(live, options.hostLifecycleGenerationSha256),
      status: "not-started",
    });
  } else {
    live.closureEvidence = strictClosure(
      observation === "cooperative-darwin-posix-process-group" ? "unproven" : "closed",
      live.fingerprint?.containmentProfile,
    );
  }
  if (!live.evidenceSealed) {return unprovenResult("ingress-incomplete", input, live);}
  if (!deadlineOpen(containmentDeadline, options)) {return unprovenResult("owner-deadline-exceeded", input, live);}
  if (observation === "cooperative-darwin-posix-process-group") {
    return unprovenResult("darwin-cooperative-reconciliation-required", input, live);
  }
  live.contained = containedResult(live, observation);
  return live.contained;
};
