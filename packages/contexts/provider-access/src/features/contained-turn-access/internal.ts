export { createContainedTurnDispatchConsumptionV1 } from "./composition/dispatch-consumption-v1-factory.js";
export { createContainedTurnCredentialMaterializationAuthorizationV1 } from "./composition/materialization-authorization-v1-factory.js";
export { createContainedTurnProviderAccessFeature } from "./composition/feature-module-factory.js";
export { createPostgresRouteSelectionOwner, type PostgresRouteSelectionOwner,
  type RouteSelectionInput } from "./composition/route-selection-owner.js";
export { snapshotRouteSelectionCurrent, routeSelectionDigest, snapshotRouteSelectionFacts, type RouteSelectionCurrent } from "./adapters/outbound/postgres/route-selection-data.js";
export {
  createDispatchConsumptionRequestDigests,
  createCredentialMaterializationRequestDigest,
  createInMemoryContainedTurnDispatchConsumptionV1,
  createStaticContainedTurnProviderAccessFeature,
  type InMemoryDispatchBindingSeed,
  type InMemoryDispatchConsumptionHarness,
  type StaticAvailableProviderAccessAuthority,
  type StaticIndeterminateProviderAccessAuthority,
  type StaticProviderAccessAuthority,
} from "./composition/package-composition.js";
export { createPostgresDispatchConsumption, type PostgresDispatchConsumptionObservation,
  type PostgresDispatchConsumptionOwner } from "./composition/postgres-dispatch-consumption.js";
export type { DispatchHeadPublication, DispatchHeadPublicationResult,
  DispatchPostgresControl } from "./adapters/outbound/postgres/dispatch-postgres-control.js";
export type { DispatchPostgresOwner } from "./adapters/outbound/postgres/dispatch-postgres-data.js";
export { createPostgresCredentialRenderingOwner,
  type PostgresCredentialRenderingOwner } from "./composition/postgres-credential-rendering-owner.js";
export { createPostgresMaterializationRepository,
  type PostgresMaterializationRepositoryOwner } from "./adapters/outbound/postgres/materialization-postgres-repository.js";
export { materializationPostgresSchemaDigest } from "./adapters/outbound/postgres/materialization-postgres-schema.js";
export { routeSelectionSchemaDigest } from "./adapters/outbound/postgres/route-selection-schema.js";
export { dispatchOperationSchemaDigest } from "./adapters/outbound/postgres/dispatch-operation-schema.js";
export type { MaterializationPostgresPool, MaterializationPostgresTimeouts } from "./adapters/outbound/postgres/materialization-postgres-transactions.js";
export type {
  CredentialGenerationField,
  CredentialGenerationOutcome,
  CredentialGenerationRequest,
  CredentialRecipe,
  CredentialRenderingSelection,
  CredentialGenerationAcquisition,
  CredentialRenderingBinding,
  CredentialRenderingOutcome,
  CredentialRenderingOwner,
  OperationCredentialMaterialAdmission,
  RenderedCredentialField,
  RenderedCredentialFields,
  TrustedCredentialMaterialSeed,
} from "./adapters/outbound/credential-rendering-contracts.js";
export { createPostgresOperationDispatchConsumption,
  type PostgresOperationDispatchConsumptionOwner } from "./composition/postgres-operation-dispatch-consumption.js";
export { createPostgresCurrentProviderAccess,
  type PostgresCurrentProviderAccessOwner } from "./composition/postgres-current-provider-access.js";
export type { PaAcceptedPreparation, PaDispatchIssuanceSelection } from "./adapters/outbound/dispatch-operation-contracts.js";
export { createContainedTurnCredentialRenderingOwner } from "./composition/credential-rendering-owner-factory.js";
export { createInMemoryDispatchConsumptionRepository } from "./adapters/outbound/in-memory-dispatch-consumption-repository.js";
export { createMaterializationBindingRepository } from "./adapters/outbound/postgres/materialization-binding-repository.js";
export { createOperationDispatchConsumption,
  type OperationDispatchConsumptionOwner } from "./composition/operation-dispatch-consumption.js";
export { createSha256DispatchConsumptionDigest } from "./adapters/outbound/sha256-dispatch-consumption-digest.js";

export { createOrdinaryCodexAuthCapture } from './adapters/outbound/ordinary-codex-auth-capture.js';
export { OrdinaryCodexAuthRefused, OrdinaryCodexAuthCleanupIndeterminate,
  type OrdinaryCodexAuthCapture, type OrdinaryCodexAuthCaptureOptions, type OrdinaryCodexAuthMetadata,
  type OrdinaryCodexAuthObservation, type OrdinaryCodexAuthReason,
  type OrdinaryCodexAuthStage } from './adapters/outbound/ordinary-codex-auth-contracts.js';

export { createPostgresOrdinaryProviderAccessOwner, type OrdinaryProviderAccessOwnerOptions } from './composition/ordinary-provider-access-owner.js';
export { OrdinaryPaUnavailable, type OrdinaryPaBinding, type OrdinaryPaAuthority, type OrdinaryPaSnapshot,
  type OrdinaryPaMaterial, type OrdinaryPaRetirement, type OrdinaryPaSettlement, type OrdinaryPaGrant } from './contracts/ordinary-provider-access.js';

// Curated closure for the trusted composition entrypoint. These are the exact
// dependency and owner contracts consumed by the exported factories; helpers,
// persistence implementations, and credential-lifetime companions stay private.
export type { ContainedTurnProviderAccessDependencies } from "./composition/feature-module-factory.js";
export type { MaterializationAuthorizationV1Dependencies } from "./composition/materialization-authorization-v1-factory.js";
export type {
  DispatchConsumptionDigest,
} from "./application/ports/outbound/dispatch-consumption-digest.js";
export type { MaterializationAuthorizationDigest } from "./application/ports/outbound/materialization-authorization-digest.js";
export type {
  DispatchConsumptionJournalEntry,
  DispatchConsumptionRepository,
  DispatchConsumptionTransaction,
  DispatchConsumptionTransactionSelector,
} from "./application/ports/outbound/dispatch-consumption-repository.js";
export type {
  MaterializationAuthorizationBinding,
  MaterializationAuthorizationRepository,
  MaterializationAuthorizationRequestSelector,
  MaterializationAuthorizationTransaction,
} from "./application/ports/outbound/materialization-authorization-repository.js";
export type {
  PaOperationOwner,
  PaOperationPublication,
  PaOperationRecordKind,
  PaOperationStore,
  PaOperationTransaction,
} from "./adapters/outbound/dispatch-operation-contracts.js";
export type {
  DispatchConsumptionOwnerState,
  InMemoryDispatchConsumptionControl,
} from "./adapters/outbound/in-memory-dispatch-consumption-repository.js";
export type {
  MaterializationPostgresOwner,
} from "./adapters/outbound/postgres/materialization-postgres-repository.js";
export type { MaterializationPostgresClient } from "./adapters/outbound/postgres/materialization-postgres-transactions.js";
export type {
  RouteSelectionDescriptor,
  RouteSelectionFacts,
} from "./adapters/outbound/postgres/route-selection-data.js";
export type {
  DispatchBindingHead,
  DispatchConsumeOutcome,
  DispatchConsumedReceipt,
  DispatchDisposition,
  DispatchExpectationValue,
  DispatchPrevention,
  DispatchPreventedReason,
  DispatchProvider,
  DispatchScopeValue,
  DispatchSettlementOutcome,
  DispatchSettlementReceipt,
} from "./domain/dispatch-consumption.js";
export type {
  ContainedTurnProviderAccessBindingObservation,
  ContainedTurnProviderAccessBindingSnapshot,
  ContainedTurnProviderAccessRepository,
} from "./application/ports/outbound/provider-access-binding-repository.js";
export type {
  AuthorizationCommand,
  AuthorizationProvider,
  AuthorizationRecord,
  AuthorizationRejectionReason,
} from "./domain/materialization-authorization.js";
export type {
  ContainedTurnProviderAccessBinding,
  ContainedTurnProviderAccessFeatureApi,
  ProviderAccessAuthorityEvidence,
  ProviderAccessProvider,
  ProviderAccessScope,
  ProviderAccessUnavailableReason,
  RevalidateContainedTurnProviderAccess,
  RevalidateContainedTurnProviderAccessInput,
  RevalidateContainedTurnProviderAccessOutcome,
  RevalidateContainedTurnProviderAccessRejection,
  ResolveContainedTurnProviderAccess,
  ResolveContainedTurnProviderAccessInput,
  ResolveContainedTurnProviderAccessOutcome,
} from "./contracts/contained-turn-provider-access.js";
export type {
  ContainedTurnDispatchConsumptionV1,
  ConsumeForDispatchInput,
  ConsumeForDispatchOutcome,
  DispatchConsumptionBindingExpectation,
  DispatchConsumptionDisposition,
  DispatchConsumptionPrevention,
  DispatchConsumptionPreventedReason,
  DispatchConsumptionReceipt,
  DispatchConsumptionScope,
  DispatchConsumptionSettlementReceipt,
  ObserveDispatchConsumptionInput,
  ObserveDispatchConsumptionOutcome,
  SettleDispatchConsumptionInput,
  SettleDispatchConsumptionOutcome,
} from "./contracts/dispatch-consumption-v1.js";
export type {
  AuthorizeCredentialMaterializationInput,
  AuthorizeCredentialMaterializationOutcome,
  CredentialMaterializationAuthorizationReceipt,
  CredentialMaterializationAuthorizationV1,
  CredentialMaterializationRejectionReason,
  CredentialMaterializationUnsupportedReason,
  ObserveCredentialMaterializationAuthorizationInput,
  ObserveCredentialMaterializationAuthorizationOutcome,
} from "./contracts/materialization-authorization-v1.js";
