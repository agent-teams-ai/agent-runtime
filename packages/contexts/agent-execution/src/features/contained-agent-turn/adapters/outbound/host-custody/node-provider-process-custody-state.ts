import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  CustodiedProviderProcess,
  CustodiedProviderProcessExit,
  HostCustodyStrictClosureEvidence,
  HostCustodyEvidence,
  HostCustodyLaunchFingerprintEvidence,
  HostCustodyLaunchPlan,
  HostCustodyLaunchPlanResolver,
  HostCustodyProcessIdentityEvidence,
  HostCustodyProcessIdentityObserver,
  HostCustodyProcessIdentityProof,
  HostCustodySpawnAcknowledgement,
  HostCustodyStartCode,
  ProviderProcessCustodyPort,
} from "./custodied-provider-process.js";
import type { ContainmentResult } from "./host-custody-evidence.js";
import type {
  ExecutableObservation,
  PrivateLaunchPathObservations,
  VerifiedLaunchDescriptors,
  WorkspaceObservation,
} from "./host-custody-launch.js";
import type { NodeCustodiedSdkProcess, SpawnStatus } from "./host-custody-process-tree.js";
import type { StableProcessGroupGuardian } from "./host-custody-stable-guardian.js";
import type { OperationResidueAuthority, OperationResidueAuthorityFactory } from "./host-custody-cgroup-v2.js";
import type { HostStderrIngress, HostStdoutIngress } from "./host-custody-stdio.js";
import { notStartedIdentity, strictClosure } from "./host-custody-evidence.js";

export const HOST_CUSTODY_LIMITS = Object.freeze({
  maxDiagnosticBytes: 65_536,
  maxStderrBytes: 16 * 1_048_576,
  maxStdinBytes: 16 * 1_048_576,
  maxStdoutBytes: 64 * 1_048_576,
  stdoutHighWaterBytes: 256 * 1024,
});

export interface LiveCustody {
  abortRequested: boolean;
  readonly attemptId: string;
  readonly custodyRef: string;
  readonly inputIdentitySha256: string;
  readonly operationId: string;
  readonly providerBinding: Parameters<ProviderProcessCustodyPort["open"]>[0]["providerBinding"];
  readonly workspaceRef: string;
  closureEvidence: HostCustodyStrictClosureEvidence;
  containment?: Promise<ContainmentResult>;
  contained?: Extract<ContainmentResult, { readonly kind: "contained" }>;
  child?: ChildProcessWithoutNullStreams;
  childProcessInstanceSha256?: string;
  evidenceSealed: boolean;
  executable?: ExecutableObservation;
  exit?: Promise<CustodiedProviderProcessExit>;
  fingerprint?: HostCustodyLaunchFingerprintEvidence;
  guardian?: StableProcessGroupGuardian;
  guardianNoStartAcknowledged?: boolean;
  guardianStartErrorCode?: HostCustodyStartCode;
  launchAuthority?: VerifiedLaunchDescriptors;
  identity: HostCustodyProcessIdentityEvidence;
  identityProof?: Promise<HostCustodyProcessIdentityProof | undefined>;
  opening: Promise<void>;
  cleanupDeadline?: number;
  containmentDeadline?: number;
  plan?: HostCustodyLaunchPlan;
  privatePaths?: PrivateLaunchPathObservations;
  privateRootClosure: { identitySha256: string; status: "active" | "deleted" | "quarantined" | "unproven" };
  process?: CustodiedProviderProcess;
  providerPid?: number;
  residueAuthority?: OperationResidueAuthority;
  sdkProcess?: NodeCustodiedSdkProcess;
  sealed: boolean;
  signalAuthorized: boolean;
  spawnAcknowledgement?: Promise<SpawnStatus>;
  spawnStatus: SpawnStatus;
  startIdentitySha256?: string;
  stdinBytes: number;
  stderr?: HostStderrIngress;
  stdout?: HostStdoutIngress;
  workspace?: WorkspaceObservation;
}

export const createLiveCustody = (
  input: Parameters<ProviderProcessCustodyPort["open"]>[0],
  custodyRef: string,
  hostLifecycleGenerationSha256: string,
  inputIdentitySha256: string,
  opening: Promise<void>,
): LiveCustody => ({
  abortRequested: false,
  attemptId: input.attemptId,
  closureEvidence: strictClosure("unproven"),
  custodyRef,
  evidenceSealed: false,
  identity: notStartedIdentity(hostLifecycleGenerationSha256),
  inputIdentitySha256,
  opening,
  operationId: input.operationId,
  providerBinding: Object.freeze({ ...input.providerBinding }),
  privateRootClosure: Object.freeze({ identitySha256: "", status: "active" }),
  sealed: false,
  signalAuthorized: false,
  spawnStatus: "never-started",
  stdinBytes: 0,
  workspaceRef: input.workspaceRef,
});

export interface CustodyTombstone {
  readonly attemptId: string;
  readonly custodyRef: string;
  readonly evidence: HostCustodyEvidence;
  readonly inputIdentitySha256: string;
  readonly operationId: string;
  readonly receiptRef: string;
}

export interface NodeProviderProcessCustodyOptions {
  readonly drainAfterMs?: number;
  readonly containmentAfterMs?: number;
  readonly forceKillAfterMs?: number;
  readonly hostLifecycleGeneration?: string;
  readonly launchPlans: HostCustodyLaunchPlanResolver;
  readonly maxDiagnosticBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxStdinBytes?: number;
  readonly maxStdoutBytes?: number;
  readonly maxTombstones?: number;
  readonly monotonicNow?: () => number;
  readonly processIdentityObserver?: HostCustodyProcessIdentityObserver;
  readonly residueAuthorityFactory?: OperationResidueAuthorityFactory;
  readonly spawnAcknowledgementObserver?: (input: {
    readonly child: ChildProcessWithoutNullStreams;
    readonly childProcessInstanceSha256: string;
  }) => Promise<HostCustodySpawnAcknowledgement>;
  readonly spawnAcknowledgementAfterMs?: number;
  readonly identityObservationAfterMs?: number;
  readonly stdoutHighWaterBytes?: number;
  readonly terminateAfterMs?: number;
}
