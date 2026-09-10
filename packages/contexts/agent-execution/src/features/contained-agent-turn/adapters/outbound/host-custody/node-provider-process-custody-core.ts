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
  type HostCustodySpawnAcknowledgement,
  type ProviderProcessCustodyPort,
} from "./custodied-provider-process.js";
import { containCustody, snapshotEvidence, unprovenResult, type ContainmentResult } from "./host-custody-evidence.js";
import {
  inputIdentity,
  positiveInteger,
  resolveLaunchCandidate,
  sha256,
} from "./host-custody-launch.js";
import {
  createPosixProcessIdentityObserver,
  delegatedStartAbortError,
  NodeCustodiedSdkProcess,
} from "./host-custody-process-tree.js";
import { OperationResidueNotAllocatedError, type OperationResidueAuthorityFactory } from "./host-custody-cgroup-v2.js";
import { bindCooperativeProcessGroupGuardian } from "./host-custody-posix-process-group.js";
import { DescriptorAuthorityAcquisitionError } from "./host-custody-launch-failure.js";
import { launchGuardedProvider } from "./node-provider-process-custody-launch.js";
import {
  assertHostCustodyReservationMode,
  openHostCustodyReservation,
} from "./node-provider-process-custody-open.js";
import { assertPrivateReservationReplay, privateReservationIdentity, snapshotPrivateReservationReplayInput, replayCustody } from "./node-provider-process-custody-replay.js";
import { releaseHostCustody } from "./host-custody-release.js";
import { quarantinePrivateRootForReconciliation } from "./host-custody-private-root.js";
import {
  assertRetainedWorkspaceAuthority,
  assertReservedWorkspaceAuthority,
  bindPrivateHostCustodyReservation,
  closeRetainedWorkspaceAuthority,
} from "./private-host-custody-reservation.js";
import {
  createLiveCustody,
  HOST_CUSTODY_LIMITS,
  isCompleteProvedNoStart,
  type CustodyTombstone,
  type LiveCustody,
  type NodeProviderProcessCustodyOptions,
} from "./node-provider-process-custody-state.js";
import {
  assertRuntimeProfilePlatform,
  type ProcessCustodyRuntimeProfile,
} from "./host-custody-runtime-profile.js";
import { acknowledgeProviderSpawn } from "./node-provider-process-custody-spawn-acknowledgement.js";
import { readCustodyStartAdmission } from "./node-provider-process-custody-start-admission.js";
import {
  custodyDataRecord,
  readNodeCustodyHttpHandoff,
  type NodeCustodyHttpPreparation,
  type NodeCustodyHttpLifetime,
} from "./node-provider-process-custody-http-reservation.js";
import type { FinalHostLaunch } from "./host-launch-finalization.js";
import { startHostCustodyLaunch } from "./host-custody-start-projection.js";
import { snapshotHostCustodyLaunchPlan } from "./host-custody-launch-plan-snapshot.js";
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

  readonly #preparations = new WeakMap<NodeCustodyHttpLifetime, LiveCustody>();
  readonly #httpPreparation: NodeCustodyHttpPreparation = (() => {
    const byRef = this.#byRef;
    const preparations = this.#preparations;
    const capability: NodeCustodyHttpPreparation = Object.freeze({
      acquire(input: Parameters<NodeCustodyHttpPreparation["acquire"]>[0]) {
        if (this !== capability) {throw new TypeError("Host Custody HTTP preparation receiver conflicts");}
        const handoff = readNodeCustodyHttpHandoff(input);
        const live = byRef.get(handoff.underlyingCustodyRef);
        if (live === undefined) {throw new TypeError("Host Custody HTTP reservation is unavailable");}
        const lifetime = live.httpReservation.acquire(live, handoff);
        preparations.set(lifetime, live);
        return lifetime;
      },
      prepareResources(lifetime: NodeCustodyHttpLifetime, input: Parameters<NodeCustodyHttpPreparation["prepareResources"]>[1]) {
        const live = preparations.get(lifetime);
        if (this !== capability || live === undefined || byRef.get(live.custodyRef) !== live) {
          throw new TypeError("Host Custody HTTP preparation identity conflicts");
        }
        return live.httpReservation.prepareResources(lifetime, input);
      },
      retainDarwinRoute(lifetime: NodeCustodyHttpLifetime, route: Parameters<NodeCustodyHttpPreparation["retainDarwinRoute"]>[1]) {
        const live = preparations.get(lifetime);
        if (this !== capability || live === undefined || byRef.get(live.custodyRef) !== live) {
          throw new TypeError("Host Custody Darwin route preparation conflicts");
        }
        live.httpReservation.retainDarwinRoute(live, lifetime, route);
      },
      finalize(lifetime: NodeCustodyHttpLifetime) {
        const live = preparations.get(lifetime);
        if (this !== capability || live === undefined || byRef.get(live.custodyRef) !== live) {
          throw new TypeError("Host Custody HTTP preparation identity conflicts");
        }
        return live.launchBinding.bind(live, lifetime);
      },
    });
    return capability;
  })();

  /** Provider gets a view of the reservation slot, never its mutation owner. */
  public static launchView(owner: unknown, custodyRef: string) {
    if (typeof owner !== "object" || owner === null || !(#byRef in owner)) {return;}
    return owner.#byRef.get(custodyRef)?.launchBinding.view;
  }

  public static startFinalized(owner: unknown, custodyRef: string, bundle: FinalHostLaunch, signal: AbortSignal) {
    if (typeof owner !== "object" || owner === null || !(#byRef in owner)) {throw new HostCustodyLaunchRejectedError();}
    const live = owner.#byRef.get(custodyRef);
    if (live === undefined) {throw new HostCustodyLaunchRejectedError();}
    live.launchBinding.assertStart(bundle);
    if (live.launchBinding.view.readFinal() !== bundle) {throw new HostCustodyLaunchRejectedError();}
    return startHostCustodyLaunch({start: (reference, input) => owner.#start(reference, input, bundle)}, custodyRef, bundle.plan, signal);
  }

  /** Host-private inspection is inert, including foreign/proxied owners. No package export. */
  public static httpPreparation(owner: unknown): NodeCustodyHttpPreparation | undefined {
    return typeof owner === "object" && owner !== null && #httpPreparation in owner
      ? owner.#httpPreparation : undefined;
  }

  public constructor(options: NodeProviderProcessCustodyOptions, runtimeProfile: ProcessCustodyRuntimeProfile) {
    options = custodyDataRecord(options);
    runtimeProfile = custodyDataRecord(runtimeProfile);
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
    if (live?.attemptId === input.attemptId && live.operationId === input.operationId &&
        live.contained?.receiptRef === input.receiptRef && live.evidenceSealed) {
      live.httpReservation.cutoff();
    }
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
    const replayInput = snapshotPrivateReservationReplayInput(input);
    const prior = this.#byAttempt.get(replayInput.attemptId) ?? this.#tombstonesByAttempt.get(replayInput.attemptId);
    if (prior !== undefined) {
      assertPrivateReservationReplay(prior, replayInput);
      if ("opening" in prior) {await prior.opening;}
      return Object.freeze({custodyRef: prior.custodyRef});
    }
    input = replayInput;
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
      ? privateReservationIdentity(input)
      : baseIdentitySha256;
    const tombstone = this.#tombstonesByAttempt.get(input.attemptId);
    const existing = this.#byAttempt.get(input.attemptId);
    if (tombstone !== undefined && requiredSpawnMode !== undefined) {
      assertHostCustodyReservationMode(tombstone.evidence.fingerprint, requiredSpawnMode);
    }
    if (tombstone !== undefined || existing !== undefined) {
      if ("launchPlan" in input) {
        const prior = tombstone ?? existing!;
        assertPrivateReservationReplay(prior, input);
        if (existing !== undefined) {await existing.opening;}
        return Object.freeze({custodyRef: prior.custodyRef});
      }
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
        ...("launchPlan" in input ? {privateReservationPlan: snapshotHostCustodyLaunchPlan(input.launchPlan)} : {}),
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
      rejectOpening: error => {
        live.sealed = true;
        live.httpReservation.cutoff();
        rejectOpening?.(error);
      },
      removeUnfingerprintedReservation: () => {
        live.httpReservation.cutoff();
        this.#byAttempt.delete(live.attemptId);
        this.#byRef.delete(live.custodyRef);
      },
      residueAuthorityFactory: {create: async reference => {
        live.residueAllocation = "uncertain";
        try {
          const authority = await this.#residueAuthorityFactory.create(reference);
          live.residueAuthority = authority;
          live.residueAllocation = "retained";
          return authority;
        } catch (error) {
          if (error instanceof OperationResidueNotAllocatedError) {live.residueAllocation = "not-allocated";}
          throw error;
        }
      }},
      expectedContainmentProfile: this.#runtimeProfile.containmentProfile,
      ...(requiredSpawnMode === undefined ? {} : { requiredSpawnMode }),
      resolveOpening,
      spawn: (reserved, arguments_, environment) => {this.#spawn(reserved, arguments_, environment);},
      ...(reservationLaunchPlans === undefined ? {} : { assertBoundReservation: assertReservedWorkspaceAuthority }),
    });
  }

  public start(custodyRef: string, input: Parameters<CustodiedSdkProcessLauncher["start"]>[1]): CustodiedSdkProcess {
    return this.#start(custodyRef, input);
  }

  #start(custodyRef: string, input: {
    readonly arguments: readonly string[];
    readonly command: string;
    readonly cwd: string | undefined;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly signal: AbortSignal;
  }, bundle?: FinalHostLaunch): CustodiedSdkProcess {
    const live = this.#byRef.get(custodyRef);
    if (live === undefined) {throw new Error("Host Custody reservation does not exist");}
    live.httpReservation.assertActive();
    if (live.sealed) {throw new Error("Host Custody reservation is sealed");}
    live.launchBinding.assertStart(bundle);
    const plan = live.plan;
    if (plan === undefined || (plan.spawnMode ?? "eager") !== "sdk-delegated") {
      throw new Error("Host Custody reservation does not permit delegated SDK start");
    }
    const admission = readCustodyStartAdmission(input, live);
    const disposeAbort = (): void => {
      // Also removes a listener if registration threw before returning a handle.
      admission.abort.remove(requestAbort);
    };
    const requestAbort = (): void => {
      live.abortRequested = true;
      void this.#triggerAbortContainment(live);
      disposeAbort();
    };
    try {
      if (admission.replay === undefined) {live.launchBinding.firstStart(live);}
      // All caller data, both fingerprints and replay eligibility are now fixed.
      // Own the entire admitted phase, including cancellation and return setup.
      live.startIdentitySha256 = admission.startIdentitySha256;
      if (admission.abort.aborted) {requestAbort(); throw delegatedStartAbortError();}
      admission.abort.subscribe(requestAbort);
      let sdkProcess = admission.replay;
      if (sdkProcess === undefined) {
        sdkProcess = this.#spawn(live, admission.arguments, admission.environment);
      }
      if (live.exit === undefined) {throw new HostCustodyLaunchRejectedError();}
      void live.exit.then(disposeAbort, disposeAbort);
      if (admission.abort.aborted) {requestAbort();}
      return sdkProcess;
    } catch (error) {
      try {live.httpReservation.cutoff();}
      finally {
        // Cleanup failure cannot strand resources already retained by launch.
        void this.#triggerStartFailureContainment(live);
        disposeAbort();
      }
      if (live.abortRequested) {throw delegatedStartAbortError();}
      if (
        error instanceof HostCustodyFingerprintConflictError ||
        error instanceof HostCustodyUnsupportedError
      ) {throw error;}
      throw new HostCustodyLaunchRejectedError();
    }
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
    live.httpReservation.assertActive();
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
    // A thrown admitted launch cannot itself prove that no process started.
    const spawnStatusBeforeLaunch = live.spawnStatus;
    live.spawnStatus = "ambiguous";
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
    if (this.#runtimeProfile.containmentProfile === "cooperative-darwin-posix-process-group") {
      bindCooperativeProcessGroupGuardian(live.residueAuthority, launched.guardian);
    }
    live.spawnAcknowledgement = acknowledgeProviderSpawn(live, launched.guardian, {
      hostLifecycleGenerationSha256: this.#hostLifecycleGenerationSha256,
      identityObservationAfterMs: this.#identityObservationAfterMs,
      monotonicNow: this.#monotonicNow,
      onStartFailure: () => this.#triggerStartFailureContainment(live),
      processIdentityObserver: this.#processIdentityObserver,
      spawnAcknowledgementAfterMs: this.#spawnAcknowledgementAfterMs,
      spawnAcknowledgementObserver: this.#spawnAcknowledgementObserver,
    });
    return launched.sdkProcess;
  }

  #containSingleFlight(
    live: LiveCustody,
    input: { readonly attemptId: string; readonly custodyRef?: string; readonly operationId: string },
  ): Promise<ContainmentResult> {
    if (live.containment !== undefined) {return live.containment;}
    // Publish single-flight ownership before synchronous abort listeners can reenter.
    const {promise: containment, resolve, reject} = Promise.withResolvers<ContainmentResult>();
    live.containment = containment;
    void this.#contain(live, input).then(resolve, reject);
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
    live.httpReservation.cutoff();
    live.containmentDeadline ??= this.#monotonicNow() + this.#containmentAfterMs;
    try {
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
        containmentAfterMs: this.#containmentAfterMs,
        drainAfterMs: this.#drainAfterMs,
        forceKillAfterMs: this.#forceKillAfterMs,
        hostLifecycleGenerationSha256: this.#hostLifecycleGenerationSha256,
        monotonicNow: this.#monotonicNow,
        terminateAfterMs: this.#terminateAfterMs,
      });
    } finally {
      if (live.fingerprint?.containmentProfile === "cooperative-darwin-posix-process-group" &&
          !isCompleteProvedNoStart(live)) {
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
