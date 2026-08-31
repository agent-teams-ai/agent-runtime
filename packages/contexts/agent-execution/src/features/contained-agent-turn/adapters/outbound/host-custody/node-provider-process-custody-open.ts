import {
  HostCustodyFingerprintConflictError,
  HostCustodyLaunchRejectedError,
  HostCustodyStartError,
  HostCustodyUnsupportedError,
  type HostCustodyLaunchPlanResolver,
  type ProviderProcessCustodyPort,
} from "./custodied-provider-process.js";
import { unprovenResult, type ContainmentResult } from "./host-custody-evidence.js";
import {
  canonicalJson,
  resolveLaunchCandidate,
  sha256,
  verifyExecutable,
} from "./host-custody-launch.js";
import type { OperationResidueAuthorityFactory } from "./host-custody-cgroup-v2.js";
import { boundedPromise } from "./host-custody-stdio.js";
import type { LiveCustody } from "./node-provider-process-custody-state.js";

type OpenInput = Parameters<ProviderProcessCustodyPort["open"]>[0];

export interface HostCustodyOpenReservation {
  readonly containmentAfterMs: number;
  readonly input: OpenInput;
  readonly launchPlans: HostCustodyLaunchPlanResolver;
  readonly live: LiveCustody;
  readonly opening: Promise<void>;
  readonly rejectOpening: ((error: unknown) => void) | undefined;
  readonly residueAuthorityFactory: OperationResidueAuthorityFactory;
  readonly resolveOpening: (() => void) | undefined;
  readonly removeUnfingerprintedReservation: () => void;
  readonly contain: (live: LiveCustody, input: OpenInput) => Promise<ContainmentResult>;
  readonly spawn: (
    live: LiveCustody,
    arguments_: readonly string[],
    environment: Readonly<Record<string, string>>,
  ) => void;
}

const settleOpening = (reservation: HostCustodyOpenReservation): void => {
  reservation.resolveOpening?.();
};

const bindLaunchCandidate = async (reservation: HostCustodyOpenReservation): Promise<void> => {
  const { input, launchPlans, live } = reservation;
  const candidate = await resolveLaunchCandidate(launchPlans, input);
  live.fingerprint = candidate.fingerprint;
  live.plan = candidate.plan;
  live.privatePaths = candidate.privatePaths;
  live.workspace = candidate.workspace;
  live.privateRootClosure = Object.freeze({
    identitySha256: sha256(canonicalJson([
      candidate.privatePaths.root.dev.toString(),
      candidate.privatePaths.root.ino.toString(),
    ])),
    status: "active",
  });
  if (live.sealed) {return;}
  live.executable = await verifyExecutable(candidate.plan);
  if (live.sealed) {return;}
  live.residueAuthority = await reservation.residueAuthorityFactory.create(live.custodyRef);
};

const rejectFailedStart = async (reservation: HostCustodyOpenReservation): Promise<void> => {
  const { input, live, opening, rejectOpening } = reservation;
  const acknowledgement = await live.spawnAcknowledgement;
  if (acknowledgement === "acknowledged") {return;}
  const failureStatus = acknowledgement === "error-before-start" ? acknowledgement : "ambiguous";
  const reason = failureStatus === "error-before-start"
    ? "spawn-error-before-start"
    : "spawn-acknowledgement-ambiguous";
  const evidence = unprovenResult(reason, input, live);
  const failure = new HostCustodyStartError(
    live.custodyRef,
    evidence.evidenceRef,
    failureStatus,
    live.guardianStartErrorCode,
  );
  rejectOpening?.(failure);
  void opening.catch(() => {});
  live.containment ??= reservation.contain(live, input);
  await live.containment;
  throw failure;
};

const launchEagerProvider = async (reservation: HostCustodyOpenReservation): Promise<void> => {
  const { live } = reservation;
  if (live.sealed || (live.plan?.spawnMode ?? "eager") !== "eager") {return;}
  if (live.plan === undefined) {throw new HostCustodyLaunchRejectedError();}
  reservation.spawn(live, live.plan.arguments, live.plan.environment);
  await rejectFailedStart(reservation);
};

const cleanupRejectedReservation = async (reservation: HostCustodyOpenReservation): Promise<void> => {
  const { live } = reservation;
  if (live.spawnStatus !== "never-started" || live.guardian !== undefined) {return;}
  live.launchAuthority?.close();
  if (live.residueAuthority !== undefined) {
    await boundedPromise(
      live.residueAuthority.close().catch(() => false),
      reservation.containmentAfterMs,
    );
  }
  if (live.fingerprint === undefined) {reservation.removeUnfingerprintedReservation();}
};

const isClosedLaunchFailure = (error: unknown): boolean =>
  error instanceof HostCustodyFingerprintConflictError ||
  error instanceof HostCustodyStartError ||
  error instanceof HostCustodyUnsupportedError;

export const openHostCustodyReservation = async (
  reservation: HostCustodyOpenReservation,
): Promise<{ readonly custodyRef: string }> => {
  let phase: "authority-verification-failed" | "guardian-launch-failed" = "authority-verification-failed";
  try {
    await bindLaunchCandidate(reservation);
    if (!reservation.live.sealed && (reservation.live.plan?.spawnMode ?? "eager") === "eager") {
      phase = "guardian-launch-failed";
    }
    await launchEagerProvider(reservation);
    settleOpening(reservation);
    return Object.freeze({ custodyRef: reservation.live.custodyRef });
  } catch (error) {
    reservation.rejectOpening?.(error);
    void reservation.opening.catch(() => {});
    await cleanupRejectedReservation(reservation);
    if (isClosedLaunchFailure(error)) {throw error;}
    throw new HostCustodyLaunchRejectedError(phase);
  }
};
