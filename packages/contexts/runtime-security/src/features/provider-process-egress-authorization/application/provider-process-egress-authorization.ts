import type {
  EgressAuthorizationIssueCode,
  EgressAuthorityReadOutcomeV1,
  EgressControlTimeV1,
  EgressCurrentAuthorityV1,
  EgressDenialEvidenceV1,
  FirstApplicationByteGrantPayloadV1,
  ProvisionalEgressAuthorizationV1,
  ProviderProcessEgressAuthorizationV1,
  RequestFinalEgressAuthorizationOutcomeV1,
  RequestFinalEgressAuthorizationV1,
  RequestProvisionalEgressAuthorizationOutcomeV1,
  RequestProvisionalEgressAuthorizationV1,
  TrustedEgressCompositionScopeV1,
  TrustedHostRequestProjectionV1,
} from "../contracts/provider-process-egress-authorization-v1.js";
import { normalizeObservedAddress, normalizePublicAddressSet } from "../domain/public-address.js";
import {
  normalizeHostname, validBudgets, validDigest, validOrigin, validRef, validRequestProjection,
} from "../domain/egress-values.js";
import { canonicalEgressValue, digestCanonical, finalAuthorizationPreimage,
  provisionalPreimage } from "./egress-canonical.js";
import { deepFreezeEgress } from "./immutable.js";
import type { EgressAuthorityOwnerReadPort } from
  "./ports/outbound/egress-authority-owner.js";
import type { EgressControlClock } from "./ports/outbound/egress-control-clock.js";
import type { EgressCanonicalDigest, EgressDecisionSigner, EgressDecisionVerifier } from
  "./ports/outbound/egress-cryptography.js";

export interface ProviderProcessEgressOperations {
  readonly scope: TrustedEgressCompositionScopeV1;
  readonly authorityOwner: EgressAuthorityOwnerReadPort;
  readonly clock: EgressControlClock;
  readonly digest: EgressCanonicalDigest;
  readonly signer: EgressDecisionSigner;
  readonly verifier: EgressDecisionVerifier;
}

type ClockRead = { readonly view: EgressControlTimeV1; readonly issue?: never } |
  { readonly view?: never; readonly issue: EgressAuthorizationIssueCode };
type FinalContext = {
  readonly ref: string;
  readonly decisionDigest: string;
};
type NetworkFacts = {
  readonly addresses: ReturnType<typeof normalizePublicAddressSet>["addresses"];
  readonly peer: string;
};
type GrantDigests = {
  readonly addressSetDigest: string;
  readonly requestFingerprint: string;
};

const same = (left: unknown, right: unknown): boolean =>
  canonicalEgressValue(left) === canonicalEgressValue(right);
const denial = (phase: "provisional" | "final", issueCode: EgressAuthorizationIssueCode,
  authorizationRef: string, decisionDigest?: string) => deepFreezeEgress({ status: "denied" as const,
  evidence: { contractVersion: "provider-process-egress-denial-evidence/v1" as const,
    phase, issueCode, authorizationRef,
    ...(decisionDigest === undefined ? {} : { decisionDigest }) } satisfies EgressDenialEvidenceV1 });

const validScope = (scope: TrustedEgressCompositionScopeV1): boolean =>
  validRef(scope.tenantId) && validRef(scope.projectId) && validRef(scope.operationId) &&
  validDigest(scope.scopeDigest);
const validSigningKey = (key: EgressCurrentAuthorityV1["policy"]["signingKey"]): boolean =>
  key.algorithm === "hmac-sha256-synthetic" && validRef(key.keyRef) && validRef(key.keyGeneration);
const validPolicy = (policy: EgressCurrentAuthorityV1["policy"]): boolean =>
  validRef(policy.policyRef) && validRef(policy.policyRevision) && validRef(policy.policyGeneration) &&
  validDigest(policy.authorizedRequestDigest) && validOrigin(policy.origin) &&
  normalizeHostname(policy.dnsIdentity) === policy.dnsIdentity && validDigest(policy.tlsPolicyDigest) &&
  validBudgets(policy.limits) && Number.isSafeInteger(policy.decisionTtlMilliseconds) &&
  policy.decisionTtlMilliseconds >= 1 && policy.decisionTtlMilliseconds <= 300_000 &&
  validSigningKey(policy.signingKey) && typeof policy.revoked === "boolean";
const validProviderAccess = (access: EgressCurrentAuthorityV1["providerAccess"]): boolean =>
  validRef(access.accessRef) && validRef(access.providerRef) && validRef(access.accountRef) &&
  validRef(access.routeRef) && validDigest(access.routeAuthorityDigest) &&
  validDigest(access.credentialBindingDigest) && validRef(access.routeGeneration) &&
  validRef(access.credentialGeneration);
const validAuthority = (authority: EgressCurrentAuthorityV1): boolean =>
  validRef(authority.authorityRef) && validPolicy(authority.policy) &&
  validProviderAccess(authority.providerAccess);
const ownerIssue = (outcome: Exclude<EgressAuthorityReadOutcomeV1,
  { readonly status: "current" }>): EgressAuthorizationIssueCode => outcome.reason;

const requestProtocolIssue = (request: TrustedHostRequestProjectionV1):
  EgressAuthorizationIssueCode | undefined => {
  if (request.framing.protocol !== "http/1.1") {return "unsupported_protocol";}
  if (request.framing.requestTarget !== "origin-form" || request.framing.authoritySource !== "host" ||
    request.framing.transferEncoding !== "absent" ||
    request.framing.connectionSpecificHeaders !== "absent" ||
    request.framing.contentLength !== request.body.byteLength) {return "unsupported_framing";}
  return undefined;
};

const requestAuthorityIssue = (request: TrustedHostRequestProjectionV1,
  authority: EgressCurrentAuthorityV1, requestDigest: string): EgressAuthorizationIssueCode | undefined => {
  if (authority.policy.revoked) {return "revoked";}
  if (authority.policy.authorizedRequestDigest !== requestDigest) {return "policy_denied";}
  if (request.scheme !== authority.policy.origin.scheme ||
    request.authority.hostname !== authority.policy.origin.hostname ||
    request.authority.port !== authority.policy.origin.port ||
    authority.policy.dnsIdentity !== authority.policy.origin.hostname) {return "origin_invalid";}
  return request.headers.credentialFields.some(field =>
    field.credentialBindingDigest !== authority.providerAccess.credentialBindingDigest)
    ? "policy_denied" : undefined;
};

const verifyProvisional = (provisional: ProvisionalEgressAuthorizationV1,
  operations: ProviderProcessEgressOperations): EgressAuthorizationIssueCode | undefined => {
  const { decisionDigest: _digest, signature: _signature, ...unsigned } = provisional;
  let calculated: string;
  try { calculated = digestCanonical(operations.digest, provisionalPreimage(unsigned)); }
  catch { return "provisional_digest_invalid"; }
  if (calculated !== provisional.decisionDigest) {return "provisional_digest_invalid";}
  const { value: _value, ...signatureKey } = provisional.signature;
  if (!same(provisional.signingKey, signatureKey) || provisional.signature.value.length < 1 ||
    provisional.signature.value.length > 1024) {return "provisional_signature_invalid";}
  try {
    return operations.verifier.verify(provisional.decisionDigest, provisional.signature)
      ? undefined : "provisional_signature_invalid";
  } catch { return "provisional_signature_invalid"; }
};

const createClockReader = (clock: EgressControlClock): (() => ClockRead) => {
  let lastClock: EgressControlTimeV1 | undefined;
  return () => {
    let view: EgressControlTimeV1;
    try { view = clock.read(); } catch { return { issue: "control_time_invalid" }; }
    if (!validRef(view.authorityId) || !validRef(view.epoch) || !Number.isSafeInteger(view.controlTime) ||
      view.controlTime < 0) {return { issue: "control_time_invalid" };}
    if (lastClock !== undefined && (view.authorityId !== lastClock.authorityId ||
      view.epoch !== lastClock.epoch)) {return { issue: "clock_epoch_mismatch" };}
    if (lastClock !== undefined && view.controlTime < lastClock.controlTime) {
      return { issue: "control_time_regressed" };
    }
    lastClock = view;
    return { view };
  };
};

const resolveAuthority = async (input: RequestProvisionalEgressAuthorizationV1,
  operations: ProviderProcessEgressOperations): Promise<EgressAuthorityReadOutcomeV1> => {
  try {
    return await operations.authorityOwner.resolvePolicy(deepFreezeEgress({
      scope: operations.scope, authorizationRequestId: input.authorizationRequestId,
      request: input.request,
    }));
  } catch { return { status: "indeterminate", reason: "owner_unavailable" }; }
};

const signProvisional = (unsigned: Omit<ProvisionalEgressAuthorizationV1,
  "decisionDigest" | "signature">, operations: ProviderProcessEgressOperations,
  ref: string): RequestProvisionalEgressAuthorizationOutcomeV1 => {
  let decisionDigest: string;
  try { decisionDigest = digestCanonical(operations.digest, provisionalPreimage(unsigned)); }
  catch { return denial("provisional", "provisional_digest_invalid", ref); }
  if (!validDigest(decisionDigest)) {
    return denial("provisional", "provisional_digest_invalid", ref);
  }
  try {
    const signature = operations.signer.sign(decisionDigest, unsigned.signingKey);
    const { value: _value, ...signatureKey } = signature;
    if (!same(signatureKey, unsigned.signingKey) || signature.value.length < 1 ||
      signature.value.length > 1024 || !operations.verifier.verify(decisionDigest, signature)) {
      return denial("provisional", "provisional_signature_invalid", ref, decisionDigest);
    }
    return deepFreezeEgress({ status: "authorized", decision: { ...unsigned, decisionDigest, signature } });
  } catch { return denial("provisional", "provisional_signature_invalid", ref, decisionDigest); }
};

const requestProvisional = async (input: RequestProvisionalEgressAuthorizationV1,
  operations: ProviderProcessEgressOperations, readClock: () => ClockRead):
  Promise<RequestProvisionalEgressAuthorizationOutcomeV1> => {
  const ref = validRef(input.authorizationRequestId) ? input.authorizationRequestId : "invalid";
  if (input.contractVersion !== "provider-process-egress-provisional/v1" ||
    !validRef(input.authorizationRequestId) || !validScope(operations.scope) ||
    !validRequestProjection(input.request)) {return denial("provisional", "invalid_input", ref);}
  const protocolIssue = requestProtocolIssue(input.request);
  if (protocolIssue !== undefined) {return denial("provisional", protocolIssue, ref);}
  let requestDigest: string;
  try { requestDigest = digestCanonical(operations.digest, input.request); }
  catch { return denial("provisional", "invalid_input", ref); }
  const outcome = await resolveAuthority(input, operations);
  if (outcome.status !== "current") {return denial("provisional", ownerIssue(outcome), ref);}
  if (!validAuthority(outcome.authority)) {return denial("provisional", "owner_malformed", ref);}
  const authorityIssue = requestAuthorityIssue(input.request, outcome.authority, requestDigest);
  if (authorityIssue !== undefined) {return denial("provisional", authorityIssue, ref);}
  const clock = readClock();
  if (clock.issue !== undefined) {return denial("provisional", clock.issue, ref);}
  const expiresAtControlTime = clock.view.controlTime + outcome.authority.policy.decisionTtlMilliseconds;
  if (!Number.isSafeInteger(expiresAtControlTime)) {
    return denial("provisional", "control_time_invalid", ref);
  }
  return signProvisional({
    contractVersion: "provider-process-egress-provisional-decision/v1",
    authorizationRequestId: input.authorizationRequestId, authorityRef: outcome.authority.authorityRef,
    scope: operations.scope, policy: outcome.authority.policy,
    providerAccess: outcome.authority.providerAccess, request: input.request, requestDigest,
    time: { ...clock.view, expiresAtControlTime }, signingKey: outcome.authority.policy.signingKey,
  }, operations, ref);
};

const validateFinalInput = (input: RequestFinalEgressAuthorizationV1,
  operations: ProviderProcessEgressOperations, context: FinalContext): EgressAuthorizationIssueCode | undefined => {
  if (input.contractVersion !== "provider-process-egress-final/v1" ||
    !validRef(input.boundaryUseId) || !validRef(input.connectionAttemptId) ||
    !validRef(input.streamId) || !validRequestProjection(input.request)) {return "invalid_input";}
  const provisionalIssue = verifyProvisional(input.provisional, operations);
  if (provisionalIssue !== undefined) {return provisionalIssue;}
  if (!same(input.provisional.scope, operations.scope)) {return "authority_drift";}
  if (input.transport !== "tcp-tls") {return "unsupported_transport";}
  const protocolIssue = requestProtocolIssue(input.request);
  if (protocolIssue !== undefined) {return protocolIssue;}
  if (input.redirectHop !== 0) {return "redirect_denied";}
  try {
    if (!same(input.request, input.provisional.request) ||
      digestCanonical(operations.digest, input.request) !== input.provisional.requestDigest) {
      return "request_mismatch";
    }
  } catch { return "request_mismatch"; }
  return context.ref === "invalid" || !validDigest(context.decisionDigest) ? "invalid_input" : undefined;
};

const readCurrentAuthority = async (input: RequestFinalEgressAuthorizationV1,
  operations: ProviderProcessEgressOperations): Promise<EgressAuthorityReadOutcomeV1> => {
  try {
    return await operations.authorityOwner.readCurrent(deepFreezeEgress({
      scope: operations.scope, authorityRef: input.provisional.authorityRef,
    }));
  } catch { return { status: "indeterminate", reason: "owner_unavailable" }; }
};

const currentAuthorityIssue = (outcome: EgressAuthorityReadOutcomeV1,
  provisional: ProvisionalEgressAuthorizationV1): EgressAuthorizationIssueCode | undefined => {
  if (outcome.status !== "current") {return ownerIssue(outcome);}
  if (!validAuthority(outcome.authority)) {return "owner_malformed";}
  if (outcome.authority.policy.revoked) {return "revoked";}
  return same(outcome.authority, { authorityRef: provisional.authorityRef,
    policy: provisional.policy, providerAccess: provisional.providerAccess })
    ? undefined : "authority_drift";
};

const currentClockIssue = (clock: ClockRead, provisional: ProvisionalEgressAuthorizationV1):
  EgressAuthorizationIssueCode | undefined => {
  if (clock.issue !== undefined) {return clock.issue;}
  if (clock.view.authorityId !== provisional.time.authorityId ||
    clock.view.epoch !== provisional.time.epoch) {return "clock_epoch_mismatch";}
  return clock.view.controlTime >= provisional.time.expiresAtControlTime ? "expired" : undefined;
};

const validateNetworkFacts = (input: RequestFinalEgressAuthorizationV1):
  { readonly facts?: NetworkFacts; readonly issue?: EgressAuthorizationIssueCode } => {
  const normalized = normalizePublicAddressSet(input.resolver.addresses);
  if (input.resolver.resolutionCount !== 1 || !validRef(input.resolver.resolverIdentity) ||
    !validRef(input.resolver.resolverEpoch) || normalized.problem !== undefined) {
    return { issue: normalized.problem ?? "address_denied" };
  }
  const pinned = normalizeObservedAddress(input.pinnedDestination.address);
  if (pinned === undefined || !normalized.addresses.some(item => item.address === pinned) ||
    input.pinnedDestination.port !== input.provisional.policy.origin.port) {
    return { issue: "pinned_destination_mismatch" };
  }
  const peer = normalizeObservedAddress(input.observedPeer.address);
  if (peer !== pinned || input.observedPeer.port !== input.pinnedDestination.port) {
    return { issue: "peer_mismatch" };
  }
  if (input.tls.alpn !== "http/1.1" || input.tls.alpn !== input.request.framing.protocol) {
    return { issue: "alpn_mismatch" };
  }
  if (normalizeHostname(input.tls.sniHostname) !== input.tls.sniHostname ||
    input.tls.sniHostname !== input.provisional.policy.origin.hostname) {
    return { issue: "sni_mismatch" };
  }
  if (input.tls.certificateValidated !== true) {return { issue: "certificate_invalid" };}
  if (normalizeHostname(input.tls.dnsIdentity) !== input.tls.dnsIdentity ||
    input.tls.dnsIdentity !== input.provisional.policy.dnsIdentity ||
    !validDigest(input.tls.certificateDigest) ||
    input.tls.tlsPolicyDigest !== input.provisional.policy.tlsPolicyDigest) {
    return { issue: "certificate_mismatch" };
  }
  return { facts: { addresses: normalized.addresses, peer } };
};

const buildGrantPayload = (input: RequestFinalEgressAuthorizationV1, operations:
  ProviderProcessEgressOperations, clock: EgressControlTimeV1, facts: NetworkFacts,
  digests: GrantDigests): FirstApplicationByteGrantPayloadV1 => {
  const journalKey = { namespace: "provider-process-egress/v1" as const,
    tenantId: operations.scope.tenantId, projectId: operations.scope.projectId,
    operationId: operations.scope.operationId, boundaryUseId: input.boundaryUseId };
  return {
    contractVersion: "provider-process-first-application-byte-grant/v1",
    authorizationRequestId: input.provisional.authorizationRequestId,
    authorityRef: input.provisional.authorityRef, scope: operations.scope,
    policy: input.provisional.policy, providerAccess: input.provisional.providerAccess,
    resolver: { resolverIdentity: input.resolver.resolverIdentity,
      resolverEpoch: input.resolver.resolverEpoch, resolutionCount: 1,
      normalizedAddresses: facts.addresses, addressSetDigest: digests.addressSetDigest },
    selectedPeer: { address: facts.peer, port: input.observedPeer.port }, tls: input.tls,
    limits: input.provisional.policy.limits, request: input.request,
    requestDigest: input.provisional.requestDigest,
    time: { authorityId: clock.authorityId, epoch: clock.epoch,
      authorizedAtControlTime: clock.controlTime,
      expiresAtControlTime: input.provisional.time.expiresAtControlTime },
    boundaryUseId: input.boundaryUseId, connectionAttemptId: input.connectionAttemptId,
    streamId: input.streamId, automaticRetryAuthorized: false, poolingAuthorized: false,
    consumption: { owner: "host-custody", journalKey,
      requestFingerprint: digests.requestFingerprint },
  };
};

const signFinalGrant = (input: RequestFinalEgressAuthorizationV1,
  operations: ProviderProcessEgressOperations, context: FinalContext, clock: EgressControlTimeV1,
  facts: NetworkFacts): RequestFinalEgressAuthorizationOutcomeV1 => {
  let payload: FirstApplicationByteGrantPayloadV1;
  let finalAuthorizationDigest: string;
  try {
    const addressSetDigest = digestCanonical(operations.digest, facts.addresses);
    const journalKey = { namespace: "provider-process-egress/v1" as const,
      tenantId: operations.scope.tenantId, projectId: operations.scope.projectId,
      operationId: operations.scope.operationId, boundaryUseId: input.boundaryUseId };
    const requestFingerprint = digestCanonical(operations.digest, { journalKey,
      connectionAttemptId: input.connectionAttemptId, streamId: input.streamId,
      requestDigest: input.provisional.requestDigest });
    payload = buildGrantPayload(input, operations, clock, facts,
      { addressSetDigest, requestFingerprint });
    finalAuthorizationDigest = digestCanonical(operations.digest, finalAuthorizationPreimage(payload));
    if (![addressSetDigest, requestFingerprint, finalAuthorizationDigest].every(validDigest)) {
      return denial("final", "final_signature_invalid", context.ref, context.decisionDigest);
    }
  } catch { return denial("final", "final_signature_invalid", context.ref, context.decisionDigest); }
  try {
    const signature = operations.signer.sign(finalAuthorizationDigest, input.provisional.signingKey);
    const { value: _value, ...signatureKey } = signature;
    if (!same(signatureKey, input.provisional.signingKey) || signature.value.length < 1 ||
      signature.value.length > 1024 ||
      !operations.verifier.verify(finalAuthorizationDigest, signature)) {
      return denial("final", "final_signature_invalid", context.ref, context.decisionDigest);
    }
    return deepFreezeEgress({ status: "authorized", grant: {
      payload, finalAuthorizationDigest, signature,
      evidence: { contractVersion: "provider-process-egress-grant-evidence/v1",
        authorizationRef: context.ref, boundaryUseRef: input.boundaryUseId,
        decisionDigest: context.decisionDigest, finalAuthorizationDigest },
    }});
  } catch { return denial("final", "final_signature_invalid", context.ref, context.decisionDigest); }
};

const authorizeFirstApplicationByte = async (input: RequestFinalEgressAuthorizationV1,
  operations: ProviderProcessEgressOperations, readClock: () => ClockRead):
  Promise<RequestFinalEgressAuthorizationOutcomeV1> => {
  const context = { ref: validRef(input.provisional.authorizationRequestId)
    ? input.provisional.authorizationRequestId : "invalid",
  decisionDigest: input.provisional.decisionDigest };
  const inputIssue = validateFinalInput(input, operations, context);
  if (inputIssue !== undefined) {return denial("final", inputIssue, context.ref, context.decisionDigest);}
  const authorityIssue = currentAuthorityIssue(await readCurrentAuthority(input, operations),
    input.provisional);
  if (authorityIssue !== undefined) {
    return denial("final", authorityIssue, context.ref, context.decisionDigest);
  }
  const clock = readClock();
  const clockIssue = currentClockIssue(clock, input.provisional);
  if (clockIssue !== undefined || clock.view === undefined) {
    return denial("final", clockIssue ?? "control_time_invalid", context.ref, context.decisionDigest);
  }
  const network = validateNetworkFacts(input);
  if (network.issue !== undefined || network.facts === undefined) {
    return denial("final", network.issue ?? "address_denied", context.ref, context.decisionDigest);
  }
  return signFinalGrant(input, operations, context, clock.view, network.facts);
};

export const createProviderProcessEgressAuthorization = (
  operations: ProviderProcessEgressOperations,
): ProviderProcessEgressAuthorizationV1 => {
  const readClock = createClockReader(operations.clock);
  return Object.freeze({
    requestProvisional: (input: RequestProvisionalEgressAuthorizationV1) =>
      requestProvisional(input, operations, readClock),
    authorizeFirstApplicationByte: (input: RequestFinalEgressAuthorizationV1) =>
      authorizeFirstApplicationByte(input, operations, readClock),
  });
};
