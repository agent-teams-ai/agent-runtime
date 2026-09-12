import { workspacePackageSourceHref } from "./workspace-package-source.mjs";
import assert from "node:assert/strict";
import {mkdtemp, realpath, lstat, readFile, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import test from "node:test";
import {pathToFileURL} from "node:url";
import {createCompositionInput, setupCapabilities, submit} from "../contained-turn-product.fixture.ts";
import {createHostCustodiedAgentRuntimeHost, AgentRuntimeHostDisposalIncompleteError} from "../../dist/composition.js";
import {createContainedTurnRouteEnforcement} from "@agent-teams/agent-execution/composition";
const { renderCodexNativeBrokerConfig } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js"));
const { DeterministicCurrentOwnerHost } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/current-owner-success-fixture.ts"));
const { policy: basePolicy, createInput } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/features/contained-agent-turn/support/docker-host-custody-lifecycle-fixture.ts"));
const { initOptions } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/features/contained-agent-turn/support/docker-claim-init-fixture.ts"));
const { imageLock } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/fixtures/docker-image-init-fixture.ts"));
const { MemoryV4Storage } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/fixtures/host-http-egress-v4-fixture.ts"));
const { HostHttpEgressV4Journal } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-journal.js"));
const { linuxExclusiveRouteSeccomp } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/linux-exclusive-route-policy.js"));
const { DOCKER_CUSTODY_NODE_PATH, DOCKER_CUSTODY_INIT_ARGUMENTS } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js"));
const { createEgressFixture } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/features/contained-agent-turn/http-egress-test-fixture.ts"));
const { renderingFixture } = await import(workspacePackageSourceHref("@agent-teams/provider-access", "tests/features/contained-turn-access/credential-rendering-test-fixture.ts"));
import {createCredentialMaterializationRequestDigest} from "@agent-teams/provider-access/composition";
import {joinedDocker} from "./linux-joined-docker.mjs";
import {joinedCurrentOwners} from "./linux-joined-current.mjs";
import {openJoinedNetwork} from "./linux-joined-network.mjs";
import {installJoinedPeer} from "./linux-joined-peer.mjs";
const storeInput = persistence => persistence ? {operationStore: persistence.store} : {};
const hash = value => createHash("sha256").update(value).digest("hex");

const closureReady = (saved, outcome) => saved?.physicalContainment.kind === "contained" &&
  (outcome !== "unknown" || saved.closureRecovery.stage === "containment_attestation");

const assertUnresolvedReceipt = saved => {
  assert.equal(saved.providerExecution.kind, "closed");
  assert.equal(saved.providerExecution.outcome, "succeeded");
  assert.equal(saved.closureRecovery.kind, "required");
  assert.equal(saved.closureRecovery.stage, "containment_attestation");
  assert.equal(saved.terminal.kind, "open");
  assert.equal(saved.reconciliation.kind, "clear", "HTTP closure debt must not invent provider ambiguity");
};

const disposeJoined = async ({host, expectReconciliationDebt, operationId, docker, network, current, persistence, root}) => {
    const failures = [];
    for (const cleanup of [async () => {
      if (!expectReconciliationDebt) {await host?.dispose(); return;}
      // Physical containment does not turn unresolved request evidence into a
      // terminal operation. Disposal must retain the exact unresolved owner.
      await assert.rejects(host.dispose(), error => {
        assert.ok(error instanceof AgentRuntimeHostDisposalIncompleteError);
        assert.equal(error.status, "termination_unproven");
        assert.equal(error.activeCallCount, 0);
        assert.deepEqual(error.containedTurns, [{operationId, status: "reconcile_required"}]);
        return true;
      });
    }, () => docker?.dispose(), () => network?.dispose(),
      () => current?.dispose(), () => persistence?.dispose(), () => root === undefined ? undefined : rm(root, {recursive: true, force: true})]) {
      try {await cleanup();} catch (error) {failures.push(error);}
    }
    if (failures.length) {throw new AggregateError(failures, "joined cleanup failed");}
};

// Explicit integration entrypoint inside a new outer Linux netns. External
// Docker, authority repositories and provider peer are synthetic. No live E2E claim.
export function registerLinuxJoinedProduct({outcomes = ["recorded", "unknown"], openStore} = {}) {
for (const evidenceOutcome of outcomes) {
test(`public RuntimeAccessHandle joins native broker with evidence ${evidenceOutcome}`, {timeout: 90000}, async t => {
  let network; let root; let current; let docker; let nativeHome; let host; let nativeRecipe; let peer; let brokerObservations;
  let expectReconciliationDebt = false;
  let operationId = "operation:one";
  let persistence;
  t.after(() => disposeJoined({host, expectReconciliationDebt, operationId, docker, network, current, persistence, root}));
  network = await openJoinedNetwork();
  root = await mkdtemp(join(process.env.AR69_JOINED_TEST_PARENT ?? tmpdir(), "ar69-joined-product-"));
  root = await realpath(root);
  const physicalBoot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const legacy = new DeterministicCurrentOwnerHost();
  const composed = await createCompositionInput(legacy, root, {workspaceRef: join(root, "workspaces", "operation"),
    privateRootPath: join(root, "private", "operation"), bindingDigest: `sha256:${hash("joined-synthetic-credential-binding")}`});
  persistence = await openStore?.();
  const readOperation = () => persistence
    ? persistence.readOperation(submit)
    : Promise.resolve(composed.fixture.current());
  const closureOwners = persistence ? persistence.closureOwners(submit.scope) : {};
  const events = [];
  const originalOwner = composed.input.selectedProvider.owner;
  const launchRecords = {async resolve(input) {
    const record = await originalOwner.launchRecords.resolve(input);
    nativeHome = record.boundary.codexHome;
    const operation = await readOperation();
    assert.ok(operation, "durable acceptance before trusted launch record");
    try {current = await joinedCurrentOwners({operation, binding: operation.providerAccessSnapshot});}
    catch (error) {events.push(`current:${error.stack}`); throw error;}
    events.push("current-owners");
    return {...record, executablePath: "/usr/local/bin/codex"};
  }};
  const registry = JSON.parse(await readFile(new URL("../../../../../docs/architecture/qualification-registry.json", import.meta.url), "utf8"));
  const target = registry.entries.find(entry => entry.id === "docker-linux-codex-enforced-network-route").targets[0];
  const baseBinding = {tenantId: "tenant:one", projectId: "project:one", scopeDigest: "scope:synthetic",
    operationId: "operation:one", attemptId: "attempt:one", custodyId: "custody:one",
    sourceRevision: "39159514cd7966cdd98292470683afa82e0d1b44", binaryRevision: target.binaryClosure,
    hostBootId: originalOwner.hostBootId, executionGenerationId: "generation:synthetic",
    adapterRevision: target.providerAdapter, capabilityManifestRevision: "manifest:synthetic",
    authorityVectorDigest: "authority:synthetic", providerAccountRef: "account:synthetic", accessRef: "access:synthetic",
    bindingRevision: 1, credentialBindingRef: "credential-binding:synthetic", providerRouteRef: "route:synthetic",
    routeRevision: "route-revision:synthetic", credentialBindingDigest: "binding:synthetic", credentialGeneration: 1};
  const engine = {inspect: (...args) => docker.inspect(...args)};
  const routeEnforcement = createContainedTurnRouteEnforcement({qualificationTarget: target,
    engine, nsenter: network.nsenter, nft: network.nft, binding: baseBinding});
  const resources = {imageInitLock: imageLock(createInput(root).imageDigest), cleanupMilliseconds: 5000,
    select({kernel, record}) {
      assert.equal((persistence ? persistence.current() : composed.fixture.current())?.dispatch.kind, "claimed");
      assert.ok(current); events.push("selected");
      const create = {...createInput(root), privateRootSource: record.privateRootPath,
        workspaceSource: record.boundary.workspaceRef, entrypoint: DOCKER_CUSTODY_NODE_PATH,
        arguments: [...DOCKER_CUSTODY_INIT_ARGUMENTS], environment: {AR_CUSTODY_INIT_CONFIGURATION: "{}"}};
      const seccomp = linuxExclusiveRouteSeccomp();
      const policy = {...basePolicy(root), cgroupParent: "agent-runtime.slice", allowedEnvironmentKeys: ["AR_CUSTODY_INIT_CONFIGURATION"],
        seccompProfileJson: seccomp.json, seccompProfileSha256: seccomp.sha256};
      docker = joinedDocker({policy, create, network, bootId: physicalBoot});
      peer = installJoinedPeer({docker, network, boundary: record.boundary, recipe: () => nativeRecipe, events});
      const egress = createEgressFixture({evidence: evidenceOutcome, route: current.route, deadlineNow: 1000, binding: {
        certificateDigest: `sha256:${hash("joined-synthetic-certificate")}`,
        spkiDigest: `sha256:${hash("joined-synthetic-spki")}`, tlsPolicyDigest: current.input.rule.tlsPolicyDigest}});
      brokerObservations = egress.observations;
      const {providerAccess: _pa, materializer: _materializer, runtimeSecurity: _rs, verifier: _verifier, guard: _guard, ...broker} = egress.ports;
      const credentials = renderingFixture("codex-chatgpt", {head: current.paInput.binding, operationRef: kernel.operationId}).create();
      t.after(() => credentials.dispose());
      const binding = {...baseBinding, operationId: kernel.operationId, attemptId: kernel.attemptId,
        custodyId: kernel.custodyId, authorityVectorDigest: kernel.authorityVectorDigest,
        scopeDigest: current.providerAccessSnapshot.scopeDigest};
      return {
        preparation: {create, enginePolicy: policy, engineClient: docker.client, engineIdentity: docker.engineIdentity,
          openLifecycle: docker.openLifecycle,
          subjectFacts: {scopeSha256: hash(binding.scopeDigest), observerSha256: hash("joined-observer"),
            networkHandle: `network:${hash("joined")}`, listenerHandle: `listener:${hash("joined")}`, routeHandle: `route:${hash("joined")}`},
          async openResourceJournal(input) {
            docker.bindSubject(input.subject);
            const journal = new HostHttpEgressV4Journal(new MemoryV4Storage(), input.subject, input.observer);
            await journal.prepare(`command:${hash("joined-resource-ledger")}`); events.push("journal"); return journal;
          },
          resources: {consumption: {async prepare() {return {kind: "ready", journal: broker.journal,
            quarantine() {}, async retire() {return "retired";}};}},
            localCut: {expectedClock: {authorityId: "clock-authority", epoch: "epoch-1"},
              clock: {read: () => ({authorityId: "clock-authority", epoch: "epoch-1", controlTime: 1000}), within: broker.clock.within}, operationDeadline: 20000}},
          initOptions: {...initOptions(), maximumStdoutBytes: 1_048_576, maximumStderrBytes: 65_536}, hostLifecycleGenerationSha256: hash("joined-generation"), cleanupMilliseconds: 5000,
          deadlines: {engineIdentityMs: 5000, allocationMs: 5000, launchMs: 5000, membershipMs: 5000,
            cleanupMs: 5000, routeMs: 5000, routeLifetimeMs: 20000}},
        route: {binding, engine, nsenter: network.nsenter, nft: network.nft},
        currentAuthority: current.input,
        signer: {scope: current.input.operation.scope, hostReservationId: kernel.custodyId,
          keyRef: "joined-test", keyGeneration: "1", signerRevision: "2",
          clock: {read: () => ({authorityId: "clock-authority", epoch: "epoch-1", controlTime: 1000})}},
        authorities: {providerAccess: credentials, createRequestDigest: createCredentialMaterializationRequestDigest},
        broker: {...broker, evidence: {...broker.evidence, digest: parts => {
          const digest = createHash("sha256"); for (const part of parts) {digest.update(part);}
          return `sha256:${digest.digest("hex")}`;
        }}, identity: {...broker.identity, operationId: kernel.operationId,
          attemptId: kernel.attemptId, custodyId: kernel.custodyId, hostBootId: originalOwner.hostBootId},
          providerAccessSnapshot: current.providerAccessSnapshot},
        nativeFiles: {async install(recipe) {
          nativeRecipe = recipe;
          await writeFile(join(nativeHome, "config.toml"), renderCodexNativeBrokerConfig(recipe), {mode: 0o600});
          const catalog = await readFile(new URL("../../../../contexts/agent-execution/tests/fixtures/codex-native-broker-0.153.4/models.json", import.meta.url));
          await writeFile(join(nativeHome, "models.json"), catalog, {mode: 0o600}); events.push("native-files");
        }},
        connection: {limits: {...egress.operation.limits, deadline: 20000, closureDeadline: 21000}},
      };
    }};
  host = createHostCustodiedAgentRuntimeHost({authorityRevision: "runtime-access-authority:fixture",
    capabilities: setupCapabilities, containedTurn: {...composed.input, ...closureOwners,
      ...storeInput(persistence), routeEnforcement, linuxCodex: resources,
      selectedProvider: {kind: "codex", owner: {...originalOwner, launchRecords}}}});
  const access = host.bindAccess({containedTurn: submit.scope});
  const accepted = await access.containedTurn.submit({commandId: submit.commandId,
    expectedProvider: submit.expectedProvider, intent: submit.intent});
  assert.equal(accepted.status, "accepted");
  operationId = accepted.operationId;
  let observed;
  for (let iteration = 0; iteration < 300; iteration++) {
    observed = await access.containedTurn.observe(accepted.operationId);
    if (observed.status === "observed" && ["succeeded", "failed", "reconcile_required"].includes(observed.turn.status)
      && closureReady(await readOperation(), evidenceOutcome)) {break;}
    await new Promise(resolve => {setTimeout(resolve, 50);});
  }
  console.log(JSON.stringify({events, observed, brokerOrder: brokerObservations?.order, brokerReceipts: brokerObservations?.receipts, messages: docker?.messages.map(message => message.kind)}));
  await peer?.verify();
  assert.equal(observed?.turn?.status, evidenceOutcome === "recorded" ? "succeeded" : "reconcile_required");
  assert.ok(events.includes("broker-response"));
  assert.equal(brokerObservations.receipts.length, 1);
  const receipt = brokerObservations.receipts[0];
  assert.equal(receipt.outcome, "completed");
  assert.equal(receipt.anomalyCode, "none");
  assert.equal(receipt.attemptCount, 1);
  assert.equal(receipt.firstByteState, "sent");
  assert.equal(receipt.inboundClosure, "closed");
  assert.equal(receipt.upstreamClosure, "closed");
  for (const key of ["provisionalAuthorizationReceiptDigest", "finalAuthorizationReceiptDigest", "materializationReceiptDigest"]) {
    assert.match(receipt[key], /^sha256:[a-f0-9]{64}$/u);
  }
  assert.equal((await readOperation())?.physicalContainment.kind, "contained");
  await assert.rejects(lstat(join(root, "private", "operation")), {code: "ENOENT"});
  assert.deepEqual(observed.turn.output, [{cursor: 0, kind: "assistant", text: "bounded synthetic output"}]);
  if (evidenceOutcome === "unknown") {assertUnresolvedReceipt(await readOperation());}
  expectReconciliationDebt = evidenceOutcome === "unknown";
  if (persistence) {
    assert.equal(evidenceOutcome, "unknown");
    await persistence.verifyRecovery({operation: await readOperation(), submit, assertUnresolvedReceipt});
  }
});

}

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {registerLinuxJoinedProduct();}
