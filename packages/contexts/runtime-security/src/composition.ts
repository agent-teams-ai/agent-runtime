export { createNodePathCanonicalizer } from "./features/setup-source-inspection-authorization/adapters/outbound/node-path-canonicalizer.js";
export { createCurrentEgressOwner } from "./features/provider-process-egress-authorization/composition/current-egress-owner.js";
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
import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { createEgressValidation } from "./features/contained-turn-egress/domain/validation.js";
import { createContainedTurnEgressGatewayCore } from "./features/contained-turn-egress/composition/gateway.js";
import { createNodeMonotonicClock } from "./features/contained-turn-egress/adapters/outbound/node-monotonic-clock.js";
import type { ContainedTurnEgressDependencies } from
  "./features/contained-turn-egress/application/contained-turn-egress-dependencies.js";
import type { ProviderRouteAuthoritySnapshotV1 } from "./features/contained-turn-egress/domain/provider-route-authority.js";
import type { TrustedEgressHostIdentityV1 } from "./features/contained-turn-egress/domain/host-identity.js";

const exactObject = <Name extends string>(value: unknown, names: readonly Name[]) => {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {return;}
  try {const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) {return;}
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !names.includes(key as Name))) {return;}
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null) as Record<Name, unknown>;
    for (const name of names) {const descriptor = descriptors[name]; if (descriptor === undefined || !("value" in descriptor)) {return;}
      result[name] = descriptor.value;} return result as Readonly<Record<Name, unknown>>;} catch {return;}
};
const intrinsicUint8Array = Uint8Array;
const intrinsicDataView = DataView;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get as
  (this: Uint8Array) => ArrayBufferLike;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get as
  (this: Uint8Array) => number;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get as
  (this: Uint8Array) => number;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "length")?.get as
  (this: Uint8Array) => number;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get as
  (this: ArrayBuffer) => number;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get as
  ((this: ArrayBuffer) => boolean) | undefined;
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === "undefined" ? undefined :
  Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get as
    ((this: SharedArrayBuffer) => number) | undefined;

const snapshotUint8Array = (value: unknown, maximumByteLength: number): Uint8Array | undefined => {
  try {
    if (!nodeTypes.isUint8Array(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {return;}
    const source = value as Uint8Array;
    const byteLength = Reflect.apply(typedArrayByteLength, source, []);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maximumByteLength) {return;}
    const backing = Reflect.apply(typedArrayBuffer, source, []);
    if (sharedArrayBufferByteLength !== undefined) {
      try {Reflect.apply(sharedArrayBufferByteLength, backing, []); return;} catch {/* Ordinary ArrayBuffer. */}
    }
    const backingByteLength = Reflect.apply(arrayBufferByteLength, backing, []);
    if (arrayBufferResizable !== undefined && Reflect.apply(arrayBufferResizable, backing, [])) {return;}
    // DataView construction rejects detached ArrayBuffers, including detached zero-length buffers.
    const detachedProof = new intrinsicDataView(backing as ArrayBuffer, 0, 0);
    if (detachedProof.byteLength !== 0) {return;}
    const byteOffset = Reflect.apply(typedArrayByteOffset, source, []);
    const length = Reflect.apply(typedArrayLength, source, []);
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset + byteLength > backingByteLength ||
        length !== byteLength) {return;}
    const output = new intrinsicUint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) {output[index] = source[index]!;}
    return output;
  } catch {return;}
};
const primitives = Object.freeze({
  sha256: (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  exactObject,
  callable: (value: unknown): value is (...args: never[]) => unknown => typeof value === "function" && !nodeTypes.isProxy(value),
  copyBytes: snapshotUint8Array,
  array: (value: unknown): value is unknown[] => Array.isArray(value) && !nodeTypes.isProxy(value),
  canonicalEd25519Signature: (value: unknown): value is string => {if (typeof value !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/u.test(value)) {return false;} const decoded = Buffer.from(value, "base64");
    return decoded.byteLength === 64 && decoded.toString("base64") === value;},
});
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
