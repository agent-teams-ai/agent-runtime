import {
  createNodeHmacEgressDecisionSeal,
  createNodeSha256EgressDigest,
  createProviderProcessEgressAuthorizationFeature,
  type RequestFinalEgressAuthorizationV1,
  type RequestProvisionalEgressAuthorizationV1,
} from "../dist/composition.js";

export const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const control = { time: 1_000 };
export const setControlTime = (value: number): void => { control.time = value; };

export const feature = () => {
  const seal = createNodeHmacEgressDecisionSeal({ keyRef: "egress-key", secret: "synthetic-only" });
  return createProviderProcessEgressAuthorizationFeature({
    clock: { now: () => control.time }, digest: createNodeSha256EgressDigest(),
    signer: seal, verifier: seal,
  }).hostEgressAuthorizationV1;
};

export const provisionalInput = (
  change: Partial<RequestProvisionalEgressAuthorizationV1> = {},
): RequestProvisionalEgressAuthorizationV1 => ({
  contractVersion: "provider-process-egress-provisional/v1",
  authorizationRequestId: "authorization-1",
  scope: { operationId: "operation-1", tenantId: "tenant-1", projectId: "project-1",
    scopeDigest: digest("1") },
  providerRoute: { providerRef: "provider-1", accountRef: "account-1", routeRef: "route-1",
    routeDigest: digest("2"), credentialBindingDigest: digest("3") },
  generations: { policy: "policy-1", key: "key-1", route: "route-generation-1",
    credential: "credential-1" },
  origin: { scheme: "https", hostname: "api.example.com", port: 443 },
  resolverAuthority: { resolverIdentity: "resolver-1", resolverEpoch: "resolver-epoch-1" },
  certificate: { dnsIdentity: "api.example.com", certificateDigest: digest("4") },
  redirectHop: 0,
  budgets: { requestBytes: 1_000, responseBytes: 10_000, totalMilliseconds: 30_000 },
  expiresAtControlTime: 1_100,
  requestIntent: { method: "POST", pathAndQuery: "/v1/messages?stream=true",
    bodyDigest: digest("5"), mediaType: "application/json", applicationProtocol: "h2",
    transportMode: "direct-tls", upgradeMode: "none" },
  ...change,
});

export const authorizeProvisional = (authority = feature()) => {
  const result = authority.requestProvisional(provisionalInput());
  if (result.status !== "authorized") {throw new Error(`fixture denied: ${result.evidence.issueCode}`);}
  return result.decision;
};

export const finalInput = (
  provisional = authorizeProvisional(),
  change: Partial<RequestFinalEgressAuthorizationV1> = {},
): RequestFinalEgressAuthorizationV1 => ({
  contractVersion: "provider-process-egress-final/v1", provisional,
  boundaryUseId: "boundary-use-1", connectionAttemptId: "connection-1", streamId: "stream-1",
  transport: "tcp-tls",
  pinnedDestination: { address: "93.184.216.34", port: 443 },
  observedPeer: { address: "93.184.216.34", port: 443 },
  sniHostname: "api.example.com",
  certificate: { validated: true, dnsIdentity: "api.example.com", certificateDigest: digest("4") },
  alpn: "h2", observedAtControlTime: control.time,
  currentAuthority: { scope: provisional.scope, providerRoute: provisional.providerRoute,
    generations: provisional.generations, revoked: false,
    resolverIdentity: provisional.resolverAuthority.resolverIdentity,
    resolverEpoch: provisional.resolverAuthority.resolverEpoch, budgets: provisional.budgets },
  resolver: { ...provisional.resolverAuthority, resolutionCount: 1, addresses: [
    { family: "ipv4", address: "93.184.216.34", classification: "public" },
  ] }, redirectHop: 0,
  requestIntent: provisionalInput().requestIntent,
  ...change,
});

export const assertDeepFrozen = (value: unknown): void => {
  if (value === null || typeof value !== "object") {return;}
  if (!Object.isFrozen(value)) {throw new Error("value is not frozen");}
  for (const nested of Object.values(value)) {assertDeepFrozen(nested);}
};
