import {joinLinuxCodexSignerConsumption, bindLinuxCodexNodeConsumption} from "../dist/composition/linux-codex-node-recipe-consumption.js";
import assert from "node:assert/strict";
import {test} from "node:test";
import {createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate,
  type EgressCurrentAuthorityV2} from "@agent-teams/runtime-security/composition";
import {bindContainedTurnHttpRuntimeSecurity} from "../dist/composition/contained-turn-http-runtime-security.js";
import {authorityFor, digest, scope} from
  "@agent-teams/runtime-security/tests/provider-process-egress-authorization.fixtures.ts";

const request = () => ({
  method: "POST" as const, scheme: "https" as const, authority: {hostname: "api.example.com", port: 443},
  requestTarget: {digest: digest("a"), byteLength: 24},
  headers: {canonicalDigest: digest("6"), fieldCount: 4, credentialFields: [{
    name: "authorization", credentialBindingDigest: digest("3"), valueDigest: digest("7"), byteLength: 32}]},
  body: {digest: digest("5"), byteLength: 128},
  framing: {protocol: "http/1.1" as const, requestTarget: "origin-form" as const,
    authoritySource: "host" as const, contentLength: 128, transferEncoding: "absent" as const,
    connectionSpecificHeaders: "absent" as const},
});

const fixture = () => {
  const {signingKey: _signingKey, ...policy} = authorityFor(request()).policy;
  const state: {authority: EgressCurrentAuthorityV2; unavailable: boolean; resolves: number; reads: number} = {
    authority: {...authorityFor(request()), policy}, unavailable: false, resolves: 0, reads: 0};
  const candidate = createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate({
    scope: scope(), hostReservationId: "custody-1", keyRef: "key-1", keyGeneration: "1", signerRevision: "1",
    clock: {read: () => ({authorityId: "clock-1", epoch: "epoch-1", controlTime: 1_000})},
    authorityOwner: {
      async resolvePolicy() {state.resolves += 1; return {status: "current", authority: state.authority};},
      async readCurrent() {state.reads += 1;
        if (state.unavailable) {throw new Error("private-owner-diagnostic");}
        return {status: "current", authority: state.authority};},
    },
  });
  const binding = bindContainedTurnHttpRuntimeSecurity(candidate);
  return {candidate, binding, state};
};

const provisional = async (f: ReturnType<typeof fixture>) => {
  const outcome = await f.binding.runtimeSecurity.requestProvisional({
    contractVersion: "provider-process-egress-provisional/v2", authorizationRequestId: "request-1", request: request()});
  assert.equal(outcome.status, "authorized");
  if (outcome.status !== "authorized") {throw new Error("Expected signed provisional decision");}
  return outcome.decision;
};

const finalInput = (decision: Awaited<ReturnType<typeof provisional>>) => ({
  contractVersion: "provider-process-egress-final/v2" as const, provisional: decision,
  boundaryUseId: "boundary-1", connectionAttemptId: "connection-1", streamId: "stream-1", transport: "tcp-tls" as const,
  resolver: {resolverIdentity: "resolver-1", resolverEpoch: "resolver-epoch-1", resolutionCount: 1 as const,
    addresses: [{family: "ipv4" as const, address: "93.184.216.34", classification: "public" as const}]},
  pinnedDestination: {address: "93.184.216.34", port: 443}, observedPeer: {address: "93.184.216.34", port: 443},
  tls: {sniHostname: "api.example.com", certificateValidated: true, dnsIdentity: "api.example.com",
    certificateDigest: digest("8"), tlsPolicyDigest: digest("4"), alpn: "http/1.1" as const},
  request: request(), redirectHop: 0 as const,
});

test("binding is inert and preserves real RS signatures through the HTTP projection", async () => {
  const f = fixture();
  try {
    assert.deepEqual([f.state.resolves, f.state.reads], [0, 0]);
    assert.deepEqual(Object.keys(f.binding).toSorted(), ["runtimeSecurity", "verifier"]);
    const decision = await provisional(f);
    assert.equal(f.binding.verifier.verifyProvisionalDecision(decision), true);
    assert.equal(f.candidate.hostEgressVerifierV2.verifyProvisionalDecision(decision), true);
    assert.deepEqual(decision.request, request());
    const result = await f.binding.runtimeSecurity.authorizeFirstApplicationByte(finalInput(decision));
    assert.equal(result.status, "authorized");
    if (result.status !== "authorized") {throw new Error("Expected signed final grant");}
    assert.equal(f.binding.verifier.verifyGrant(result.grant), true);
    assert.equal(f.candidate.hostEgressVerifierV2.verifyGrant(result.grant), true);
    assert.deepEqual(result.grant.payload.providerAccess, f.state.authority.providerAccess);
    assert.deepEqual(result.grant.payload.request, request());
    assert.ok(f.state.resolves > 0); assert.ok(f.state.reads > 0);
    assert.ok(Object.isFrozen(result.grant.payload.resolver.normalizedAddresses));
    assert.ok(Object.isFrozen(f.binding.verifier.signingKey));
    const altered = structuredClone(result.grant);
    (altered.payload.selectedPeer as {address: string}).address = "93.184.216.35";
    assert.equal(f.binding.verifier.verifyGrant(altered), false);
    const other = fixture();
    try {assert.equal(other.binding.verifier.verifyGrant(result.grant), false);}
    finally {other.candidate.dispose();}
  } finally {f.candidate.dispose();}
});

for (const change of ["revoked", "policyGeneration", "accountRef", "routeAuthorityDigest", "credentialGeneration",
  "credentialBindingDigest", "unavailable"] as const) {
  test(`fresh RS owner ${change} denies final authorization after a valid provisional decision`, async () => {
    const f = fixture();
    try {
      const decision = await provisional(f);
      if (change === "unavailable") {f.state.unavailable = true;}
      else if (change === "revoked") {f.state.authority = {...f.state.authority,
        policy: {...f.state.authority.policy, revoked: true}};}
      else if (change === "policyGeneration") {f.state.authority = {...f.state.authority,
        policy: {...f.state.authority.policy, policyGeneration: "changed"}};}
      else {f.state.authority = {...f.state.authority,
        providerAccess: {...f.state.authority.providerAccess, [change]: change.includes("Digest") ? digest("b") : "changed"}};}
      const result = await f.binding.runtimeSecurity.authorizeFirstApplicationByte(finalInput(decision));
      assert.deepEqual(result, {status: "denied"});
      assert.ok(f.state.reads > 0);
      assert.doesNotMatch(JSON.stringify(result), /private-owner-diagnostic/);
    } finally {f.candidate.dispose();}
  });
}

test("owner disposal prevents new grants while historical signatures remain verifiable", async () => {
  const f = fixture(); const decision = await provisional(f); f.candidate.dispose();
  assert.equal(f.binding.verifier.verifyProvisionalDecision(decision), true);
  assert.deepEqual(await f.binding.runtimeSecurity.authorizeFirstApplicationByte(finalInput(decision)), {status: "denied"});
  assert.deepEqual(await f.binding.runtimeSecurity.requestProvisional({
    contractVersion: "provider-process-egress-provisional/v2", authorizationRequestId: "request-2", request: request()}),
  {status: "denied"});
});

test("the bridge rejects altered owner proofs before returning authorization", async () => {
  const f = fixture();
  try {
    const decision = await provisional(f);
    const final = await f.binding.runtimeSecurity.authorizeFirstApplicationByte(finalInput(decision));
    if (final.status !== "authorized") {throw new Error("Expected signed final grant");}
    const binding = bindContainedTurnHttpRuntimeSecurity(Object.freeze({...f.candidate,
      hostEgressAuthorizationV2: Object.freeze({
        async requestProvisional() {return {status: "authorized" as const,
          decision: {...decision, authorityRef: "altered"}};},
        async authorizeFirstApplicationByte() {return {status: "authorized" as const,
          grant: {...final.grant, finalAuthorizationDigest: digest("b")}};},
      }),
    }));
    assert.deepEqual(await binding.runtimeSecurity.requestProvisional({
      contractVersion: "provider-process-egress-provisional/v2", authorizationRequestId: "request-1", request: request()}),
    {status: "denied"});
    assert.deepEqual(await binding.runtimeSecurity.authorizeFirstApplicationByte(finalInput(decision)), {status: "denied"});
  } finally {f.candidate.dispose();}
});

test("consumption envelope records the actual broker verifier key and retains the selected receiver", async () => {
  const f = fixture();
  try {
    const subject = {tenantId: "tenant-1", projectId: "project-1", scopeDigest: digest("c"), operationId: "operation-1",
      attemptId: "attempt-1", custodyId: "custody-1", hostBootId: "boot-1", hostInstanceId: "host-1", executionGenerationId: "execution-1"};
    const binder = bindLinuxCodexNodeConsumption({directory: {path: "/synthetic/consumption", device: "1", inode: "2"}}, subject);
    let envelope: ReturnType<typeof binder.readEnvelope> | undefined;
    const selected = {async prepare(references: Parameters<typeof binder.readEnvelope>[0]) {
      assert.equal(this, selected); envelope = binder.readEnvelope(references);
      return {kind: "unknown" as const};
    }};
    const joined = joinLinuxCodexSignerConsumption(selected, f.candidate.hostEgressVerifierV2);
    selected.prepare = async () => {throw new Error("mutated callback");};
    await joined.prepare({selectedDockerAuthorityDigest: digest("d"), networkNamespaceIdentity: "netns:1:2",
      cgroupIdentity: "cgroup:3:4", listenerIdentity: "listener:ipv4:172.30.0.1:43129"});
    assert.equal(envelope?.signerIdentity, f.binding.verifier.signingKey.publicKeyDigest);
    assert.notEqual(envelope?.signerIdentity, "key-1");
    assert.ok(Object.isFrozen(envelope));
  } finally {f.candidate.dispose();}
});
