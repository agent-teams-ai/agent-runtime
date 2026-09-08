import {randomUUID} from "node:crypto";
import {isAbsolute, normalize, relative} from "node:path";
import {NodeUnixSocketDockerEngine, snapshotDockerEnginePolicy, awaitNetworkCleanupWork,
  createNodeLinuxDockerResidueCustody, NodeDockerCustodyJournalStorage,
  HostHttpEgressV4NodeStorage, HostHttpEgressV4Journal}
  from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import type {DockerLinuxPostClaimDependencies} from "./docker-linux-post-claim-preparation.js";
import type {DockerLinuxExclusiveRouteAdmissionInput} from "./docker-linux-exclusive-route-admission.js";
import {createNodeHostHttpConsumptionJournal} from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";

type Dependencies = DockerLinuxPostClaimDependencies;
type Call = Parameters<Dependencies["engineIdentity"]>[0];
type Policy = Parameters<Dependencies["openLifecycle"]>[0];
type Residue = ReturnType<typeof createNodeLinuxDockerResidueCustody>;
type Consumption = Parameters<typeof createNodeHostHttpConsumptionJournal>[0];

export type NodeDockerConsumptionReferences = Pick<Consumption["envelope"],
  "selectedDockerAuthorityDigest" | "networkNamespaceIdentity" | "cgroupIdentity" | "listenerIdentity" | "signerIdentity">;
export type DockerHttpConsumptionReferences = Omit<NodeDockerConsumptionReferences, "signerIdentity">;
export type NodeDockerConsumptionRecipe = Readonly<{
  prepare(references: NodeDockerConsumptionReferences): ReturnType<Dependencies["resources"]["consumption"]["prepare"]>;
}>;

  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || path !== ".." && !path.startsWith("../") && !isAbsolute(path);
  };

export interface NodeDockerDeploymentRecipeInput {
  readonly enginePolicy: Dependencies["enginePolicy"];
  /** Dedicated, already-created private directories outside provider mounts.
   * Never replace a directory containing recovery debt with an empty one. */
  readonly custodyJournalRoot: string;
  readonly resourceJournalRoot: string;
  readonly nsenter: DockerLinuxExclusiveRouteAdmissionInput["nsenter"];
  readonly nft: DockerLinuxExclusiveRouteAdmissionInput["nft"];
  /** Host storage and the bound subject reader; observations arrive after route admission. */
  readonly consumption: Readonly<{
    directory: Consumption["directory"];
    limits?: Consumption["limits"];
    readEnvelope(references: NodeDockerConsumptionReferences): Consumption["envelope"];
  }>;
}

export interface NodeDockerDeploymentRecipe {
  readonly preparation: Pick<Dependencies, "enginePolicy" | "engineIdentity" | "openLifecycle" | "openResourceJournal">;
  readonly route: Omit<DockerLinuxExclusiveRouteAdmissionInput, "binding">;
  readonly consumption: NodeDockerConsumptionRecipe;
  releaseAfterHostCleanup(call: Call): Promise<"released" | "pending">;
}

/** One operation's concrete production owners. Construction does no I/O.
 * The existing post-claim owner supplies the network-derived policy and joined
 * observation issuer. No transport, residue proof or journal implementation is
 * injectable here. The Host still owns allocation and reverse-order cleanup.
 */
export const createNodeDockerDeploymentRecipe = (input: NodeDockerDeploymentRecipeInput): NodeDockerDeploymentRecipe => {
  // This engine is used ONLY for /info. It must not select an operation network
  // before the Engine identity needed to derive that network has been observed.
  // The existing Engine constructor validates a full create policy even for
  // identity reads. This private validation name is never allocated or used by
  // a create call, and is excluded from the returned preparation policy.
  const identityPolicy = snapshotDockerEnginePolicy({...input.enginePolicy, allowedNetworkName: "ar-identity-read-only"});
  const {allowedNetworkName: _network, ...enginePolicy} = identityPolicy;
  const identityEngine = new NodeUnixSocketDockerEngine({policy: identityPolicy});
  const custodyRoot = input.custodyJournalRoot;
  const resourceRoot = input.resourceJournalRoot;
  const journalRoots = [custodyRoot, resourceRoot, input.consumption.directory.path];
  if (journalRoots.some(root => !isAbsolute(root) || normalize(root) !== root ||
      [identityPolicy.privateRootSourceRoot, identityPolicy.workspaceSourceRoot].some(mount => contains(mount, root))) ||
      journalRoots.some((root, index) => journalRoots.some((other, otherIndex) => index !== otherIndex && contains(root, other)))) {
    throw new TypeError("Docker recipe requires separate absolute journal roots outside provider mounts");
  }
  const nsenter = Object.freeze({...input.nsenter});
  const nft = Object.freeze({...input.nft});
  const consumptionDirectory = Object.freeze({...input.consumption.directory});
  const consumptionLimits = input.consumption.limits === undefined ? undefined : Object.freeze({...input.consumption.limits});
  const readEnvelope = input.consumption.readEnvelope.bind(input.consumption);
  let consumptionEntered = false;
  let consumptionSettled = true;
  let consumptionFlight: ReturnType<Dependencies["resources"]["consumption"]["prepare"]> | undefined;
  let closed = false;
  let storage: NodeDockerCustodyJournalStorage | undefined;
  let identityFlight: ReturnType<Dependencies["engineIdentity"]> | undefined;
  let lifecycle: Residue | undefined;
  let routeEngine: NodeUnixSocketDockerEngine | undefined;
  let journal: HostHttpEgressV4Journal | undefined;
  let journalFlight: Promise<HostHttpEgressV4Journal> | undefined;
  let published = false;
  let release: Promise<"released" | "pending"> | undefined;
  const assertOpen = () => {if (closed) {throw new TypeError("Docker recipe admission closed");}};
  const preparation: Pick<Dependencies, "enginePolicy" | "engineIdentity" | "openLifecycle" | "openResourceJournal"> = Object.freeze({
    enginePolicy: Object.freeze(enginePolicy),
    engineIdentity(call: Call) {
      assertOpen();
      if (identityFlight !== undefined) {throw new TypeError("Docker recipe identity is one-use");}
      identityFlight = (async () => {
        const identity = await identityEngine.identity(call);
        assertOpen();
        storage = await NodeDockerCustodyJournalStorage.open(custodyRoot);
        assertOpen();
        return identity;
      })();
      return identityFlight;
    },
    openLifecycle(policy: Policy) {
      assertOpen();
      if (storage === undefined || lifecycle !== undefined) {throw new TypeError("Docker recipe lifecycle order conflict");}
      const selected = snapshotDockerEnginePolicy(policy);
      // Only the post-claim network name may differ from trusted deployment policy.
      const expected = snapshotDockerEnginePolicy({...enginePolicy, allowedNetworkName: selected.allowedNetworkName});
      if ((Object.keys(expected) as Array<keyof Policy>).some(key => JSON.stringify(selected[key]) !== JSON.stringify(expected[key]))) {
        throw new TypeError("Docker recipe Engine policy changed");
      }
      lifecycle = createNodeLinuxDockerResidueCustody({policy: selected, journalStorage: storage});
      routeEngine = new NodeUnixSocketDockerEngine({policy: selected});
      return lifecycle.lifecycle;
    },
    openResourceJournal({subject, observer}: Parameters<Dependencies["openResourceJournal"]>[0]) {
      assertOpen();
      if (lifecycle === undefined || journalFlight !== undefined) {throw new TypeError("Docker recipe journal order conflict");}
      journal = new HostHttpEgressV4Journal(new HostHttpEgressV4NodeStorage(resourceRoot), subject, observer);
      const owned = journal;
      journalFlight = (async () => {
        const result = await owned.prepare(randomUUID());
        assertOpen();
        if (result.kind !== "fresh") {throw new TypeError("Docker resource journal requires reconciliation");}
        published = true;
        return owned;
      })();
      return journalFlight;
    },
  });
  const route: Omit<DockerLinuxExclusiveRouteAdmissionInput, "binding"> = Object.freeze({nsenter, nft,
    engine: Object.freeze({inspect(...args: Parameters<NonNullable<typeof routeEngine>["inspect"]>) {
      if (routeEngine === undefined) {throw new TypeError("Docker route inspection requires the selected lifecycle");}
      return routeEngine.inspect(...args);
    }}),
  });
  const consumption: NodeDockerConsumptionRecipe = Object.freeze({prepare(references: NodeDockerConsumptionReferences) {
    assertOpen();
    if (!published || consumptionEntered) {throw new TypeError("Docker consumption preparation order conflict");}
    consumptionEntered = true;
    const captured = Object.freeze({...references});
    const envelope = Object.freeze({...readEnvelope(captured)});
    for (const key of ["selectedDockerAuthorityDigest", "networkNamespaceIdentity", "cgroupIdentity", "listenerIdentity", "signerIdentity"] as const) {
      if (typeof captured[key] !== "string" || envelope[key] !== captured[key]) {
        throw new TypeError("Docker consumption observation reference changed");
      }
    }
    const recipe = createNodeHostHttpConsumptionJournal({directory: consumptionDirectory, envelope,
      ...(consumptionLimits === undefined ? {} : {limits: consumptionLimits})});
    assertOpen();
    consumptionSettled = false;
    consumptionFlight = recipe.prepare().then(result => {
      if (result.kind !== "ready") {consumptionSettled = result.kind !== "unknown"; return result;}
      return Object.freeze({...result, async retire() {
        const outcome = await result.retire();
        consumptionSettled = outcome === "retired";
        return outcome;
      }});
    });
    return consumptionFlight;
  }});
  return Object.freeze({preparation, route, consumption,
    /** Call after the Host's existing cleanup has settled. This closes only
     * local descriptor/storage custody, never a container or an operation.
     * V4 itself refuses retirement while any required absence proof is missing.
     * Failed preparation is joined before closing its unpublished descriptors.
     * Keep this owner reachable and retry pending cleanup; never erase its roots.
     */
    releaseAfterHostCleanup(call: Call): Promise<"released" | "pending"> {
      closed = true;
      if (call.signal.aborted || !Number.isSafeInteger(call.deadlineEpochMs) || Date.now() >= call.deadlineEpochMs) {
        return Promise.resolve("pending");
      }
      release ??= (async () => {
        await Promise.allSettled([identityFlight, journalFlight, consumptionFlight]);
        if (call.signal.aborted || Date.now() >= call.deadlineEpochMs) {return "pending" as const;}
        if (!consumptionSettled) {return "pending" as const;}
        try {
          if (published && journal !== undefined && journal.evidence().resourceLedger !== "retired") {
            if (journal.evidence().reconcileRequired) {return "pending" as const;}
            await journal.recordIntent(randomUUID(), {kind: "retired", targetSha256: journal.target("retired")});
          }
          if (lifecycle !== undefined && await lifecycle.disposeResidue(call) !== "released") {return "pending" as const;}
          await journal?.close();
          await storage?.close();
          return "released" as const;
        } catch {return "pending" as const;}
      })().then(result => {if (result === "pending") {release = undefined;} return result;});
      const pending = release;
      // A caller timeout bounds observation, not the retained cleanup flight.
      return awaitNetworkCleanupWork(pending, call).then(() => pending, () => "pending" as const);
    },
  });
};
