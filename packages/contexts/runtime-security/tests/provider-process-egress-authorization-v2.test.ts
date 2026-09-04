import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate,
  type EgressCurrentAuthorityV2,
  type ProvisionalEgressAuthorizationV2,
  type RequestFinalEgressAuthorizationV2,
  type SignedFirstApplicationByteGrantV2,
} from "../dist/composition.js";
import { authorityFor, harness as v1Harness, provisionalInput as v1ProvisionalInput,
  requestProjection, scope } from "./provider-process-egress-authorization.fixtures.ts";

const authorityV2 = (): EgressCurrentAuthorityV2 => {
  const source = authorityFor();
  const { signingKey: _signingKey, ...policy } = source.policy;
  return { authorityRef: source.authorityRef, policy, providerAccess: source.providerAccess };
};

const candidateHarness = (change: Partial<{
  hostReservationId: string;
  keyGeneration: string;
  keyRef: string;
  signerRevision: string;
}> = {}) => {
  const state = { authority: authorityV2(), resolveCalls: [] as unknown[], currentCalls: [] as unknown[] };
  const clock = { authorityId: "clock-authority-1", epoch: "process-epoch-1", controlTime: 1_000 };
  const authorityOwner = {
    async resolvePolicy(input: unknown) {state.resolveCalls.push(input);
      return { status: "current" as const, authority: state.authority };},
    async readCurrent(input: unknown) {state.currentCalls.push(input);
      return { status: "current" as const, authority: state.authority };},
  };
  const candidate = createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate({
    scope: scope(), hostReservationId: change.hostReservationId ?? "host-reservation-1",
    keyRef: change.keyRef ?? "candidate-egress-key", keyGeneration: change.keyGeneration ?? "1",
    signerRevision: change.signerRevision ?? "rs-ed25519-candidate-v2", authorityOwner,
    clock: { read: () => ({ ...clock }) },
  });
  return { candidate, gateway: candidate.hostEgressAuthorizationV2,
    verifier: candidate.hostEgressVerifierV2, state, clock, authorityOwner };
};

const provisionalInputV2 = () => ({
  contractVersion: "provider-process-egress-provisional/v2" as const,
  authorizationRequestId: "authorization-1", request: requestProjection(),
});

const authorizeProvisionalV2 = async (setup: ReturnType<typeof candidateHarness>) => {
  const outcome = await setup.gateway.requestProvisional(provisionalInputV2());
  assert.equal(outcome.status, "authorized");
  if (outcome.status !== "authorized") {throw new Error(outcome.evidence.issueCode);}
  return outcome.decision;
};

const finalInputV2 = (provisional: ProvisionalEgressAuthorizationV2):
  RequestFinalEgressAuthorizationV2 => ({
  contractVersion: "provider-process-egress-final/v2", provisional,
  boundaryUseId: "boundary-use-1", connectionAttemptId: "connection-1", streamId: "stream-1",
  transport: "tcp-tls", resolver: { resolverIdentity: "resolver-1", resolverEpoch: "resolver-epoch-1",
    resolutionCount: 1, addresses: [{ family: "ipv4", address: "93.184.216.34",
      classification: "public" }] },
  pinnedDestination: { address: "93.184.216.34", port: 443 },
  observedPeer: { address: "93.184.216.34", port: 443 },
  tls: { sniHostname: "api.example.com", certificateValidated: true,
    dnsIdentity: "api.example.com", certificateDigest: `sha256:${"8".repeat(64)}`,
    tlsPolicyDigest: `sha256:${"4".repeat(64)}`, alpn: "http/1.1" },
  request: requestProjection(), redirectHop: 0,
});

const authorizeGrantV2 = async (setup: ReturnType<typeof candidateHarness>) => {
  const provisional = await authorizeProvisionalV2(setup);
  const outcome = await setup.gateway.authorizeFirstApplicationByte(finalInputV2(provisional));
  assert.equal(outcome.status, "authorized");
  if (outcome.status !== "authorized") {throw new Error(outcome.evidence.issueCode);}
  return { provisional, grant: outcome.grant };
};

test("the candidate executes the complete V2 flow with a fresh pinned Ed25519 verifier", async () => {
  const first = candidateHarness();
  const { provisional, grant } = await authorizeGrantV2(first);
  assert.equal(provisional.contractVersion, "provider-process-egress-provisional-decision/v2");
  assert.equal(grant.payload.contractVersion, "provider-process-first-application-byte-grant/v2");
  assert.equal(grant.evidence.contractVersion, "provider-process-egress-grant-evidence/v2");
  assert.equal(grant.payload.consumption.journalKey.namespace, "provider-process-egress/v2");
  assert.equal(provisional.signingKey.algorithm, "ed25519");
  assert.equal(provisional.signingKey.signatureEncoding, "hex-lower");
  assert.match(provisional.signingKey.publicKeyDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(provisional.signature.value, /^[0-9a-f]{128}$/);
  assert.match(grant.signature.value, /^[0-9a-f]{128}$/);
  assert.equal(first.verifier.verifyProvisionalDecision(provisional), true);
  assert.equal(first.verifier.verifyGrant(grant), true);
  assert.equal(Object.isFrozen(grant), true);
  const serialized = JSON.stringify(first.candidate);
  assert.doesNotMatch(serialized, /private|secret|BEGIN|pkcs8/i);

  const second = candidateHarness();
  assert.notEqual(second.verifier.signingKey.publicKeyDigest,
    first.verifier.signingKey.publicKeyDigest);
  assert.equal(second.verifier.verifyGrant(grant), false);
});

test("V1 and V2 exact envelopes reject one another without broadening V1", async () => {
  const v1 = v1Harness();
  const v2 = candidateHarness();
  assert.equal((await v1.gateway.requestProvisional(provisionalInputV2() as never)).status, "denied");
  assert.equal((await v2.gateway.requestProvisional(v1ProvisionalInput() as never)).status, "denied");

  const v1Decision = await v1.gateway.requestProvisional(v1ProvisionalInput());
  const v2Decision = await authorizeProvisionalV2(v2);
  assert.equal(v1Decision.status, "authorized");
  if (v1Decision.status === "authorized") {
    assert.equal((await v2.gateway.authorizeFirstApplicationByte(
      { ...finalInputV2(v2Decision), provisional: v1Decision.decision } as never)).status, "denied");
  }
  const v1Final = { ...finalInputV2(v2Decision), contractVersion:
    "provider-process-egress-final/v1" };
  assert.equal((await v1.gateway.authorizeFirstApplicationByte(v1Final as never)).status, "denied");
});

test("the verifier rejects payload, time, scope, request, TLS, evidence and key substitutions", async () => {
  const setup = candidateHarness();
  const { grant } = await authorizeGrantV2(setup);
  const mutations: ((value: SignedFirstApplicationByteGrantV2) => void)[] = [
    value => {(value.payload.scope as { tenantId: string }).tenantId = "tenant-2";},
    value => {(value.payload.request.body as { digest: string }).digest = `sha256:${"9".repeat(64)}`;},
    value => {(value.payload.time as { authorizedAtControlTime: number }).authorizedAtControlTime += 1;},
    value => {(value.payload.tls as { certificateDigest: string }).certificateDigest =
      `sha256:${"9".repeat(64)}`;},
    value => {(value.payload.consumption as { requestFingerprint: string }).requestFingerprint =
      `sha256:${"9".repeat(64)}`;},
    value => {(value.evidence as { boundaryUseRef: string }).boundaryUseRef = "other-use";},
    value => {(value.signature as { keyRef: string }).keyRef = "other-key";},
    value => {(value.signature as { keyGeneration: string }).keyGeneration = "2";},
    value => {(value.signature as { signerRevision: string }).signerRevision = "other-revision";},
    value => {(value.signature as { publicKeyDigest: string }).publicKeyDigest =
      `sha256:${"0".repeat(64)}`;},
    value => {(value.signature as { hostReservationId: string }).hostReservationId = "other-host";},
    value => {(value.signature as { algorithm: string }).algorithm = "hmac-sha256-synthetic";},
    value => {(value.signature as { value: string }).value = value.signature.value.toUpperCase();},
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(grant);
    mutate(copy);
    assert.equal(setup.verifier.verifyGrant(copy), false);
  }
});

test("final authorization rejects authority drift and provisional binding substitutions", async () => {
  const setup = candidateHarness();
  const provisional = await authorizeProvisionalV2(setup);
  const keyChanges = [
    { keyGeneration: "2" }, { signerRevision: "other" }, { keyRef: "other" },
    { publicKeyDigest: `sha256:${"0".repeat(64)}` }, { hostReservationId: "other" },
  ];
  for (const change of keyChanges) {
    const changed = structuredClone(provisional);
    Object.assign(changed.signingKey, change);
    assert.equal((await setup.gateway.authorizeFirstApplicationByte(finalInputV2(changed))).status,
      "denied");
  }
  setup.state.authority = { ...setup.state.authority,
    policy: { ...setup.state.authority.policy, policyGeneration: "changed" } };
  assert.equal((await setup.gateway.authorizeFirstApplicationByte(finalInputV2(provisional))).status,
    "denied");
});

test("candidate construction and DTO boundaries resist mutation, getters, proxies and oversized arrays", async () => {
  const setup = candidateHarness();
  const originalResolve = setup.authorityOwner.resolvePolicy;
  setup.authorityOwner.resolvePolicy = async () => {throw new Error("replacement");};
  assert.equal((await setup.gateway.requestProvisional(provisionalInputV2())).status, "authorized");
  setup.authorityOwner.resolvePolicy = originalResolve;

  const proxied = provisionalInputV2();
  (proxied as { request: unknown }).request = new Proxy(proxied.request, {});
  assert.equal((await setup.gateway.requestProvisional(proxied as never)).status, "denied");
  const oversized = provisionalInputV2();
  (oversized.request.headers as { credentialFields: unknown[] }).credentialFields =
    Array.from({ length: 257 }, () => ({}));
  assert.equal((await setup.gateway.requestProvisional(oversized as never)).status, "denied");

  const dependencies = { scope: scope(), hostReservationId: "host", keyRef: "key",
    keyGeneration: "1", signerRevision: "revision", authorityOwner: setup.authorityOwner,
    clock: { read: () => ({ ...setup.clock }) } };
  assert.throws(() => createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate(
    new Proxy(dependencies, {})), TypeError);
  let reads = 0;
  Object.defineProperty(dependencies, "keyRef", { enumerable: true, get() {reads += 1; return "key";} });
  assert.throws(() => createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate(dependencies),
    TypeError);
  assert.equal(reads, 0);
});

test("disposal is monotonic and does not regenerate verifier trust", async () => {
  const setup = candidateHarness();
  const { grant } = await authorizeGrantV2(setup);
  const digestBefore = setup.verifier.signingKey.publicKeyDigest;
  setup.candidate.dispose();
  setup.candidate.dispose();
  assert.equal(setup.candidate.isDisposed(), true);
  assert.equal(setup.verifier.signingKey.publicKeyDigest, digestBefore);
  assert.equal(setup.verifier.verifyGrant(grant), true);
  assert.equal((await setup.gateway.requestProvisional(provisionalInputV2())).status, "denied");
});
