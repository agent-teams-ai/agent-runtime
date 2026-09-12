import type {HostHttpEgressSessionDependencies} from "@agent-teams/agent-execution/composition";
import type {createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate,
  ProvisionalEgressAuthorizationV2, SignedFirstApplicationByteGrantV2,
  TrustedHostRequestProjectionV2} from "@agent-teams/runtime-security/composition";

type Candidate = ReturnType<typeof createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate>;
type Binding = Pick<HostHttpEgressSessionDependencies, "runtimeSecurity" | "verifier">;
type HttpDecision = Extract<Awaited<ReturnType<Binding["runtimeSecurity"]["requestProvisional"]>>,
  {status: "authorized"}>["decision"];
type HttpGrant = Extract<Awaited<ReturnType<Binding["runtimeSecurity"]["authorizeFirstApplicationByte"]>>,
  {status: "authorized"}>["grant"];

/** Narrow the signed request without rewriting any signed field. */
const httpRequest = (request: TrustedHostRequestProjectionV2): HttpDecision["request"] | undefined => {
  const framing = request.framing;
  if (framing.protocol !== "http/1.1" || framing.requestTarget !== "origin-form" ||
      framing.authoritySource !== "host" || framing.contentLength === null ||
      framing.transferEncoding !== "absent" || framing.connectionSpecificHeaders !== "absent") {return undefined;}
  return Object.freeze({...request, framing: Object.freeze({protocol: framing.protocol,
    requestTarget: framing.requestTarget, authoritySource: framing.authoritySource,
    contentLength: framing.contentLength, transferEncoding: framing.transferEncoding,
    connectionSpecificHeaders: framing.connectionSpecificHeaders})});
};

const httpDecision = (decision: ProvisionalEgressAuthorizationV2): HttpDecision | undefined => {
  const request = httpRequest(decision.request);
  return request === undefined ? undefined : Object.freeze({...decision, request});
};

const httpGrant = (grant: SignedFirstApplicationByteGrantV2): HttpGrant | undefined => {
  const payload = grant.payload; const request = httpRequest(payload.request);
  if (request === undefined || payload.tls.alpn !== "http/1.1") {return undefined;}
  const addresses: HttpGrant["payload"]["resolver"]["normalizedAddresses"][number][] = [];
  for (const address of payload.resolver.normalizedAddresses) {
    if (address.classification !== "public") {return undefined;}
    addresses.push(Object.freeze({...address, classification: address.classification}));
  }
  return Object.freeze({...grant, payload: Object.freeze({...payload, request,
    tls: Object.freeze({...payload.tls, alpn: payload.tls.alpn}),
    resolver: Object.freeze({...payload.resolver, normalizedAddresses: Object.freeze(addresses)})})});
};

/**
 * Private, inert binding of an already owned RS Ed25519 candidate into AE's HTTP
 * consumer contract. RS keeps its current policy/PA reads, signer and disposal.
 * This binding creates no key, listener or authority and adds no feature port.
 * Only the trusted composition root supplies this frozen owner-created object.
 */
export const bindContainedTurnHttpRuntimeSecurity = (candidate: Candidate): Binding => {
  const authorization = candidate.hostEgressAuthorizationV2;
  const verifier = candidate.hostEgressVerifierV2;
  const requestProvisional = authorization.requestProvisional.bind(authorization);
  const authorizeFirstApplicationByte = authorization.authorizeFirstApplicationByte.bind(authorization);
  const verifyProvisionalDecision = verifier.verifyProvisionalDecision.bind(verifier);
  const verifyGrant = verifier.verifyGrant.bind(verifier);
  const signingKey = Object.freeze({...verifier.signingKey});
  const denied = Object.freeze({status: "denied" as const});
  return Object.freeze({
    runtimeSecurity: Object.freeze<Binding["runtimeSecurity"]>({
      async requestProvisional(input) {
        try {
          const outcome = await requestProvisional(input);
          if (outcome.status !== "authorized" || !verifyProvisionalDecision(outcome.decision)) {return denied;}
          const decision = httpDecision(outcome.decision);
          return decision === undefined ? denied : Object.freeze({status: "authorized", decision});
        } catch {return denied;}
      },
      async authorizeFirstApplicationByte(input) {
        try {
          const outcome = await authorizeFirstApplicationByte(input);
          if (outcome.status !== "authorized" || !verifyGrant(outcome.grant)) {return denied;}
          const grant = httpGrant(outcome.grant);
          return grant === undefined ? denied : Object.freeze({status: "authorized", grant});
        } catch {return denied;}
      },
    }),
    verifier: Object.freeze<Binding["verifier"]>({signingKey,
      verifyProvisionalDecision(value) {try {return verifyProvisionalDecision(value);} catch {return false;}},
      verifyGrant(value) {try {return verifyGrant(value);} catch {return false;}},
    }),
  });
};
