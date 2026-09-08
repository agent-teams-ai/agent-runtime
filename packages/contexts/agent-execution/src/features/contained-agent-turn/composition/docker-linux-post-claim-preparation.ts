import {DockerConsumptionObservations} from "./docker-consumption-observations.js";
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
  captureHost?(): Promise<Readonly<{create: DockerHostCustodyContainerCreateInput; hostLifecycleGenerationSha256: string}>>;
  beforeLaunch?(input: Readonly<{identity: EngineIdentity; policy: EnginePolicy}>): Promise<NonNullable<LaunchInput["imageInit"]>>;
  afterInit?(input: Readonly<{claimed: Claimed; launch: Launched}>): Promise<void>;
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
const finishInitReadiness = async (ready: Promise<Readonly<{kind: string}>>, afterReady: () => Promise<void> | undefined,
  assertOpen: () => void): Promise<void> => {
  if ((await ready).kind !== "ready") {throw new TypeError("Docker authenticated init readiness is unproven");}
  assertOpen();
  await afterReady();
  assertOpen();
};

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
    ...(join.afterInit === undefined ? {} : {afterInit: join.afterInit.bind(join)}),
    ...(join.captureHost === undefined ? {} : {captureHost: join.captureHost.bind(join)}),
    ...(join.beforeLaunch === undefined ? {} : {beforeLaunch: join.beforeLaunch.bind(join)}),
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

type PreparationResources = {
  network: ReturnType<typeof createDockerOperationNetworkOwner> | undefined;
  observers: Observers | undefined;
  journal: ResourceJournal | undefined;
  allocated: DockerOperationNetworkAllocation | undefined;
  networkAttempted: boolean;
  lifecycle: DockerHostCustodyLifecycle | undefined;
  launched: Launched | undefined;
  launchAttempted: boolean;
  launchKey: Launched["key"] | undefined;
  routeAttempted: boolean;
  routeInstalled: boolean;
  routeOwner: LinuxExclusiveRouteOwner | undefined;
  product: ReturnType<typeof createDockerHostHttpResources> | undefined;
};

const createPreparationResources = (): PreparationResources => ({
  network: undefined, observers: undefined, journal: undefined, allocated: undefined,
  networkAttempted: false, lifecycle: undefined, launched: undefined,
  launchAttempted: false, launchKey: undefined, routeAttempted: false,
  routeInstalled: false, routeOwner: undefined, product: undefined,
});

/** Host capture and image selection run inside the retained preparation flight.
 * The caller checks admission again after each operation before any effect. */
const createHostLaunchPreparation = <Io extends DockerLinuxPreparedProviderIo>(
  dependencies: DockerLinuxPostClaimDependencies, join: DockerLinuxClaimedJoin<Io> | undefined,
  assertOpen: () => void,
) => ({
  async captureHost(proof: Claimed["committedDispatchProof"]) {
    const owner: LaunchInput["owner"] = Object.freeze({tenantId: proof.tenantId, projectId: proof.projectId,
      operationId: proof.operationId, attemptId: proof.attemptId, custodyId: proof.custodyId,
      hostInstanceId: proof.hostInstanceId, hostBootId: proof.hostBootId});
    assertOpen();
    const host = await join?.captureHost?.();
    assertOpen();
    return {owner, create: host?.create ?? dependencies.create,
      hostLifecycleGenerationSha256: host?.hostLifecycleGenerationSha256 ?? dependencies.hostLifecycleGenerationSha256};
  },
  async beforeLaunch(input: Readonly<{identity: EngineIdentity; policy: EnginePolicy}>, call: EngineCall) {
    const imageInit = await join?.beforeLaunch?.(input);
    assertOpen();
    return {call, ...(imageInit === undefined ? {} : {imageInit})};
  },
});

const prepareOperationNetwork = (
  dependencies: DockerLinuxPostClaimDependencies, resources: PreparationResources,
  input: Readonly<{proof: Claimed["committedDispatchProof"]; owner: LaunchInput["owner"];
    create: DockerHostCustodyContainerCreateInput; identity: EngineIdentity}>,
) => {
  const {proof, owner, create, identity} = input;
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
  resources.network = createDockerOperationNetworkOwner({subject, engine, cleanupMilliseconds: dependencies.cleanupMilliseconds});
  const claim: Parameters<NonNullable<typeof resources.network>["allocate"]>[1] = Object.freeze({...owner,
    effectId: subject.effectId, workspaceId: subject.workspaceId,
    executionGenerationId: subject.executionGenerationId,
    committedClaimSha256: subject.committedClaimSha256, acceptedAuthoritySha256: subject.acceptedAuthoritySha256});
  return {subject, policy, claim, network: resources.network};
};

const createResourceCutoff = (resources: PreparationResources): (() => void) => () => {
  try {resources.product?.cutoff();} finally {
    try {resources.network?.cutoff();} finally {resources.routeOwner?.revoke();}
  }
};

const createResourceCleanup = (
  resources: PreparationResources,
  input: Readonly<{routeAdmission: DockerLinuxOperationRouteAdmission; cleanupCall(): EngineCall;
    cleanupMs: number; observationDeadline: number}>,
): (() => Promise<boolean>) => {
  const {routeAdmission, cleanupCall, cleanupMs, observationDeadline} = input;
  // Only acknowledged proofs survive a failed attempt. Replaying a successful
  // observation with a changed target is not fresh V4 evidence.
  const retainProof = (prove: () => Promise<boolean>): (() => Promise<boolean>) => {
    let proven = false;
    return async () => {
      if (proven) {return true;}
      if (!Number.isSafeInteger(observationDeadline) || Date.now() >= observationDeadline) {return false;}
      proven = await prove();
      return proven;
    };
  };
  /** Release in the reverse of allocation, in the order the ledger encodes:
   * local admission is cut and observed, the exact container is contained and
   * proven absent, the route lease releases its namespace, then the listener
   * endpoint, then the operation network. Anything this cannot prove keeps its
   * ownership and quarantines instead of reporting a clean refusal. */
  const proveCutoff = retainProof(async (): Promise<boolean> => {
    let proven = true;
    try {if (resources.routeOwner?.revoke() === "quarantined") {proven = false;}} catch {proven = false;}
    try {resources.product?.cutoff();} catch {proven = false;}
    try {resources.network?.cutoff();} catch {proven = false;}
    if (resources.network === undefined || resources.observers === undefined || resources.journal === undefined) {return proven;}
    return resources.observers.observeCutoff(resources.network.signal, resources.product?.listener ?? null).then(() => proven, () => false);
  });
  const proveContainerAbsent = retainProof(async (): Promise<boolean> => {
    if (!resources.launchAttempted) {
      if (!resources.networkAttempted) {return true;}
      if (resources.lifecycle === undefined || resources.observers === undefined || resources.launchKey === undefined) {return false;}
      const token = await resources.lifecycle.removalObservation
        .observeNoCreation({key: resources.launchKey, call: cleanupCall()})
        .catch(() => null);
      if (token === undefined || token === null) {return false;}
      return resources.observers.observeContainerAbsent(token).then(() => true, () => false);
    }
    if (resources.lifecycle === undefined || resources.observers === undefined || resources.launchKey === undefined) {return false;}
    // A late start acknowledgement can cross cutoff before launch publication.
    // Only the lifecycle's retained exact identity can support cleanup then.
    const authority = resources.launched?.authority ?? resources.lifecycle.retainedAuthority(resources.launchKey);
    if (authority === undefined) {return false;}
    const token = await resources.lifecycle.removalObservation
      .containAndObserve({authority, key: resources.launchKey, call: cleanupCall()})
      .then(issued => issued ?? null, () => null);
    if (token === null) {return false;}
    return resources.observers.observeContainerAbsent(token).then(() => true, () => false);
  });
  const proveListenerAbsent = retainProof(async (): Promise<boolean> => {
    if (resources.product === undefined) {return true;}
    const released = await resources.product.cleanupResources(Math.min(observationDeadline, Date.now() + cleanupMs))
      .catch(() => false);
    const readback = resources.product.listener;
    if (!released || readback === undefined || resources.observers === undefined) {return false;}
    return resources.observers.observeListenerAbsent(readback).then(() => true, () => false);
  });
  const releaseRoute = retainProof(async () =>
    await routeAdmission.releaseAfterContainerRemoval().catch(() => "quarantined" as const) !== "quarantined");
  return async (): Promise<boolean> => {
    // An acknowledged route intent without an observed installation may still
    // have left a kernel table behind; that is uncertainty, not a refusal.
    let proven = !resources.routeAttempted || resources.routeInstalled;
    proven = await proveCutoff() && proven;
    const containerAbsent = await proveContainerAbsent();
    proven = containerAbsent && proven;
    if (resources.routeAttempted && containerAbsent) {
      proven = await releaseRoute() && proven;
    }
    proven = await proveListenerAbsent() && proven;
    if (resources.networkAttempted) {
      if (Date.now() >= observationDeadline) {return false;}
      const removed = await resources.network?.cleanupNetwork().catch(() => "unknown" as const);
      proven = removed === "absent" && proven;
    }
    return proven;
  };
};

/** Keep one retained cleanup flight; only a settled failure can be retried. */
const createCleanupSettlement = (cleanup: () => boolean | Promise<boolean>,
  observationAbort: AbortController, observationDeadline: number): (() => Promise<boolean>) => {
  let cleanupFlight: Promise<boolean> | undefined;
  return (): Promise<boolean> => {
    if (cleanupFlight !== undefined) {return cleanupFlight;}
    cleanupFlight = Promise.resolve().then(() => {
      if (!Number.isSafeInteger(observationDeadline) || Date.now() >= observationDeadline) {return false;}
      return cleanup();
    }).catch(() => false).then(proven => {
      if (proven) {observationAbort.abort();}
      else {cleanupFlight = undefined;}
      return proven;
    });
    return cleanupFlight;
  };
};

const awaitPreparationCleanup = async (deadlineEpochMs: number, preparationFlight: Promise<Outcome> | undefined,
  settleResources: () => Promise<boolean>): Promise<Readonly<{kind: "released" | "quarantined"}>> => {
  try {
    if (!Number.isSafeInteger(deadlineEpochMs) || Date.now() >= deadlineEpochMs) {
      throw new TypeError("Invalid cleanup deadline");
    }
    const work = (preparationFlight ?? Promise.resolve()).then(() => {
      if (Date.now() >= deadlineEpochMs) {return false;}
      return settleResources();
    });
    await awaitNetworkCleanupWork(work, {signal: new AbortController().signal, deadlineEpochMs});
    return Object.freeze({kind: await work ? "released" as const : "quarantined" as const});
  } catch {return Object.freeze({kind: "quarantined" as const});}
};

const assertPreparationOpen = (cut: boolean, signal: AbortSignal, deadline: number): void => {
  if (cut || signal.aborted || Date.now() >= deadline) {throw new TypeError("Host post-claim preparation was cut off");}
};

const createFailureSettlement = (cutoff: () => void, settleResources: () => Promise<boolean>) =>
  async (reason: UnsupportedReason): Promise<Outcome> => {
    try {cutoff();} catch { /* Retained cleanup still runs after a failed cutoff. */ }
    return await settleResources() ? unsupported(reason) : quarantined();
  };

const createPreparationCalls = (input: Claimed, admissionAbort: AbortController,
  admissionDeadline: number, observationAbort: AbortController, observation: Readonly<{deadline: number; cleanupMs: number}>) => {
  const observationDeadline = observation.deadline;
    const call = (milliseconds: number): EngineCall =>
      Object.freeze({signal: AbortSignal.any([input.signal, admissionAbort.signal]),
        deadlineEpochMs: Math.min(admissionDeadline, Date.now() + milliseconds)});
    // Release is not admission: an irreversible caller cutoff must not stop the
    // Engine and journal work that proves these resources actually went away.
    const cleanupCall = (): EngineCall =>
      Object.freeze({signal: observationAbort.signal,
        deadlineEpochMs: Math.min(observationDeadline, Date.now() + observation.cleanupMs)});
  return {call, cleanupCall};
};

const createPreparationOwner = <Io extends DockerLinuxPreparedProviderIo>(
  dependencies: DockerLinuxPostClaimDependencies, join?: DockerLinuxClaimedJoin<Io>,
): DockerLinuxPostClaimOwner<Io> => {
  const deadlines = Object.freeze({...dependencies.deadlines});
  // Capture the supplied remaining operation lease once; no stage can renew it.
  const admissionDeadline = Date.now() + deadlines.routeLifetimeMs;
  const admissionAbort = new AbortController();
  const observationAbort = new AbortController();
  const observationDeadline = admissionDeadline + deadlines.cleanupMs;
  let entered = false;
  let cut = false;
  let retainedClaim: Claimed | undefined;
  let claimBinding: Readonly<Pick<Claimed, "committedDispatchProof" | "underlyingCustodyRef" | "signal">> | undefined;
  let execution: DockerLinuxPreparedExecution<Io> | undefined;
  let taken = false;
  let cutResources: (() => void) | undefined;
  let cleanupResources: (() => Promise<boolean>) | undefined;
  let preparationFlight: Promise<Outcome> | undefined;
  const cutoff = () => {cut = true; admissionAbort.abort(); cutResources?.();};
  const settleResources = createCleanupSettlement(() => cleanupResources?.() ?? true, observationAbort, observationDeadline);
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

    const {call, cleanupCall} = createPreparationCalls(input, admissionAbort,
      admissionDeadline, observationAbort, {deadline: observationDeadline, cleanupMs: deadlines.cleanupMs});
    let stage: Stage = "subject";
    const resources = createPreparationResources();

    cutResources = createResourceCutoff(resources);
    cleanupResources = createResourceCleanup(resources, {routeAdmission, cleanupCall,
      cleanupMs: deadlines.cleanupMs, observationDeadline});

    const settle = createFailureSettlement(cutoff, settleResources);

    // Irreversible caller cutoff is honored between every step, so a cut signal
    // can never let the next resource effect start.
    const assertOpen = (): void => assertPreparationOpen(cut, input.signal, admissionDeadline);
    const hostPreparation = createHostLaunchPreparation(dependencies, join, assertOpen);
    try {
      const proof = input.committedDispatchProof;
      const {owner, create, hostLifecycleGenerationSha256} = await hostPreparation.captureHost(proof);
      assertOpen();
      const identity = await dependencies.engineIdentity(call(deadlines.engineIdentityMs));
      const {subject, policy, claim, network} = prepareOperationNetwork(dependencies, resources, {proof, owner, create, identity});

      assertOpen();

      // Construction performs no effect, and the removal observation owner it
      // holds is the only issuer of this attempt's exact container absence.
      stage = "lifecycle";
      resources.lifecycle = dependencies.openLifecycle(policy);
      resources.launchKey = subject.attempt;
      resources.observers = createDockerHostHttpEgressObservers({subject, removal: resources.lifecycle.removalObservation});

      assertOpen();

      // The ledger accepts exactly one observation owner, so the network/Engine
      // owner and the Host-side issuers are joined before it is opened.
      stage = "journal";
      resources.journal = await dependencies.openResourceJournal({subject,
        observer: joinHostHttpEgressV4Observers([network.observationOwner, resources.observers.observationOwner])});
      resources.observers.bind(resources.journal);

      assertOpen();

      stage = "network";
      resources.networkAttempted = true;
      resources.allocated = await network.allocate(resources.journal, claim, call(deadlines.allocationMs));

      assertOpen();

      stage = "launch";
      const launch = await hostPreparation.beforeLaunch({identity, policy}, call(deadlines.launchMs));
      assertOpen();
      resources.launchAttempted = true;
      resources.launched = await resources.lifecycle.launch({...launch, create, owner, lifetime: {
        admission: {signal: AbortSignal.any([input.signal, admissionAbort.signal]), deadlineEpochMs: admissionDeadline},
        observation: {signal: observationAbort.signal, deadlineEpochMs: observationDeadline,
          isActive: () => !observationAbort.signal.aborted && Date.now() < observationDeadline},
      }});

      assertOpen();

      stage = "listener";
      const reservation = new DockerCustodyHttpReservation({lifecycle: resources.lifecycle, launch: resources.launched,
        hostLifecycleGenerationSha256, claimed: input});
      resources.product = createDockerHostHttpResources({host: reservation, network, allocated: resources.allocated,
        hostLifecycleGenerationSha256});
      const product = resources.product;
      const launched = resources.launched;
      const lifecycle = resources.lifecycle;
      const observers = resources.observers;
      let providerIo: Io | undefined;
      let routeFirstWrite: DockerLinuxOperationRouteFirstWrite | undefined;
      const listener = await product.prepare(resources.journal, input, dependencies.resources, async address => {
        // Throw only: settlement waits for this same Host preparation flight.
        assertOpen();
        // The endpoint the kernel actually bound is published by its own retained
        // recipe; only then may the container be observed as a network member.
        await observers.observeListener(product.listener!, address);
        assertOpen();

        // The authenticated handshake runs over the retained attach channel, not
        // over the operation network, so it is ordered before membership. The V4
        // ledger constrains only the resource axis and says nothing about it.
        stage = "init";
        providerIo = join?.prepareProviderIo(Object.freeze({claimed: input, launch: launched, init: dependencies.initOptions}));
        await finishInitReadiness((join === undefined ? launched.openInitSession(dependencies.initOptions) : providerIo!).ready(),
          () => join?.afterInit?.(Object.freeze({claimed: input, launch: launched})), assertOpen);

        stage = "membership";
        await product.observeContainer(launched.authority, call(deadlines.membershipMs));
        assertOpen();

        // The route owner is the last admission gate before provider execution.
        // A fresh acknowledged intent is recorded first: it is the only permission
        // to attempt the kernel effect, and an unobserved attempt stays uncertain.
        stage = "route";
        const endpoint = Object.freeze({address: address.address, port: address.port});
        await observers.recordRouteIntent();
        resources.routeAttempted = true;
        const admitted = await routeAdmission.admit({authority: launched.authority, endpoint,
          ...call(deadlines.routeMs),
          lifetimeMs: Math.max(0, admissionDeadline - Date.now())});
        if (admitted.kind !== "installed") {throw new TypeError("Docker exclusive route admission refused");}
        resources.routeOwner = admitted.owner;
        await observers.observeRouteInstalled(admitted.owner, endpoint);
        resources.routeInstalled = true;
        routeFirstWrite = admitted.firstWrite;
        assertOpen();
        const references = await DockerConsumptionObservations.read(lifecycle, launched, admitted.owner, endpoint,
          call(deadlines.membershipMs));
        assertOpen();
        stage = "listener";
        return references;
      });
      if (listener.kind !== "prepared" || routeFirstWrite === undefined) {
        throw new TypeError("Host HTTP consumption preparation is unproven");
      }
      // Publication is after ready consumption as well as observed route installation.
      assertOpen();
      if (join !== undefined) {
        const final = await join.finishClaimed(Object.freeze({claimed: input, launch: resources.launched,
          providerIo: providerIo!, http: resources.product, routeFirstWrite}));
        assertOpen();
        if (!isIssuedCodexAppServerLaunchPlan(final.plan)) {throw new TypeError("Docker final plan is not issued");}
        execution = Object.freeze({launch: resources.launched, providerIo: providerIo!, plan: final.plan});
      } else {dependencies.publishRouteFirstWrite?.(routeFirstWrite);}
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
      return awaitPreparationCleanup(input.deadlineEpochMs, preparationFlight, settleResources);
    },
  });
};
