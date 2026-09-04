import {
  createNodeHmacEgressDecisionSeal,
  createNodeSha256EgressDigest,
  createProviderProcessEgressAuthorizationFeature,
  type EgressAuthorityReadOutcomeV1,
  type EgressCurrentAuthorityV1,
  type RequestFinalEgressAuthorizationV1,
  type RequestProvisionalEgressAuthorizationV1,
  type TrustedEgressCompositionScopeV1,
  type TrustedHostRequestProjectionV1,
} from "../dist/composition.js";

export const digest = (character: string): string => `sha256:${character.repeat(64)}`;
export const canonical = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {return String(value);}
  if (Array.isArray(value)) {return `[${value.map(canonical).join(",")}]`;}
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).toSorted().map(key =>
    `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
};

export const requestProjection = (
  change: Partial<TrustedHostRequestProjectionV1> = {},
): TrustedHostRequestProjectionV1 => ({
  method: "POST", scheme: "https", authority: { hostname: "api.example.com", port: 443 },
  requestTarget: { digest: digest("a"), byteLength: 24 },
  headers: { canonicalDigest: digest("6"), fieldCount: 4, credentialFields: [{
    name: "authorization", credentialBindingDigest: digest("3"), valueDigest: digest("7"),
    byteLength: 32,
  }] },
  body: { digest: digest("5"), byteLength: 128 },
  framing: { protocol: "http/1.1", requestTarget: "origin-form", authoritySource: "host",
    contentLength: 128, transferEncoding: "absent", connectionSpecificHeaders: "absent" },
  ...change,
});

export const scope = (tenantId = "tenant-1"): TrustedEgressCompositionScopeV1 => ({
  tenantId, projectId: "project-1", operationId: "operation-1", scopeDigest: digest("1"),
});

export const authorityFor = (
  request: TrustedHostRequestProjectionV1 = requestProjection(),
): EgressCurrentAuthorityV1 => {
  const digestPort = createNodeSha256EgressDigest();
  return {
    authorityRef: "authority-1",
    policy: {
      policyRef: "policy-1", policyRevision: "policy-revision-1",
      policyGeneration: "policy-generation-1",
      authorizedRequestDigest: digestPort.digest(canonical(request)),
      origin: { scheme: "https", hostname: "api.example.com", port: 443 },
      dnsIdentity: "api.example.com", tlsPolicyDigest: digest("4"),
      limits: { requestBytes: 1_000, responseBytes: 10_000, totalMilliseconds: 30_000 },
      decisionTtlMilliseconds: 100,
      signingKey: { algorithm: "hmac-sha256-synthetic", keyRef: "egress-key",
        keyGeneration: "key-generation-1" },
      revoked: false,
    },
    providerAccess: {
      accessRef: "access-1", providerRef: "provider-1", accountRef: "account-1",
      routeRef: "route-1", routeAuthorityDigest: digest("2"),
      credentialBindingDigest: digest("3"), routeGeneration: "route-generation-1",
      credentialGeneration: "credential-generation-1",
    },
  };
};

export const harness = (options: {
  readonly boundScope?: TrustedEgressCompositionScopeV1;
  readonly initialAuthority?: EgressCurrentAuthorityV1;
} = {}) => {
  const boundScope = options.boundScope ?? scope();
  const state: {
    authority: EgressCurrentAuthorityV1;
    resolveOutcome?: EgressAuthorityReadOutcomeV1;
    currentOutcome?: EgressAuthorityReadOutcomeV1;
    resolveThrows: boolean;
    currentThrows: boolean;
    resolveCalls: unknown[];
    currentCalls: unknown[];
  } = { authority: options.initialAuthority ?? authorityFor(), resolveThrows: false,
    currentThrows: false, resolveCalls: [], currentCalls: [] };
  const clock = { authorityId: "clock-authority-1", epoch: "process-epoch-1", controlTime: 1_000 };
  const seal = createNodeHmacEgressDecisionSeal({ keyRef: "egress-key", secret: "synthetic-only" });
  const authorityOwner = {
    async resolvePolicy(input: unknown) {
      state.resolveCalls.push(input);
      if (state.resolveThrows) {throw new Error("synthetic resolve failure");}
      return state.resolveOutcome ?? { status: "current" as const, authority: state.authority };
    },
    async readCurrent(input: unknown) {
      state.currentCalls.push(input);
      if (state.currentThrows) {throw new Error("synthetic current failure");}
      return state.currentOutcome ?? { status: "current" as const, authority: state.authority };
    },
  };
  const gateway = createProviderProcessEgressAuthorizationFeature({
    scope: boundScope, authorityOwner, clock: { read: () => ({ ...clock }) },
    digest: createNodeSha256EgressDigest(), signer: seal, verifier: seal,
  }).hostEgressAuthorizationV1;
  return { gateway, state, clock, seal, boundScope };
};

export const feature = () => harness().gateway;
export const provisionalInput = (
  change: Partial<RequestProvisionalEgressAuthorizationV1> = {},
): RequestProvisionalEgressAuthorizationV1 => ({
  contractVersion: "provider-process-egress-provisional/v1", authorizationRequestId: "authorization-1",
  request: requestProjection(), ...change,
});
export const authorizeProvisional = async (gateway = feature(),
  input = provisionalInput()) => {
  const result = await gateway.requestProvisional(input);
  if (result.status !== "authorized") {throw new Error(`fixture denied: ${result.evidence.issueCode}`);}
  return result.decision;
};
export const finalInput = (provisional: Awaited<ReturnType<typeof authorizeProvisional>>,
  change: Partial<RequestFinalEgressAuthorizationV1> = {}): RequestFinalEgressAuthorizationV1 => ({
  contractVersion: "provider-process-egress-final/v1", provisional,
  boundaryUseId: "boundary-use-1", connectionAttemptId: "connection-1", streamId: "stream-1",
  transport: "tcp-tls",
  resolver: { resolverIdentity: "resolver-1", resolverEpoch: "resolver-epoch-1", resolutionCount: 1,
    addresses: [{ family: "ipv4", address: "93.184.216.34", classification: "public" }] },
  pinnedDestination: { address: "93.184.216.34", port: 443 },
  observedPeer: { address: "93.184.216.34", port: 443 },
  tls: { sniHostname: "api.example.com", certificateValidated: true,
    dnsIdentity: "api.example.com", certificateDigest: digest("8"), tlsPolicyDigest: digest("4"),
    alpn: "http/1.1" },
  request: provisional.request, redirectHop: 0, ...change,
});

export const assertDeepFrozen = (value: unknown): void => {
  if (value === null || typeof value !== "object") {return;}
  if (!Object.isFrozen(value)) {throw new Error("value is not frozen");}
  for (const nested of Object.values(value)) {assertDeepFrozen(nested);}
};
