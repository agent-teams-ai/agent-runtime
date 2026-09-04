export { createNodePathCanonicalizer } from "./features/setup-source-inspection-authorization/adapters/outbound/node-path-canonicalizer.js";
export { createInMemoryDispatchConsumptionRepository } from "./features/contained-turn-dispatch-authority/adapters/outbound/in-memory-dispatch-consumption-repository.js";
export type { InMemoryDispatchConsumptionRepository } from "./features/contained-turn-dispatch-authority/adapters/outbound/in-memory-dispatch-consumption-repository.js";
export { createNodeSha256DispatchDigest } from "./features/contained-turn-dispatch-authority/adapters/outbound/node-sha256-dispatch-digest.js";
export type { DispatchControlClock } from "./features/contained-turn-dispatch-authority/application/ports/outbound/control-clock.js";
export type {
  DispatchConsumptionRepository,
  PersistedConsumption,
} from "./features/contained-turn-dispatch-authority/application/ports/outbound/dispatch-consumption-repository.js";
export type { DispatchDigest } from "./features/contained-turn-dispatch-authority/application/ports/outbound/dispatch-digest.js";
export {
  createContainedTurnDispatchAuthorityFeature,
  type ContainedTurnDispatchAuthorityFeatureDependencies,
} from "./features/contained-turn-dispatch-authority/composition/feature-module-factory.js";
export type {
  DispatchAuthorityHead,
  DispatchAuthorityScope,
} from "./features/contained-turn-dispatch-authority/domain/dispatch-authority-head.js";
export { createAuthorizeClaudeCodeSetupInspection } from "./features/setup-source-inspection-authorization/application/authorize-claude-code-setup-inspection.js";
export type { PathCanonicalizer } from "./features/setup-source-inspection-authorization/application/ports/outbound/path-canonicalizer.js";
export {
  createSetupInspectionAuthorizationFeature,
  type SetupInspectionAuthorizationDependencies,
} from "./features/setup-source-inspection-authorization/composition/feature-module-factory.js";
export {
  createProviderProcessEgressAuthorizationFeature,
  type ProviderProcessEgressAuthorizationDependencies,
} from "./features/provider-process-egress-authorization/composition/feature-module-factory.js";
export {
  createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate,
  type ProviderProcessEgressAuthorizationV2AuthorityOwner,
  type ProviderProcessEgressAuthorizationV2CandidateDependencies,
} from "./features/provider-process-egress-authorization/composition/ed25519-v2-candidate-factory.js";
export {
  createNodeHmacEgressDecisionSeal,
  createNodeSha256EgressDigest,
} from "./features/provider-process-egress-authorization/adapters/outbound/node-egress-cryptography.js";
export type { EgressControlClock } from
  "./features/provider-process-egress-authorization/application/ports/outbound/egress-control-clock.js";
export type { EgressAuthorityOwnerReadPort } from
  "./features/provider-process-egress-authorization/application/ports/outbound/egress-authority-owner.js";
export type {
  EgressCanonicalDigest,
  EgressDecisionSigner,
  EgressDecisionVerifier,
} from "./features/provider-process-egress-authorization/application/ports/outbound/egress-cryptography.js";
export type {
  EgressAuthorityReadOutcome,
  EgressControlTime,
  EgressCurrentAuthority,
  EgressDecisionSignature,
  EgressSigningKeyMetadata,
  TrustedEgressCompositionScope,
  TrustedHostRequestProjection,
} from "./features/provider-process-egress-authorization/domain/provider-process-egress-model.js";
export type {
  EgressAuthorityReadOutcomeV1,
  EgressCurrentAuthorityV1,
  EgressDecisionSignatureV1,
  ProviderProcessEgressAuthorizationV1,
  RequestFinalEgressAuthorizationV1,
  RequestProvisionalEgressAuthorizationV1,
  SignedFirstApplicationByteGrantV1,
  TrustedEgressCompositionScopeV1,
  TrustedHostRequestProjectionV1,
} from "./features/provider-process-egress-authorization/contracts/provider-process-egress-authorization-v1.js";
export type {
  EgressAuthorityReadOutcomeV2,
  EgressCurrentAuthorityV2,
  EgressDecisionSignatureV2,
  EgressSignatureAlgorithmV2,
  EgressSignatureEncodingV2,
  EgressSigningKeyMetadataV2,
  HostEgressVerifierV2,
  ProvisionalEgressAuthorizationV2,
  ProviderProcessEgressAuthorizationV2,
  RequestFinalEgressAuthorizationV2,
  RequestProvisionalEgressAuthorizationV2,
  SignedFirstApplicationByteGrantV2,
  TrustedEgressCompositionScopeV2,
  TrustedHostRequestProjectionV2,
} from "./features/provider-process-egress-authorization/contracts/provider-process-egress-authorization-v2.js";
