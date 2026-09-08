import { imageLock } from "../../../contexts/agent-execution/tests/fixtures/docker-image-init-fixture.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createContainedTurnRouteEnforcement } from "@agent-teams/agent-execution/composition";
import {
  createHostCustodiedAgentRuntimeHost,
  ProviderRouteEnforcementUnsupportedError,
} from "../dist/composition.js";
import { composeCandidateHostCustodiedContainedTurnForImplementationEvidence } from
  "../dist/composition/contained-turn-feature-composition.js";
import { DeterministicCurrentOwnerHost } from "../../../contexts/agent-execution/tests/current-owner-success-fixture.ts";
import {setupCapabilities, createCompositionInput, submit} from "./contained-turn-product.fixture.ts";

import {createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate,
  type EgressCurrentAuthorityV2, type RequestFinalEgressAuthorizationV2,
  type SignedFirstApplicationByteGrantV2} from "@agent-teams/runtime-security/composition";
import {authorityFor, digest} from "../../../contexts/runtime-security/tests/provider-process-egress-authorization.fixtures.ts";
import {createStrictHttpEgressBroker} from "../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import type {HostHttpGrant, HostHttpProvisionalDecision, HttpEgressBrokerPorts} from "../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import {createEgressFixture, SECRET_MARKER} from "../../../contexts/agent-execution/tests/features/contained-agent-turn/http-egress-test-fixture.ts";
import {
  createCredentialMaterializationRequestDigest,
  createInMemoryContainedTurnDispatchConsumptionV1,
} from "@agent-teams/provider-access/composition";

const codexInitialization = Object.freeze({
  platformFamily: "unix" as const,
  platformOs: "linux" as const,
  userAgent: "agent-runtime/0.150.1 (Ubuntu 24.04; x86_64) synthetic (agent-runtime; codex-app-server-contained-turn:0.150.1+native-permission-config-v2)",
});
const unavailable = (): never => {throw new Error("setup dependency must not be reached");};
class AmbiguousContainmentHost extends DeterministicCurrentOwnerHost {
  public override async requestContainment() {
    this.containments += 1;
    return Object.freeze({evidenceRef: "evidence:ambiguous-containment", kind: "unproven" as const});
  }
}


test("product Host composition rejects a candidate before Host Custody effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "embedded-host-custody-"));
  const custody = new DeterministicCurrentOwnerHost(codexInitialization);
  try {
    const composed = await createCompositionInput(custody, root);
    assert.throws(() => createHostCustodiedAgentRuntimeHost({
      authorityRevision: "runtime-access-authority:fixture",
      capabilities: setupCapabilities, containedTurn: composed.input,
    }), error => error instanceof ProviderRouteEnforcementUnsupportedError &&
      error.reason === "route-enforcement-unqualified");
    assert.deepEqual({containments: custody.containments, finalities: custody.finalities,
      releases: custody.releases, reserves: custody.reserves, starts: custody.starts},
    {containments: 0, finalities: 0, releases: 0, reserves: 0, starts: 0});
  } finally {await rm(root, {recursive: true, force: true});}
});

test("ambiguous Host containment stays nonterminal without releasing operation custody", async () => {
  const root = await mkdtemp(join(tmpdir(), "embedded-host-custody-ambiguous-"));
  const custody = new AmbiguousContainmentHost();
  try {
    const composed = await createCompositionInput(custody, root);
    const product = composeCandidateHostCustodiedContainedTurnForImplementationEvidence(composed.input);
    const outcome = await product.feature.submit.execute(submit);
    assert.equal(outcome.status, "observed");
    assert.equal(outcome.status === "observed" && outcome.turn.status, "reconcile_required");
    assert.equal(custody.containments, process.platform === "linux" ? 1 : 0);
    assert.equal(custody.releases, 0);
    // A possibly live process retains its operation-private workspace in custody;
    // moving that workspace would manufacture cleanup evidence.
    assert.equal(composed.fixture.workspaceQuarantines.length, 0);
    product.dispose();
  } finally {await rm(root, {recursive: true, force: true});}
});

const selected = "2606:4700:1111:1111:1111:1111:1111:1111";
const canonical = ["2606:4700:0000:0000:0000:0000:0000:abcd",
  "2606:4700:0001:0000:0000:0000:0000:0001", selected] as const;
const candidates = [selected, "2606:4700:1::1", "2606:4700::ABCD"];

const executeSigned = async (options: Readonly<{
  addresses?: readonly string[]; selectedAddress?: string; peerAddress?: string; peerAtFirstByte?: string;
  changeFinal?: (input: RequestFinalEgressAuthorizationV2) => RequestFinalEgressAuthorizationV2;
  changeGrant?: (grant: SignedFirstApplicationByteGrantV2) => SignedFirstApplicationByteGrantV2;
}> = {}) => {
  const peerAddress = options.peerAddress ?? options.selectedAddress ?? selected;
  const fixture = createEgressFixture({addresses: options.addresses ?? candidates,
    selectedAddress: options.selectedAddress ?? selected,
    binding: {peerAddress, certificateDigest: digest("8") as `sha256:${string}`, tlsPolicyDigest: digest("4")},
    ...(options.peerAtFirstByte === undefined ? {} : {bindingAtFirstByte: {peerAddress: options.peerAtFirstByte}})});
  const {ports: base} = fixture;
  const snapshot = {...base.providerAccessSnapshot, scopeDigest: digest("1"), ownerAuthorityDigest: digest("3")};
  const providerAccessHarness = createInMemoryContainedTurnDispatchConsumptionV1({bindings: [Object.freeze({
    acceptedAuthorityDigest: "accepted-authority:http-egress", accessRef: snapshot.accessRef,
    authorityHeadDigest: "authority-head:http-egress", bindingDigest: "binding:http-egress",
    bindingRevision: snapshot.revision, claimBeforeControlTime: 100,
    credentialBindingDigest: snapshot.ownerAuthorityDigest, credentialBindingRef: snapshot.credentialBindingRef,
    credentialGeneration: snapshot.credentialGeneration, expiresAtControlTime: 100,
    opaqueOwnerEvidenceRef: "owner-evidence:http-egress", projectId: snapshot.projectId,
    provider: snapshot.provider, providerAccountRef: snapshot.providerAccountRef,
    providerRouteRef: snapshot.providerRouteRef, scopeDigest: snapshot.scopeDigest,
    tenantId: snapshot.tenantId,
  })], initialControlTime: 50});
  let authority: EgressCurrentAuthorityV2;
  const candidate = createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate({
    scope: {tenantId: snapshot.tenantId, projectId: snapshot.projectId,
      operationId: base.identity.operationId, scopeDigest: snapshot.scopeDigest},
    hostReservationId: base.identity.custodyId, keyRef: "resolver-regression-key", keyGeneration: "1",
    signerRevision: "resolver-regression-v2", clock: {read: () => ({authorityId: "clock-authority",
      epoch: "epoch-1", controlTime: 0})},
    authorityOwner: {resolvePolicy: async input => {
      const source = authorityFor(input.request);
      const {signingKey: _key, ...policy} = source.policy;
      authority = {authorityRef: source.authorityRef,
        policy: {...policy, origin: {scheme: "https", hostname: base.route.originHost, port: base.route.originPort},
          dnsIdentity: base.route.originHost},
        providerAccess: {...source.providerAccess, providerRef: snapshot.provider,
          routeGeneration: String(snapshot.revision), credentialGeneration: String(snapshot.credentialGeneration)}};
      return {status: "current", authority};
    }, readCurrent: async () => ({status: "current", authority})},
  });
  const finalInputs: RequestFinalEgressAuthorizationV2[] = [];
  const signedGrants: SignedFirstApplicationByteGrantV2[] = [];
  const verified: boolean[] = [];
  const ports: HttpEgressBrokerPorts = {...base, providerAccessSnapshot: snapshot,
    providerAccess: Object.freeze({
      createRequestDigest: createCredentialMaterializationRequestDigest,
      authorize: providerAccessHarness.materialization.authorize,
      observe: providerAccessHarness.materialization.observe,
    }),
    evidence: {...base.evidence, digest: parts => `sha256:${base.evidence.digest(parts)}`},
    runtimeSecurity: {
      requestProvisional: async input => {
        const outcome = await candidate.hostEgressAuthorizationV2.requestProvisional(input);
        return outcome.status === "denied" ? outcome
          : {status: "authorized", decision: outcome.decision as HostHttpProvisionalDecision};
      },
      authorizeFirstApplicationByte: async input => {
        finalInputs.push(input);
        const outcome = await candidate.hostEgressAuthorizationV2.authorizeFirstApplicationByte(
          options.changeFinal?.(input) ?? input);
        if (outcome.status === "denied") {return outcome;}
        signedGrants.push(outcome.grant);
        assert.equal(candidate.hostEgressVerifierV2.verifyGrant(outcome.grant), true);
        return {status: "authorized", grant: (options.changeGrant?.(outcome.grant) ?? outcome.grant) as HostHttpGrant};
      },
    }, verifier: {...candidate.hostEgressVerifierV2, verifyGrant: grant => {
      const valid = candidate.hostEgressVerifierV2.verifyGrant(grant);
      verified.push(valid); return valid;
    }},
  };
  try {
    const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
    return {fixture, receipt, finalInputs, signedGrants, verified};
  } finally {candidate.dispose();}
};

test("accepts a real signed IPv6 grant with the signed canonical resolver ordering", async () => {
  for (const addresses of [candidates, candidates.toReversed(), canonical]) {
    const result = await executeSigned({addresses});
    assert.equal(result.signedGrants.length, 1);
    assert.deepEqual(result.verified, [true]);
    assert.equal(result.receipt.outcome, "completed");
    assert.equal(result.fixture.observations.dispatches, 1);
    const input = result.finalInputs[0]; const grant = result.signedGrants[0];
    assert.ok(input); assert.ok(grant);
    const expected = canonical.map(address => ({family: "ipv6", address, classification: "public"}));
    assert.deepEqual(input.resolver.addresses, expected);
    assert.deepEqual(grant.payload.resolver.normalizedAddresses, expected);
    assert.doesNotMatch(JSON.stringify([result.receipt, result.finalInputs, result.signedGrants]), new RegExp(SECRET_MARKER));
  }
});

test("accepts compressed IPv6 transport observations against the expanded signed peer", async () => {
  const result = await executeSigned({selectedAddress: "2606:4700::abcd", peerAddress: "2606:4700::abcd"});
  assert.deepEqual(result.verified, [true]);
  assert.equal(result.receipt.outcome, "completed");
  assert.equal(result.fixture.observations.dispatches, 1);
  const grant = result.signedGrants[0]; assert.ok(grant);
  assert.equal(grant.payload.selectedPeer.address, canonical[0]);
});

test("preserves IPv4 signed grants and sorting", async () => {
  const result = await executeSigned({addresses: ["93.184.216.9", "93.184.216.34"],
    selectedAddress: "93.184.216.34"});
  assert.deepEqual(result.verified, [true]);
  assert.equal(result.receipt.outcome, "completed");
  const input = result.finalInputs[0]; assert.ok(input);
  assert.deepEqual(input.resolver.addresses.map(value => value.address), ["93.184.216.34", "93.184.216.9"]);
});

test("rejects valid signatures for different IPv6 resolver evidence or selected peer", async () => {
  const changes: NonNullable<Parameters<typeof executeSigned>[0]>["changeFinal"][] = [
    input => ({...input, resolver: {...input.resolver, resolverIdentity: "other-resolver"}}),
    input => ({...input, resolver: {...input.resolver, resolverEpoch: "other-epoch"}}),
    input => ({...input, resolver: {...input.resolver, addresses: [{family: "ipv6", address: selected, classification: "public"}]}}),
    input => ({...input, pinnedDestination: {...input.pinnedDestination, address: canonical[0]},
      observedPeer: {...input.observedPeer, address: canonical[0]}}),
  ];
  for (const changeFinal of changes) {
    const result = await executeSigned({changeFinal});
    assert.equal(result.signedGrants.length, 1);
    assert.deepEqual(result.verified, [true]);
    assert.equal(result.receipt.anomalyCode, "final_denied");
    assert.equal(result.receipt.firstByteState, "not_sent");
    assert.equal(result.fixture.observations.dispatches, 0);
  }
});

test("rejects tampered IPv6 grants and peer drift before the first byte", async () => {
  const tampered = await executeSigned({changeGrant: grant => ({...grant, payload: {...grant.payload,
    resolver: {...grant.payload.resolver, normalizedAddresses: grant.payload.resolver.normalizedAddresses.toReversed()}}})});
  assert.deepEqual(tampered.verified, [false]);
  assert.equal(tampered.receipt.anomalyCode, "final_denied");
  const drift = await executeSigned({peerAtFirstByte: "2606:4700::beef"});
  assert.deepEqual(drift.verified, [true]);
  assert.equal(drift.receipt.anomalyCode, "transport_binding_drift");
  for (const result of [tampered, drift]) {
    assert.equal(result.receipt.firstByteState, "not_sent");
    assert.equal(result.fixture.observations.dispatches, 0);
  }
});

// Compiled PRODUCT path: synthetic operation owners, actual production selector,
// Docker kernel custody and private RuntimeAccessHandle. No daemon/provider IO.
const dockerProductRoute = async () => {
  const registry = JSON.parse(await readFile(new URL("../../../../docs/architecture/qualification-registry.json", import.meta.url), "utf8"));
  const target = registry.entries.find((entry: {id: string}) => entry.id === "docker-linux-codex-enforced-network-route").targets[0];
  const pin = {path: "/synthetic/unavailable-route-tool", sha256: "a".repeat(64)};
  return createContainedTurnRouteEnforcement({qualificationTarget: target,
    engine: {inspect: unavailable}, nsenter: pin, nft: pin,
    binding: {tenantId: "tenant:one", projectId: "project:one", scopeDigest: "scope:synthetic",
      operationId: "operation:one", attemptId: "attempt:one", custodyId: "custody:one",
      sourceRevision: "62d1863868d54f0337a6c60f02274ef96659ef47", binaryRevision: target.binaryClosure,
      hostBootId: "host-boot:embedded-custody", executionGenerationId: "generation:synthetic",
      adapterRevision: target.providerAdapter, capabilityManifestRevision: "manifest:synthetic",
      authorityVectorDigest: "authority:synthetic", providerAccountRef: "account:synthetic",
      accessRef: "access:synthetic", bindingRevision: 1, credentialBindingRef: "credential-binding:synthetic",
      providerRouteRef: "route:synthetic", routeRevision: "route-revision:synthetic",
      credentialBindingDigest: "binding:synthetic", credentialGeneration: 1},
  } as never);
};

const assertNoLegacyEffects = (custody: DeterministicCurrentOwnerHost) =>
  assert.deepEqual([custody.reserves, custody.starts, custody.containments, custody.releases], [0, 0, 0, 0]);

test("Linux product refuses absent trusted Docker resources without constructing legacy custody", async () => {
  const root = await mkdtemp(join(tmpdir(), "embedded-docker-product-"));
  const custody = new DeterministicCurrentOwnerHost();
  try {
    const composed = await createCompositionInput(custody, root);
    const input = {...composed.input, routeEnforcement: await dockerProductRoute()};
    assert.throws(() => createHostCustodiedAgentRuntimeHost({authorityRevision: "runtime-access-authority:fixture",
      capabilities: setupCapabilities, containedTurn: input}), process.platform === "linux" && process.arch === "x64"
      ? /Linux Codex composition input unavailable: trusted-resources/u : /route-enforcement-unqualified/u);
    assertNoLegacyEffects(custody);
    assert.equal(composed.fixture.current(), undefined);
  } finally {await rm(root, {recursive: true, force: true});}
});

for (const absent of ["route", "nativeFiles", "currentAuthority"] as const) {
  test(`private Linux Docker handle retains one committed claim and cleanup debt with missing ${absent}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "embedded-docker-product-claim-"));
    const custody = new DeterministicCurrentOwnerHost();
    let selectionCount = 0; let resourceEffects = 0;
    const resourceEffect = () => {resourceEffects += 1; throw new Error("resource effect before admission");};
    try {
      const composed = await createCompositionInput(custody, root);
      const input = {...composed.input, routeEnforcement: await dockerProductRoute(), linuxCodex: {
        imageInitLock: imageLock(), cleanupMilliseconds: 100,
        select() {
          selectionCount += 1;
          // The real Docker owner is the only factory that invokes this callback.
          // The kernel's actual synthetic store must already acknowledge its claim.
          assert.equal(composed.fixture.current()?.dispatch.kind, "claimed");
          return {
            preparation: {resources: {consumption: {prepare: resourceEffect}},
              engineIdentity: resourceEffect, openLifecycle: resourceEffect, openResourceJournal: resourceEffect},
            route: {}, nativeFiles: {install: resourceEffect}, broker: {}, connection: {},
            [absent]: undefined,
          } as never;
        },
      }};
      const build = () => createHostCustodiedAgentRuntimeHost({authorityRevision: "runtime-access-authority:fixture",
        capabilities: setupCapabilities, containedTurn: input});
      if (process.platform !== "linux" || process.arch !== "x64") {
        assert.throws(build, /route-enforcement-unqualified/u);
        assert.equal(selectionCount, 0); assert.equal(resourceEffects, 0); assertNoLegacyEffects(custody);
        return;
      }
      const host = build();
      assert.equal(selectionCount, 0); assert.equal(resourceEffects, 0); assertNoLegacyEffects(custody);
      const access = host.bindAccess({containedTurn: submit.scope});
      assert.deepEqual(Object.keys(access.containedTurn).toSorted(), ["cancel", "observe", "submit"]);
      assert.equal("dispose" in access, false); assert.equal("linuxCodex" in access, false);
      const accepted = await access.containedTurn.submit({commandId: submit.commandId,
        expectedProvider: submit.expectedProvider, intent: submit.intent});
      assert.equal(accepted.status, "accepted");
      if (accepted.status !== "accepted") {throw new Error("expected durable acceptance");}
      let observed = await access.containedTurn.observe(accepted.operationId);
      for (let turn = 0; turn < 100 && !(observed.status === "observed" && observed.turn.status === "reconcile_required"); turn += 1) {
        await new Promise<void>(resolve => {setImmediate(resolve);});
        observed = await access.containedTurn.observe(accepted.operationId);
      }
      assert.equal(observed.status === "observed" && observed.turn.status, "reconcile_required");
      assert.equal(selectionCount, 1); assert.equal(composed.fixture.claimAuthorities.length, 1);
      assert.equal(resourceEffects, 0); assertNoLegacyEffects(custody);
      await access.containedTurn.submit({commandId: submit.commandId,
        expectedProvider: submit.expectedProvider, intent: submit.intent});
      assert.equal(selectionCount, 1); assert.equal(composed.fixture.claimAuthorities.length, 1);
      assert.equal(composed.fixture.providerCalls.value, 0);
      assert.equal(composed.fixture.custodyReleases.length, 0);
      assert.equal(composed.fixture.workspaceQuarantines.length, 0);
      // Missing physical receipts remain owned by the existing Host shutdown contract.
      await assert.rejects(host.dispose());
      assert.equal(resourceEffects, 0); assertNoLegacyEffects(custody);
    } finally {await rm(root, {recursive: true, force: true});}
  });
}
