import {
  detachEgressAuthorityOutcomeV2,
  detachEgressClockView,
  detachEgressScope,
  detachFinalEgressInputV2,
  detachProvisionalEgressDecisionV2,
  detachProvisionalEgressInputV2,
  detachSignedEgressGrantV2,
  isNodeProxy,
} from "../adapters/node-egress-boundary.js";
import { createNodeEd25519EgressCandidateSeal, createNodeSha256EgressDigest } from
  "../adapters/outbound/node-egress-cryptography.js";
import { deepFreezeEgress } from "../application/immutable.js";
import { canonicalEgressValue, digestCanonical, finalAuthorizationPreimage, provisionalPreimage } from
  "../application/egress-canonical.js";
import { createProviderProcessEgressAuthorization } from
  "../application/provider-process-egress-authorization.js";
import type { GrantPayloadBeforeFingerprint } from
  "../application/provider-process-egress-authorization.js";
import type { EgressAuthorityOwnerReadPort } from
  "../application/ports/outbound/egress-authority-owner.js";
import type { EgressControlClock } from "../application/ports/outbound/egress-control-clock.js";
import type {
  EgressAuthorityReadOutcomeV2,
  EgressCurrentAuthorityV2,
  EgressDecisionSignatureV2,
  EgressSigningKeyMetadataV2,
  FirstApplicationByteGrantPayloadV2,
  HostEgressVerifierV2,
  ProvisionalEgressAuthorizationV2,
  ProviderProcessEgressAuthorizationV2,
  RequestFinalEgressAuthorizationOutcomeV2,
  RequestFinalEgressAuthorizationV2,
  RequestProvisionalEgressAuthorizationOutcomeV2,
  RequestProvisionalEgressAuthorizationV2,
  SignedFirstApplicationByteGrantV2,
  TrustedEgressCompositionScopeV2,
  TrustedHostRequestProjectionV2,
} from "../contracts/provider-process-egress-authorization-v2.js";
import type {
  EgressAuthorityReadOutcome,
  EgressControlTime,
  EgressCurrentAuthority,
  EgressDecisionSignature,
  FirstApplicationByteGrantPayload,
  ProvisionalEgressAuthorization,
  RequestFinalEgressAuthorization,
  RequestProvisionalEgressAuthorization,
  TrustedHostRequestProjection,
} from "../domain/provider-process-egress-model.js";

export interface ProviderProcessEgressAuthorizationV2AuthorityOwner {
  resolvePolicy(input: {
    readonly scope: TrustedEgressCompositionScopeV2;
    readonly authorizationRequestId: string;
    readonly request: TrustedHostRequestProjectionV2;
  }): Promise<EgressAuthorityReadOutcomeV2>;
  readCurrent(input: {
    readonly scope: TrustedEgressCompositionScopeV2;
    readonly authorityRef: string;
  }): Promise<EgressAuthorityReadOutcomeV2>;
}

export interface ProviderProcessEgressAuthorizationV2CandidateDependencies {
  readonly scope: TrustedEgressCompositionScopeV2;
  readonly hostReservationId: string;
  readonly keyRef: string;
  readonly keyGeneration: string;
  readonly signerRevision: string;
  readonly authorityOwner: ProviderProcessEgressAuthorizationV2AuthorityOwner;
  readonly clock: EgressControlClock;
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

const snapshotDependencies = (input: ProviderProcessEgressAuthorizationV2CandidateDependencies) => {
  if (input === null || typeof input !== "object" || isNodeProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype) {throw new TypeError("invalid dependencies");}
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const expected = ["authorityOwner", "clock", "hostReservationId", "keyGeneration", "keyRef",
    "scope", "signerRevision"].toSorted();
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key === "symbol") || keys.length !== expected.length ||
    (keys as string[]).toSorted().some((key, index) => key !== expected[index]) ||
    (keys as string[]).some(key => descriptors[key] === undefined ||
      !("value" in descriptors[key]!))) {throw new TypeError("inexact dependencies");}
  const values = Object.fromEntries(expected.map(key => [key, descriptors[key]!.value]));
  for (const name of ["hostReservationId", "keyGeneration", "keyRef", "signerRevision"] as const) {
    if (typeof values[name] !== "string") {throw new TypeError("invalid candidate binding");}
  }
  const scope = deepFreezeEgress(detachEgressScope(values.scope)) as TrustedEgressCompositionScopeV2;
  const resolvePolicy = snapshotFunction(values.authorityOwner, "resolvePolicy");
  const readCurrent = snapshotFunction(values.authorityOwner, "readCurrent");
  const readClock = snapshotFunction(values.clock, "read");
  return { scope, resolvePolicy, readCurrent, readClock,
    binding: { hostReservationId: values.hostReservationId as string,
      keyGeneration: values.keyGeneration as string, keyRef: values.keyRef as string,
      signerRevision: values.signerRevision as string } };
};

const requestFromDto = (request: TrustedHostRequestProjectionV2): TrustedHostRequestProjection => ({
  method: request.method, scheme: request.scheme,
  authority: { hostname: request.authority.hostname, port: request.authority.port },
  requestTarget: { digest: request.requestTarget.digest, byteLength: request.requestTarget.byteLength },
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

const policyToDto = (policy: EgressCurrentAuthority["policy"]): EgressCurrentAuthorityV2["policy"] => ({
  policyRef: policy.policyRef, policyRevision: policy.policyRevision,
  policyGeneration: policy.policyGeneration, authorizedRequestDigest: policy.authorizedRequestDigest,
  origin: policy.origin, dnsIdentity: policy.dnsIdentity, tlsPolicyDigest: policy.tlsPolicyDigest,
  limits: policy.limits, decisionTtlMilliseconds: policy.decisionTtlMilliseconds,
  revoked: policy.revoked,
});

const signingKeyToV2 = (key: EgressCurrentAuthority["policy"]["signingKey"]):
  EgressSigningKeyMetadataV2 => {
  if (key.algorithm !== "ed25519") {throw new TypeError("invalid V2 signing key");}
  return { algorithm: key.algorithm, signatureEncoding: key.signatureEncoding,
    keyRef: key.keyRef, publicKeyDigest: key.publicKeyDigest, keyGeneration: key.keyGeneration,
    signerRevision: key.signerRevision, hostReservationId: key.hostReservationId };
};

const signatureToV2 = (signature: EgressDecisionSignature): EgressDecisionSignatureV2 => {
  if (signature.algorithm !== "ed25519") {throw new TypeError("invalid V2 signature");}
  return { ...signingKeyToV2(signature), value: signature.value };
};

const provisionalFromDto = (decision: ProvisionalEgressAuthorizationV2):
  ProvisionalEgressAuthorization => ({
  authorizationRequestId: decision.authorizationRequestId, authorityRef: decision.authorityRef,
  scope: decision.scope, policy: { ...decision.policy, signingKey: decision.signingKey },
  providerAccess: decision.providerAccess, request: requestFromDto(decision.request),
  requestDigest: decision.requestDigest, time: decision.time, signingKey: decision.signingKey,
  decisionDigest: decision.decisionDigest, signature: decision.signature,
});

const provisionalInputFromDto = (input: RequestProvisionalEgressAuthorizationV2):
  RequestProvisionalEgressAuthorization => ({ authorizationRequestId: input.authorizationRequestId,
  request: requestFromDto(input.request) });

const finalInputFromDto = (input: RequestFinalEgressAuthorizationV2):
  RequestFinalEgressAuthorization => ({ provisional: provisionalFromDto(input.provisional),
  boundaryUseId: input.boundaryUseId, connectionAttemptId: input.connectionAttemptId,
  streamId: input.streamId, transport: input.transport,
  resolver: { resolverIdentity: input.resolver.resolverIdentity,
    resolverEpoch: input.resolver.resolverEpoch, resolutionCount: input.resolver.resolutionCount,
    addresses: input.resolver.addresses.map(address => ({ ...address })) },
  pinnedDestination: { ...input.pinnedDestination }, observedPeer: { ...input.observedPeer },
  tls: { ...input.tls }, request: requestFromDto(input.request), redirectHop: input.redirectHop });

const provisionalToDto = (decision: ProvisionalEgressAuthorization):
  ProvisionalEgressAuthorizationV2 => ({
  contractVersion: "provider-process-egress-provisional-decision/v2",
  authorizationRequestId: decision.authorizationRequestId, authorityRef: decision.authorityRef,
  scope: decision.scope, policy: policyToDto(decision.policy),
  providerAccess: decision.providerAccess, request: decision.request,
  requestDigest: decision.requestDigest, time: decision.time,
  signingKey: signingKeyToV2(decision.signingKey),
  decisionDigest: decision.decisionDigest, signature: signatureToV2(decision.signature),
});

const grantFieldsToDto = (payload: GrantPayloadBeforeFingerprint) => ({
  contractVersion: "provider-process-first-application-byte-grant/v2" as const,
  authorizationRequestId: payload.authorizationRequestId, authorityRef: payload.authorityRef,
  scope: payload.scope, policy: policyToDto(payload.policy), providerAccess: payload.providerAccess,
  resolver: payload.resolver, selectedPeer: payload.selectedPeer, tls: payload.tls,
  limits: payload.limits, request: payload.request, requestDigest: payload.requestDigest,
  time: payload.time, boundaryUseId: payload.boundaryUseId,
  connectionAttemptId: payload.connectionAttemptId, streamId: payload.streamId,
  redirectHop: payload.redirectHop, provisionalDecisionDigest: payload.provisionalDecisionDigest,
  automaticRetryAuthorized: payload.automaticRetryAuthorized,
  poolingAuthorized: payload.poolingAuthorized,
});

const grantPayloadToDto = (payload: FirstApplicationByteGrantPayload):
  FirstApplicationByteGrantPayloadV2 => ({ ...grantFieldsToDto(payload),
  consumption: { ...payload.consumption, journalKey: { ...payload.consumption.journalKey,
    namespace: "provider-process-egress/v2" } } });

const provisionalSigningDocument = (decision: Omit<ProvisionalEgressAuthorization,
  "decisionDigest" | "signature">) => ({ contractVersion:
  "provider-process-egress-provisional-decision/v2" as const,
  authorizationRequestId: decision.authorizationRequestId, authorityRef: decision.authorityRef,
  scope: decision.scope, policy: policyToDto(decision.policy), providerAccess: decision.providerAccess,
  request: decision.request, requestDigest: decision.requestDigest, time: decision.time,
  signingKey: decision.signingKey });

const grantConsumptionDocument = (payload: GrantPayloadBeforeFingerprint) => ({
  ...grantFieldsToDto(payload), consumption: { ...payload.consumption,
    journalKey: { ...payload.consumption.journalKey, namespace: "provider-process-egress/v2" } },
});

const grantSigningDocument = (payload: FirstApplicationByteGrantPayload) => ({
  payload: grantPayloadToDto(payload),
  evidence: { contractVersion: "provider-process-egress-grant-evidence/v2" as const },
});

const invalid = (phase: "provisional" | "final") => deepFreezeEgress({ status: "denied" as const,
  evidence: { contractVersion: "provider-process-egress-denial-evidence/v2" as const,
    phase, issueCode: "invalid_input" as const, authorizationRef: "invalid" } });

export const createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate = (
  dependencies: ProviderProcessEgressAuthorizationV2CandidateDependencies,
) => {
  const captured = snapshotDependencies(dependencies);
  const seal = createNodeEd25519EgressCandidateSeal(captured.binding);
  const ownerCall = async (operation: (...input: never[]) => unknown, input: unknown):
    Promise<EgressAuthorityReadOutcome> => {
    let returned: unknown;
    try { returned = await operation(input as never); }
    catch { return { status: "indeterminate", reason: "owner_unavailable" }; }
    let outcome: EgressAuthorityReadOutcomeV2;
    try { outcome = deepFreezeEgress(detachEgressAuthorityOutcomeV2(returned)) as
      EgressAuthorityReadOutcomeV2; }
    catch { return { status: "indeterminate", reason: "owner_malformed" }; }
    if (outcome.status !== "current") {return outcome;}
    return { status: "current", authority: { authorityRef: outcome.authority.authorityRef,
      policy: { ...outcome.authority.policy, signingKey: seal.signingKey },
      providerAccess: outcome.authority.providerAccess } };
  };
  const authorityOwner: EgressAuthorityOwnerReadPort = Object.freeze({
    resolvePolicy: (input: Parameters<EgressAuthorityOwnerReadPort["resolvePolicy"]>[0]) =>
      ownerCall(captured.resolvePolicy, input),
    readCurrent: (input: Parameters<EgressAuthorityOwnerReadPort["readCurrent"]>[0]) =>
      ownerCall(captured.readCurrent, input),
  });
  const authority = createProviderProcessEgressAuthorization({ scope: captured.scope,
    authorityOwner, clock: Object.freeze({ read: () => deepFreezeEgress(
      detachEgressClockView(captured.readClock())) as EgressControlTime }),
    digest: createNodeSha256EgressDigest(), signer: seal.signer, verifier: seal.verifier,
    validSigningKey: key => key.algorithm === "ed25519" &&
      key.publicKeyDigest === seal.signingKey.publicKeyDigest &&
      key.keyRef === seal.signingKey.keyRef && key.keyGeneration === seal.signingKey.keyGeneration &&
      key.signerRevision === seal.signingKey.signerRevision &&
      key.hostReservationId === seal.signingKey.hostReservationId,
    journalNamespace: "provider-process-egress/v2",
    signedDocuments: Object.freeze({ provisional: provisionalSigningDocument,
      consumption: grantConsumptionDocument, grant: grantSigningDocument }) });
  const hostEgressAuthorizationV2: ProviderProcessEgressAuthorizationV2 = Object.freeze({
    async requestProvisional(input: RequestProvisionalEgressAuthorizationV2) {
      try {
        const dto = detachProvisionalEgressInputV2(input) as RequestProvisionalEgressAuthorizationV2;
        const outcome = await authority.requestProvisional(provisionalInputFromDto(dto));
        const mapped: RequestProvisionalEgressAuthorizationOutcomeV2 = outcome.status === "authorized"
          ? { status: "authorized", decision: provisionalToDto(outcome.decision) }
          : { status: "denied", evidence: { contractVersion:
            "provider-process-egress-denial-evidence/v2", ...outcome.evidence } };
        return deepFreezeEgress(mapped);
      } catch { return invalid("provisional"); }
    },
    async authorizeFirstApplicationByte(input: RequestFinalEgressAuthorizationV2) {
      try {
        const dto = detachFinalEgressInputV2(input) as RequestFinalEgressAuthorizationV2;
        const outcome = await authority.authorizeFirstApplicationByte(finalInputFromDto(dto));
        const mapped: RequestFinalEgressAuthorizationOutcomeV2 = outcome.status === "authorized"
          ? { status: "authorized", grant: { payload: grantPayloadToDto(outcome.grant.payload),
            finalAuthorizationDigest: outcome.grant.finalAuthorizationDigest,
            signature: signatureToV2(outcome.grant.signature),
            evidence: { contractVersion: "provider-process-egress-grant-evidence/v2",
              authorizationRef: outcome.grant.payload.authorizationRequestId,
              boundaryUseRef: outcome.grant.payload.boundaryUseId,
              decisionDigest: outcome.grant.payload.provisionalDecisionDigest,
              finalAuthorizationDigest: outcome.grant.finalAuthorizationDigest,
              signingKey: seal.signingKey } } }
          : { status: "denied", evidence: { contractVersion:
            "provider-process-egress-denial-evidence/v2", ...outcome.evidence } };
        return deepFreezeEgress(mapped);
      } catch { return invalid("final"); }
    },
  });
  const hostEgressVerifierV2: HostEgressVerifierV2 = Object.freeze({ signingKey: seal.signingKey,
    verifyProvisionalDecision(decision: ProvisionalEgressAuthorizationV2) {
      try {
        const detached = detachProvisionalEgressDecisionV2(decision) as
          ProvisionalEgressAuthorizationV2;
        const internal = provisionalFromDto(detached);
        const { decisionDigest: _digest, signature, ...unsigned } = internal;
        const calculated = digestCanonical(createNodeSha256EgressDigest(),
          provisionalPreimage(provisionalSigningDocument(unsigned)));
        return calculated === detached.decisionDigest && seal.verifier.verify(calculated, signature);
      } catch { return false; }
    },
    verifyGrant(grant: SignedFirstApplicationByteGrantV2) {
      try {
        const detached = detachSignedEgressGrantV2(grant) as SignedFirstApplicationByteGrantV2;
        const calculated = digestCanonical(createNodeSha256EgressDigest(),
          finalAuthorizationPreimage({ payload: detached.payload,
            evidence: { contractVersion: "provider-process-egress-grant-evidence/v2" } }));
        return calculated === detached.finalAuthorizationDigest &&
          detached.evidence.authorizationRef === detached.payload.authorizationRequestId &&
          detached.evidence.boundaryUseRef === detached.payload.boundaryUseId &&
          detached.evidence.decisionDigest === detached.payload.provisionalDecisionDigest &&
          detached.evidence.finalAuthorizationDigest === detached.finalAuthorizationDigest &&
          canonicalEgressValue(detached.evidence.signingKey) === canonicalEgressValue(seal.signingKey) &&
          seal.verifier.verify(calculated, detached.signature);
      } catch { return false; }
    },
  });
  return Object.freeze({ hostEgressAuthorizationV2, hostEgressVerifierV2,
    dispose: () => { seal.dispose(); }, isDisposed: () => seal.isDisposed() });
};
