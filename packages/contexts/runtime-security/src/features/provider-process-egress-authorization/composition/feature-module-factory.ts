import {
  detachEgressAuthorityOutcome,
  detachEgressClockView,
  detachEgressDecisionSignature,
  detachEgressScope,
  detachFinalEgressInput,
  detachProvisionalEgressInput,
  isNodeProxy,
} from "../adapters/node-egress-boundary.js";
import { deepFreezeEgress } from "../application/immutable.js";
import { createProviderProcessEgressAuthorization } from
  "../application/provider-process-egress-authorization.js";
import type { EgressAuthorityOwnerReadPort } from
  "../application/ports/outbound/egress-authority-owner.js";
import type { EgressControlClock } from "../application/ports/outbound/egress-control-clock.js";
import type { EgressCanonicalDigest, EgressDecisionSigner, EgressDecisionVerifier } from
  "../application/ports/outbound/egress-cryptography.js";
import type {
  EgressAuthorityReadOutcomeV1,
  EgressControlTimeV1,
  FirstApplicationByteGrantPayloadV1,
  ProvisionalEgressAuthorizationV1,
  RequestFinalEgressAuthorizationOutcomeV1,
  RequestFinalEgressAuthorizationV1,
  RequestProvisionalEgressAuthorizationOutcomeV1,
  RequestProvisionalEgressAuthorizationV1,
  TrustedEgressCompositionScopeV1,
  TrustedHostRequestProjectionV1,
} from "../contracts/provider-process-egress-authorization-v1.js";
import type {
  EgressAuthorityReadOutcome,
  EgressControlTime,
  EgressDecisionSignature,
  FirstApplicationByteGrantPayload,
  ProvisionalEgressAuthorization,
  RequestFinalEgressAuthorization,
  RequestFinalEgressAuthorizationOutcome,
  RequestProvisionalEgressAuthorization,
  RequestProvisionalEgressAuthorizationOutcome,
  TrustedEgressCompositionScope,
  TrustedHostRequestProjection,
} from "../domain/provider-process-egress-model.js";

export interface ProviderProcessEgressAuthorizationDependencies {
  readonly scope: TrustedEgressCompositionScope;
  readonly authorityOwner: EgressAuthorityOwnerReadPort;
  readonly clock: EgressControlClock;
  readonly digest: EgressCanonicalDigest;
  readonly signer: EgressDecisionSigner;
  readonly verifier: EgressDecisionVerifier;
}

const snapshotFunction = (owner: unknown, name: string): ((...input: never[]) => unknown) => {
  if (owner === null || typeof owner !== "object" || isNodeProxy(owner)) {
    throw new TypeError("invalid dependency");
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") {
    throw new TypeError("invalid dependency operation");
  }
  return descriptor.value.bind(owner) as (...input: never[]) => unknown;
};

const requestFromDto = (request: TrustedHostRequestProjectionV1): TrustedHostRequestProjection => ({
  method: request.method, scheme: request.scheme,
  authority: { hostname: request.authority.hostname, port: request.authority.port },
  requestTarget: { digest: request.requestTarget.digest,
    byteLength: request.requestTarget.byteLength },
  headers: { canonicalDigest: request.headers.canonicalDigest, fieldCount: request.headers.fieldCount,
    credentialFields: request.headers.credentialFields.map(field => ({ name: field.name,
      credentialBindingDigest: field.credentialBindingDigest, valueDigest: field.valueDigest,
      byteLength: field.byteLength })) },
  body: { digest: request.body.digest, byteLength: request.body.byteLength },
  framing: { protocol: request.framing.protocol, requestTarget: request.framing.requestTarget,
    authoritySource: request.framing.authoritySource, contentLength: request.framing.contentLength,
    transferEncoding: request.framing.transferEncoding,
    connectionSpecificHeaders: request.framing.connectionSpecificHeaders },
});

const provisionalFromDto = (decision: ProvisionalEgressAuthorizationV1):
  ProvisionalEgressAuthorization => ({
  authorizationRequestId: decision.authorizationRequestId, authorityRef: decision.authorityRef,
  scope: decision.scope, policy: decision.policy, providerAccess: decision.providerAccess,
  request: requestFromDto(decision.request), requestDigest: decision.requestDigest,
  time: decision.time, signingKey: decision.signingKey, decisionDigest: decision.decisionDigest,
  signature: decision.signature,
});

const provisionalInputFromDto = (input: RequestProvisionalEgressAuthorizationV1):
  RequestProvisionalEgressAuthorization => ({
  authorizationRequestId: input.authorizationRequestId, request: requestFromDto(input.request),
});

const finalInputFromDto = (input: RequestFinalEgressAuthorizationV1):
  RequestFinalEgressAuthorization => ({
  provisional: provisionalFromDto(input.provisional), boundaryUseId: input.boundaryUseId,
  connectionAttemptId: input.connectionAttemptId, streamId: input.streamId,
  transport: input.transport,
  resolver: { resolverIdentity: input.resolver.resolverIdentity,
    resolverEpoch: input.resolver.resolverEpoch, resolutionCount: input.resolver.resolutionCount,
    addresses: input.resolver.addresses.map(address => ({ family: address.family,
      address: address.address, classification: address.classification })) },
  pinnedDestination: { ...input.pinnedDestination }, observedPeer: { ...input.observedPeer },
  tls: { ...input.tls }, request: requestFromDto(input.request), redirectHop: input.redirectHop,
});

const provisionalToDto = (decision: ProvisionalEgressAuthorization):
  ProvisionalEgressAuthorizationV1 => ({
  contractVersion: "provider-process-egress-provisional-decision/v1",
  authorizationRequestId: decision.authorizationRequestId, authorityRef: decision.authorityRef,
  scope: decision.scope, policy: decision.policy, providerAccess: decision.providerAccess,
  request: decision.request, requestDigest: decision.requestDigest, time: decision.time,
  signingKey: decision.signingKey, decisionDigest: decision.decisionDigest,
  signature: decision.signature,
});

const provisionalSigningDocument = (decision: Omit<ProvisionalEgressAuthorization,
  "decisionDigest" | "signature">) => ({
  contractVersion: "provider-process-egress-provisional-decision/v1" as const,
  authorizationRequestId: decision.authorizationRequestId, authorityRef: decision.authorityRef,
  scope: decision.scope, policy: decision.policy, providerAccess: decision.providerAccess,
  request: decision.request, requestDigest: decision.requestDigest, time: decision.time,
  signingKey: decision.signingKey,
});

const grantPayloadToDto = (payload: FirstApplicationByteGrantPayload):
  FirstApplicationByteGrantPayloadV1 => ({
  contractVersion: "provider-process-first-application-byte-grant/v1",
  authorizationRequestId: payload.authorizationRequestId, authorityRef: payload.authorityRef,
  scope: payload.scope, policy: payload.policy, providerAccess: payload.providerAccess,
  resolver: payload.resolver, selectedPeer: payload.selectedPeer, tls: payload.tls,
  limits: payload.limits, request: payload.request, requestDigest: payload.requestDigest,
  time: payload.time, boundaryUseId: payload.boundaryUseId,
  connectionAttemptId: payload.connectionAttemptId, streamId: payload.streamId,
  automaticRetryAuthorized: payload.automaticRetryAuthorized,
  poolingAuthorized: payload.poolingAuthorized, consumption: payload.consumption,
});

const provisionalOutcomeToDto = (outcome: RequestProvisionalEgressAuthorizationOutcome):
  RequestProvisionalEgressAuthorizationOutcomeV1 => outcome.status === "authorized"
  ? { status: "authorized", decision: provisionalToDto(outcome.decision) }
  : { status: "denied", evidence: { contractVersion: "provider-process-egress-denial-evidence/v1",
    ...outcome.evidence } };

const finalOutcomeToDto = (outcome: RequestFinalEgressAuthorizationOutcome):
  RequestFinalEgressAuthorizationOutcomeV1 => outcome.status === "authorized"
  ? { status: "authorized", grant: { payload: grantPayloadToDto(outcome.grant.payload),
    finalAuthorizationDigest: outcome.grant.finalAuthorizationDigest,
    signature: outcome.grant.signature,
    evidence: { contractVersion: "provider-process-egress-grant-evidence/v1",
      ...outcome.grant.evidence } } }
  : { status: "denied", evidence: { contractVersion: "provider-process-egress-denial-evidence/v1",
    ...outcome.evidence } };

const ownerFromDto = (value: unknown): EgressAuthorityReadOutcome => {
  const outcome = detachEgressAuthorityOutcome(value) as EgressAuthorityReadOutcomeV1;
  if (outcome.status === "current") {
    return { status: "current", authority: { authorityRef: outcome.authority.authorityRef,
      policy: outcome.authority.policy, providerAccess: outcome.authority.providerAccess } };
  }
  if (outcome.status === "denied") {return { status: "denied", reason: outcome.reason };}
  return { status: "indeterminate", reason: outcome.reason };
};

const ownerUnavailable = () => deepFreezeEgress({ status: "indeterminate" as const,
  reason: "owner_unavailable" as const });
const ownerMalformed = () => deepFreezeEgress({ status: "indeterminate" as const,
  reason: "owner_malformed" as const });

const snapshotDependencies = (input: ProviderProcessEgressAuthorizationDependencies) => {
  if (input === null || typeof input !== "object" || isNodeProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype) {throw new TypeError("invalid dependencies");}
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const expected = ["authorityOwner", "clock", "digest", "scope", "signer", "verifier"].toSorted();
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some(key => typeof key === "symbol")) {throw new TypeError("inexact dependencies");}
  const keys = (ownKeys as string[]).toSorted();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
    keys.some(key => descriptors[key] === undefined || !("value" in descriptors[key]!))) {
    throw new TypeError("inexact dependencies");
  }
  const scope = deepFreezeEgress(detachEgressScope(input.scope) as TrustedEgressCompositionScopeV1);
  const resolvePolicy = snapshotFunction(input.authorityOwner, "resolvePolicy") as
    EgressAuthorityOwnerReadPort["resolvePolicy"];
  const readCurrent = snapshotFunction(input.authorityOwner, "readCurrent") as
    EgressAuthorityOwnerReadPort["readCurrent"];
  const clockRead = snapshotFunction(input.clock, "read") as () => EgressControlTimeV1;
  const digest = snapshotFunction(input.digest, "digest") as (value: string) => string;
  const sign = snapshotFunction(input.signer, "sign") as EgressDecisionSigner["sign"];
  const verify = snapshotFunction(input.verifier, "verify") as
    (value: string, signature: EgressDecisionSignature) => boolean;
  const callOwner = async (operation: (...args: never[]) => unknown, ownerInput: unknown) => {
    let returned: unknown;
    try { returned = await operation(ownerInput as never); } catch { return ownerUnavailable(); }
    try { return deepFreezeEgress(ownerFromDto(returned)); } catch { return ownerMalformed(); }
  };
  return Object.freeze({
    scope,
    authorityOwner: Object.freeze({
      resolvePolicy: (ownerInput: Parameters<EgressAuthorityOwnerReadPort["resolvePolicy"]>[0]) =>
        callOwner(resolvePolicy, ownerInput),
      readCurrent: (ownerInput: Parameters<EgressAuthorityOwnerReadPort["readCurrent"]>[0]) =>
        callOwner(readCurrent, ownerInput),
    }),
    clock: Object.freeze({ read: () => deepFreezeEgress(
      detachEgressClockView(clockRead()) as EgressControlTime) }),
    digest: Object.freeze({ digest }),
    signer: Object.freeze({ sign: (value: string, key: Parameters<EgressDecisionSigner["sign"]>[1]) =>
      deepFreezeEgress(detachEgressDecisionSignature(sign(value, key)) as EgressDecisionSignature) }),
    verifier: Object.freeze({ verify: (value: string, signature: EgressDecisionSignature) =>
      verify(value, signature) === true }),
    signedDocuments: Object.freeze({ provisional: provisionalSigningDocument,
      grant: grantPayloadToDto }),
  });
};

const invalid = (phase: "provisional" | "final") => deepFreezeEgress({ status: "denied" as const,
  evidence: { contractVersion: "provider-process-egress-denial-evidence/v1" as const,
    phase, issueCode: "invalid_input" as const, authorizationRef: "invalid" } });

export const createProviderProcessEgressAuthorizationFeature = (
  dependencies: ProviderProcessEgressAuthorizationDependencies,
) => {
  const authority = createProviderProcessEgressAuthorization(snapshotDependencies(dependencies));
  const hostEgressAuthorizationV1 = Object.freeze({
    async requestProvisional(input: RequestProvisionalEgressAuthorizationV1) {
      try {
        const dto = detachProvisionalEgressInput(input) as RequestProvisionalEgressAuthorizationV1;
        return deepFreezeEgress(provisionalOutcomeToDto(
          await authority.requestProvisional(provisionalInputFromDto(dto))));
      } catch { return invalid("provisional"); }
    },
    async authorizeFirstApplicationByte(input: RequestFinalEgressAuthorizationV1) {
      try {
        const dto = detachFinalEgressInput(input) as RequestFinalEgressAuthorizationV1;
        return deepFreezeEgress(finalOutcomeToDto(
          await authority.authorizeFirstApplicationByte(finalInputFromDto(dto))));
      } catch { return invalid("final"); }
    },
  });
  return Object.freeze({ hostEgressAuthorizationV1 });
};
