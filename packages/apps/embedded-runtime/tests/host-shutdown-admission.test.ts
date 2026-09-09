import assert from "node:assert/strict";
import test from "node:test";

import {
  ContainedTurnKernelCustodyAdapter,
  type ContainedTurnHostCustodyPort,
} from "../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-adapter.js";
import type {
  ContainedTurnKernelCustodyPort,
} from "../../../contexts/agent-execution/dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import {
  containedTurnOperationCutoffRevision,
} from "../../../contexts/agent-execution/dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";
import {
  adapterSnapshot,
  attemptId,
  authorityDigest,
  commandId,
  custodyId,
  effectId,
  hostBootId,
  hostInstanceId,
  operationId,
  preparationToken,
  providerAccessSnapshot,
  workspaceId,
} from "../../../contexts/agent-execution/tests/contained-turn-kernel-fixtures.ts";
import {containedTurnIdentity} from "../../../contexts/agent-execution/dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { committedDispatchProofFixture } from "../../../contexts/agent-execution/tests/features/contained-agent-turn/support/committed-dispatch-proof-fixture.ts";

const EMPTY_SHA256 = "0".repeat(64);
const drain = Object.freeze({ bytes: 0, sha256: EMPTY_SHA256, status: "complete" as const });
const fingerprint = Object.freeze({
  argumentsSha256: "1".repeat(64),
  binaryRevision: adapterSnapshot.binaryRevision,
  containmentProfile: "strict-linux-cgroup-v2" as const,
  environmentKeys: Object.freeze([]),
  executablePathSha256: "2".repeat(64),
  executableSha256: "3".repeat(64),
  fingerprintSha256: "4".repeat(64),
  intentMode: "analysis" as const,
  planSha256: "5".repeat(64),
  privatePathEnvironmentKeys: Object.freeze([]),
  privateRootPathSha256: "6".repeat(64),
  providerBindingSha256: "7".repeat(64),
  spawnMode: "sdk-delegated" as const,
  workspaceSha256: "8".repeat(64),
});

const syntheticAttemptOwner = Object.freeze({
  prepare: async () => Object.freeze({
    arguments: Object.freeze([]),
    binaryRevision: adapterSnapshot.binaryRevision,
    containmentProfile: "strict-linux-cgroup-v2" as const,
    environment: Object.freeze({}),
    executablePath: "/synthetic/provider",
    executableSha256: "3".repeat(64),
    intentMode: "analysis" as const,
    privateRootPath: "/synthetic/private",
    provider: "codex" as const,
    spawnMode: "sdk-delegated" as const,
  }),
  retain: () => {},
  retire: () => {},
});

const syntheticWorkspaceOwner = (workspaceRef: string) => Object.freeze({
  withLaunchAuthority: async <Result>(input: Readonly<{workspaceId: string}>, consume: (target: Readonly<{
    canonicalPath: string;
    descriptorPath: string;
    identity: Readonly<{dev: bigint; ino: bigint; mountId: string}>;
  }>) => Promise<Result>): Promise<Result> => {
    assert.ok(input.workspaceId.length > 0);
    return consume(Object.freeze({
      canonicalPath: workspaceRef,
      descriptorPath: "/proc/self/fd/99",
      identity: Object.freeze({dev: 1n, ino: 2n, mountId: "mount:synthetic"}),
    }));
  },
});

const runningEvidence = () => Object.freeze({
  closure: Object.freeze({limitations: Object.freeze([] as const), profile: "strict-linux-cgroup-v2" as const, status: "unproven" as const}),
  fingerprint,
  guardianExit: Object.freeze({ status: "unobserved" }),
  identity: Object.freeze({
    binarySha256: fingerprint.executableSha256,
    childProcessInstanceSha256: "9".repeat(64),
    hostLifecycleGenerationSha256: "a".repeat(64),
    pgid: 101,
    pid: 102,
    planSha256: fingerprint.planSha256,
    proofRef: "host-process-proof:synthetic",
    status: "proved",
  }),
  privateRoot: Object.freeze({ identitySha256: "b".repeat(64), status: "active" }),
  providerExit: Object.freeze({ status: "unobserved" }),
  sealed: false,
  spawn: "acknowledged",
  stderr: Object.freeze({ ...drain, status: "incomplete" }),
  stdout: Object.freeze({ ...drain, status: "incomplete" }),
});

type Preparation = ConstructorParameters<typeof ContainedTurnKernelCustodyAdapter>[1]["postClaimPreparation"];
const createHarness = (options: {
  preparation?: Preparation;
  prepare?: typeof syntheticAttemptOwner.prepare;
  reserve?: () => Promise<void>;
} = {}) => {
  let executeCalls = 0;
  let openCalls = 0;
  let processCalls = 0;
  let releaseCalls = 0;
  let containmentCalls = 0;
  let retireCalls = 0;
  const hostCustody: ContainedTurnHostCustodyPort = Object.freeze({
    evidence: () => runningEvidence(),
    async reserve() {openCalls++; await options.reserve?.(); return {custodyRef: "host-custody:synthetic"};},
    open: async () => {throw new Error("generic open is unused");},
    async release() {releaseCalls++; return {kind: "unproven" as const, evidenceRef: "release:unproven"};},
    async requestContainment() {containmentCalls++; return {kind: "unproven" as const, evidenceRef: "containment:unproven"};},
  });
  const custody = new ContainedTurnKernelCustodyAdapter(hostCustody, {
    postClaimPreparation: options.preparation ?? "current-owner",
    attemptOwner: {...syntheticAttemptOwner, prepare: options.prepare ?? syntheticAttemptOwner.prepare,
      retire() {retireCalls++;}},
    hostBootId, hostInstanceId, startObservationAfterMs: 100,
    workspaceOwner: syntheticWorkspaceOwner("/synthetic/current-kernel-workspace"),
  });
  return {custody, counts: {
    get retired() {return retireCalls;}, get containments() {return containmentCalls;}, get executions() {return executeCalls;},
    get opens() {return openCalls;}, get processes() {return processCalls;}, get releases() {return releaseCalls;},
  }, incrementExecution: () => {executeCalls++;}, incrementProcess: () => {processCalls++;}};
};

const openInput: Parameters<ContainedTurnKernelCustodyPort["open"]>[0] = Object.freeze({
  adapterSnapshot,
  attemptId,
  authorityVectorDigest: authorityDigest,
  commandId,
  custodyId,
  effectId,
  intentMode: "analysis",
  operationId,
  operationCutoffRevision: containedTurnOperationCutoffRevision(0),
  operationRevision: 1,
  preparationToken,
  providerAccessSnapshot,
  workspaceId,
});

const startInput = (
  harness: ReturnType<typeof createHarness>,
  outcome: "cancelled" | "failed" | "succeeded",
  spawn = true,
): Parameters<ContainedTurnKernelCustodyPort["start"]>[0] => Object.freeze({
  attemptId,
  custodyId,
  execute: async delegated => {
    harness.incrementExecution();
    if (spawn) {
      delegated.createProcess(() => {
        harness.incrementProcess();
        return Object.freeze({ syntheticProcess: true });
      });
    }
    return Object.freeze({ kind: "completed" as const, outcome });
  },
  intentMode: "analysis",
  operationId,
  committedDispatchProof: committedDispatchProofFixture(openInput, openedOutcomes.get(harness.custody)!),
  workspaceId,
});


import { composeHostCustodiedAgentRuntimeHost } from "../dist/composition/host-custodied-agent-runtime-host.js";
import {createAgentRuntimeHostDisposalLifecycle, AgentRuntimeHostDisposalIncompleteError} from "../dist/composition/agent-runtime-host-disposal.js";
import {composeHostCustodiedContainedTurn} from "../dist/composition/contained-turn-feature-composition.js";
const openedOutcomes = new WeakMap<ContainedTurnKernelCustodyAdapter, Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>>();
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => {resolve = r;}); return {promise, resolve}; };
const shutdown = (harness: ReturnType<typeof createHarness>) => {
  const cancellation = deferred();
  let releases = 0;
  let durablePending = true;
  const cancellationEntered = deferred();
  const host = composeHostCustodiedAgentRuntimeHost({authorityRevision: "runtime-access-authority:fixture", capabilities: {}, containedTurn: {}} as never,
    () => composeHostCustodiedContainedTurn({
      selectedProvider: {kind: "codex", owner: {}}, hostCustody: {},
      artifacts: {}, workspace: {}, operationStore: {}, security: {},
      providerAccess: Object.freeze({
        dispatchConsumptionV1: Object.freeze({consumeForDispatch() {}, observeDispatchConsumption() {}, settleDispatchConsumption() {}}),
        resolve: Object.freeze({execute() {}}), revalidate: Object.freeze({execute() {}}),
      }),
    } as never, {claude: (() => {throw new Error("unselected owner");}) as never,
      codex: (() => Object.freeze({custody: harness.custody, provider: Object.freeze({}),
        sealAdmission() {harness.custody.sealAdmission();}, dispose() {releases++;}})) as never,
    }, (() => ({submit: {execute() {}}, observe: {execute() {}},
      cancel: {async execute() {cancellationEntered.resolve(); await cancellation.promise; return {status: "not_found"};}},
    })) as never),
    input => {
      const lifecycle = createAgentRuntimeHostDisposalLifecycle(input.containedTurn);
      lifecycle.registerContainedTurn({operationId, scope: {authorityRevision: "runtime-access-authority:fixture", projectId: "project", tenantId: "tenant"}}, {});
      return {bindAccess() {throw new Error("unused bindAccess");}, dispose: lifecycle.dispose, [Symbol.asyncDispose]: lifecycle.dispose};
    });
  const disposal = host.dispose();
  void disposal.then(() => {durablePending = false;}, () => {durablePending = false;});
  return {entered: cancellationEntered.promise, host,
    finish: async () => {
      cancellation.resolve();
      await assert.rejects(disposal, error => error instanceof AgentRuntimeHostDisposalIncompleteError && error.status === "termination_unproven");
      await assert.rejects(host.dispose(), AgentRuntimeHostDisposalIncompleteError);
      assert.equal(releases, 0, "failed shutdown retains custody on retry");
    }, pending: () => durablePending, releases: () => releases};
};
test("late preparation cannot dispatch during unresolved durable shutdown", async () => {
  const prepared = deferred(); const entered = deferred(); let signal!: AbortSignal;
  const harness = createHarness({preparation: {async prepareClaimed(input) {signal = input.signal; entered.resolve(); await prepared.promise; return {kind: "prepared"};}}});
  openedOutcomes.set(harness.custody, await harness.custody.open(openInput));
  const starting = harness.custody.start(startInput(harness, "succeeded"));
  await entered.promise;
  const stopping = shutdown(harness);
  await stopping.entered;
  assert.equal(stopping.pending(), true);
  assert.equal(signal.aborted, true);
  prepared.resolve();
  await starting;
  assert.equal(harness.counts.processes, 0);
  assert.equal(harness.counts.executions, 0);
  assert.equal(stopping.releases(), 0);
  await stopping.finish();
});
test("retained delegated creator is fenced during unresolved shutdown", async () => {
  const entered = deferred(); const finish = deferred(); let delegated!: Parameters<Parameters<ContainedTurnKernelCustodyPort["start"]>[0]["execute"]>[0];
  const harness = createHarness();
  openedOutcomes.set(harness.custody, await harness.custody.open(openInput));
  const starting = harness.custody.start({...startInput(harness, "succeeded"), execute: async input => {delegated = input; entered.resolve(); await finish.promise; return {kind: "completed", outcome: "succeeded"};}});
  await entered.promise;
  const stopping = shutdown(harness);
  await stopping.entered;
  assert.throws(() => delegated.createProcess(() => {harness.incrementProcess(); return {};}), /cutoff/u);
  assert.equal(harness.counts.processes, 0);
  assert.equal(stopping.pending(), true);
  finish.resolve(); await starting; await stopping.finish();
});

test("shutdown fences new opens and starts but preserves custody evidence for reconciliation", async () => {
  const harness = createHarness();
  openedOutcomes.set(harness.custody, await harness.custody.open(openInput));
  const stopping = shutdown(harness);
  await stopping.entered;
  await assert.rejects(harness.custody.open(openInput), /admission is unavailable/u);
  await assert.rejects(harness.custody.start(startInput(harness, "succeeded")), /admission is unavailable/u);
  assert.equal(harness.counts.opens, 1);
  assert.equal(harness.counts.processes, 0);
  const observation = await harness.custody.ensurePhysicalContainment({attemptId, custodyId, operationId, authorityVectorDigest: authorityDigest, requestDigest: authorityDigest, requestId: containedTurnIdentity("closure_request", "closure-request:shutdown")});
  assert.equal(observation.kind, "indeterminate", "shutdown cannot turn unproven containment into closure");
  assert.equal(harness.counts.releases, 0);
  await stopping.finish();
});

test("owner cleanup failure remains retryable after admission is permanently fenced", async () => {
  const harness = createHarness();
  let disposals = 0;
  let durableCalls = 0;
  const failure = new Error("synthetic cleanup failure");
  const host = composeHostCustodiedAgentRuntimeHost({authorityRevision: "runtime-access-authority:fixture", capabilities: {}, containedTurn: {}} as never,
    (() => ({feature: {submit: {execute() {}}, observe: {execute() {}}, cancel: {execute() {}}},
      sealAdmission() {harness.custody.sealAdmission();},
      dispose() {disposals++; if (disposals === 1) {throw failure;}}})) as never,
    (() => ({bindAccess() {}, async dispose() {durableCalls++; await assert.rejects(harness.custody.open(openInput), /admission is unavailable/u);}})) as never);
  await assert.rejects(host.dispose(), error => error === failure);
  await Promise.all([host.dispose(), host[Symbol.asyncDispose]()]);
  await host.dispose();
  assert.equal(disposals, 2);
  assert.equal(durableCalls, 4);
  assert.equal(harness.counts.opens, 0);
});

test("shutdown fences an outstanding open before raw acquisition", async () => {
  const entered = deferred(); const finish = deferred();
  const harness = createHarness({prepare: async () => {
    entered.resolve(); await finish.promise; return syntheticAttemptOwner.prepare();
  }});
  const opening = harness.custody.open(openInput);
  await entered.promise;
  const stopping = shutdown(harness);
  await stopping.entered;
  const rejected = assert.rejects(opening, /cut off before acquisition/u);
  finish.resolve(); await rejected;
  assert.equal(harness.counts.opens, 0);
  assert.equal(harness.counts.retired, 1);
  assert.equal(harness.counts.releases, 0);
  await stopping.finish();
});

test("a reservation acquired across shutdown is retained and cannot start", async () => {
  const entered = deferred(); const finish = deferred();
  const harness = createHarness({reserve: async () => {entered.resolve(); await finish.promise;}});
  const opening = harness.custody.open(openInput);
  await entered.promise;
  const stopping = shutdown(harness);
  await stopping.entered;
  finish.resolve();
  openedOutcomes.set(harness.custody, await opening);
  assert.equal(harness.counts.retired, 0, "late acquisition must retain custody");
  await assert.rejects(harness.custody.start(startInput(harness, "succeeded")), /admission is unavailable/u);
  assert.equal((await harness.custody.ensurePhysicalContainment({attemptId, custodyId, operationId, authorityVectorDigest: authorityDigest, requestDigest: authorityDigest, requestId: containedTurnIdentity("closure_request", "closure-request:shutdown")})).kind, "indeterminate");
  assert.equal(harness.counts.releases, 0);
  await stopping.finish();
});
