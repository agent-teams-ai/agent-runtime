export {createDockerProviderProcessBridge, prepareDockerProviderProcessIo, takeDockerProviderProcessAbandonment, assertDockerPreparedIoLaunch} from "./docker-provider-process-bridge.js";
export type {DockerProviderProcessInput, PreparedDockerProviderIo} from "./docker-provider-process-bridge.js";
export {DockerHostCustodyLifecycle, dockerProviderProcessMountFacts} from "./docker-host-custody-lifecycle.js";
export {captureDockerHttpResourceRecord, subscribeDockerHttpAbort, DockerHttpNetworkResources, dockerHttpOperationNetworkRecipe} from "./docker-http-network-resources.js";
export type {DockerHttpNetworkResourceInput} from "./docker-http-network-resources.js";
export {dockerHostCustodyAttemptKey, sameDockerAuthority} from "./docker-host-custody-lifecycle-guards.js";
export type {DockerHostCustodyContainerCreateInput} from "./docker-host-custody-lifecycle-guards.js";
export type {DockerCustodyAttemptKey, DockerCustodyOwnerIdentity} from "./journal/docker-custody-journal-types.js";
export type {LaunchedDockerCustody} from "./docker-lifecycle-issued-launch.js";
export {awaitNetworkCleanupWork} from "./engine/docker-engine-composition.js";
export {createDockerHostHttpEgressObservers, joinHostHttpEgressV4Observers} from "./host-http-egress-v4-observers.js";
export type {DockerHostHttpEgressObserverInput, DockerHttpListenerReadback} from "./host-http-egress-v4-observers.js";
export {readNodeLinuxRouteNamespace, openNodeLinuxExclusiveRoute, LinuxExclusiveRouteOpeningError} from "./node-linux-exclusive-route.js";
export type {LinuxRouteToolPin} from "./node-linux-exclusive-route.js";
export type {LinuxExclusiveRouteBinding, LinuxExclusiveRouteOwner} from "./linux-exclusive-route-owner.js";
export type {LinuxExclusiveRouteEndpoint} from "./linux-exclusive-route-policy.js";
export type {DockerHostCustodyLifetime, DockerContainedTurnInitSession} from "./docker-contained-turn-host-custody.js";

export {readNodeLinuxDockerCgroup, isConcreteLinuxDockerLifecycle, createNodeLinuxDockerResidueCustody} from "./node-linux-docker-residue-custody.js";

export {canonicalJsonSha256} from "./engine/docker-engine-composition.js";

/** Curated private handoff for later kernel wiring; no ordinary caller proof writer. */
export {createDockerImageInitOwner} from "./docker-image-init-owner.js";
export type {DockerImageInitOwner, DockerImageInitWitness, DockerImageInitHostBinding} from "./docker-image-init-owner.js";
export {DOCKER_CUSTODY_NODE_PATH, DOCKER_CUSTODY_BOOTSTRAP_PATH, DOCKER_CUSTODY_INIT_ARGUMENTS} from "./engine/docker-engine-composition.js";
export type {DockerImageInitLock} from "./engine/docker-engine-composition.js";
export {parseDockerImageReference} from "./engine/docker-engine-composition.js";

export {
  NodeUnixSocketDockerEngine, snapshotDockerImageInitLock, snapshotDockerEnginePolicy,
  DockerEngineError, DockerOperationNetwork, FakeDockerEngine, assertNetworkContainer,
  assertNetworkEngine, createSpecificationSha256, decodeEngineIdentity, decodeInspection,
  decodeOperationNetwork, encodeCreateRequest, networkBinding, networkDigest,
  operationNetworkLabels, operationNetworkName,
} from "./engine/docker-engine-composition.js";

// Private composition construction of existing durable resource owners.
export {NodeDockerCustodyJournalStorage} from "./journal/node-docker-custody-journal-storage.js";
export {HostHttpEgressV4NodeStorage} from "./journal/host-http-egress-v4-node-storage.js";
export {HostHttpEgressV4Journal} from "./journal/host-http-egress-v4-journal.js";

export {captureDockerWorkspaceCustody, readDockerWorkspaceCustody} from "./node-linux-docker-residue-custody.js";

export {createNodeDockerRouteProvenance} from "./node-docker-route-provenance.js";
export type {NodeDockerRouteSubject} from "./node-docker-route-provenance.js";
export {CGROUP2_SUPER_MAGIC, PROC_SUPER_MAGIC} from "./linux-docker-residue-io.js";
export {DOCKER_CUSTODY_INIT_PROTOCOL, DockerCustodyFrameDecoder, encodeDockerCustodyFrame} from "./init/docker-custody-init-protocol.js";
export {DockerCustodyJournal} from "./journal/docker-custody-journal.js";
export {DockerCustodyJournalConflictError} from "./journal/docker-custody-journal-types.js";
export {composeLinuxDockerResidueCustody} from "./node-linux-docker-residue-custody.js";
export {dockerCustodyOwnerIdentitySha256} from "./journal/docker-custody-journal-codec.js";
export {installLinuxExclusiveRoute} from "./linux-exclusive-route-owner.js";
export {linuxExclusiveRouteSeccomp} from "./linux-exclusive-route-policy.js";
export {residueLeaf, residueParent} from "./linux-docker-residue-parsers.js";
export {v4Decode, v4Hash} from "./journal/host-http-egress-v4-codec.js";
export {v4Replay} from "./journal/host-http-egress-v4-replay.js";
