import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { nativeHttpRequestProfile, type NativeHttpRequestProfileId } from "@agent-teams/agent-execution/composition";
import { createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate,
  type CurrentEgressOwnerInput, type PostgresDispatchConsumptionRepository,canonicalEgressValue } from
  "@agent-teams/runtime-security/composition";
import type { RouteSelectionCurrent, RouteSelectionInput } from "@agent-teams/provider-access/composition";
import { createContainedTurnCurrentEgressOwners,
  type ContainedTurnCurrentEgressOwnersInput } from "../dist/composition/contained-turn-current-egress-owners.js";
import { bindContainedTurnHttpRuntimeSecurity } from "../dist/composition/contained-turn-http-runtime-security.js";
import { harness, selection } from "./support/external/provider-access/features/contained-turn-access/route-selection-fixture.ts";
import { authority } from "./support/external/runtime-security/contained-turn-dispatch-authority.fixtures.ts";
import { routeSelectionDigest } from
  "@agent-teams/provider-access/composition";

export const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const choices = [
  ["codex-chatgpt", "codex-chatgpt-responses/v1"], ["codex-api", "codex-api-key-responses/v1"],
  ["claude-oauth", "claude-authorization-messages/v1"], ["claude-api", "claude-api-key-messages/v1"],
] as const;
type Head = Awaited<ReturnType<PostgresDispatchConsumptionRepository["readAuthority"]>>;
type HttpSecurity = ReturnType<typeof bindContainedTurnHttpRuntimeSecurity>["runtimeSecurity"];
type FinalHttpInput = Parameters<HttpSecurity["authorizeFirstApplicationByte"]>[0];

export const fixture = async (recipe: RouteSelectionInput["recipe"] = "codex-chatgpt",
  profileId: NativeHttpRequestProfileId = "codex-chatgpt-responses/v1",
  selected: Readonly<{binding?: Partial<RouteSelectionInput["binding"]>; authority?: Parameters<typeof authority>[0]}> = {}) => {
  const profile = nativeHttpRequestProfile(profileId)!;
  const seed = selection(recipe);
  const paInput = { ...seed, descriptor: profile, binding: { ...seed.binding,
    scopeDigest: digest("scope"), credentialBindingDigest: digest("original-credential"),
    credentialGeneration: 17, bindingRevision: 3, ...selected.binding } };
  // Existing PA synthetic pool and REAL route owner. Fixture endorsement is an
  // explicit setup action, outside the ACL; no database connection exists here.
  const paHarness = await harness(paInput);
  const paOwner = paHarness.owner();
  const endorsed = await paOwner.control.endorse(1);
  const acceptedDispatch: Head = { headVersion: "9007199254740993", authority: authority({
    scope: { tenantId: paInput.binding.tenantId, projectId: paInput.binding.projectId,
      scopeDigest: paInput.binding.scopeDigest }, providerId: profile.provider,
    acceptedAuthorityDigest: digest("accepted"), authorityHeadDigest: digest("head"),
    constraintsDigest: digest("constraints"), containmentPolicyDigest: digest("containment"),
    requestDigest: digest("request"), providerBindingDigest: digest("provider"),
    claimBindingDigest: digest("claim"), claimBeforeControlTime: 1_005, ...selected.authority,
  }) };
  const { scope, operationId, providerId, authorityGeneration, claimBindingDigest, ...facts } = acceptedDispatch.authority!;
  const operation = { scope: { ...scope, operationId }, providerId, authorityGeneration, claimBindingDigest };
  // Independent expected projection used only to prepare explicit trusted approval.
  const approvedHead = { headVersion: acceptedDispatch.headVersion, authority: { ...facts, operation } };
  const route: CurrentEgressOwnerInput["rule"]["route"] = {
    method: "POST", origin: { scheme: "https", hostname: profile.originHost, port: 443 },
    requestTarget: { digest: digest(profile.upstreamPath), byteLength: Buffer.byteLength(profile.upstreamPath, "utf8") },
    credentialSlots: profile.credentialFieldNames.toSorted(), credentialRecipeRef: recipe,
    framing: { protocol: "http/1.1", requestTarget: "origin-form", authoritySource: "host",
      contentLength: "body-byte-length", transferEncoding: "absent", connectionSpecificHeaders: "absent" },
  };
  const rule = { policyRef: "reviewed-http-rule", revision: "revision-1",
    expectedAcceptedConstraintsDigest: facts.constraintsDigest, route, tlsPolicyDigest: digest("host-tls-policy"),
    limits: { requestBytes: 1_024, responseBytes: 8_192, totalMilliseconds: 30_000 }, decisionTtlMilliseconds: 1_000 };
  const state = { now: 100, clockReads: 0, head: structuredClone(acceptedDispatch), calls: [] as string[],
    paOverride: undefined as { value: unknown } | undefined, afterPa: undefined as (() => void) | undefined,
    rsFailure: false, paFailure: false, rsClosed: 0, paDisposed: 0 };
  const rs = {
    readAuthority(key: Parameters<PostgresDispatchConsumptionRepository["readAuthority"]>[0]): Promise<Head> {
      assert.equal(this, rs); assert.deepEqual(key, { scope, operationId, providerId, authorityGeneration });
      state.calls.push("RS");
      if (state.rsFailure) {return Promise.reject(new Error("synthetic RS unavailable"));}
      return Promise.resolve(state.head);
    },
    close() { state.rsClosed++; },
  };
  const pa = {
    async readCurrent(): Promise<RouteSelectionCurrent | undefined> {
      assert.equal(this, pa); state.calls.push("PA");
      if (state.paFailure) {throw new Error("synthetic PA unavailable");}
      const value = state.paOverride ? state.paOverride.value : await paOwner.readCurrent();
      state.afterPa?.();
      return value as RouteSelectionCurrent | undefined;
    },
    dispose() { state.paDisposed++; paOwner.dispose(); },
  };
  const input: ContainedTurnCurrentEgressOwnersInput = { operation: structuredClone(operation), acceptedDispatch,
    rule, approval: { ruleRevision: rule.revision, bindingDigest: digest(canonicalEgressValue({
      domain: "rs-current-egress-rule/v1", operation, acceptedDispatch: approvedHead, rule })) },
    timing: { controlTimeAtAnchor: 1_000, monotonicAtAnchor: 100, operationDeadlineMonotonic: 10_100,
      readTimeoutMilliseconds: 500 }, monotonicNow: () => { state.clockReads++; return state.now; },
    runtimeSecurity: rs, providerAccess: pa };
  const request = { method: route.method, scheme: route.origin.scheme,
    authority: { hostname: route.origin.hostname, port: route.origin.port }, requestTarget: { ...route.requestTarget },
    headers: { canonicalDigest: digest("headers"), fieldCount: 8, credentialFields: route.credentialSlots.map(name => ({
      name, credentialBindingDigest: paInput.binding.credentialBindingDigest, valueDigest: digest("opaque-value"), byteLength: 32 })) },
    body: { digest: digest("body"), byteLength: 128 }, framing: { ...route.framing, contentLength: 128 } };
  const owner = createContainedTurnCurrentEgressOwners(input);
  const candidate = createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate({ scope: operation.scope,
    hostReservationId: "reservation-1", keyRef: "ephemeral-test-key", keyGeneration: "1", signerRevision: "2",
    authorityOwner: owner, clock: { read: () => ({ authorityId: "control", epoch: "epoch-1",
      controlTime: 1_000 + state.now - 100 }) } });
  const binding = bindContainedTurnHttpRuntimeSecurity(candidate);
  return { input, state, owner, candidate, binding, request, endorsed, paInput, paHarness, paOwner, rs, pa,
    async provisional() {
      const result = await binding.runtimeSecurity.requestProvisional({
        contractVersion: "provider-process-egress-provisional/v2", authorizationRequestId: "request-1", request });
      assert.equal(result.status, "authorized");
      if (result.status !== "authorized") {throw new Error("Expected signed provisional decision");}
      return result.decision;
    },
    finalInput(decision: FinalHttpInput["provisional"]): FinalHttpInput {
      return { contractVersion: "provider-process-egress-final/v2", provisional: decision, boundaryUseId: "byte-1",
        connectionAttemptId: "connection-1", streamId: "stream-1", transport: "tcp-tls",
        resolver: { resolverIdentity: "resolver", resolverEpoch: "epoch-1", resolutionCount: 1,
          addresses: [{ family: "ipv4", address: "93.184.216.34", classification: "public" }] },
        pinnedDestination: { address: "93.184.216.34", port: 443 }, observedPeer: { address: "93.184.216.34", port: 443 },
        tls: { sniHostname: profile.originHost, certificateValidated: true, dnsIdentity: profile.originHost,
          certificateDigest: digest("certificate"), tlsPolicyDigest: digest("host-tls-policy"), alpn: "http/1.1" },
        request, redirectHop: 0 };
    },
    dispose() { owner.dispose(); candidate.dispose(); pa.dispose(); rs.close(); },
  };
};

export const changed = <T>(source: T, path: string, value: unknown): T => {
  const copy = structuredClone(source);
  const keys = path.split(".");
  let target = copy as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) { target = target[key] as Record<string, unknown>; }
  target[keys.at(-1)!] = value;
  return copy;
};
// A synthetically re-endorsed owner result lets tests isolate ACL checks from
// digest integrity checks without creating a second owner implementation.
export const redigest = async (current: RouteSelectionCurrent): Promise<RouteSelectionCurrent> => ({
  ...current, routeGeneration: String(current.binding.bindingRevision), routeAuthorityDigest: await routeSelectionDigest(current),
});
