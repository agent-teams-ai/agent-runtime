import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodexAppServerPermissionBoundary } from "@agent-teams/agent-execution/composition";
import {
  createHostCustodiedAgentRuntimeHost,
  createClaudeCodeSetupInspectionPlanner,
  createCodexSetupInspectionPlanner,
  ProviderRouteEnforcementUnsupportedError,
  type ContainedTurnOuterCompositionDependencies,
} from "../dist/composition.js";
import { composeCandidateHostCustodiedContainedTurnForImplementationEvidence } from
  "../dist/composition/contained-turn-feature-composition.js";
import { DeterministicCurrentOwnerHost } from "../../../contexts/agent-execution/tests/current-owner-success-fixture.ts";
import { createDependencies } from "../../../contexts/agent-execution/tests/features/contained-agent-turn/support/contained-agent-turn-fixture.ts";

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

const unavailable = (): never => {throw new Error("setup dependency must not be reached");};
const codexInitialization = Object.freeze({
  platformFamily: "unix" as const,
  platformOs: "linux" as const,
  userAgent: "agent-runtime/0.150.1 (Ubuntu 24.04; x86_64) synthetic (agent-runtime; codex-app-server-contained-turn:0.150.1+native-permission-config-v2)",
});
const setupCapabilities = Object.freeze({
  claudeCodeSetup: Object.freeze({
    authorizeClaudeCodeSetupInspection: Object.freeze({execute: unavailable}),
    discoverClaudeCodeInstallations: Object.freeze({execute: unavailable}),
    inspectClaudeCodeConfiguration: Object.freeze({execute: unavailable}),
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("linux"),
  }),
  codexSetup: Object.freeze({
    authorizeSetupInspection: Object.freeze({execute: unavailable}),
    discoverCodexInstallations: Object.freeze({execute: unavailable}),
    inspectCodexConfiguration: Object.freeze({execute: unavailable}),
    planCodexSetupInspection: createCodexSetupInspectionPlanner("linux"),
  }),
});

type OuterProviderAccess = ContainedTurnOuterCompositionDependencies["providerAccess"];
type OuterSecurityAuthority = ContainedTurnOuterCompositionDependencies["security"]["dispatchAuthorityV1"];

const providerAccess = Object.freeze({
  dispatchConsumptionV1: Object.freeze({
    async consumeForDispatch(input: Parameters<OuterProviderAccess["dispatchConsumptionV1"]["consumeForDispatch"]>[0]) {
      return Object.freeze({kind: "consumed" as const, receipt: Object.freeze({
        ...input.binding,
        authorityHeadDigestAtConsumption: input.binding.authorityHeadDigest,
        claimBeforeControlTime: 100,
        claimBindingDigest: input.claimBindingDigest,
        consumedAtControlTime: 50,
        consumptionDigest: "provider-access-consumption:synthetic",
        grantRequestId: input.grantRequestId,
        opaqueOwnerEvidenceRef: "provider-access-evidence:synthetic",
        operationId: input.operationId,
        provider: input.provider,
        purpose: input.purpose,
        requestDigest: input.requestDigest,
        scope: input.scope,
      })});
    },
    async observeDispatchConsumption() {return Object.freeze({kind: "not_found" as const});},
    async settleDispatchConsumption(input: Parameters<OuterProviderAccess["dispatchConsumptionV1"]["settleDispatchConsumption"]>[0]) {
      return Object.freeze({kind: "settled" as const, receipt: Object.freeze({
        consumptionDigest: input.consumptionDigest,
        disposition: input.disposition,
        expectedBinding: input.expectedBinding,
        operationId: input.operationId,
        provider: input.provider,
        scope: input.scope,
        settledAtControlTime: 100,
        settlementDigest: "provider-access-settlement:synthetic",
        settlementRequestId: input.settlementRequestId,
      })});
    },
  }),
  resolve: Object.freeze({async execute(input: Parameters<OuterProviderAccess["resolve"]["execute"]>[0]) {
    return Object.freeze({
      binding: Object.freeze({
        accessRef: "access:synthetic", credentialBindingDigest: "binding:synthetic",
        credentialBindingRef: "credential-binding:synthetic", credentialGeneration: 1,
        projectId: input.scope.projectId, provider: input.provider, providerAccountRef: "account:synthetic",
        providerRouteRef: "route:synthetic", revision: 1, tenantId: input.scope.tenantId,
      }),
      evidence: Object.freeze({authorityDigest: "authority:acceptance", bindingAuthorityDigest: "binding:synthetic",
        proofRef: "proof:acceptance", purpose: "acceptance" as const}),
      kind: "resolved" as const,
    });
  }}),
  revalidate: Object.freeze({async execute(input: Parameters<OuterProviderAccess["revalidate"]["execute"]>[0]) {
    return Object.freeze({
      binding: input.binding,
      evidence: Object.freeze({authorityDigest: "authority:dispatch", bindingAuthorityDigest: "binding:synthetic",
        proofRef: "proof:dispatch", purpose: "dispatch" as const}),
      kind: "valid" as const,
    });
  }}),
}) satisfies OuterProviderAccess;

const runtimeSecurityAuthority = Object.freeze({
  async consumeForDispatch(input: Parameters<OuterSecurityAuthority["consumeForDispatch"]>[0]) {
    return Object.freeze({status: "consumed" as const, receipt: Object.freeze({
      acceptedAuthorityDigest: input.acceptedAuthorityDigest,
      authorityGeneration: input.authorityGeneration,
      authorityHeadDigestAtConsumption: input.expectedAuthorityHeadDigest,
      authorityRevision: input.expectedAuthorityRevision,
      claimBeforeControlTime: 100,
      claimBindingDigest: input.claimBindingDigest,
      consumedAtControlTime: 50,
      consumptionDigest: "runtime-security-consumption:synthetic",
      constraintsDigest: input.expectedConstraintsDigest,
      containmentPolicyDigest: input.expectedContainmentPolicyDigest,
      contractVersion: "contained-turn-dispatch-consumption/v1" as const,
      grantRequestId: input.grantRequestId,
      operationId: input.operationId,
      ownerEvidenceRef: "runtime-security-evidence:synthetic",
      providerBindingDigest: input.providerBindingDigest,
      providerId: input.providerId,
      purpose: input.purpose,
      requestDigest: input.requestDigest,
      scope: input.scope,
    })});
  },
  async observeDispatchConsumption() {return Object.freeze({status: "not_found" as const});},
  async settleDispatchConsumption() {
    return Object.freeze({status: "settled" as const, receipt: Object.freeze({})});
  },
}) satisfies OuterSecurityAuthority;

class AmbiguousContainmentHost extends DeterministicCurrentOwnerHost {
  public override async requestContainment() {
    this.containments += 1;
    return Object.freeze({evidenceRef: "evidence:ambiguous-containment", kind: "unproven" as const});
  }
}

const createCompositionInput = async (hostCustody: DeterministicCurrentOwnerHost, root: string) => {
  const fixture = createDependencies();
  const effectAdmission = Object.freeze({});
  const workspaceRef = join(root, "workspace");
  const privateRootPath = join(root, "host-private");
  const codexHome = join(privateRootPath, "home");
  const tmpDir = join(privateRootPath, "temp");
  await Promise.all([
    mkdir(workspaceRef, {recursive: true, mode: 0o700}),
    mkdir(codexHome, {recursive: true, mode: 0o700}),
    mkdir(tmpDir, {recursive: true, mode: 0o700}),
  ]);
  return Object.freeze({
    fixture,
    input: Object.freeze({
      operationStore: fixture.dependencies.operationStore,
      security: Object.freeze({
        dispatchAuthorityV1: runtimeSecurityAuthority,
        legacy: fixture.dependencies.security,
      }),
      providerAccess,
      workspace: fixture.dependencies.workspace,
      artifacts: fixture.dependencies.artifacts,
      hostCustody,
      selectedProvider: Object.freeze({
        kind: "codex" as const,
        owner: Object.freeze({
          effectCustody: Object.freeze({admit: () => effectAdmission}),
          hostBootId: "host-boot:embedded-custody",
          hostInstanceId: "host-instance:embedded-custody",
          platformTarget: Object.freeze({architecture: "x64" as const, platform: "linux" as const}),
          launchRecords: Object.freeze({async resolve(input) {
            return Object.freeze({
              boundary: createCodexAppServerPermissionBoundary({codexHome, intentMode: input.intentMode, workspaceRef}),
              credentialOutputInventory: Object.freeze({
                credentialBindingDigest: input.credentialBindingDigest,
                credentialGeneration: input.credentialGeneration,
                sensitiveOutputTokens: Object.freeze([]),
              }),
              executablePath: "/synthetic/codex", privateRootPath, tmpDir,
            });
          }}),
          workspaceOwner: Object.freeze({async withLaunchAuthority<Result>(
            _input: unknown,
            consume: (authority: Readonly<{canonicalPath: string; descriptorPath: string;
              identity: Readonly<{dev: bigint; ino: bigint; mountId: string}>}>) => Promise<Result>,
          ): Promise<Result> {
            return consume(Object.freeze({canonicalPath: workspaceRef, descriptorPath: "/proc/self/fd/99",
              identity: Object.freeze({dev: 1n, ino: 2n, mountId: "mount:synthetic"})}));
          }}),
        }),
      }),
    }),
  });
};

const submit = Object.freeze({
  commandId: "command:embedded-host-custody", expectedProvider: "codex",
  intent: Object.freeze({mode: "analysis" as const, prompt: "Inspect the disposable synthetic workspace."}),
  scope: Object.freeze({projectId: "project:one", tenantId: "tenant:one"}),
});

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
