import type {
  EgressAuthorizationIssueCode,
  EgressDenialEvidenceV1,
  ProvisionalEgressAuthorizationV1,
  ProviderProcessEgressAuthorizationV1,
  RequestFinalEgressAuthorizationV1,
  RequestProvisionalEgressAuthorizationV1,
} from "../contracts/provider-process-egress-authorization-v1.js";
import { normalizeObservedAddress, normalizePublicAddressSet } from
  "../domain/public-address.js";
import { normalizeHostname, validBudgets, validDigest, validIntent, validOrigin, validRef } from
  "../domain/egress-values.js";
import { canonicalEgressValue, digestCanonical, finalAuthorizationPreimage, provisionalPreimage } from
  "./egress-canonical.js";
import { deepFreezeEgress } from "./immutable.js";
import type { EgressControlClock } from "./ports/outbound/egress-control-clock.js";
import type { EgressCanonicalDigest, EgressDecisionSigner, EgressDecisionVerifier } from
  "./ports/outbound/egress-cryptography.js";

export interface ProviderProcessEgressOperations {
  readonly clock: EgressControlClock;
  readonly digest: EgressCanonicalDigest;
  readonly signer: EgressDecisionSigner;
  readonly verifier: EgressDecisionVerifier;
}

const same = (left: unknown, right: unknown): boolean =>
  canonicalEgressValue(left) === canonicalEgressValue(right);

const denial = (
  phase: "provisional" | "final",
  issueCode: EgressAuthorizationIssueCode,
  authorizationRef: string,
  decisionDigest?: string,
) => deepFreezeEgress({ status: "denied" as const, evidence: {
  contractVersion: "provider-process-egress-denial-evidence/v1" as const,
  phase, issueCode, authorizationRef,
  ...(decisionDigest === undefined ? {} : { decisionDigest }),
} satisfies EgressDenialEvidenceV1 });

const validScope = (scope: RequestProvisionalEgressAuthorizationV1["scope"]): boolean =>
  validRef(scope.operationId) && validRef(scope.tenantId) && validRef(scope.projectId) &&
  validDigest(scope.scopeDigest);

const validProviderRoute = (
  route: RequestProvisionalEgressAuthorizationV1["providerRoute"],
): boolean => validRef(route.providerRef) && validRef(route.accountRef) && validRef(route.routeRef) &&
  validDigest(route.routeDigest) && validDigest(route.credentialBindingDigest);

const validGenerations = (
  generations: RequestProvisionalEgressAuthorizationV1["generations"],
): boolean => Object.values(generations).every(validRef);

const validResolver = (
  resolver: RequestProvisionalEgressAuthorizationV1["resolverAuthority"],
): boolean => validRef(resolver.resolverIdentity) && validRef(resolver.resolverEpoch);

const verifyDecision = (
  provisional: ProvisionalEgressAuthorizationV1,
  operations: ProviderProcessEgressOperations,
): EgressAuthorizationIssueCode | undefined => {
  const calculated = digestCanonical(operations.digest, provisionalPreimage(provisional));
  if (calculated !== provisional.decisionDigest) {return "provisional_digest_invalid";}
  if (provisional.signature.keyGeneration !== provisional.generations.key ||
    !operations.verifier.verify(provisional.decisionDigest, provisional.signature)) {
    return "provisional_signature_invalid";
  }
  return undefined;
};

const finalProtocolIssue = (
  input: RequestFinalEgressAuthorizationV1,
): EgressAuthorizationIssueCode | undefined => {
  if (input.transport !== "tcp-tls") {return "unsupported_transport";}
  if (input.requestIntent.transportMode !== "direct-tls") {return "unsupported_proxy";}
  if (input.requestIntent.upgradeMode !== "none") {return "unsupported_upgrade";}
  if (input.requestIntent.applicationProtocol !== "http/1.1" &&
    input.requestIntent.applicationProtocol !== "h2") {return "unsupported_protocol";}
  if (input.redirectHop !== 0 || input.provisional.redirectHop !== 0) {return "redirect_denied";}
  return undefined;
};

const finalAuthorityIssue = (
  input: RequestFinalEgressAuthorizationV1,
): EgressAuthorizationIssueCode | undefined => {
  const provisional = input.provisional;
  if (!same(input.currentAuthority.scope, provisional.scope)) {return "scope_mismatch";}
  const currentRoute = input.currentAuthority.providerRoute;
  if (currentRoute.providerRef !== provisional.providerRoute.providerRef) {return "provider_mismatch";}
  if (currentRoute.accountRef !== provisional.providerRoute.accountRef) {return "account_mismatch";}
  if (currentRoute.routeRef !== provisional.providerRoute.routeRef ||
    currentRoute.routeDigest !== provisional.providerRoute.routeDigest) {return "route_mismatch";}
  if (currentRoute.credentialBindingDigest !== provisional.providerRoute.credentialBindingDigest) {
    return "credential_mismatch";
  }
  const current = input.currentAuthority.generations;
  if (current.policy !== provisional.generations.policy) {return "policy_generation_mismatch";}
  if (current.key !== provisional.generations.key) {return "key_generation_mismatch";}
  if (current.route !== provisional.generations.route) {return "route_generation_mismatch";}
  if (current.credential !== provisional.generations.credential) {
    return "credential_generation_mismatch";
  }
  return input.currentAuthority.revoked ? "revoked" : undefined;
};

const finalTimeAndResolverIssue = (
  input: RequestFinalEgressAuthorizationV1,
  operations: ProviderProcessEgressOperations,
): EgressAuthorizationIssueCode | undefined => {
  const provisional = input.provisional;
  const now = operations.clock.now();
  if (!Number.isSafeInteger(now) || input.observedAtControlTime !== now) {return "control_time_mismatch";}
  if (now >= provisional.expiresAtControlTime) {return "expired";}
  if (input.currentAuthority.resolverIdentity !== provisional.resolverAuthority.resolverIdentity ||
    input.currentAuthority.resolverEpoch !== provisional.resolverAuthority.resolverEpoch ||
    input.resolver.resolverIdentity !== provisional.resolverAuthority.resolverIdentity ||
    input.resolver.resolverEpoch !== provisional.resolverAuthority.resolverEpoch ||
    input.resolver.resolutionCount !== 1) {return "resolver_mismatch";}
  const finalAddresses = normalizePublicAddressSet(input.resolver.addresses);
  if (finalAddresses.problem !== undefined) {return finalAddresses.problem;}
  return undefined;
};

const finalDestinationIssue = (
  input: RequestFinalEgressAuthorizationV1,
): EgressAuthorizationIssueCode | undefined => {
  const provisional = input.provisional;
  const pinned = normalizeObservedAddress(input.pinnedDestination.address);
  const addresses = normalizePublicAddressSet(input.resolver.addresses);
  if (pinned === undefined || addresses.problem !== undefined ||
    !addresses.addresses.some(item => item.address === pinned) ||
    input.pinnedDestination.port !== provisional.origin.port) {return "pinned_destination_mismatch";}
  const peer = normalizeObservedAddress(input.observedPeer.address);
  if (peer !== pinned || input.observedPeer.port !== input.pinnedDestination.port) {return "peer_mismatch";}
  const sniHostname = normalizeHostname(input.sniHostname);
  if (sniHostname === undefined || input.sniHostname !== sniHostname ||
    sniHostname !== provisional.origin.hostname) {return "sni_mismatch";}
  if (input.certificate.validated !== true) {return "certificate_invalid";}
  const certificateIdentity = normalizeHostname(input.certificate.dnsIdentity);
  if (certificateIdentity === undefined || input.certificate.dnsIdentity !== certificateIdentity ||
    certificateIdentity !== provisional.certificate.dnsIdentity ||
    input.certificate.certificateDigest !== provisional.certificate.certificateDigest) {
    return "certificate_mismatch";
  }
  return undefined;
};

const finalRequestIssue = (
  input: RequestFinalEgressAuthorizationV1,
  operations: ProviderProcessEgressOperations,
): EgressAuthorizationIssueCode | undefined => {
  const provisional = input.provisional;
  if (input.alpn !== input.requestIntent.applicationProtocol) {return "alpn_mismatch";}
  if (!same(input.currentAuthority.budgets, provisional.budgets)) {return "budget_mismatch";}
  if (!validIntent(input.requestIntent) ||
    digestCanonical(operations.digest, input.requestIntent) !== provisional.requestIntentDigest) {
    return "request_intent_mismatch";
  }
  return undefined;
};

const firstFinalIssue = (
  input: RequestFinalEgressAuthorizationV1,
  operations: ProviderProcessEgressOperations,
): EgressAuthorizationIssueCode | undefined => {
  const checks = [
    () => verifyDecision(input.provisional, operations),
    () => finalProtocolIssue(input),
    () => finalAuthorityIssue(input),
    () => finalTimeAndResolverIssue(input, operations),
    () => finalDestinationIssue(input),
    () => finalRequestIssue(input, operations),
  ];
  for (const check of checks) {
    const issue = check();
    if (issue !== undefined) {return issue;}
  }
  return undefined;
};

const provisionalIssue = (
  input: RequestProvisionalEgressAuthorizationV1,
  now: number,
): EgressAuthorizationIssueCode | undefined => {
  const structurallyValid = [
    input.contractVersion === "provider-process-egress-provisional/v1",
    validRef(input.authorizationRequestId), validScope(input.scope),
    validProviderRoute(input.providerRoute), validGenerations(input.generations),
    validResolver(input.resolverAuthority), validBudgets(input.budgets),
    validRef(input.certificate.dnsIdentity), validDigest(input.certificate.certificateDigest),
    Number.isSafeInteger(now), Number.isSafeInteger(input.expiresAtControlTime),
  ].every(Boolean);
  if (!structurallyValid) {return "invalid_input";}
  if (!validOrigin(input.origin) ||
    normalizeHostname(input.certificate.dnsIdentity) !== input.origin.hostname) {
    return "origin_invalid";
  }
  if (input.redirectHop !== 0) {return "redirect_denied";}
  if (input.requestIntent.transportMode !== "direct-tls") {return "unsupported_proxy";}
  if (input.requestIntent.upgradeMode !== "none") {return "unsupported_upgrade";}
  if (input.requestIntent.applicationProtocol === "h3") {return "unsupported_protocol";}
  if (!validIntent(input.requestIntent)) {return "invalid_input";}
  if (input.expiresAtControlTime <= now || input.expiresAtControlTime > now + 300_000) {
    return "expired";
  }
  return undefined;
};

export const createProviderProcessEgressAuthorization = (
  operations: ProviderProcessEgressOperations,
): ProviderProcessEgressAuthorizationV1 => {
  return Object.freeze({
    requestProvisional(input: RequestProvisionalEgressAuthorizationV1) {
      const ref = validRef(input.authorizationRequestId) ? input.authorizationRequestId : "invalid";
      const now = operations.clock.now();
      const initialIssue = provisionalIssue(input, now);
      if (initialIssue !== undefined) {return denial("provisional", initialIssue, ref);}
      const requestIntentDigest = digestCanonical(operations.digest, input.requestIntent);
      if (!validDigest(requestIntentDigest)) {return denial("provisional", "invalid_input", ref);}
      const unsigned = {
        contractVersion: "provider-process-egress-provisional-decision/v1" as const,
        authorizationRequestId: input.authorizationRequestId,
        scope: input.scope, providerRoute: input.providerRoute, generations: input.generations,
        origin: input.origin,
        resolverAuthority: input.resolverAuthority,
        certificate: input.certificate, redirectHop: 0 as const, budgets: input.budgets,
        expiresAtControlTime: input.expiresAtControlTime, requestIntentDigest,
      };
      const decisionDigest = digestCanonical(operations.digest, provisionalPreimage(unsigned));
      if (!validDigest(decisionDigest)) {return denial("provisional", "invalid_input", ref);}
      const signature = operations.signer.sign(decisionDigest, input.generations.key);
      if (signature.keyGeneration !== input.generations.key || !validRef(signature.keyRef) ||
        !validRef(signature.keyGeneration) || signature.value.length < 1 || signature.value.length > 1024) {
        return denial("provisional", "provisional_signature_invalid", ref, decisionDigest);
      }
      const detachedSignature = { keyRef: signature.keyRef, keyGeneration: signature.keyGeneration,
        value: signature.value };
      return deepFreezeEgress({ status: "authorized" as const,
        decision: { ...unsigned, decisionDigest, signature: detachedSignature } });
    },
    authorizeFirstApplicationByte(input: RequestFinalEgressAuthorizationV1) {
      const ref = validRef(input.provisional.authorizationRequestId)
        ? input.provisional.authorizationRequestId : "invalid";
      if (input.contractVersion !== "provider-process-egress-final/v1" ||
        !validRef(input.boundaryUseId) || !validRef(input.connectionAttemptId) ||
        !validRef(input.streamId)) {return denial("final", "invalid_input", ref);}
      const issue = firstFinalIssue(input, operations);
      if (issue !== undefined) {return denial("final", issue, ref, input.provisional.decisionDigest);}
      const resolver = normalizePublicAddressSet(input.resolver.addresses);
      if (resolver.problem !== undefined) {
        return denial("final", resolver.problem, ref, input.provisional.decisionDigest);
      }
      const selectedPeer = { address: normalizeObservedAddress(input.observedPeer.address)!,
        port: input.observedPeer.port };
      const certificate = { dnsIdentity: input.certificate.dnsIdentity,
        certificateDigest: input.certificate.certificateDigest };
      const addressSetDigest = digestCanonical(operations.digest, resolver.addresses);
      if (!validDigest(addressSetDigest)) {
        return denial("final", "invalid_input", ref, input.provisional.decisionDigest);
      }
      const resolverBinding = { resolverIdentity: input.resolver.resolverIdentity,
        resolverEpoch: input.resolver.resolverEpoch, resolutionCount: 1 as const, addressSetDigest };
      const finalAuthorizationDigest = digestCanonical(operations.digest, finalAuthorizationPreimage({
        authorizationRequestId: input.provisional.authorizationRequestId,
        boundaryUseId: input.boundaryUseId, connectionAttemptId: input.connectionAttemptId,
        streamId: input.streamId, decisionDigest: input.provisional.decisionDigest,
        requestIntentDigest: input.provisional.requestIntentDigest, scope: input.provisional.scope,
        providerRoute: input.provisional.providerRoute, generations: input.provisional.generations,
        resolver: resolverBinding, selectedPeer,
        sniHostname: input.sniHostname, certificate, alpn: input.alpn,
        budgets: input.provisional.budgets, observedAtControlTime: input.observedAtControlTime,
      }));
      if (!validDigest(finalAuthorizationDigest)) {
        return denial("final", "invalid_input", ref, input.provisional.decisionDigest);
      }
      return deepFreezeEgress({ status: "authorized" as const, grant: {
        contractVersion: "provider-process-first-application-byte-grant/v1" as const,
        authorizationRequestId: input.provisional.authorizationRequestId,
        boundaryUseId: input.boundaryUseId, connectionAttemptId: input.connectionAttemptId,
        streamId: input.streamId, decisionDigest: input.provisional.decisionDigest,
        requestIntentDigest: input.provisional.requestIntentDigest,
        finalAuthorizationDigest, scope: input.provisional.scope,
        providerRoute: input.provisional.providerRoute, generations: input.provisional.generations,
        resolver: resolverBinding, selectedPeer, sniHostname: input.sniHostname, certificate,
        alpn: input.alpn as "http/1.1" | "h2", budgets: input.provisional.budgets,
        authority: "runtime-security-final-authorization-only" as const,
        automaticRetryAuthorized: false as const, poolingAuthorized: false as const,
        consumption: {
          owner: "host-custody" as const,
          latch: "durable-one-use-first-byte-journal" as const,
          requiredBeforeFirstByte: true as const,
          grantProvesBytesSent: false as const,
          exactReplay: "return-original-durable-outcome" as const,
          conflictingReplay: "fail-closed" as const,
          journalKey: input.boundaryUseId,
          requestFingerprint: finalAuthorizationDigest,
        },
        evidence: {
          contractVersion: "provider-process-egress-grant-evidence/v1" as const,
          authorizationRef: input.provisional.authorizationRequestId,
          boundaryUseRef: input.boundaryUseId,
          decisionDigest: input.provisional.decisionDigest,
          requestIntentDigest: input.provisional.requestIntentDigest,
          finalAuthorizationDigest,
        },
      }});
    },
  });
};
