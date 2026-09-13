import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCurrentEgressOwner } from
  "../../../dist/features/provider-process-egress-authorization/composition/current-egress-owner.js";
import { createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate } from
  "../../../dist/features/provider-process-egress-authorization/composition/ed25519-v2-candidate-factory.js";
import { canonicalEgressValue } from
  "../../../dist/features/provider-process-egress-authorization/application/egress-canonical.js";
import type { CurrentEgressOwnerInput, CurrentEgressEndorsement } from
  "../../../dist/features/provider-process-egress-authorization/composition/current-egress-inputs.js";
import type { ProvisionalEgressAuthorizationV2, RequestFinalEgressAuthorizationV2 } from
  "../../../dist/features/provider-process-egress-authorization/contracts/provider-process-egress-authorization-v2.js";

export const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const scope = () => ({ tenantId: "tenant-1", projectId: "project-1", operationId: "operation-1",
  scopeDigest: digest("scope") });
export const request = () => ({ method: "POST" as const, scheme: "https" as const,
  authority: { hostname: "api.example.com", port: 443 },
  requestTarget: { digest: digest("/v1/messages?beta=true"), byteLength: 22 },
  headers: { canonicalDigest: digest("headers"), fieldCount: 4, credentialFields: [{
    name: "authorization", credentialBindingDigest: digest("original-credential"),
    valueDigest: digest("opaque-materialized-value"), byteLength: 32 }] },
  body: { digest: digest("body"), byteLength: 128 },
  framing: { protocol: "http/1.1" as const, requestTarget: "origin-form" as const,
    authoritySource: "host" as const, contentLength: 128, transferEncoding: "absent" as const,
    connectionSpecificHeaders: "absent" as const } });
export const approve = (input: CurrentEgressOwnerInput) => ({ ...input,
  approval: { ruleRevision: input.rule.revision, bindingDigest: digest(canonicalEgressValue({
    domain: "rs-current-egress-rule/v1", operation: input.operation,
    acceptedDispatch: input.acceptedDispatch, rule: input.rule })) } });

// Synthetic callbacks only: these do not claim production RS/PA persistence.
export const fixture = () => {
  const operation = { scope: scope(), providerId: "provider-1", authorityGeneration: "generation-1",
    claimBindingDigest: digest("committed-claim") };
  const selected = request();
  const route = { method: selected.method, origin: { scheme: selected.scheme, ...selected.authority },
    requestTarget: selected.requestTarget, credentialSlots: ["authorization"],
    credentialRecipeRef: "bearer-recipe-1", framing: { ...selected.framing, contentLength: "body-byte-length" as const } };
  const acceptedDispatch = { headVersion: "7", authority: { operation, decision: "accepted" as const,
    purpose: "contained-turn.provider-dispatch/v1" as const, authorityRevision: "rs-revision-2",
    acceptedAuthorityDigest: digest("accepted-authority"), authorityHeadDigest: digest("head"),
    constraintsDigest: digest("opaque-dispatch-constraints"), containmentPolicyDigest: digest("containment"),
    requestDigest: digest("dispatch-request"), providerBindingDigest: digest("provider-binding"),
    claimBeforeControlTime: 11_000, revoked: false, ownerEvidenceRef: "runtime-security-evidence:v1:head-2" } };
  const pa: CurrentEgressEndorsement = { operation, accessRef: "access-1", accountRef: "account-1",
    providerRouteRef: "pa-route-1", bindingRevision: 3, credentialGeneration: "credential-generation-8",
    credentialBindingDigest: digest("original-credential"), routeAuthorityDigest: digest("pa-owned-route"),
    available: true, revoked: false, route };
  const state = { now: 100, head: structuredClone(acceptedDispatch), pa: structuredClone(pa),
    calls: [] as string[], clockReads: 0 };
  const input = approve({ operation, acceptedDispatch,
    rule: { policyRef: "rs-http-rule", revision: "root-reviewed-rule-1",
      expectedAcceptedConstraintsDigest: acceptedDispatch.authority.constraintsDigest, route,
      tlsPolicyDigest: digest("host-fixed-tls"), limits: { requestBytes: 1024, responseBytes: 8192,
        totalMilliseconds: 30_000 }, decisionTtlMilliseconds: 1000 },
    approval: { ruleRevision: "pending", bindingDigest: digest("pending") },
    timing: { controlTimeAtAnchor: 1000, monotonicAtAnchor: 100, operationDeadlineMonotonic: 10_100,
      readTimeoutMilliseconds: 100 }, monotonicNow: () => { state.clockReads += 1; return state.now; },
    readRsHead: async selector => { assert.deepEqual(selector, operation); state.calls.push("RS"); return state.head; },
    readPaEndorsement: async selector => { assert.deepEqual(selector, operation); state.calls.push("PA"); return state.pa; },
  });
  return { input, state };
};
export const resolveInput = () => ({ scope: scope(), authorizationRequestId: "authorization-1", request: request() });
export const current = async (owner: ReturnType<typeof createCurrentEgressOwner>) => {
  const result = await owner.resolvePolicy(resolveInput());
  assert.equal(result.status, "current");
  if (result.status !== "current") {throw new Error("Expected authorized fixture result");}
  return result.authority;
};
export const candidate = (input: CurrentEgressOwnerInput, controlNow: () => number = () => 1000) => {
  const owner = createCurrentEgressOwner(input);
  const signer = createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate({ scope: input.operation.scope,
    hostReservationId: "host-reservation-1", keyRef: "ephemeral-test-key", keyGeneration: "1",
    signerRevision: "candidate-v2", authorityOwner: owner,
    clock: { read: () => ({ authorityId: "control-authority", epoch: "epoch-1", controlTime: controlNow() }) } });
  return { owner, signer, gateway: signer.hostEgressAuthorizationV2,
    dispose() { owner.dispose(); signer.dispose(); } };
};
export const provisional = async (setup: ReturnType<typeof candidate>) => {
  const { scope: _scope, ...fields } = resolveInput();
  const result = await setup.gateway.requestProvisional({
    contractVersion: "provider-process-egress-provisional/v2", ...fields });
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {throw new Error("Expected authorized fixture result");}
  return result.decision;
};
export const finalInput = (decision: ProvisionalEgressAuthorizationV2): RequestFinalEgressAuthorizationV2 => ({
  contractVersion: "provider-process-egress-final/v2", provisional: decision, boundaryUseId: "byte-use-1",
  connectionAttemptId: "connection-1", streamId: "stream-1", transport: "tcp-tls",
  resolver: { resolverIdentity: "resolver-1", resolverEpoch: "epoch-1", resolutionCount: 1,
    addresses: [{ family: "ipv4", address: "93.184.216.34", classification: "public" }] },
  pinnedDestination: { address: "93.184.216.34", port: 443 }, observedPeer: { address: "93.184.216.34", port: 443 },
  tls: { sniHostname: "api.example.com", certificateValidated: true, dnsIdentity: "api.example.com",
    certificateDigest: digest("certificate"), tlsPolicyDigest: digest("host-fixed-tls"), alpn: "http/1.1" },
  request: decision.request, redirectHop: 0,
});
export const deferred = <T>() => {
  let complete!: (value: T) => void;
  let fail!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { complete = resolve; fail = reject; });
  return { promise, resolve: complete, reject: fail };
};
export const changed = <T>(source: T, path: string, value: unknown): T => {
  const copy = structuredClone(source);
  const keys = path.split(".");
  let target = copy as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) { target = target[key] as Record<string, unknown>; }
  target[keys.at(-1)!] = value;
  return copy;
};
