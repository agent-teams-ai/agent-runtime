import { DockerCustodyHttpReservation } from "./docker-custody-http-reservation.js";
import { createDockerHostHttpResources, type DockerHostHttpListenerResources } from "./docker-host-http-resources.js";
import { createDockerOperationNetworkOwner, type DockerOperationNetworkAllocation } from "./docker-operation-network-owner.js";
import type { ContainedTurnHostPostClaimPreparation } from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";
import { dockerHostCustodyAttemptKey, dockerHttpOperationNetworkRecipe, DockerHostCustodyLifecycle,
  type DockerHttpNetworkResourceInput, type DockerHostCustodyContainerCreateInput,
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

/** Step 8 of the route-enforcement plan. The Linux exclusive route owner is not
 * joined here: this seam can therefore report only its own absence, and no
 * caller-supplied double can widen that result into route-enforcement evidence.
 * When `openNodeLinuxExclusiveRoute` is wired, this port gains an "installed"
 * outcome and only then can `prepareClaimed` return prepared. */
export interface DockerLinuxOperationRouteAdmission {
  admit(input: Readonly<{
    authority: Launched["authority"];
    endpoint: Readonly<{address: string; port: number}>;
    signal: AbortSignal;
    deadlineEpochMs: number;
  }>): Promise<Readonly<{kind: "unsupported"; reason: "owner"}>>;
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
  membershipMs: number; cleanupMs: number;
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
}>;

type Stage = "owner" | "subject" | "journal" | "network" | "launch" | "listener" | "membership" | "init" | "route";
const REASONS: Readonly<Record<Stage, UnsupportedReason>> = Object.freeze({
  owner: "owner", route: "owner", subject: "network", network: "network", membership: "network",
  journal: "journal", launch: "broker", listener: "broker", init: "broker",
});
const unsupported = (reason: UnsupportedReason): Outcome => Object.freeze({kind: "unsupported" as const, reason});
const quarantined = (): Outcome => Object.freeze({kind: "quarantined" as const});

/**
 * Production post-claim preparation for the Docker/Linux Codex route.
 *
 * It orchestrates the order the V4 ledger already encodes: the operation network
 * is allocated from the committed dispatch proof alone, its name reaches
 * `NetworkMode` at create time, the listener binds the gateway Docker assigned,
 * the container joins that network, and the authenticated init handshake
 * completes before any provider execution is possible.
 *
 * Nothing here can return prepared yet: step 8, the Linux exclusive route owner,
 * has no implementation on this revision. A missing route admission owner is
 * refused before allocation, as the custody contract requires, so the default
 * production wiring performs no Engine effect at all. Once an effect exists and
 * its release cannot be proven, this owner reports quarantined and keeps
 * ownership rather than claiming a clean teardown.
 */
export const createDockerLinuxPostClaimPreparation = (
  dependencies: DockerLinuxPostClaimDependencies,
): Preparation => {
  const deadlines = dependencies.deadlines;
  let entered = false;
  const prepareClaimed = async (input: Claimed): Promise<Outcome> => {
    if (entered) {return unsupported("owner");}
    entered = true;
    // A missing authority owner must be refused before allocation, so this is
    // read before the first Engine call and before the ledger is opened.
    const routeAdmission = dependencies.routeAdmission;
    if (routeAdmission === undefined || input.signal.aborted) {return unsupported("owner");}

    const call = (milliseconds: number): EngineCall =>
      Object.freeze({signal: input.signal, deadlineEpochMs: Date.now() + milliseconds});
    let stage: Stage = "subject";
    let network: ReturnType<typeof createDockerOperationNetworkOwner> | undefined;
    let allocated: DockerOperationNetworkAllocation | undefined;
    let networkAttempted = false;
    let lifecycle: DockerHostCustodyLifecycle | undefined;
    let launched: Launched | undefined;
    let launchAttempted = false;
    let product: ReturnType<typeof createDockerHostHttpResources> | undefined;

    /** Release in the reverse of allocation: listener and session, then the
     * container, then the network. Anything this cannot prove absent keeps its
     * ownership and quarantines instead of reporting a clean refusal. */
    const settle = async (reason: UnsupportedReason): Promise<Outcome> => {
      let indeterminate = false;
      try {product?.cutoff();} catch {indeterminate = true;}
      try {network?.cutoff();} catch {indeterminate = true;}
      if (product !== undefined) {
        const released = await product.cleanupResources(Date.now() + deadlines.cleanupMs).catch(() => false);
        if (!released) {indeterminate = true;}
      }
      if (launchAttempted) {
        // A launch that never returned an authority leaves no handle to contain;
        // its fate belongs to the lifecycle's own fencing, not to a claim here.
        const contained = launched === undefined || lifecycle === undefined ? null : await lifecycle
          .contain({authority: launched.authority, key: launched.key, call: call(deadlines.cleanupMs)})
          .catch(() => null);
        if (contained?.kind !== "closed") {indeterminate = true;}
      }
      if (networkAttempted) {
        const removed = await network?.cleanupNetwork().catch(() => "unknown" as const);
        if (removed !== "absent") {indeterminate = true;}
      }
      return indeterminate ? quarantined() : unsupported(reason);
    };

    // Irreversible caller cutoff is honored between every step, so a cut signal
    // can never let the next resource effect start.
    const assertOpen = (): void => {
      if (input.signal.aborted) {throw new TypeError("Host post-claim preparation was cut off");}
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

      stage = "journal";
      const journal = await dependencies.openResourceJournal({subject, observer: network.observationOwner});

      assertOpen();

      stage = "network";
      networkAttempted = true;
      allocated = await network.allocate(journal, claim, call(deadlines.allocationMs));

      assertOpen();

      stage = "launch";
      lifecycle = dependencies.openLifecycle(policy);
      const launchCall = call(deadlines.launchMs);
      launchAttempted = true;
      launched = await lifecycle.launch({call: launchCall, create, owner});

      assertOpen();

      stage = "listener";
      const reservation = new DockerCustodyHttpReservation({lifecycle, launch: launched,
        hostLifecycleGenerationSha256: dependencies.hostLifecycleGenerationSha256, claimed: input});
      product = createDockerHostHttpResources({host: reservation, network, allocated,
        hostLifecycleGenerationSha256: dependencies.hostLifecycleGenerationSha256});
      const prepared = await product.prepare(journal, input, dependencies.resources);
      if (prepared.kind !== "prepared") {throw new TypeError("Host HTTP listener preparation is unproven");}
      assertOpen();

      // The authenticated handshake runs over the retained attach channel, not
      // over the operation network, so it is ordered before membership. The V4
      // ledger constrains only the resource axis and says nothing about it.
      stage = "init";
      const ready = await launched.openInitSession(dependencies.initOptions).ready();
      if (ready.kind !== "ready") {throw new TypeError("Docker authenticated init readiness is unproven");}
      assertOpen();

      // Known gap on this revision: the V4 replay admits container_attached only
      // after listener_allocated, and no owner in this repository issues a
      // listener observation, so membership cannot be published yet. The step is
      // kept in place, and its refusal keeps the operation fail-closed.
      stage = "membership";
      await product.observeContainer(launched.authority, call(deadlines.membershipMs));
      assertOpen();

      stage = "route";
      // The route owner is the last admission gate before provider execution.
      // Its current outcome is refusal, so no unrouted container can proceed.
      const admitted = await routeAdmission.admit({authority: launched.authority,
        endpoint: Object.freeze({address: prepared.address.address, port: prepared.address.port}),
        signal: input.signal, deadlineEpochMs: Date.now() + deadlines.membershipMs});
      return await settle(admitted.reason);
    } catch {
      return await settle(REASONS[stage]);
    }
  };
  return Object.freeze({prepareClaimed});
};
