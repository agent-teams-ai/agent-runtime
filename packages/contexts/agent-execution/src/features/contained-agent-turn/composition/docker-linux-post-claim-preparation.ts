import {isIssuedCodexAppServerLaunchPlan, type CodexAppServerLaunchPlan} from "../adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import { DockerCustodyHttpReservation } from "./docker-custody-http-reservation.js";
import { createDockerHostHttpResources, type DockerHostHttpResources, type DockerHostHttpListenerResources } from "./docker-host-http-resources.js";
import { createDockerOperationNetworkOwner, type DockerOperationNetworkAllocation } from "./docker-operation-network-owner.js";
import type { ContainedTurnHostPostClaimPreparation } from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";
import { createDockerHostHttpEgressObservers, dockerHostCustodyAttemptKey, dockerHttpOperationNetworkRecipe,
  joinHostHttpEgressV4Observers, DockerHostCustodyLifecycle, awaitNetworkCleanupWork,
  type DockerHttpNetworkResourceInput, type DockerHostCustodyContainerCreateInput,
  type LinuxExclusiveRouteEndpoint, type LinuxExclusiveRouteOwner,
} from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";

type Preparation = ContainedTurnHostPostClaimPreparation;
type Claimed = Parameters<Preparation["prepareClaimed"]>[0];
type Outcome = Awaited<ReturnType<Preparation["prepareClaimed"]>>;
type UnsupportedReason = Extract<Outcome, {kind: "unsupported"}>["reason"];
type LaunchInput = Parameters<DockerHostCustodyLifecycle["launch"]>[0];
type EngineCall = LaunchInput["call"];
type Launched = Awaited<ReturnType<DockerHostCustodyLifecycle["launch"]>>;
type InitOptions = Parameters<Launched["openInitSession"]>[0];
type EngineIdentity = Parameters<typeof dockerHostCustodyAttemptKey>[2];
type EnginePolicy = DockerHttpNetworkResourceInput["engine"]["policy"];
type EngineClient = DockerHttpNetworkResourceInput["engine"]["client"];
type Subject = DockerHttpNetworkResourceInput["subject"];
type ResourceJournal = Parameters<ReturnType<typeof createDockerHostHttpResources>["prepare"]>[0];
type ObservationOwner = ReturnType<typeof createDockerOperationNetworkOwner>["observationOwner"];
type Observers = ReturnType<typeof createDockerHostHttpEgressObservers>;

/** The installed lease's first-write authority, in the exact shape the broker's
 * internal `routeFirstWrite` port takes. It is minted by the admission owner
 * from its own route binding, so no caller can reserve against a binding the
 * lease never installed. */
export type DockerLinuxOperationRouteFirstWrite = Readonly<{
  reserve(requestId: string): Readonly<{consume(): boolean}>;
}>;

/** The last admission gate before provider execution. Only an installed exclusive
 * route lease admits the operation; every other outcome refuses it. The lease
 * owner keeps its own namespace custody, so release is a second method here and
 * never a claim the orchestration can make on its behalf. */
export interface DockerLinuxOperationRouteAdmission {
  admit(input: Readonly<{
    authority: Launched["authority"];
    endpoint: LinuxExclusiveRouteEndpoint;
    signal: AbortSignal;
    deadlineEpochMs: number;
    lifetimeMs: number;
  }>): Promise<
    | Readonly<{kind: "installed"; owner: LinuxExclusiveRouteOwner;
      firstWrite: DockerLinuxOperationRouteFirstWrite}>
    | Readonly<{kind: "unsupported"; reason: "owner"}>>;
  /** Called only after the exact container was proven absent. "none" means no
   * namespace or pinned tool was ever opened for this attempt. */
  releaseAfterContainerRemoval(): Promise<"closed" | "quarantined" | "none">;
}

/** Operation-fixed subject facts owned by the trusted composition root: private
 * V4 resource handles and the scope/observer digests. They are identity, never
 * permission, and never come from the environment or a canary report. */
export type DockerLinuxPostClaimSubjectFacts = Readonly<{
  scopeSha256: string; observerSha256: string;
  networkHandle: string; listenerHandle: string; routeHandle: string;
}>;

export type DockerLinuxPostClaimDeadlines = Readonly<{
  engineIdentityMs: number; allocationMs: number; launchMs: number;
  membershipMs: number; cleanupMs: number; routeMs: number;
  /** Remaining authoritative operation lease handed to the route owner, which
   * spends its own preparation time out of it and never restarts it. */
  routeLifetimeMs: number;
}>;

export type DockerLinuxPostClaimDependencies = Readonly<{
  subjectFacts: DockerLinuxPostClaimSubjectFacts;
  create: DockerHostCustodyContainerCreateInput;
  /** The operation network name is bound by this owner, so the trusted root
   * supplies every other Engine policy field and never the network name. */
  enginePolicy: Omit<EnginePolicy, "allowedNetworkName">;
  engineClient?: EngineClient;
  /** Engine identity is read before the network exists; it must not depend on
   * `allowedNetworkName`, which is exactly what the attempt key regression pins. */
  engineIdentity(call: EngineCall): Promise<EngineIdentity>;
  openLifecycle(policy: EnginePolicy): DockerHostCustodyLifecycle;
  /** Returns an already-opened V4 resource ledger for this subject. Storage,
   * locator and command identity stay with the trusted root. */
  openResourceJournal(input: Readonly<{subject: Subject; observer: ObservationOwner}>): Promise<ResourceJournal>;
  resources: DockerHostHttpListenerResources;
  initOptions: InitOptions;
  hostLifecycleGenerationSha256: string;
  cleanupMilliseconds: number;
  deadlines: DockerLinuxPostClaimDeadlines;
  /** Absent until the route owner is wired. Absence is refused before allocation. */
  routeAdmission?: DockerLinuxOperationRouteAdmission;
  /** Receives the installed lease's first-write authority once, after the ledger
   * observed the installation and before preparation reports success. Absence
   * leaves the broker session without a route cut; a refusal here fails the
   * preparation rather than admitting an unenforced turn. */
  publishRouteFirstWrite?(port: DockerLinuxOperationRouteFirstWrite): void;
}>;

/** The IO owner issues and validates this capability. Composition retains the
 * exact object; it never reconstructs IO or opens a second init session. */
export interface DockerLinuxPreparedProviderIo {
  ready(): ReturnType<ReturnType<Launched["openInitSession"]>["ready"]>;
}
export type DockerLinuxClaimedPreparation = Claimed;
export type DockerLinuxPreparedExecution<Io extends DockerLinuxPreparedProviderIo> = Readonly<{
  launch: Launched; providerIo: Io; plan: CodexAppServerLaunchPlan;
}>;
export type DockerLinuxClaimedJoin<Io extends DockerLinuxPreparedProviderIo> = Readonly<{
  prepareProviderIo(input: Readonly<{claimed: Claimed; launch: Launched; init: InitOptions}>): Io;
  finishClaimed(input: Readonly<{claimed: Claimed; launch: Launched; providerIo: Io;
    http: DockerHostHttpResources; routeFirstWrite: DockerLinuxOperationRouteFirstWrite}>):
    Promise<Readonly<{plan: CodexAppServerLaunchPlan}>>;
}>;
export interface DockerLinuxPostClaimOwner<Io extends DockerLinuxPreparedProviderIo> {
  readonly preparation: Preparation;
  takePrepared(claimed: Claimed): DockerLinuxPreparedExecution<Io>;
  cutoff(): void;
  cleanup(input: Readonly<{deadlineEpochMs: number}>): Promise<Readonly<{kind: "released" | "quarantined"}>>;
}

/** Joined construction requires both external owners before any allocation. */
export const createDockerLinuxPostClaimOwner = <Io extends DockerLinuxPreparedProviderIo>(
  dependencies: DockerLinuxPostClaimDependencies, join: DockerLinuxClaimedJoin<Io>,
): DockerLinuxPostClaimOwner<Io> => {
  if (typeof join?.prepareProviderIo !== "function" || typeof join?.finishClaimed !== "function") {
    throw new TypeError("Docker joined preparation requires IO and finalization owners");
  }
  if (typeof dependencies.engineIdentity !== "function" || typeof dependencies.openLifecycle !== "function" ||
    typeof dependencies.openResourceJournal !== "function" || typeof dependencies.resources?.listenerFor !== "function" ||
    typeof dependencies.resources?.consumption?.prepare !== "function") {
    throw new TypeError("Docker joined preparation requires resource owners");
  }
  return createPreparationOwner(dependencies, Object.freeze({
    prepareProviderIo: join.prepareProviderIo.bind(join), finishClaimed: join.finishClaimed.bind(join),
  }));
};

type Stage = "owner" | "subject" | "lifecycle" | "journal" | "network" | "launch" | "listener"
  | "membership" | "init" | "route";
const REASONS: Readonly<Record<Stage, UnsupportedReason>> = Object.freeze({
  owner: "owner", route: "owner", subject: "network", network: "network", membership: "network",
  journal: "journal", lifecycle: "broker", launch: "broker", listener: "broker", init: "broker",
});
const unsupported = (reason: UnsupportedReason): Outcome => Object.freeze({kind: "unsupported" as const, reason});
const quarantined = (): Outcome => Object.freeze({kind: "quarantined" as const});
const prepared = (): Outcome => Object.freeze({kind: "prepared" as const});

/**
 * Production post-claim preparation for the Docker/Linux Codex route.
 *
 * It orchestrates the order the V4 ledger already encodes: the operation network
 * is allocated from the committed dispatch proof alone, its name reaches
 * `NetworkMode` at create time, the listener binds the gateway Docker assigned,
 * the container joins that network, the authenticated init handshake completes,
 * and only an installed exclusive route admits provider execution.
 *
 * A missing route admission owner is refused before allocation, as the custody
 * contract requires, so a wiring without one performs no Engine effect at all.
 * After the first effect the release order is the reverse of allocation, and
 * anything this owner cannot prove released leaves it quarantined with its
 * ownership retained rather than claiming a clean teardown.
 */
export const createDockerLinuxPostClaimPreparation = (
  dependencies: DockerLinuxPostClaimDependencies,
): Preparation => createPreparationOwner(dependencies).preparation;

const createPreparationOwner = <Io extends DockerLinuxPreparedProviderIo>(
  dependencies: DockerLinuxPostClaimDependencies, join?: DockerLinuxClaimedJoin<Io>,
): DockerLinuxPostClaimOwner<Io> => {
  const deadlines = dependencies.deadlines;
  let entered = false;
  let cut = false;
  let retainedClaim: Claimed | undefined;
  let claimBinding: Readonly<Pick<Claimed, "committedDispatchProof" | "underlyingCustodyRef" | "signal">> | undefined;
  let execution: DockerLinuxPreparedExecution<Io> | undefined;
  let taken = false;
  let cutResources = () => {};
  let cleanupResources: (() => Promise<boolean>) | undefined;
  let cleanupFlight: Promise<boolean> | undefined;
  let preparationFlight: Promise<Outcome> | undefined;
  const cutoff = () => {cut = true; cutResources();};
  const settleResources = () => cleanupFlight ??= Promise.resolve().then(() => cleanupResources?.() ?? true)
    .catch(() => false);
  const prepareClaimed = async (input: Claimed): Promise<Outcome> => {
    if (entered) {return unsupported("owner");}
    entered = true;
    retainedClaim = input;
    claimBinding = Object.freeze({committedDispatchProof: input.committedDispatchProof,
      underlyingCustodyRef: input.underlyingCustodyRef, signal: input.signal});
    // A missing authority owner must be refused before allocation, so this is
    // read before the first Engine call and before the ledger is opened.
    const routeAdmission = dependencies.routeAdmission;
    if (typeof routeAdmission?.admit !== "function" || typeof routeAdmission?.releaseAfterContainerRemoval !== "function" ||
      cut || input.signal.aborted) {return unsupported("owner");}

    const call = (milliseconds: number): EngineCall =>
      Object.freeze({signal: input.signal, deadlineEpochMs: Date.now() + milliseconds});
    // Release is not admission: an irreversible caller cutoff must not stop the
    // Engine and journal work that proves these resources actually went away.
    const cleanupCall = (): EngineCall =>
      Object.freeze({signal: new AbortController().signal, deadlineEpochMs: Date.now() + deadlines.cleanupMs});
    let stage: Stage = "subject";
    let network: ReturnType<typeof createDockerOperationNetworkOwner> | undefined;
    let observers: Observers | undefined;
    let journal: ResourceJournal | undefined;
    let allocated: DockerOperationNetworkAllocation | undefined;
    let networkAttempted = false;
    let lifecycle: DockerHostCustodyLifecycle | undefined;
    let launched: Launched | undefined;
    let launchAttempted = false;
    let routeAttempted = false;
    let routeInstalled = false;
    let routeOwner: LinuxExclusiveRouteOwner | undefined;
    let product: ReturnType<typeof createDockerHostHttpResources> | undefined;

    cutResources = () => {
      try {product?.cutoff();} finally {
        try {network?.cutoff();} finally {routeOwner?.revoke();}
      }
    };

    /** Release in the reverse of allocation, in the order the ledger encodes:
     * local admission is cut and observed, the exact container is contained and
     * proven absent, the route lease releases its namespace, then the listener
     * endpoint, then the operation network. Anything this cannot prove keeps its
     * ownership and quarantines instead of reporting a clean refusal. */
    const proveCutoff = async (): Promise<boolean> => {
      let proven = true;
      try {if (routeOwner?.revoke() === "quarantined") {proven = false;}} catch {proven = false;}
      try {product?.cutoff();} catch {proven = false;}
      try {network?.cutoff();} catch {proven = false;}
      if (network === undefined || observers === undefined || journal === undefined) {return proven;}
      return observers.observeCutoff(network.signal, product?.listener ?? null).then(() => proven, () => false);
    };
    const proveContainerAbsent = async (): Promise<boolean> => {
      if (!launchAttempted) {return true;}
      // A launch that never returned an authority leaves no handle to contain;
      // its fate belongs to the lifecycle's own fencing, not to a claim here.
      if (launched === undefined || lifecycle === undefined || observers === undefined) {return false;}
      const token = await lifecycle.removalObservation
        .containAndObserve({authority: launched.authority, key: launched.key, call: cleanupCall()})
        .then(issued => issued ?? null, () => null);
      if (token === null) {return false;}
      return observers.observeContainerAbsent(token).then(() => true, () => false);
    };
    const proveListenerAbsent = async (): Promise<boolean> => {
      if (product === undefined) {return true;}
      const released = await product.cleanupResources(Date.now() + deadlines.cleanupMs).catch(() => false);
      const readback = product.listener;
      if (!released || readback === undefined || observers === undefined) {return false;}
      return observers.observeListenerAbsent(readback).then(() => true, () => false);
    };
    cleanupResources = async (): Promise<boolean> => {
      // An acknowledged route intent without an observed installation may still
      // have left a kernel table behind; that is uncertainty, not a refusal.
      let proven = !routeAttempted || routeInstalled;
      proven = await proveCutoff() && proven;
      const containerAbsent = await proveContainerAbsent();
      proven = containerAbsent && proven;
      if (routeAttempted && containerAbsent) {
        const released = await routeAdmission.releaseAfterContainerRemoval().catch(() => "quarantined" as const);
        proven = released !== "quarantined" && proven;
      }
      proven = await proveListenerAbsent() && proven;
      if (networkAttempted) {
        const removed = await network?.cleanupNetwork().catch(() => "unknown" as const);
        proven = removed === "absent" && proven;
      }
      return proven;
    };
    const settle = async (reason: UnsupportedReason): Promise<Outcome> => {
      try {cutoff();} catch { /* Continue retained cleanup after failed admission cut. */ }
      return await settleResources() ? unsupported(reason) : quarantined();
    };

    // Irreversible caller cutoff is honored between every step, so a cut signal
    // can never let the next resource effect start.
    const assertOpen = (): void => {
      if (cut || input.signal.aborted) {throw new TypeError("Host post-claim preparation was cut off");}
    };
    try {
      const proof = input.committedDispatchProof;
      const owner: LaunchInput["owner"] = Object.freeze({tenantId: proof.tenantId, projectId: proof.projectId,
        operationId: proof.operationId, attemptId: proof.attemptId, custodyId: proof.custodyId,
        hostInstanceId: proof.hostInstanceId, hostBootId: proof.hostBootId});
      const create = dependencies.create;
      const identity = await dependencies.engineIdentity(call(deadlines.engineIdentityMs));
      const subject: Subject = Object.freeze({
        attempt: dockerHostCustodyAttemptKey(owner, create, identity),
        effectId: proof.effectId, workspaceId: proof.workspaceId, executionGenerationId: proof.executionGenerationId,
        committedClaimSha256: proof.proofDigest.slice(7), acceptedAuthoritySha256: proof.acceptedAuthorityVectorDigest.slice(7),
        scopeSha256: dependencies.subjectFacts.scopeSha256, observerSha256: dependencies.subjectFacts.observerSha256,
        imageDigest: create.imageDigest, networkHandle: dependencies.subjectFacts.networkHandle,
        listenerHandle: dependencies.subjectFacts.listenerHandle, routeHandle: dependencies.subjectFacts.routeHandle,
      });
      const recipe = dockerHttpOperationNetworkRecipe(subject);
      const policy: EnginePolicy = Object.freeze({...dependencies.enginePolicy, allowedNetworkName: recipe.name});
      const engine = dependencies.engineClient === undefined
        ? Object.freeze({policy}) : Object.freeze({policy, client: dependencies.engineClient});
      network = createDockerOperationNetworkOwner({subject, engine, cleanupMilliseconds: dependencies.cleanupMilliseconds});
      const claim: Parameters<NonNullable<typeof network>["allocate"]>[1] = Object.freeze({...owner,
        effectId: subject.effectId, workspaceId: subject.workspaceId,
        executionGenerationId: subject.executionGenerationId,
        committedClaimSha256: subject.committedClaimSha256, acceptedAuthoritySha256: subject.acceptedAuthoritySha256});

      assertOpen();

      // Construction performs no effect, and the removal observation owner it
      // holds is the only issuer of this attempt's exact container absence.
      stage = "lifecycle";
      lifecycle = dependencies.openLifecycle(policy);
      observers = createDockerHostHttpEgressObservers({subject, removal: lifecycle.removalObservation});

      assertOpen();

      // The ledger accepts exactly one observation owner, so the network/Engine
      // owner and the Host-side issuers are joined before it is opened.
      stage = "journal";
      journal = await dependencies.openResourceJournal({subject,
        observer: joinHostHttpEgressV4Observers([network.observationOwner, observers.observationOwner])});
      observers.bind(journal);

      assertOpen();

      stage = "network";
      networkAttempted = true;
      allocated = await network.allocate(journal, claim, call(deadlines.allocationMs));

      assertOpen();

      stage = "launch";
      const launchCall = call(deadlines.launchMs);
      launchAttempted = true;
      launched = await lifecycle.launch({call: launchCall, create, owner});

      assertOpen();

      stage = "listener";
      const reservation = new DockerCustodyHttpReservation({lifecycle, launch: launched,
        hostLifecycleGenerationSha256: dependencies.hostLifecycleGenerationSha256, claimed: input});
      product = createDockerHostHttpResources({host: reservation, network, allocated,
        hostLifecycleGenerationSha256: dependencies.hostLifecycleGenerationSha256});
      const listener = await product.prepare(journal, input, dependencies.resources);
      if (listener.kind !== "prepared" || product.listener === undefined) {
        throw new TypeError("Host HTTP listener preparation is unproven");
      }
      // The endpoint the kernel actually bound is published by its own retained
      // recipe; only then may the container be observed as a network member.
      await observers.observeListener(product.listener, listener.address);
      assertOpen();

      // The authenticated handshake runs over the retained attach channel, not
      // over the operation network, so it is ordered before membership. The V4
      // ledger constrains only the resource axis and says nothing about it.
      stage = "init";
      const providerIo = join?.prepareProviderIo(Object.freeze({claimed: input, launch: launched, init: dependencies.initOptions}));
      const ready = await (join === undefined ? launched.openInitSession(dependencies.initOptions) : providerIo!).ready();
      if (ready.kind !== "ready") {throw new TypeError("Docker authenticated init readiness is unproven");}
      assertOpen();

      stage = "membership";
      await product.observeContainer(launched.authority, call(deadlines.membershipMs));
      assertOpen();

      // The route owner is the last admission gate before provider execution.
      // A fresh acknowledged intent is recorded first: it is the only permission
      // to attempt the kernel effect, and an unobserved attempt stays uncertain.
      stage = "route";
      const endpoint = Object.freeze({address: listener.address.address, port: listener.address.port});
      await observers.recordRouteIntent();
      routeAttempted = true;
      const admitted = await routeAdmission.admit({authority: launched.authority, endpoint,
        signal: input.signal, deadlineEpochMs: Date.now() + deadlines.routeMs,
        lifetimeMs: deadlines.routeLifetimeMs});
      if (admitted.kind !== "installed") {return await settle(admitted.reason);}
      routeOwner = admitted.owner;
      await observers.observeRouteInstalled(admitted.owner, endpoint);
      routeInstalled = true;
      // The broker's first-write gate is handed over only after the ledger has
      // observed the installation, so no session can hold an unobserved lease.
      assertOpen();
      if (join !== undefined) {
        const final = await join.finishClaimed(Object.freeze({claimed: input, launch: launched,
          providerIo: providerIo!, http: product, routeFirstWrite: admitted.firstWrite}));
        assertOpen();
        if (!isIssuedCodexAppServerLaunchPlan(final.plan)) {throw new TypeError("Docker final plan is not issued");}
        execution = Object.freeze({launch: launched, providerIo: providerIo!, plan: final.plan});
      } else {dependencies.publishRouteFirstWrite?.(admitted.firstWrite);}
      assertOpen();
      return prepared();
    } catch {
      return await settle(REASONS[stage]);
    }
  };
  const preparation: Preparation = Object.freeze({prepareClaimed(input: Claimed) {
    if (preparationFlight !== undefined) {return Promise.resolve(unsupported("owner"));}
    // Defer entry until the flight is retained, including reentrant callbacks.
    preparationFlight = Promise.resolve().then(() => prepareClaimed(input));
    return preparationFlight;
  }});
  return Object.freeze({preparation, cutoff,
    takePrepared(claimed: Claimed) {
      if (cut || taken || execution === undefined || claimed !== retainedClaim ||
        claimed.committedDispatchProof !== claimBinding?.committedDispatchProof ||
        claimed.underlyingCustodyRef !== claimBinding?.underlyingCustodyRef ||
        claimed.signal !== claimBinding?.signal || claimed.signal.aborted) {
        throw new TypeError("Docker prepared handoff unavailable or conflicts");
      }
      taken = true;
      return execution;
    },
    async cleanup(input: Readonly<{deadlineEpochMs: number}>) {
      try {cutoff();} catch { /* Cleanup still owns every retained slot. */ }
      const work = (preparationFlight ?? Promise.resolve()).then(() => settleResources());
      try {
        if (!Number.isSafeInteger(input.deadlineEpochMs)) {throw new TypeError("Invalid cleanup deadline");}
        await awaitNetworkCleanupWork(work, {signal: new AbortController().signal, deadlineEpochMs: input.deadlineEpochMs});
        return Object.freeze({kind: await work ? "released" as const : "quarantined" as const});
      } catch {return Object.freeze({kind: "quarantined" as const});}
    },
  });
};
