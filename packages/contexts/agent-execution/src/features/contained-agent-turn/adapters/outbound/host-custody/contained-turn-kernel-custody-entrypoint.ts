export {
  ContainedTurnKernelCustodyAdapter,
  type ContainedTurnHostCustodyPort,
  type ContainedTurnKernelCustodyAttemptOwner,
  type ContainedTurnKernelWorkspaceOwner,
} from "./contained-turn-kernel-custody-adapter.js";
import {ContainedTurnKernelCustodyAdapter} from "./contained-turn-kernel-custody-adapter.js";
import type {ContainedTurnKernelCustodyPort} from "../../../application/ports/outbound/contained-turn-ports.js";
import type {ContainedTurnHostCustodyPort, ContainedTurnKernelCustodyAdapterOptions} from "./contained-turn-kernel-custody-contracts.js";
export const createContainedTurnKernelCustodyPort = (
  hostCustody: ContainedTurnHostCustodyPort,
  options: ContainedTurnKernelCustodyAdapterOptions,
): ContainedTurnKernelCustodyPort => new ContainedTurnKernelCustodyAdapter(hostCustody, options);
export {
  createHostHttpEgressSession,
  type HostHttpEgressSessionDependencies,
} from "./egress/host-http-egress-session.js";
export { createNativeHttpEgressRoute, nativeHttpRequestProfile,
  type NativeHttpRequestProfileId } from "./egress/native-http-request-profile.js";
export { NodeHttpEgressBoundaryIds } from "./egress/node-http-egress-boundary-ids.js";
export { NodeTlsHttpEgressError, NodeTlsHttpEgressTransport,
  type NodeTlsHttpEgressTransportOptions } from "./egress/node-tls-http-egress-transport.js";
export type { HttpEgressRouteFirstWrite,
  HttpEgressRouteFirstWriteReservation } from "./egress/http-egress-ports.js";
export type { ContainedTurnHostPostClaimPreparation } from "./contained-turn-kernel-custody-contracts.js";

export {custodyDataRecord, sameHostCustodyBinding, isHostCustodyDataCallback} from "./host-custody-inert-record.js";
export {isNodeProxy} from "./node-inert-record.js";
export {NodeCustodyHttpResources, type NodeCustodyHttpResourceInput} from "./node-custody-http-resources.js";
export {readHostCustodyHttpHandoff, hostHttpAbortOperations, type HostCustodyHttpHandoff,
  type HostCustodyHttpResourceLifetime} from "./host-custody-http-resource-lifetime.js";

export {createImmutableHostCustodyLaunchPlan} from "./host-custody-launch-plan-snapshot.js";

export {hostLaunchFinalizationRecipe} from "./host-custody-finalizable-plan.js";
export {retainFinalizationHttpResources} from "./host-launch-finalization-validation.js";

export {createNodeHostHttpListener} from "./egress/node-host-http-listener.js";
export {createNodeHostHttpConnection} from "./egress/node-host-http-connection.js";
export {NodeHttpEgressTrustedResolver, type NodeHttpEgressTrustedResolverOptions} from "./egress/node-http-egress-trusted-resolver.js";

export {PostgresHttpEgressEvidence, initializePostgresHttpEgressEvidence, type PostgresHttpEgressEvidenceScope} from "./egress/postgres-http-egress-evidence.js";

export {createNodeHostHttpConsumptionJournal} from "./egress/node-host-http-consumption-journal.js";

export {NodeProviderProcessCustodyCore} from "./node-provider-process-custody-core.js";
export {DarwinRouteDurableStorage, darwinDigest, inspectDarwinRouteRequestInventory,
  type DarwinTrustedDirectory, type DarwinRouteRequestInventoryIdentity,
  type DarwinRouteRequestInventory} from "./darwin-route-durable-storage.js";
export {DarwinRouteLifecycleJournal} from "./darwin-route-lifecycle-journal.js";
export {DarwinSeatbeltRouteOwner} from "./darwin-seatbelt-route-owner.js";
export {pinDarwinExecutable, createDarwinSeatbeltProjection} from "./darwin-seatbelt-launch-projection.js";
export {createDarwinHostHttpConsumptionJournal} from "./egress/darwin-host-http-consumption-journal.js";
export type {HostHttpLocalCutInput} from "./egress/host-http-local-cut-owner.js";
export type {
  HTTP_EGRESS_ANOMALY_CODES,
  HttpEgressAnomalyCode,
  HttpEgressClosureState,
  HttpEgressConnection,
  HttpEgressExpectedRequest,
  HttpEgressFirstByteState,
  HttpEgressLimits,
  HttpEgressOperation,
  HttpEgressOutcome,
  HttpEgressReceipt,
} from "./egress/http-egress-contracts.js";
export type {
  HostHttpBoundaryIds,
  HostHttpConsumptionJournal,
  HostHttpCredentialMaterializer,
  HostHttpGrant,
  HostHttpLocalAuthorityCut,
  HostHttpMaterializationAuthorizationRequest,
  HostHttpMaterializationOutcome,
  HostHttpMaterializationReceipt,
  HostHttpPolicy,
  HostHttpProviderAccessAuthorization,
  HostHttpProviderAccessProof,
  HostHttpProviderAccessSnapshot,
  HostHttpProvisionalDecision,
  HostHttpRequestProjection,
  HostHttpResolverObservation,
  HostHttpRuntimeSecurityV2,
  HostHttpScope,
  HostHttpSignature,
  HostHttpSigningKey,
  HostHttpTlsObservation,
  HostHttpUnsignedMaterializationAuthorizationRequest,
  HostHttpVerifierV2,
  HttpEgressBrokerPorts,
  HttpEgressClock,
  HttpEgressDispatch,
  HttpEgressEvidence,
  HttpEgressResolution,
  HttpEgressRoute,
  HttpEgressTransportAttempt,
  HttpEgressTransportBinding,
  HttpEgressTransportSession,
  HttpEgressTrustedResolver,
  HttpEgressUpstreamTransport,
} from "./egress/http-egress-ports.js";
export type {
  HttpPresentationHeaderName,
  NativeHttpRequestProfile,
} from "./egress/native-http-request-profile.js";
export type {
  NativeHttpPresentationField,
  NativeHttpPresentationFields,
} from "./egress/native-http-request-headers.js";
export type {
  PreparedHttpFieldInputV1,
  PreparedHttpRequestInputV1,
} from "./egress/prepared-http-request-validation.js";
export type {StrictHttpRequest} from "./egress/strict-http-request.js";

export {snapshotHttpBytes} from "./egress/http-byte-intrinsics.js";

export {withNativeHostCustodyWorkspaceAuthority, retireNativeHostCustodyWorkspaceAuthority,
  type NativeHostCustodyWorkspaceAuthority} from "./native-host-custody-workspace-authority.js";

export {
  readDarwinNativeLaunchObservation, inspectDarwinNativeLaunchObservation,
  assertDarwinNativeLaunchObservationCurrent,
  installDarwinNativeCodexMaterial, inspectDarwinNativeCodexMaterial,
  assertDarwinNativeCodexMaterialCurrent,
  inspectDarwinNativeExecutionLease, assertDarwinNativeExecutionClaim,
  cutoffDarwinNativeExecution, settleDarwinNativeExecutionLaunchRoute,
  settleDarwinNativeExecutionPrivateMaterial, disposeDarwinNativeExecution,
  type DarwinNativeWorkspaceSelection, type DarwinNativeLaunchObservation,
  type DarwinNativeCodexMaterial,
} from "./darwin-attempt-owner-selection.js";

export {darwinAttemptOwnerStates} from "./darwin-attempt-owner-protocol.js";
export {
  captureRootDarwinAttemptWorkspace, withDarwinNativeWorkspaceSelection,
  revokeDarwinNativeWorkspaceSelection, consumeDarwinNativeWorkspaceSelection,
} from "./darwin-attempt-owner-selection.js";
export type {
  DarwinNativeExecutionLease, NativePreparedAttemptBinding,
  RetainedNativeAttemptAuthority, RetainedNativeHttpLaunchAuthority, NativeDirectoryFact, NativeFileFact,
} from "./darwin-attempt-owner-selection.js";
export type {
  DarwinAttemptRetainedOwners, DarwinAttemptRetainedCompletion, DarwinAttemptRetainedOwnerFactory,
} from "./darwin-attempt-owner-bridge.js";

export {markDarwinNativeRootLaunchPlan} from "./host-custody-launch.js";
export {HTTP_EVIDENCE_FENCE} from "./egress/postgres-http-egress-evidence-transactions.js";
export {createHostHttpAdmissionGuard} from "./egress/host-http-admission-guard.js";
export {createPreparedHttpRequestV1} from "./egress/prepared-http-request-v1.js";
export {createStrictHttpEgressBroker} from "./egress/strict-http-egress-broker.js";
export {initialHttpEgressState} from "./egress/http-egress-settlement.js";
export {materializationAuthorizationRequest, projectPreparedRequest} from "./egress/http-egress-session-authority.js";

// Public composition declaration dependencies for this adapter boundary.
export { type DarwinNativeFinalLaunchData } from "./darwin-attempt-owner-final-launch.js";
export { type DarwinAttemptOwnerCommand, type DarwinAttemptOwnerEvent, type DarwinNativeLaunchData, type DarwinNativeWorkspaceFile, type DarwinNativeWorkspaceFileEntry, type DarwinNativeWorkspaceTree, type DarwinNativeWorkspaceTreeLimits } from "./darwin-attempt-owner-protocol.js";
export { type IssuedDarwinRouteReservation, type NodeCustodyExecutionSessionIdentity, type NodeCustodyHttpLifetime, NodeProviderProcessCustodyHttpReservation } from "./node-provider-process-custody-http-reservation.js";
export { type DarwinExecutablePin, type DarwinSeatbeltProjection } from "./darwin-seatbelt-launch-projection.js";
export { type LiveCustody } from "./node-provider-process-custody-state.js";
export { type HostHttpConsumptionDirectory } from "./egress/host-http-consumption-storage.js";
export { type HostHttpConsumptionEnvelope, type HostHttpConsumptionLimits } from "./egress/host-http-consumption-format.js";
export { type HostHttpConsumptionPreparation } from "./egress/node-host-http-consumption-journal.js";
export { type OwnedNodeTlsSocket } from "./egress/node-tls-http-egress-transport-attempt.js";
export { type GuardianExitObservation, type GuardianProviderStream, type GuardianProviderStreamFinal, type GuardianStartObservation, StableProcessGroupGuardian } from "./host-custody-stable-guardian.js";
export { HostStderrIngress, HostStdoutIngress, RedactedDiagnosticRing } from "./host-custody-stdio.js";
export { type ClaimedHostLaunchFinalizer, HostLaunchBinding, type StagedHostLaunch } from "./host-launch-finalization.js";
export { prepareAuthenticatedHostHttpEgressSession } from "./egress/host-http-egress-session.js";
export { type HostCustodyHttpResourceOwner } from "./host-custody-http-resource-lifetime.js";
export { type NodeCustodyHttpListenerLifecycle } from "./node-custody-http-resources.js";
export { type OperationResidueAuthority } from "./host-custody-cgroup-v2.js";
export { type SpawnStatus } from "./host-custody-process-tree.js";
export { type DarwinAttemptOwnerEventKind, type DarwinAttemptOwnerImage, type DarwinNativeDirectoryData, type DarwinNativeFileData } from "./darwin-attempt-owner-protocol.js";
export { type HostHttpAuthenticatedSession, type HostHttpSessionIdentity, type PreparedHostHttpAuthenticatedSession } from "./egress/host-http-egress-session.js";
export { type HostHttpLocalCutClaimedInput, type HostHttpLocalCutClockSample, type HostHttpLocalCutSnapshot } from "./egress/host-http-local-cut-owner.js";
export { type NodeTlsSocketEvent, type NodeTlsSocketListener } from "./egress/node-tls-http-egress-transport-attempt.js";
export { type HostCustodyGuardianLaunchInput, type HostCustodyProviderEventListener } from "./host-custody-stable-guardian.js";
export { type HostCustodyStreamAccounting } from "./host-custody-stdio.js";
export { type NodeCustodyHttpConsumptionRecipe, type NodeCustodyHttpIngress, type NodeCustodyHttpListenerRecipe, type NodeCustodyHttpResourcePreparation, type NodeCustodyHttpSession } from "./node-custody-http-resources.js";
export { type NodeHostHttpListenerAddress } from "./egress/node-host-http-listener.js";
export { type PreparedHostHttpConsumptionJournal } from "./egress/node-host-http-consumption-journal.js";
export { type HttpEgressPostgresClient, type HttpEgressPostgresQueryResult } from "./egress/postgres-http-egress-evidence-transactions.js";
export { type ContainedTurnKernelCustodyAdapterOptions, type KernelOpenInput } from "./contained-turn-kernel-custody-contracts.js";
export { type HttpEgressMutableState } from "./egress/http-egress-settlement.js";
export { type NodeHostHttpAccept, type NodeHostHttpListener, type NodeHostHttpListenerClosure, type NodeHostHttpListenerConfig, type NodeHostHttpListenerObservation } from "./egress/node-host-http-listener.js";
export { type NodeHttpEgressDnsBackend } from "./egress/node-http-egress-trusted-resolver.js";
export { type NodeTlsHttpEgressErrorCode, type NodeTlsTrustInput } from "./egress/node-tls-http-egress-transport-support.js";
export { type NodeTlsHttpEgressConnector } from "./egress/node-tls-http-egress-transport-attempt.js";
export { type PostgresHttpEgressReceiptIdentity } from "./egress/postgres-http-egress-evidence-codec.js";
export { type PostgresHttpEgressPool } from "./egress/postgres-http-egress-evidence-transactions.js";
export { type HostHttpAbortOperations } from "./host-custody-http-resource-lifetime.js";
export { type FinalHostLaunch, type ReservedHostLaunchView } from "./host-launch-finalization.js";
export { type NodeCustodyHttpPreparation } from "./node-provider-process-custody-http-reservation.js";
export { type ProcessCustodyRuntimeProfile } from "./host-custody-runtime-profile.js";
export { type ContainmentResult } from "./host-custody-evidence.js";
export { type OperationResidueAuthorityFactory } from "./host-custody-cgroup-v2.js";

export { DARWIN_COOPERATIVE_CUSTODY_LIMITATIONS, type ContainedTurnCustodyHandle,
  type CustodiedProviderProcess, type CustodiedProviderProcessExit, type CustodiedProviderProcessRegistry,
  type CustodiedSdkProcess, type CustodiedSdkProcessLauncher, type HostCustodyClosureEvidence,
  type HostCustodyContainmentProfile, type HostCustodyCooperativeClosureEvidence, type HostCustodyDrainEvidence,
  type HostCustodyEvidence, type HostCustodyEvidenceRegistry, type HostCustodyGuardianExitEvidence,
  type HostCustodyLaunchFingerprintEvidence, type HostCustodyLaunchPlan, type HostCustodyLaunchPlanResolver,
  type HostCustodyNativeDarwinClosureEvidence, type HostCustodyPrivateRootClosureEvidence,
  type HostCustodyProcessIdentityEvidence, type HostCustodyProcessIdentityObserver,
  type HostCustodyProcessIdentityProof, type HostCustodyProviderExitEvidence, type HostCustodyReservationInput,
  type HostCustodySpawnAcknowledgement, type HostCustodyStartCode, type HostCustodyStrictClosureEvidence,
  type HostCustodyWorkspaceAuthority, type PrivateDirectoryCustodyPort, type ProviderProcessCustodyPort
} from "./custodied-provider-process.js";
export { bindDarwinAttemptOwnerBridge } from "./darwin-attempt-owner-bridge.js";
export { type DarwinAttemptOwnerBridgeBinding, type DarwinNativeWorkspacePrimitives
} from "./darwin-attempt-owner-selection.js";
export { type HostHttpAdmissionGuard, type HostHttpAdmissionLease, type HostHttpAdmissionSnapshot,
  type HostHttpCompleteSuccess, type HostHttpReservationIdentity } from "./egress/host-http-admission-guard.js";
export { type PreparedHttpByteSpanV1, type PreparedHttpCredentialValueSpanV1,
  type PreparedHttpRequestCustodyV1, type PreparedHttpRequestV1 } from "./egress/prepared-http-request-v1.js";
export { type ExecutableObservation, type LaunchCandidate, type PrivateLaunchPathObservations,
  type PrivatePathObservation, type VerifiedLaunchDescriptors, type WorkspaceObservation
} from "./host-custody-launch.js";
export { type RetainedHostCustodyWorkspaceAuthority } from "./private-host-custody-reservation.js";
