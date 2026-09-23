export { snapshotDispatchAuthorityHead } from "./domain/dispatch-authority-head.js";
export type {
  PostgresDispatchAuthorityChange,
  PostgresDispatchAuthoritySnapshot,
  PostgresDispatchConsumptionRepository,
} from "./adapters/outbound/postgres/dispatch-consumption-repository.js";
export type {
  DispatchPgClient,
  DispatchPgDeadlines,
  DispatchPgPool,
} from "./adapters/outbound/postgres/transaction.js";
export { createInMemoryDispatchConsumptionRepository } from "./adapters/outbound/in-memory-dispatch-consumption-repository.js";
export type { InMemoryDispatchConsumptionRepository } from "./adapters/outbound/in-memory-dispatch-consumption-repository.js";
export { createNodeSha256DispatchDigest } from "./adapters/outbound/node-sha256-dispatch-digest.js";
export type { DispatchControlClock } from "./application/ports/outbound/control-clock.js";
export type {
  ConsumeTransactionDecision,
  ConsumeTransactionSnapshot,
  DispatchConsumptionRepository,
  ObservedConsumptionRecord,
  PersistedConsumption,
  SettlementTransactionDecision,
  SettlementTransactionSnapshot,
} from "./application/ports/outbound/dispatch-consumption-repository.js";
export type { DispatchDigest } from "./application/ports/outbound/dispatch-digest.js";
export {
  createContainedTurnDispatchAuthorityFeature,
  type ContainedTurnDispatchAuthorityFeatureDependencies,
} from "./composition/feature-module-factory.js";
export type {
  DispatchAuthorityHead,
  DispatchAuthorityScope,
  DispatchConsumeRequest,
  DispatchPreventionReason as DispatchPreventionRecordReason,
} from "./domain/dispatch-authority-head.js";
export type {
  ContainedTurnProviderDispatchPurpose,
  DispatchAuthorityScope as ContainedTurnDispatchAuthorityScopeV1,
  ContainedTurnDispatchAuthorityV1,
  ConsumeForDispatchInput,
  ConsumeForDispatchOutcome,
  DispatchConsumptionLifecycleState,
  DispatchConsumptionReceipt,
  DispatchConsumptionSettlementReceipt,
  DispatchPreventionEvidence,
  DispatchPreventionReason,
  DispatchSettlementDisposition,
  ObserveDispatchConsumptionInput,
  ObserveDispatchConsumptionOutcome,
  SettleDispatchConsumptionInput,
  SettleDispatchConsumptionOutcome,
} from "./contracts/contained-turn-dispatch-authority-v1.js";
export { createDispatchAcceptanceFeature, type DispatchAcceptanceDependencies } from
  "./composition/dispatch-acceptance-factory.js";
export type {
  DispatchAcceptanceIntent,
  DispatchAcceptancePolicy,
  DispatchAcceptanceDecision,
  DispatchAcceptanceStore,
  DispatchPolicyReadPort,
  DispatchPublicationKey,
  DispatchPublicationRepository,
  DispatchAcceptedPreparation,
} from "./application/ports/outbound/dispatch-acceptance-owner.js";
export type {
  DispatchConsumeResult,
  DispatchConsumptionLifecycle,
  DispatchConsumptionRecordReceipt,
  DispatchPreventionRecord,
  DispatchSettlementRecordReceipt,
  DispatchSettlementResult,
  DispatchSettlementDisposition as PersistedDispatchSettlementDisposition,
  PersistedDispatchConsumeResult,
  PersistedDispatchSettlementResult,
} from "./application/dispatch-consumption-models.js";
export { createPostgresDispatchAcceptanceStore } from
  "./adapters/outbound/postgres/dispatch-acceptance-store.js";
export { createPostgresDispatchConsumptionRepository } from
  "./adapters/outbound/postgres/dispatch-consumption-repository.js";

export {createOrdinarySecurityOwner, type OrdinarySecurityOwnerOptions, type OrdinarySecurityOwner,
  type OrdinarySecurityGrant, type OrdinarySecurityObservation, type OrdinarySecurityScope,
  type OrdinarySecurityInput, type OrdinarySecurityPolicy, type OrdinarySecurityAuthority,
  type OrdinarySecuritySettlement} from "./composition/ordinary-security-factory.js";
export type { OrdinarySecurityBinding } from "./domain/ordinary-security-policy.js";
