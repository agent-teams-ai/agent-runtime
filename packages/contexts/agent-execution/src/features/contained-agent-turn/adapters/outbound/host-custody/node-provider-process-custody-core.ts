/* oxlint-disable max-lines -- shared POSIX custody core remains within the reviewed 600-line production limit. */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  HostCustodyFingerprintConflictError,
  HostCustodyLaunchRejectedError,
  HostCustodyUnsupportedError,
  type CustodiedProviderProcess,
  type ContainedTurnCustodyHandle,
  type CustodiedProviderProcessRegistry,
  type CustodiedSdkProcess,
  type CustodiedSdkProcessLauncher,
  type HostCustodyEvidenceRegistry,
  type HostCustodyEvidence,
  type HostCustodyLaunchPlanResolver,
  type HostCustodyReservationInput,
  type HostCustodyProcessIdentityObserver,
  type HostCustodyProcessIdentityProof,
  type HostCustodySpawnAcknowledgement,
  type ProviderProcessCustodyPort,
} from "./custodied-provider-process.js";
import {
  containCustody,
  identityBase,
  snapshotEvidence,
  unprovenResult,
  type ContainmentResult,
} from "./host-custody-evidence.js";
import {
  assertDelegatedStartFingerprint,
  canonicalJson,
  createFingerprint,
  inputIdentity,
  positiveInteger,
  resolveLaunchCandidate,
  sha256,
} from "./host-custody-launch.js";
import {
  createPosixProcessIdentityObserver,
  delegatedStartAbortError,
  NodeCustodiedSdkProcess,
  observeProcessIdentity,
  type SpawnStatus,
} from "./host-custody-process-tree.js";
import { StableProcessGroupGuardian, type GuardianStartObservation } from "./host-custody-stable-guardian.js";
import type { OperationResidueAuthorityFactory } from "./host-custody-cgroup-v2.js";
import { launchGuardedProvider } from "./node-provider-process-custody-launch.js";
import {
  assertHostCustodyReservationMode,
  openHostCustodyReservation,
} from "./node-provider-process-custody-open.js";
import { replayCustody } from "./node-provider-process-custody-replay.js";
import { releaseHostCustody } from "./host-custody-release.js";
import { quarantinePrivateRootForReconciliation } from "./host-custody-private-root.js";
import { boundedPromise } from "./host-custody-stdio.js";
import {
  assertRetainedWorkspaceAuthority,
  assertReservedWorkspaceAuthority,
  bindPrivateHostCustodyReservation,
  closeRetainedWorkspaceAuthority,
} from "./private-host-custody-reservation.js";
import {
  createLiveCustody,
  HOST_CUSTODY_LIMITS,
  type CustodyTombstone,
  type LiveCustody,
  type NodeProviderProcessCustodyOptions,
} from "./node-provider-process-custody-state.js";
import {
  assertRuntimeProfilePlatform,
  type ProcessCustodyRuntimeProfile,
} from "./host-custody-runtime-profile.js";
export type { NodeProviderProcessCustodyOptions } from "./node-provider-process-custody-state.js";
export class NodeProviderProcessCustodyCore implements
  ProviderProcessCustodyPort,
  CustodiedProviderProcessRegistry,
  CustodiedSdkProcessLauncher,
  HostCustodyEvidenceRegistry
{
  readonly #byAttempt = new Map<string, LiveCustody>();
  readonly #byRef = new Map<string, LiveCustody>();
  readonly #containmentAfterMs: number;
  readonly #drainAfterMs: number;
  readonly #forceKillAfterMs: number;
  readonly #hostLifecycleGenerationSha256: string;
  readonly #launchPlans: HostCustodyLaunchPlanResolver;
  readonly #maxDiagnosticBytes: number;
  readonly #maxStderrBytes: number;
  readonly #maxStdinBytes: number;
  readonly #maxStdoutBytes: number;
  readonly #maxTombstones: number;
  readonly #monotonicNow: () => number;
  readonly #processIdentityObserver: HostCustodyProcessIdentityObserver | undefined;
  readonly #runtimeProfile: ProcessCustodyRuntimeProfile;
  readonly #residueAuthorityFactory: OperationResidueAuthorityFactory;
  readonly #identityObservationAfterMs: number;
  readonly #spawnAcknowledgementAfterMs: number;
  readonly #spawnAcknowledgementObserver: ((input: {
    readonly child: ChildProcessWithoutNullStreams;
    readonly childProcessInstanceSha256: string;
  }) => Promise<HostCustodySpawnAcknowledgement>) | undefined;
  readonly #stdoutHighWaterBytes: number;
  readonly #terminateAfterMs: number;
  readonly #tombstonesByAttempt = new Map<string, CustodyTombstone>();
  readonly #tombstonesByRef = new Map<string, CustodyTombstone>();

  public constructor(options: NodeProviderProcessCustodyOptions, runtimeProfile: ProcessCustodyRuntimeProfile) {
    assertRuntimeProfilePlatform(runtimeProfile);
    this.#runtimeProfile = runtimeProfile;
    this.#launchPlans = options.launchPlans;
    this.#terminateAfterMs = positiveInteger("terminateAfterMs", options.terminateAfterMs, 2_000);
    this.#forceKillAfterMs = positiveInteger("forceKillAfterMs", options.forceKillAfterMs, 2_000);
    this.#drainAfterMs = positiveInteger("drainAfterMs", options.drainAfterMs, 2_000);
    this.#containmentAfterMs = positiveInteger("containmentAfterMs", options.containmentAfterMs, 15_000);
    this.#spawnAcknowledgementAfterMs = positiveInteger("spawnAcknowledgementAfterMs", options.spawnAcknowledgementAfterMs, 10_000);
    this.#maxDiagnosticBytes = positiveInteger("maxDiagnosticBytes", options.maxDiagnosticBytes, HOST_CUSTODY_LIMITS.maxDiagnosticBytes);
    this.#maxStderrBytes = positiveInteger("maxStderrBytes", options.maxStderrBytes, HOST_CUSTODY_LIMITS.maxStderrBytes);
    this.#maxStdinBytes = positiveInteger("maxStdinBytes", options.maxStdinBytes, HOST_CUSTODY_LIMITS.maxStdinBytes);
    this.#maxStdoutBytes = positiveInteger("maxStdoutBytes", options.maxStdoutBytes, HOST_CUSTODY_LIMITS.maxStdoutBytes);
    this.#maxTombstones = positiveInteger("maxTombstones", options.maxTombstones, 10_000);
    this.#stdoutHighWaterBytes = positiveInteger("stdoutHighWaterBytes", options.stdoutHighWaterBytes, HOST_CUSTODY_LIMITS.stdoutHighWaterBytes);
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#identityObservationAfterMs = positiveInteger("identityObservationAfterMs", options.identityObservationAfterMs, 2_000);
    this.#processIdentityObserver = options.processIdentityObserver ?? createPosixProcessIdentityObserver();
    this.#residueAuthorityFactory = options.residueAuthorityFactory ?? runtimeProfile.residueAuthorityFactory;
    this.#spawnAcknowledgementObserver = options.spawnAcknowledgementObserver;
    this.#hostLifecycleGenerationSha256 = sha256(options.hostLifecycleGeneration ?? randomUUID());
  }
  public get(custodyRef: string): CustodiedProviderProcess | undefined {
    return this.#byRef.get(custodyRef)?.process;
  }
  public evidence(custodyRef: string): HostCustodyEvidence | undefined {
    const tombstone = this.#tombstonesByRef.get(custodyRef);
    if (tombstone !== undefined) {return tombstone.evidence;}
    const live = this.#byRef.get(custodyRef);
    if (live === undefined || live.fingerprint === undefined) {return undefined;}
    return snapshotEvidence(live);
  }

  public async release(input: {
    readonly attemptId: string;
    readonly custodyRef?: string;
    readonly operationId: string;
    readonly receiptRef: string;
  }): Promise<{ readonly kind: "released" } | { readonly evidenceRef: string; readonly kind: "unproven" }> {
    const live = input.custodyRef === undefined
      ? this.#byAttempt.get(input.attemptId)
      : this.#byRef.get(input.custodyRef);
    const outcome = await releaseHostCustody({
      byAttempt: this.#byAttempt,
      byRef: this.#byRef,
      cleanupAfterMs: this.#containmentAfterMs,
      maxTombstones: this.#maxTombstones,
      monotonicNow: this.#monotonicNow,
      tombstonesByAttempt: this.#tombstonesByAttempt,
      tombstonesByRef: this.#tombstonesByRef,
    }, input);
    if (outcome.kind === "released" && live !== undefined) {closeRetainedWorkspaceAuthority(live);}
    return outcome;
  }

  public async open(input: Parameters<ProviderProcessCustodyPort["open"]>[0]): Promise<ContainedTurnCustodyHandle> {
    return this.#open(input);
  }

  public async reserve(input: HostCustodyReservationInput): Promise<ContainedTurnCustodyHandle> {
    const reservation = await bindPrivateHostCustodyReservation(input, this, this.#runtimeProfile);
    try {
      const opened = await this.#open(
        input, "sdk-delegated", reservation.launchPlans, reservation.retainedWorkspaceAuthority,
      );
      if (this.#byAttempt.get(input.attemptId)?.retainedWorkspaceAuthority !==
          reservation.retainedWorkspaceAuthority) {
        reservation.retainedWorkspaceAuthority.close();
      }
      return opened;
    } catch (error) {reservation.retainedWorkspaceAuthority.close(); throw error;}
  }

  async #open(
    input: Parameters<ProviderProcessCustodyPort["open"]>[0] | HostCustodyReservationInput,
    requiredSpawnMode?: "sdk-delegated",
    reservationLaunchPlans?: HostCustodyLaunchPlanResolver,
    retainedWorkspaceAuthority?: import("./private-host-custody-reservation.js").RetainedHostCustodyWorkspaceAuthority,
  ): Promise<ContainedTurnCustodyHandle> {
    const baseIdentitySha256 = inputIdentity(input);
    const identitySha256 = "workspaceAuthority" in input
      ? sha256(canonicalJson([
        baseIdentitySha256,
        input.workspaceAuthority.canonicalPath,
        input.workspaceAuthority.identity.dev.toString(),
        input.workspaceAuthority.identity.ino.toString(),
        input.workspaceAuthority.identity.mountId,
      ]))
      : baseIdentitySha256;
    const tombstone = this.#tombstonesByAttempt.get(input.attemptId);
    const existing = this.#byAttempt.get(input.attemptId);
    if (tombstone !== undefined && requiredSpawnMode !== undefined) {
      assertHostCustodyReservationMode(tombstone.evidence.fingerprint, requiredSpawnMode);
    }
    if (tombstone !== undefined || existing !== undefined) {
      const replay = await replayCustody(
        input, identitySha256, tombstone, existing,
        () => this.#resolveCandidate(input, requiredSpawnMode),
      );
      if (replay !== undefined) {return replay;}
    }
    if (this.#tombstonesByAttempt.size + this.#byAttempt.size >= this.#maxTombstones) {
      throw new HostCustodyUnsupportedError("retention-capacity-exhausted");
    }
    const custodyRef = `urn:agent-runtime:host-custody:${randomUUID()}`;
    let resolveOpening: (() => void) | undefined;
    let rejectOpening: ((error: unknown) => void) | undefined;
    const opening = new Promise<void>((resolve, reject) => {resolveOpening = resolve; rejectOpening = reject;});
    const live = createLiveCustody(
      input,
      custodyRef,
      this.#hostLifecycleGenerationSha256,
      identitySha256,
      {
        containmentProfile: this.#runtimeProfile.containmentProfile,
        opening,
        ...("workspaceAuthority" in input ? { workspaceAuthority: input.workspaceAuthority } : {}),
        ...(retainedWorkspaceAuthority === undefined ? {} : { retainedWorkspaceAuthority }),
      },
    );
    this.#byAttempt.set(input.attemptId, live);
    this.#byRef.set(custodyRef, live);
    return openHostCustodyReservation({
      contain: (reserved, reservedInput) => this.#containSingleFlight(reserved, reservedInput),
      containmentAfterMs: this.#containmentAfterMs,
      input,
      launchPlans: reservationLaunchPlans ?? this.#launchPlans,
      live,
      opening,
      rejectOpening,
      removeUnfingerprintedReservation: () => {
        this.#byAttempt.delete(live.attemptId);
        this.#byRef.delete(live.custodyRef);
      },
      residueAuthorityFactory: this.#residueAuthorityFactory,
      expectedContainmentProfile: this.#runtimeProfile.containmentProfile,
      ...(requiredSpawnMode === undefined ? {} : { requiredSpawnMode }),
      resolveOpening,
      spawn: (reserved, arguments_, environment) => {this.#spawn(reserved, arguments_, environment);},
      ...(reservationLaunchPlans === undefined ? {} : { assertBoundReservation: assertReservedWorkspaceAuthority }),
    });
  }

  public start(custodyRef: string, input: {
    readonly arguments: readonly string[];
    readonly command: string;
    readonly cwd: string | undefined;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly signal: AbortSignal;
  }): CustodiedSdkProcess {
    const live = this.#byRef.get(custodyRef);
    if (live === undefined) {throw new Error("Host Custody reservation does not exist");}
    if (live.sealed) {throw new Error("Host Custody reservation is sealed");}
    const plan = live.plan;
    if (plan === undefined || (plan.spawnMode ?? "eager") !== "sdk-delegated") {
      throw new Error("Host Custody reservation does not permit delegated SDK start");
    }
    const environment = assertDelegatedStartFingerprint(input, plan, live.workspaceRef);
    const startIdentitySha256 = sha256(canonicalJson([
      live.fingerprint?.planSha256,
      sha256(input.command),
      input.cwd === undefined ? undefined : sha256(input.cwd),
      input.arguments,
      Object.keys(environment).toSorted(),
    ]));
    const requestAbort = (): void => {
      live.abortRequested = true;
      void this.#triggerAbortContainment(live);
    };
    input.signal.addEventListener("abort", requestAbort, { once: true });
    if (input.signal.aborted) {
      requestAbort();
      input.signal.removeEventListener("abort", requestAbort);
      throw delegatedStartAbortError();
    }
    if (live.startIdentitySha256 !== undefined) {
      if (live.startIdentitySha256 !== startIdentitySha256 || live.sdkProcess === undefined) {
        input.signal.removeEventListener("abort", requestAbort);
        throw new HostCustodyFingerprintConflictError("Host Custody delegated start fingerprint conflict");
      }
      void live.exit?.finally(() => input.signal.removeEventListener("abort", requestAbort));
      return live.sdkProcess;
    }
    live.startIdentitySha256 = startIdentitySha256;
    const startFingerprint = createFingerprint({
      attemptId: live.attemptId,
      intentMode: plan.intentMode,
      operationId: live.operationId,
      providerBinding: live.providerBinding,
      workspaceRef: live.workspaceRef,
    }, plan, live.workspaceRef, input.arguments);
    if (live.fingerprint?.fingerprintSha256 !== startFingerprint.fingerprintSha256) {
      throw new HostCustodyFingerprintConflictError("Host Custody delegated start fingerprint conflict");
    }
    let sdkProcess: NodeCustodiedSdkProcess;
    try {
      sdkProcess = this.#spawn(live, input.arguments, environment);
    } catch (error) {
      input.signal.removeEventListener("abort", requestAbort);
      if (
        error instanceof HostCustodyFingerprintConflictError ||
        error instanceof HostCustodyUnsupportedError
      ) {throw error;}
      throw new HostCustodyLaunchRejectedError();
    }
    if (input.signal.aborted) {requestAbort();}
    void live.exit?.finally(() => input.signal.removeEventListener("abort", requestAbort));
    return sdkProcess;
  }

  public requestContainment(input: {
    readonly attemptId: string;
    readonly custodyRef?: string;
    readonly operationId: string;
  }): Promise<ContainmentResult> {
    const tombstone = input.custodyRef === undefined
      ? this.#tombstonesByAttempt.get(input.attemptId)
      : this.#tombstonesByRef.get(input.custodyRef);
    if (tombstone?.attemptId === input.attemptId && tombstone.operationId === input.operationId) {
      return Promise.resolve(Object.freeze({ kind: "contained", receiptRef: tombstone.receiptRef }));
    }
    const live = input.custodyRef === undefined
      ? this.#byAttempt.get(input.attemptId)
      : this.#byRef.get(input.custodyRef);
    if (live === undefined || live.attemptId !== input.attemptId || live.operationId !== input.operationId) {
      return Promise.resolve(unprovenResult("missing", input));
    }
    return this.#containSingleFlight(live, input);
  }

  #spawn(
    live: LiveCustody,
    arguments_: readonly string[],
    environment: Readonly<Record<string, string>>,
  ): NodeCustodiedSdkProcess {
    if (live.sealed) {throw new Error("Host Custody reservation is sealed");}
    if (live.child !== undefined || live.spawnAcknowledgement !== undefined) {
      if (live.sdkProcess !== undefined) {return live.sdkProcess;}
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
    let launched: ReturnType<typeof launchGuardedProvider>;
    try {
      launched = launchGuardedProvider({
        arguments: arguments_,
        environment,
        live,
        maxDiagnosticBytes: this.#maxDiagnosticBytes,
        maxStderrBytes: this.#maxStderrBytes,
        maxStdinBytes: this.#maxStdinBytes,
        maxStdoutBytes: this.#maxStdoutBytes,
        monotonicNow: this.#monotonicNow,
        onAbort: () => {void this.#triggerAbortContainment(live);},
        onOverflow: () => {void this.#triggerOverflowContainment(live);},
        spawnAcknowledgementAfterMs: this.#spawnAcknowledgementAfterMs,
        stdoutHighWaterBytes: this.#stdoutHighWaterBytes,
        writeAfterMs: this.#spawnAcknowledgementAfterMs,
        ...(live.retainedWorkspaceAuthority === undefined ? {} : {
          workspaceDescriptorPath: live.retainedWorkspaceAuthority.descriptorPath,
        }),
      });
    } finally {
      closeRetainedWorkspaceAuthority(live);
    }
    live.childProcessInstanceSha256 = sha256(randomUUID());
    live.executable = launched.authority.executable;
    live.launchAuthority = launched.authority;
    live.spawnStatus = "ambiguous";
    live.guardian = launched.guardian;
    live.spawnAcknowledgement = this.#acknowledgeSpawn(live, launched.guardian);
    live.child = launched.child;
    live.exit = launched.exit;
    live.process = launched.process;
    live.sdkProcess = launched.sdkProcess;
    live.stderr = launched.stderr;
    live.stdout = launched.stdout;
    return launched.sdkProcess;
  }

  async #observeSpawnAcknowledgement(
    live: LiveCustody,
    guardian: StableProcessGroupGuardian,
    start: GuardianStartObservation,
    acknowledgementDeadline: number,
  ): Promise<SpawnStatus> {
    if (start.status !== "acknowledged") {return start.status;}
    live.providerPid = start.providerPid;
    const pgid = guardian.child.pid;
    const observer = this.#spawnAcknowledgementObserver;
    if (pgid === undefined || observer === undefined) {return pgid === undefined ? "ambiguous" : "acknowledged";}
    try {
      const remaining = acknowledgementDeadline - this.#monotonicNow();
      if (remaining <= 0) {return "ambiguous";}
      const observed = await boundedPromise(
        observer({
          child: guardian.child,
          childProcessInstanceSha256: live.childProcessInstanceSha256 ?? sha256("missing-child-instance"),
        }),
        remaining,
      );
      if (observed === undefined || this.#monotonicNow() >= acknowledgementDeadline) {return "ambiguous";}
      if (
        observed.status === "acknowledged" &&
        observed.child === guardian.child &&
        observed.pid === start.providerPid &&
        observed.pgid === pgid
      ) {
        return "acknowledged";
      }
      return observed.status === "error-before-start" ? "error-before-start" : "ambiguous";
    } catch {return "ambiguous";}
  }

  async #acknowledgeSpawn(live: LiveCustody, guardian: StableProcessGroupGuardian): Promise<SpawnStatus> {
    const acknowledgementDeadline = this.#monotonicNow() + this.#spawnAcknowledgementAfterMs;
    const startRemaining = acknowledgementDeadline - this.#monotonicNow();
    const start = startRemaining <= 0
      ? undefined
      : await boundedPromise(guardian.start, startRemaining);
    if (start === undefined || this.#monotonicNow() >= acknowledgementDeadline) {
      live.spawnStatus = "ambiguous";
      live.signalAuthorized = false;
      live.identity = Object.freeze({
        ...identityBase(live, this.#hostLifecycleGenerationSha256),
        status: "ambiguous",
      });
      setTimeout(() => {void this.#triggerStartFailureContainment(live);}, 0);
      return "ambiguous";
    }
    live.guardianNoStartAcknowledged = start.status === "error-before-start";
    if (start.status === "error-before-start" && start.code !== undefined) {
      live.guardianStartErrorCode = start.code;
    }
    let acknowledgement = await this.#observeSpawnAcknowledgement(live, guardian, start, acknowledgementDeadline);
    live.spawnStatus = acknowledgement;
    if (acknowledgement === "acknowledged") {
      live.identityProof = this.#observeProcessIdentity(live, guardian.child, acknowledgementDeadline);
      const remaining = acknowledgementDeadline - this.#monotonicNow();
      const proof = remaining <= 0
        ? undefined
        : await boundedPromise(live.identityProof, remaining);
      if (proof === undefined || this.#monotonicNow() >= acknowledgementDeadline) {
        acknowledgement = "ambiguous";
        live.spawnStatus = "ambiguous";
        live.signalAuthorized = false;
        if (live.identity.status === "not-started" || live.identity.status === "proved") {
          const pgid = guardian.child.pid;
          const pid = live.providerPid;
          live.identity = Object.freeze({
            ...identityBase(live, this.#hostLifecycleGenerationSha256),
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
        ...identityBase(live, this.#hostLifecycleGenerationSha256),
        ...(pid === undefined || pgid === undefined ? {} : { pgid, pid }),
        status: acknowledgement === "error-before-start" ? "not-started" : "ambiguous",
      });
    }
    if (acknowledgement !== "acknowledged") {
      setTimeout(() => {void this.#triggerStartFailureContainment(live);}, 0);
    }
    return acknowledgement;
  }

  async #observeProcessIdentity(
    live: LiveCustody,
    child: ChildProcessWithoutNullStreams,
    acknowledgementDeadline: number,
  ): Promise<HostCustodyProcessIdentityProof | undefined> {
    if (live.fingerprint === undefined || live.executable === undefined || live.plan === undefined) {
      live.signalAuthorized = false;
      live.identity = Object.freeze({ ...identityBase(live, this.#hostLifecycleGenerationSha256), status: "ambiguous" });
      return undefined;
    }
    const observation = await observeProcessIdentity({
      child,
      childProcessInstanceSha256: live.childProcessInstanceSha256 ?? sha256("missing-child-instance"),
      executable: live.executable,
      fingerprint: live.fingerprint,
      hostLifecycleGenerationSha256: this.#hostLifecycleGenerationSha256,
      monotonicNow: this.#monotonicNow,
      observer: this.#processIdentityObserver,
      observationTimeoutMs: this.#identityObservationAfterMs,
      providerPid: live.providerPid ?? -1,
    });
    if (
      this.#monotonicNow() >= acknowledgementDeadline ||
      live.sealed ||
      live.spawnStatus !== "acknowledged"
    ) {return undefined;}
    live.identity = observation.evidence;
    live.signalAuthorized = observation.proof !== undefined && observation.evidence.status === "proved";
    return observation.proof;
  }

  #containSingleFlight(
    live: LiveCustody,
    input: { readonly attemptId: string; readonly custodyRef?: string; readonly operationId: string },
  ): Promise<ContainmentResult> {
    if (live.containment !== undefined) {return live.containment;}
    const containment = this.#contain(live, input);
    live.containment = containment;
    void containment.then(
      result => {
        if (result.kind === "unproven" && live.containment === containment) {
          delete live.containment;
        }
        return null;
      },
      () => {
        if (live.containment === containment) {delete live.containment;}
        return null;
      },
    );
    return containment;
  }

  async #contain(
    live: LiveCustody,
    input: { readonly attemptId: string; readonly custodyRef?: string; readonly operationId: string },
  ): Promise<ContainmentResult> {
    live.sealed = true;
    live.containmentDeadline ??= this.#monotonicNow() + this.#containmentAfterMs;
    try {
      return await containCustody(live, input, {
        containmentAfterMs: this.#containmentAfterMs,
        drainAfterMs: this.#drainAfterMs,
        forceKillAfterMs: this.#forceKillAfterMs,
        hostLifecycleGenerationSha256: this.#hostLifecycleGenerationSha256,
        monotonicNow: this.#monotonicNow,
        terminateAfterMs: this.#terminateAfterMs,
      });
    } finally {
      if (live.fingerprint?.containmentProfile === "cooperative-darwin-posix-process-group" &&
          live.spawnStatus !== "never-started" && live.spawnStatus !== "error-before-start") {
        quarantinePrivateRootForReconciliation(live);
      }
    }
  }

  async #triggerOverflowContainment(live: LiveCustody): Promise<void> {
    const containment = this.#containSingleFlight(live, {
      attemptId: live.attemptId,
      custodyRef: live.custodyRef,
      operationId: live.operationId,
    });
    await containment.catch(() => {});
  }

  async #triggerAbortContainment(live: LiveCustody): Promise<void> {
    live.abortRequested = true;
    const containment = this.#containSingleFlight(live, {
      attemptId: live.attemptId,
      custodyRef: live.custodyRef,
      operationId: live.operationId,
    });
    await containment.catch(() => {});
  }

  async #triggerStartFailureContainment(live: LiveCustody): Promise<void> {
    const containment = this.#containSingleFlight(live, {
      attemptId: live.attemptId,
      custodyRef: live.custodyRef,
      operationId: live.operationId,
    });
    await containment.catch(() => {});
  }

  async #resolveCandidate(
    input: Parameters<ProviderProcessCustodyPort["open"]>[0],
    requiredSpawnMode?: "sdk-delegated",
  ) {
    try {
      const candidate = await resolveLaunchCandidate(this.#launchPlans, input);
      if (candidate.plan.containmentProfile !== this.#runtimeProfile.containmentProfile) {
        throw new HostCustodyUnsupportedError("platform-profile-unavailable");
      }
      assertHostCustodyReservationMode(candidate.plan, requiredSpawnMode);
      return candidate;
    }
    catch (error) {
      if (error instanceof HostCustodyUnsupportedError) {throw error;}
      throw new HostCustodyLaunchRejectedError();
    }
  }
}
