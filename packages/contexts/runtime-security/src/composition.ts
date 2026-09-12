export { createNodePathCanonicalizer } from "./features/setup-source-inspection-authorization/adapters/outbound/node-path-canonicalizer.js";
export { createCurrentEgressOwner, canonicalEgressValue, captureCurrentEgressResolve, currentEgressDigest } from "./features/provider-process-egress-authorization/composition/current-egress-owner.js";
export type { CurrentEgressOwnerInput, CurrentEgressDispatchHead, CurrentEgressEndorsement,
  CurrentEgressOperation, CurrentEgressRoute } from "./features/provider-process-egress-authorization/composition/current-egress-inputs.js";
export { snapshotDispatchAuthorityHead } from "./features/contained-turn-dispatch-authority/domain/dispatch-authority-head.js";
export type { PostgresDispatchConsumptionRepository } from "./features/contained-turn-dispatch-authority/adapters/outbound/postgres/dispatch-consumption-repository.js";
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
import { createEgressValidation } from "./features/contained-turn-egress/domain/validation.js";
import { createContainedTurnEgressGatewayCore } from "./features/contained-turn-egress/composition/gateway.js";
import { createNodeMonotonicClock } from "./features/contained-turn-egress/adapters/outbound/node-monotonic-clock.js";
import { createNodeEgressSecurityPrimitives } from "./features/contained-turn-egress/adapters/outbound/node-security-primitives.js";
import type { ContainedTurnEgressDependencies } from
  "./features/contained-turn-egress/application/contained-turn-egress-dependencies.js";
import type { ProviderRouteAuthoritySnapshotV1 } from "./features/contained-turn-egress/domain/provider-route-authority.js";
import type { TrustedEgressHostIdentityV1 } from "./features/contained-turn-egress/domain/host-identity.js";

const primitives = createNodeEgressSecurityPrimitives();
export const createContainedTurnEgressGateway = (identity: TrustedEgressHostIdentityV1,
  dependencies: ContainedTurnEgressDependencies) =>
  createContainedTurnEgressGatewayCore(identity, dependencies, primitives, createNodeMonotonicClock());
/** Pure private-composition projection for the dormant route candidate's dispatch grant.
 * The existing dispatch owner must commit this digest before egress; legacy/unbound digests fail closed.
 * Provider Access still owns resolution/revalidation of every fact in the projection. */
export const containedTurnEgressProviderBindingDigest = (route: ProviderRouteAuthoritySnapshotV1): string | undefined => {
  const validation = createEgressValidation(primitives); const captured = validation.snapshotRoute(route);
  return captured === undefined ? undefined : validation.routeBindingDigest(captured);
};
export { createNodeEd25519EgressSigner } from
  "./features/contained-turn-egress/adapters/outbound/node-ed25519.js";
export type {
  BufferedEgressRequestV1,
  EgressAuthorizationBodyV1,
  EgressAuthorizationEnvelopeV1,
  EgressTransportObservationV1,
} from "./features/contained-turn-egress/domain/egress-authorization.js";
export type { ContainedTurnEgressRequest, ContainedTurnEgressResult } from
  "./features/contained-turn-egress/domain/egress-request.js";
export type { EgressPolicyTimeSnapshotV1 } from "./features/contained-turn-egress/domain/egress-policy.js";
export type { NetworkAddressV1 } from "./features/contained-turn-egress/domain/network-address.js";
export type { TrustedEgressHostIdentityV1 } from "./features/contained-turn-egress/domain/host-identity.js";
export type {
  ProviderRouteAuthoritySnapshotV1,
  ProviderRouteRevalidationV1,
} from "./features/contained-turn-egress/domain/provider-route-authority.js";
export type { ContainedTurnEgress } from "./features/contained-turn-egress/application/contained-turn-egress.js";
export type { ContainedTurnEgressDependencies } from
  "./features/contained-turn-egress/application/contained-turn-egress-dependencies.js";
export type { EgressAuthorizationSignerV1 } from
  "./features/contained-turn-egress/application/ports/outbound/egress-authorization-signer.js";
export type { EgressPolicyTimeAuthorityV1 } from
  "./features/contained-turn-egress/application/ports/outbound/egress-policy-time-authority.js";
export type { ProviderRouteAuthorityV1 } from
  "./features/contained-turn-egress/application/ports/outbound/provider-route-authority.js";
export type {
  EgressTransportGatewayV1,
  EgressTransportV1,
  TrustedEgressFirstWriteV1,
} from "./features/contained-turn-egress/application/ports/outbound/egress-exchange.js";
export type { NodeEd25519SignerIdentity } from "./features/contained-turn-egress/adapters/outbound/node-ed25519.js";
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
export { createDispatchAcceptanceFeature, type DispatchAcceptanceDependencies } from
  './features/contained-turn-dispatch-authority/composition/dispatch-acceptance-factory.js';
export type { DispatchAcceptanceIntent, DispatchAcceptancePolicy, DispatchAcceptanceDecision,
  DispatchAcceptanceStore, DispatchPolicyReadPort, DispatchPublicationRepository,
  DispatchAcceptedPreparation } from
  './features/contained-turn-dispatch-authority/application/ports/outbound/dispatch-acceptance-owner.js';
export { createPostgresDispatchAcceptanceStore } from
  './features/contained-turn-dispatch-authority/adapters/outbound/postgres/dispatch-acceptance-store.js';
export { createPostgresDispatchConsumptionRepository } from
  './features/contained-turn-dispatch-authority/adapters/outbound/postgres/dispatch-consumption-repository.js';

export {createOrdinarySecurityOwner, type OrdinarySecurityOwnerOptions, type OrdinarySecurityOwner,
  type OrdinarySecurityGrant, type OrdinarySecurityObservation, type OrdinarySecurityScope,
  type OrdinarySecurityInput, type OrdinarySecurityPolicy, type OrdinarySecurityAuthority,
  type OrdinarySecuritySettlement} from "./features/contained-turn-dispatch-authority/composition/ordinary-security-factory.js";
