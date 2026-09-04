import type {
  EgressAuthorizationIssueCode,
  EgressAuthorityReadOutcome,
  EgressControlTime,
  EgressCurrentAuthority,
  EgressDenialEvidence,
  EgressConsumptionJournalKey,
  FirstApplicationByteGrantPayload,
  ProvisionalEgressAuthorization,
  ProviderProcessEgressAuthorization,
  RequestFinalEgressAuthorizationOutcome,
  RequestFinalEgressAuthorization,
  RequestProvisionalEgressAuthorizationOutcome,
  RequestProvisionalEgressAuthorization,
  TrustedEgressCompositionScope,
  TrustedHostRequestProjection,
} from "../domain/provider-process-egress-model.js";
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
  readonly scope: TrustedEgressCompositionScope;
  readonly authorityOwner: EgressAuthorityOwnerReadPort;
  readonly clock: EgressControlClock;
  readonly digest: EgressCanonicalDigest;
  readonly signer: EgressDecisionSigner;
  readonly verifier: EgressDecisionVerifier;
  readonly validSigningKey: (key: EgressCurrentAuthority["policy"]["signingKey"]) => boolean;
  readonly journalNamespace: EgressConsumptionJournalKey["namespace"];
  readonly signedDocuments: {
    readonly provisional: (decision: Omit<ProvisionalEgressAuthorization,
      "decisionDigest" | "signature">) => unknown;
    readonly consumption: (payload: GrantPayloadBeforeFingerprint) => unknown;
    readonly grant: (payload: FirstApplicationByteGrantPayload) => unknown;
  };
}

type ClockRead = { readonly view: EgressControlTime; readonly issue?: never } |
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
};

const same = (left: unknown, right: unknown): boolean =>
  canonicalEgressValue(left) === canonicalEgressValue(right);
const denial = (phase: "provisional" | "final", issueCode: EgressAuthorizationIssueCode,
  authorizationRef: string, decisionDigest?: string) => deepFreezeEgress({ status: "denied" as const,
  evidence: { phase, issueCode, authorizationRef,
    ...(decisionDigest === undefined ? {} : { decisionDigest }) } satisfies EgressDenialEvidence });

const validScope = (scope: TrustedEgressCompositionScope): boolean =>
  validRef(scope.tenantId) && validRef(scope.projectId) && validRef(scope.operationId) &&
  validDigest(scope.scopeDigest);
const validSigningKeyMetadata = (key: EgressCurrentAuthority["policy"]["signingKey"]): boolean =>
  validRef(key.keyRef) && validRef(key.keyGeneration) && (key.algorithm === "hmac-sha256-synthetic" ||
    (key.signatureEncoding === "hex-lower" && validDigest(key.publicKeyDigest) &&
      validRef(key.signerRevision) && validRef(key.hostReservationId)));
const validPolicy = (policy: EgressCurrentAuthority["policy"],
  operations: ProviderProcessEgressOperations): boolean =>
  validRef(policy.policyRef) && validRef(policy.policyRevision) && validRef(policy.policyGeneration) &&
  validDigest(policy.authorizedRequestDigest) && validOrigin(policy.origin) &&
  normalizeHostname(policy.dnsIdentity) === policy.dnsIdentity && validDigest(policy.tlsPolicyDigest) &&
  validBudgets(policy.limits) && Number.isSafeInteger(policy.decisionTtlMilliseconds) &&
  policy.decisionTtlMilliseconds >= 1 && policy.decisionTtlMilliseconds <= 300_000 &&
  validSigningKeyMetadata(policy.signingKey) &&
  operations.validSigningKey(policy.signingKey) && typeof policy.revoked === "boolean";
const validProviderAccess = (access: EgressCurrentAuthority["providerAccess"]): boolean =>
  validRef(access.accessRef) && validRef(access.providerRef) && validRef(access.accountRef) &&
  validRef(access.routeRef) && validDigest(access.routeAuthorityDigest) &&
  validDigest(access.credentialBindingDigest) && validRef(access.routeGeneration) &&
  validRef(access.credentialGeneration);
const validAuthority = (authority: EgressCurrentAuthority,
  operations: ProviderProcessEgressOperations): boolean =>
  validRef(authority.authorityRef) && validPolicy(authority.policy, operations) &&
  validProviderAccess(authority.providerAccess);
const ownerIssue = (outcome: Exclude<EgressAuthorityReadOutcome,
  { readonly status: "current" }>): EgressAuthorizationIssueCode => outcome.reason;

const requestProtocolIssue = (request: TrustedHostRequestProjection):
  EgressAuthorizationIssueCode | undefined => {
  if (request.framing.protocol !== "http/1.1") {return "unsupported_protocol";}
  if (request.framing.requestTarget !== "origin-form" || request.framing.authoritySource !== "host" ||
    request.framing.transferEncoding !== "absent" ||
    request.framing.connectionSpecificHeaders !== "absent" ||
    request.framing.contentLength !== request.body.byteLength) {return "unsupported_framing";}
  return undefined;
};

const requestAuthorityIssue = (request: TrustedHostRequestProjection,
  authority: EgressCurrentAuthority, requestDigest: string): EgressAuthorizationIssueCode | undefined => {
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

const verifyProvisional = (provisional: ProvisionalEgressAuthorization,
  operations: ProviderProcessEgressOperations): EgressAuthorizationIssueCode | undefined => {
  const { decisionDigest: _digest, signature: _signature, ...unsigned } = provisional;
  let calculated: string;
  try { calculated = digestCanonical(operations.digest,
    provisionalPreimage(operations.signedDocuments.provisional(unsigned))); }
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
  let lastClock: EgressControlTime | undefined;
  return () => {
    let view: EgressControlTime;
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

const resolveAuthority = async (input: RequestProvisionalEgressAuthorization,
  operations: ProviderProcessEgressOperations): Promise<EgressAuthorityReadOutcome> => {
  try {
    return await operations.authorityOwner.resolvePolicy(deepFreezeEgress({
      scope: operations.scope, authorizationRequestId: input.authorizationRequestId,
      request: input.request,
    }));
  } catch { return { status: "indeterminate", reason: "owner_unavailable" }; }
};

const signProvisional = (unsigned: Omit<ProvisionalEgressAuthorization,
  "decisionDigest" | "signature">, operations: ProviderProcessEgressOperations,
  ref: string): RequestProvisionalEgressAuthorizationOutcome => {
  let decisionDigest: string;
  try { decisionDigest = digestCanonical(operations.digest,
    provisionalPreimage(operations.signedDocuments.provisional(unsigned))); }
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

const requestProvisional = async (input: RequestProvisionalEgressAuthorization,
  operations: ProviderProcessEgressOperations, readClock: () => ClockRead):
  Promise<RequestProvisionalEgressAuthorizationOutcome> => {
  const ref = validRef(input.authorizationRequestId) ? input.authorizationRequestId : "invalid";
  if (!validRef(input.authorizationRequestId) || !validScope(operations.scope) ||
    !validRequestProjection(input.request)) {return denial("provisional", "invalid_input", ref);}
  const protocolIssue = requestProtocolIssue(input.request);
  if (protocolIssue !== undefined) {return denial("provisional", protocolIssue, ref);}
  let requestDigest: string;
  try { requestDigest = digestCanonical(operations.digest, input.request); }
  catch { return denial("provisional", "invalid_input", ref); }
  const outcome = await resolveAuthority(input, operations);
  if (outcome.status !== "current") {return denial("provisional", ownerIssue(outcome), ref);}
  if (!validAuthority(outcome.authority, operations)) {
    return denial("provisional", "owner_malformed", ref);
  }
  const authorityIssue = requestAuthorityIssue(input.request, outcome.authority, requestDigest);
  if (authorityIssue !== undefined) {return denial("provisional", authorityIssue, ref);}
  const clock = readClock();
  if (clock.issue !== undefined) {return denial("provisional", clock.issue, ref);}
  const expiresAtControlTime = clock.view.controlTime + outcome.authority.policy.decisionTtlMilliseconds;
  if (!Number.isSafeInteger(expiresAtControlTime)) {
    return denial("provisional", "control_time_invalid", ref);
  }
  return signProvisional({
    authorizationRequestId: input.authorizationRequestId, authorityRef: outcome.authority.authorityRef,
    scope: operations.scope, policy: outcome.authority.policy,
    providerAccess: outcome.authority.providerAccess, request: input.request, requestDigest,
    time: { ...clock.view, expiresAtControlTime }, signingKey: outcome.authority.policy.signingKey,
  }, operations, ref);
};

const validateFinalInput = (input: RequestFinalEgressAuthorization,
  operations: ProviderProcessEgressOperations, context: FinalContext): EgressAuthorizationIssueCode | undefined => {
  if (!validRef(input.boundaryUseId) || !validRef(input.connectionAttemptId) ||
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

const readCurrentAuthority = async (input: RequestFinalEgressAuthorization,
  operations: ProviderProcessEgressOperations): Promise<EgressAuthorityReadOutcome> => {
  try {
    return await operations.authorityOwner.readCurrent(deepFreezeEgress({
      scope: operations.scope, authorityRef: input.provisional.authorityRef,
    }));
  } catch { return { status: "indeterminate", reason: "owner_unavailable" }; }
};

const currentAuthorityIssue = (outcome: EgressAuthorityReadOutcome,
  provisional: ProvisionalEgressAuthorization, operations: ProviderProcessEgressOperations):
  EgressAuthorizationIssueCode | undefined => {
  if (outcome.status !== "current") {return ownerIssue(outcome);}
  if (!validAuthority(outcome.authority, operations)) {return "owner_malformed";}
  if (outcome.authority.policy.revoked) {return "revoked";}
  return same(outcome.authority, { authorityRef: provisional.authorityRef,
    policy: provisional.policy, providerAccess: provisional.providerAccess })
    ? undefined : "authority_drift";
};

const currentClockIssue = (clock: ClockRead, provisional: ProvisionalEgressAuthorization):
  EgressAuthorizationIssueCode | undefined => {
  if (clock.issue !== undefined) {return clock.issue;}
  if (clock.view.authorityId !== provisional.time.authorityId ||
    clock.view.epoch !== provisional.time.epoch) {return "clock_epoch_mismatch";}
  return clock.view.controlTime >= provisional.time.expiresAtControlTime ? "expired" : undefined;
};

const validateNetworkFacts = (input: RequestFinalEgressAuthorization):
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

export type GrantPayloadBeforeFingerprint = Omit<FirstApplicationByteGrantPayload, "consumption"> & {
  readonly consumption: Omit<FirstApplicationByteGrantPayload["consumption"], "requestFingerprint">;
};

const buildGrantPayloadBeforeFingerprint = (input: RequestFinalEgressAuthorization, operations:
  ProviderProcessEgressOperations, clock: EgressControlTime, facts: NetworkFacts,
  digests: GrantDigests): GrantPayloadBeforeFingerprint => {
  const journalKey = { namespace: operations.journalNamespace,
    tenantId: operations.scope.tenantId, projectId: operations.scope.projectId,
    operationId: operations.scope.operationId, boundaryUseId: input.boundaryUseId };
  return {
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
    streamId: input.streamId, redirectHop: 0,
    provisionalDecisionDigest: input.provisional.decisionDigest,
    automaticRetryAuthorized: false, poolingAuthorized: false,
    consumption: { owner: "host-custody", journalKey },
  };
};

const signFinalGrant = (input: RequestFinalEgressAuthorization,
  operations: ProviderProcessEgressOperations, context: FinalContext, clock: EgressControlTime,
  facts: NetworkFacts): RequestFinalEgressAuthorizationOutcome => {
  let payload: FirstApplicationByteGrantPayload;
  let finalAuthorizationDigest: string;
  try {
    const addressSetDigest = digestCanonical(operations.digest, facts.addresses);
    const beforeFingerprint = buildGrantPayloadBeforeFingerprint(input, operations, clock, facts,
      { addressSetDigest });
    const requestFingerprint = digestCanonical(operations.digest,
      operations.signedDocuments.consumption(beforeFingerprint));
    payload = { ...beforeFingerprint, consumption: {
      ...beforeFingerprint.consumption, requestFingerprint,
    } };
    finalAuthorizationDigest = digestCanonical(operations.digest,
      finalAuthorizationPreimage(operations.signedDocuments.grant(payload)));
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
    }});
  } catch { return denial("final", "final_signature_invalid", context.ref, context.decisionDigest); }
};

const authorizeFirstApplicationByte = async (input: RequestFinalEgressAuthorization,
  operations: ProviderProcessEgressOperations, readClock: () => ClockRead):
  Promise<RequestFinalEgressAuthorizationOutcome> => {
  const context = { ref: validRef(input.provisional.authorizationRequestId)
    ? input.provisional.authorizationRequestId : "invalid",
  decisionDigest: input.provisional.decisionDigest };
  const inputIssue = validateFinalInput(input, operations, context);
  if (inputIssue !== undefined) {return denial("final", inputIssue, context.ref, context.decisionDigest);}
  const authorityIssue = currentAuthorityIssue(await readCurrentAuthority(input, operations),
    input.provisional, operations);
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
): ProviderProcessEgressAuthorization => {
  const readClock = createClockReader(operations.clock);
  return Object.freeze({
    requestProvisional: (input: RequestProvisionalEgressAuthorization) =>
      requestProvisional(input, operations, readClock),
    authorizeFirstApplicationByte: (input: RequestFinalEgressAuthorization) =>
      authorizeFirstApplicationByte(input, operations, readClock),
  });
};
