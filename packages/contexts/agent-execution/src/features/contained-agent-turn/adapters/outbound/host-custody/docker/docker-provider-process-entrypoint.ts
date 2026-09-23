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
  DockerEngineError, DockerOperationNetwork, assertNetworkContainer,
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

// Public composition declaration dependencies for this adapter boundary.
export { DockerCustodyInitHostSession } from "./init/docker-custody-init-host-session.js";
export { type DockerCustodyInitHostAuthority, type DockerCustodyInitHostClosedEvidence, type DockerCustodyInitHostOptions, type DockerCustodyInitHostOutput, type DockerCustodyInitHostReady, type DockerCustodyInitHostResult, type DockerCustodyInitHostRootExit, type DockerCustodyInitHostStart, type DockerCustodyInitHostWriteResult } from "./init/docker-custody-init-runtime-types.js";
export { type DockerImageReference } from "./engine/docker-engine-composition.js";
export { type DockerNoCreationInput, type DockerNoCreationObservation } from "./docker-no-creation-observation-owner.js";
export { type DockerRemovalObservation } from "./docker-removal-observation-owner.js";
export { type UnixHttpResponse } from "./engine/docker-engine-composition.js";
export { type UnixHijackChannel } from "./engine/docker-engine-composition.js";
export { type DockerContainerResourceFacts, type DockerContainerStateFacts } from "./engine/docker-engine-composition.js";
export { type DockerArchiveFile } from "./engine/docker-engine-composition.js";
export { type DockerCustodyHostObservation, type DockerCustodyInitHostCompletion } from "./init/docker-custody-init-observation.js";
export { DOCKER_CUSTODY_CHILD_SIGNALS, DOCKER_CUSTODY_HOST_SIGNALS, type DockerCustodyChildSignal, type DockerCustodyContainmentRequest, type DockerCustodyEnvironmentEntry, type DockerCustodyExecutableMapping, type DockerCustodyHostHandshake, type DockerCustodyHostMessage, type DockerCustodyHostSignal, type DockerCustodyHostSignalRequest, type DockerCustodyIdentity, type DockerCustodyInitMessage, type DockerCustodyInitReady, type DockerCustodyObservationBinding, type DockerCustodyProviderDrainComplete, type DockerCustodyProviderDrainFailed, type DockerCustodyProviderExecAcknowledgement, type DockerCustodyProviderExecRequest, type DockerCustodyProviderInput, type DockerCustodyProviderInputEof, type DockerCustodyProviderInstance, type DockerCustodyProviderInstanceFacts, type DockerCustodyProviderObservation, type DockerCustodyProviderOutput, type DockerCustodySignalObservation } from "./init/docker-custody-init-protocol.js";
export { DOCKER_CUSTODY_ACTION_STATES, DOCKER_CUSTODY_DEBT_REASONS, DOCKER_CUSTODY_JOURNAL_VERSION, DOCKER_CUSTODY_OBSERVATION_STATES, DOCKER_CUSTODY_STATES, type DockerCustodyDebtReason, type DockerCustodyJournalState } from "./journal/docker-custody-journal-types.js";
export { type HostHttpEgressV4Observed } from "./journal/host-http-egress-v4-types.js";
export { type ResidueFile, type ResidueStat } from "./linux-docker-residue-io.js";
export { type LinuxExclusiveFirstWrite } from "./linux-exclusive-route-owner.js";
export { createDockerHttpListenerLifecycle } from "./docker-http-listener-lifecycle.js";
export { type DockerHttpListenerIdentity } from "./docker-http-listener-lifecycle.js";
export { type DockerLifecycleAbsentObservation, type DockerLifecyclePresentObservation } from "./docker-lifecycle-observations.js";
export { type DockerOperationNetworkEngineInput } from "./engine/docker-engine-composition.js";
export { type HostHttpEgressReplayExchange, type HostHttpEgressReplayResource } from "./journal/host-http-egress-v4-replay.js";
export { type NodeDockerRouteBinding } from "./node-docker-route-provenance.js";
export { type LinuxDockerResidueLaunchedCustody } from "./node-linux-docker-residue-custody.js";
export { type DockerHostCustodyCompositionDependencies, type DockerHostCustodyContainment, type DockerHostCustodyContainerCreate, type DockerHostCustodyJournalPort, type DockerHostCustodyRecovery, type DockerHostCustodyRecoveryResolver, type DockerHostCustodyResiduePort } from "./docker-host-custody-lifecycle.js";
export { type DockerLifecycleObservation } from "./docker-lifecycle-observations.js";
export { type DockerLifecycleImageSelection } from "./docker-lifecycle-authority.js";
export { type DockerContainedTurnInitOptions } from "./docker-contained-turn-host-custody.js";
export { type DockerCustodyInitHostExec } from "./init/docker-custody-init-host-session.js";
export { type DockerHostCustodyContainmentInput, type DockerRemovalObservationOwner } from "./docker-removal-observation-owner.js";
export { type DockerHttpResourceClaim } from "./docker-http-network-resources.js";
export { type DockerContainerAuthority, type DockerContainerCreate, type DockerContainerObservation, type DockerCustodyDuplexChannel, type DockerEngineCall, type DockerEngineIdentity, type DockerEnginePolicy, type DockerEnginePort, type DockerLogFrame } from "./engine/docker-engine-composition.js";
export { type DockerEndpointIdentity } from "./engine/docker-engine-composition.js";
export { type DockerEngineFailureCode } from "./engine/docker-engine-composition.js";
export { type DockerOperationNetworkBinding, type DockerOperationNetworkObservation } from "./engine/docker-engine-composition.js";
export { type DockerOperationNetworkInput, type DockerOperationNetworkRemoval } from "./engine/docker-engine-composition.js";
export { type DockerEngineClient } from "./engine/docker-engine-composition.js";
export { type DockerCustodyProtocolMessage } from "./init/docker-custody-init-protocol.js";
export { type DockerCustodyActionState, type DockerCustodyJournalEvidence, type DockerCustodyJournalFile, type DockerCustodyJournalLimits, type DockerCustodyJournalRecord, type DockerCustodyJournalStorage, type DockerCustodyObservationState, type DockerCustodyRecoveryObservation } from "./journal/docker-custody-journal-types.js";
export { DockerCustodyJournalError } from "./journal/docker-custody-journal-types.js";
export { type DockerCustodyJournalRecoveryReader, type DockerCustodyJournalWriter } from "./journal/docker-custody-journal.js";
export { type HostHttpEgressV4Capacity, type HostHttpEgressV4Event, type HostHttpEgressV4Intent, type HostHttpEgressV4Observation, type HostHttpEgressV4ObservationOwner, type HostHttpEgressV4Record, type HostHttpEgressV4Storage, type HostHttpEgressV4Subject } from "./journal/host-http-egress-v4-types.js";
export { type HostHttpEgressV4FileSystem } from "./journal/host-http-egress-v4-node-storage.js";
export { type HostHttpEgressV4Ledger } from "./journal/host-http-egress-v4-replay.js";
export { type DockerCustodyLinuxFileSystemPort } from "./journal/node-docker-custody-journal-storage.js";
export { type LinuxExclusiveRouteKernel } from "./linux-exclusive-route-owner.js";
export { type LinuxDockerResidueComposition } from "./node-linux-docker-residue-custody.js";
export { type DockerResidueIo } from "./linux-docker-residue-io.js";
