import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  HostCustodyProcessIdentityObserver,
  HostCustodySpawnAcknowledgement,
} from "./custodied-provider-process.js";
import { identityBase } from "./host-custody-evidence.js";
import { sha256 } from "./host-custody-launch.js";
import {
  observeProcessIdentity,
  type SpawnStatus,
} from "./host-custody-process-tree.js";
import type {
  GuardianStartObservation,
  StableProcessGroupGuardian,
} from "./host-custody-stable-guardian.js";
import { boundedPromise } from "./host-custody-stdio.js";
import type { LiveCustody } from "./node-provider-process-custody-state.js";

interface ProviderSpawnAcknowledgementDependencies {
  readonly hostLifecycleGenerationSha256: string;
  readonly identityObservationAfterMs: number;
  readonly monotonicNow: () => number;
  readonly onStartFailure: () => Promise<void>;
  readonly processIdentityObserver: HostCustodyProcessIdentityObserver | undefined;
  readonly spawnAcknowledgementAfterMs: number;
  readonly spawnAcknowledgementObserver: ((input: {
    readonly child: ChildProcessWithoutNullStreams;
    readonly childProcessInstanceSha256: string;
  }) => Promise<HostCustodySpawnAcknowledgement>) | undefined;
}

const observeSpawnAcknowledgement = async (
  live: LiveCustody,
  guardian: StableProcessGroupGuardian,
  start: GuardianStartObservation,
  acknowledgementDeadline: number,
  dependencies: ProviderSpawnAcknowledgementDependencies,
): Promise<SpawnStatus> => {
  if (start.status !== "acknowledged") {return start.status;}
  live.providerPid = start.providerPid;
  const pgid = guardian.child.pid;
  const observer = dependencies.spawnAcknowledgementObserver;
  if (pgid === undefined || observer === undefined) {
    return pgid === undefined ? "ambiguous" : "acknowledged";
  }
  try {
    const remaining = acknowledgementDeadline - dependencies.monotonicNow();
    if (remaining <= 0) {return "ambiguous";}
    const observed = await boundedPromise(
      observer({
        child: guardian.child,
        childProcessInstanceSha256:
          live.childProcessInstanceSha256 ?? sha256("missing-child-instance"),
      }),
      remaining,
    );
    if (observed === undefined || dependencies.monotonicNow() >= acknowledgementDeadline) {
      return "ambiguous";
    }
    if (
      observed.status === "acknowledged" &&
      observed.child === guardian.child &&
      observed.pid === start.providerPid &&
      observed.pgid === pgid
    ) {
      return "acknowledged";
    }
    return observed.status === "error-before-start" ? "error-before-start" : "ambiguous";
  } catch {
    return "ambiguous";
  }
};

const observeProviderProcessIdentity = async (
  live: LiveCustody,
  child: ChildProcessWithoutNullStreams,
  acknowledgementDeadline: number,
  dependencies: ProviderSpawnAcknowledgementDependencies,
) => {
  if (live.fingerprint === undefined || live.executable === undefined || live.plan === undefined) {
    live.signalAuthorized = false;
    live.identity = Object.freeze({
      ...identityBase(live, dependencies.hostLifecycleGenerationSha256),
      status: "ambiguous",
    });
    return;
  }
  const observation = await observeProcessIdentity({
    child,
    childProcessInstanceSha256:
      live.childProcessInstanceSha256 ?? sha256("missing-child-instance"),
    executable: live.executable,
    fingerprint: live.fingerprint,
    hostLifecycleGenerationSha256: dependencies.hostLifecycleGenerationSha256,
    monotonicNow: dependencies.monotonicNow,
    observer: dependencies.processIdentityObserver,
    observationTimeoutMs: dependencies.identityObservationAfterMs,
    providerPid: live.providerPid ?? -1,
  });
  if (
    dependencies.monotonicNow() >= acknowledgementDeadline ||
    live.sealed ||
    live.spawnStatus !== "acknowledged"
  ) {return;}
  live.identity = observation.evidence;
  live.signalAuthorized = observation.proof !== undefined && observation.evidence.status === "proved";
  return observation.proof;
};

export const acknowledgeProviderSpawn = async (
  live: LiveCustody,
  guardian: StableProcessGroupGuardian,
  dependencies: ProviderSpawnAcknowledgementDependencies,
): Promise<SpawnStatus> => {
  const acknowledgementDeadline =
    dependencies.monotonicNow() + dependencies.spawnAcknowledgementAfterMs;
  const startRemaining = acknowledgementDeadline - dependencies.monotonicNow();
  const start = startRemaining <= 0
    ? undefined
    : await boundedPromise(guardian.start, startRemaining);
  if (start === undefined || dependencies.monotonicNow() >= acknowledgementDeadline) {
    live.spawnStatus = "ambiguous";
    live.signalAuthorized = false;
    live.identity = Object.freeze({
      ...identityBase(live, dependencies.hostLifecycleGenerationSha256),
      status: "ambiguous",
    });
    setTimeout(() => {void dependencies.onStartFailure();}, 0);
    return "ambiguous";
  }
  live.guardianNoStartAcknowledged = start.status === "error-before-start";
  if (start.status === "error-before-start" && start.code !== undefined) {
    live.guardianStartErrorCode = start.code;
  }
  let acknowledgement = await observeSpawnAcknowledgement(
    live, guardian, start, acknowledgementDeadline, dependencies,
  );
  live.spawnStatus = acknowledgement;
  if (acknowledgement === "acknowledged") {
    live.identityProof = observeProviderProcessIdentity(
      live, guardian.child, acknowledgementDeadline, dependencies,
    );
    const remaining = acknowledgementDeadline - dependencies.monotonicNow();
    const proof = remaining <= 0
      ? undefined
      : await boundedPromise(live.identityProof, remaining);
    if (proof === undefined || dependencies.monotonicNow() >= acknowledgementDeadline) {
      acknowledgement = "ambiguous";
      live.spawnStatus = "ambiguous";
      live.signalAuthorized = false;
      if (live.identity.status === "not-started" || live.identity.status === "proved") {
        const pgid = guardian.child.pid;
        const pid = live.providerPid;
        live.identity = Object.freeze({
          ...identityBase(live, dependencies.hostLifecycleGenerationSha256),
          ...(pid === undefined || pgid === undefined ? {} : { pgid, pid }),
          status: "unproven",
        });
      }
    }
  } else {
    live.signalAuthorized = false;
    const pgid = guardian.child.pid;
    const pid = live.providerPid;
    live.identity = Object.freeze({
      ...identityBase(live, dependencies.hostLifecycleGenerationSha256),
      ...(pid === undefined || pgid === undefined ? {} : { pgid, pid }),
      status: acknowledgement === "error-before-start" ? "not-started" : "ambiguous",
    });
  }
  if (acknowledgement !== "acknowledged") {
    setTimeout(() => {void dependencies.onStartFailure();}, 0);
  }
  return acknowledgement;
};
