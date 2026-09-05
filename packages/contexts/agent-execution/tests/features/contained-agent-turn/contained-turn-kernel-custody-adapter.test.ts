import assert from "node:assert/strict";
import test from "node:test";

import {
  ContainedTurnKernelCustodyAdapter,
  type ContainedTurnHostCustodyPort,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-adapter.js";
import {
  DARWIN_COOPERATIVE_CUSTODY_LIMITATIONS,
  type HostCustodyEvidence,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";
import type {
  ContainedTurnKernelCustodyPort,
} from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import {
  createContainedTurnFeature,
} from "../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import {
  containedTurnCleanupPermit,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-preparation.js";
import {
  containedTurnOperationCutoffRevision,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";
import {
  mutateContainedTurnOperation,
  validateContainedTurnOperation,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import {
  adapterSnapshot,
  attemptBinding,
  attemptId,
  authorityDigest,
  createActiveOperation,
  commandId,
  custodyId,
  effectId,
  hostBootId,
  hostInstanceId,
  operationId,
  preparationToken,
  proofId,
  providerAccessSnapshot,
  workspaceId,
} from "../../contained-turn-kernel-fixtures.ts";
import {
  createDependencies,
} from "../../features/contained-agent-turn/support/contained-agent-turn-fixture.ts";
import { committedDispatchProofFixture } from "./support/committed-dispatch-proof-fixture.ts";

const EMPTY_SHA256 = "0".repeat(64);
const drain = Object.freeze({ bytes: 0, sha256: EMPTY_SHA256, status: "complete" as const });
const notStartedDrain = Object.freeze({ bytes: 0, sha256: EMPTY_SHA256, status: "not-started" as const });
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

const runningEvidence = (): HostCustodyEvidence => Object.freeze({
  closure: Object.freeze({
    limitations: Object.freeze([] as const),
    profile: "strict-linux-cgroup-v2",
    status: "unproven",
  }),
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

const pendingNoStartEvidence = (): HostCustodyEvidence => Object.freeze({
  closure: Object.freeze({
    limitations: Object.freeze([] as const),
    profile: "strict-linux-cgroup-v2",
    status: "unproven",
  }),
  fingerprint,
  guardianExit: Object.freeze({ status: "unobserved" }),
  identity: Object.freeze({
    binarySha256: EMPTY_SHA256,
    childProcessInstanceSha256: EMPTY_SHA256,
    hostLifecycleGenerationSha256: "a".repeat(64),
    planSha256: EMPTY_SHA256,
    status: "not-started",
  }),
  privateRoot: Object.freeze({ identitySha256: "b".repeat(64), status: "active" }),
  providerExit: Object.freeze({ status: "not-started" }),
  sealed: false,
  spawn: "never-started",
  stderr: notStartedDrain,
  stdout: notStartedDrain,
});

interface HarnessOptions {
  readonly cooperative?: boolean;
  readonly guardianCode?: number | null;
  readonly missingProviderExit?: boolean;
  readonly noStart?: boolean;
  readonly providerCode?: number | null;
  readonly releaseFailures?: number;
  readonly stderrStatus?: "complete" | "incomplete";
  readonly stdoutStatus?: "complete" | "incomplete";
}

const createHarness = (options: HarnessOptions = {}) => {
  let evidence = options.noStart === true ? pendingNoStartEvidence() : runningEvidence();
  if (options.cooperative === true) {
    evidence = Object.freeze({
      ...evidence,
      closure: Object.freeze({
        limitations: DARWIN_COOPERATIVE_CUSTODY_LIMITATIONS,
        profile: "cooperative-darwin-posix-process-group" as const,
        status: evidence.closure.status,
      }),
      fingerprint: Object.freeze({
        ...evidence.fingerprint,
        containmentProfile: "cooperative-darwin-posix-process-group" as const,
      }),
    });
  }
  let executeCalls = 0;
  let openCalls = 0;
  let processCalls = 0;
  let releaseCalls = 0;
  let containmentCalls = 0;
  const hostCustody: ContainedTurnHostCustodyPort = Object.freeze({
    evidence(custodyRef: string) {
      return custodyRef === "host-custody:synthetic" ? evidence : undefined;
    },
    async reserve(input: Parameters<ContainedTurnHostCustodyPort["reserve"]>[0]) {
      openCalls += 1;
      assert.equal(input.attemptId, attemptId);
      assert.equal(input.intentMode, "analysis");
      assert.equal(input.operationId, operationId);
      assert.equal(input.workspaceRef, "/synthetic/current-kernel-workspace");
      return Object.freeze({ custodyRef: "host-custody:synthetic" });
    },
    open: async () => {throw new Error("generic Host open must not serve kernel reservation");},
    async release() {
      releaseCalls += 1;
      return releaseCalls <= (options.releaseFailures ?? 0)
        ? Object.freeze({ evidenceRef: "host-release:retry", kind: "unproven" as const })
        : Object.freeze({ kind: "released" as const });
    },
    async requestContainment() {
      containmentCalls += 1;
      evidence = options.noStart === true
        ? Object.freeze({
          ...evidence,
          closure: Object.freeze({
            limitations: options.cooperative === true
              ? DARWIN_COOPERATIVE_CUSTODY_LIMITATIONS
              : Object.freeze([] as const),
            profile: options.cooperative === true
              ? "cooperative-darwin-posix-process-group" as const
              : "strict-linux-cgroup-v2" as const,
            status: "not-started" as const,
          }),
          identity: Object.freeze({ ...evidence.identity, status: "not-started" as const }),
          providerExit: Object.freeze({ status: "not-started" as const }),
          sealed: true,
          spawn: "never-started" as const,
          stderr: notStartedDrain,
          stdout: notStartedDrain,
        })
        : Object.freeze({
          ...evidence,
          closure: Object.freeze({
            limitations: options.cooperative === true
              ? DARWIN_COOPERATIVE_CUSTODY_LIMITATIONS
              : Object.freeze([] as const),
            profile: options.cooperative === true
              ? "cooperative-darwin-posix-process-group" as const
              : "strict-linux-cgroup-v2" as const,
            status: "closed" as const,
          }),
          guardianExit: Object.freeze({
            code: options.guardianCode ?? 0,
            signal: null,
            status: "observed" as const,
          }),
          providerExit: options.missingProviderExit === true
            ? Object.freeze({ status: "unobserved" as const })
            : Object.freeze({
              code: options.providerCode ?? 0,
              signal: null,
              status: "observed" as const,
            }),
          sealed: true,
          stderr: Object.freeze({ ...drain, status: options.stderrStatus ?? "complete" }),
          stdout: Object.freeze({ ...drain, status: options.stdoutStatus ?? "complete" }),
        });
      return Object.freeze({ kind: "contained" as const, receiptRef: "host-containment:synthetic" });
    },
  });
  const custody = new ContainedTurnKernelCustodyAdapter(hostCustody, {
    attemptOwner: syntheticAttemptOwner,
    completionAfterMs: 15,
    hostBootId,
    hostInstanceId,
    startObservationAfterMs: 100,
    workspaceOwner: syntheticWorkspaceOwner("/synthetic/current-kernel-workspace"),
  });
  return {
    custody,
    hostCustody,
    counts: {
      get containments() {return containmentCalls;},
      get executions() {return executeCalls;},
      get opens() {return openCalls;},
      get processes() {return processCalls;},
      get releases() {return releaseCalls;},
    },
    incrementExecution: () => {executeCalls += 1;},
    incrementProcess: () => {processCalls += 1;},
  };
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

const openedOutcomes = new WeakMap<ContainedTurnKernelCustodyAdapter, Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>>();
const openHarness = async (harness: ReturnType<typeof createHarness>) => {
  const outcome = await harness.custody.open(openInput);
  openedOutcomes.set(harness.custody, outcome);
  return outcome;
};

const openAndStart = async (
  harness: ReturnType<typeof createHarness>,
  outcome: "cancelled" | "failed" | "succeeded",
) => {
  await openHarness(harness);
  const startBoundary = harness.custody.completionBoundary({
    attemptId, custodyId, operationId, phase: "start",
  });
  try {
    return await harness.custody.start(startInput(harness, outcome));
  } finally {
    startBoundary.release();
  }
};

const attest = (
  custody: ContainedTurnKernelCustodyAdapter,
  finalCursor = 0,
) => custody.attestExecutionClosure({ attemptId, custodyId, finalCursor, operationId });

const applyCurrentKernelClosure = (
  attestation: Extract<Awaited<ReturnType<typeof attest>>, { readonly kind: "proved" }>,
) => {
  let operation = createActiveOperation();
  operation = mutateContainedTurnOperation(operation, {
    kind: "record_provider_acceptance",
    proof: Object.freeze({
      binding: Object.freeze({ ...attemptBinding, disposition: "accepted" as const }),
      kind: "provider_acceptance",
      proofId: proofId("proof:provider-acceptance:host-adapter"),
    }),
  });
  operation = mutateContainedTurnOperation(operation, {
    executionProof: attestation.executionClosureProof,
    kind: "close_provider_execution",
    terminalObservationProof: attestation.terminalObservationProof,
  });
  operation = mutateContainedTurnOperation(operation, {
    kind: "drain_output",
    proof: attestation.outputDrainProof,
  });
  operation = mutateContainedTurnOperation(operation, {
    kind: "resolve_effect",
    proof: Object.freeze({
      binding: Object.freeze({ ...attemptBinding, disposition: "committed" as const }),
      kind: "effect_resolution",
      proofId: proofId("proof:effect:host-adapter"),
    }),
  });
  validateContainedTurnOperation(operation);
  return operation;
};

test("exact seven-port composition dispatches once through the dedicated Host mapper", async () => {
  let evidence = runningEvidence();
  let hostOpenCalls = 0;
  let hostContainmentCalls = 0;
  const hostCustody: ContainedTurnHostCustodyPort = Object.freeze({
    evidence: (custodyRef: string) => custodyRef === "host-custody:composition" ? evidence : undefined,
    reserve: async () => {
      hostOpenCalls += 1;
      return Object.freeze({ custodyRef: "host-custody:composition" });
    },
    open: async () => {throw new Error("generic Host open must not serve kernel reservation");},
    release: async () => Object.freeze({ kind: "released" as const }),
    requestContainment: async () => {
      hostContainmentCalls += 1;
      evidence = Object.freeze({
        ...evidence,
        closure: Object.freeze({
          limitations: Object.freeze([] as const),
          profile: "strict-linux-cgroup-v2",
          status: "closed",
        }),
        guardianExit: Object.freeze({ code: 12, signal: null, status: "observed" }),
        providerExit: Object.freeze({ code: 27, signal: null, status: "observed" }),
        sealed: true,
        stderr: drain,
        stdout: drain,
      });
      return Object.freeze({ kind: "contained" as const, receiptRef: "host-containment:composition" });
    },
  });
  const fixture = createDependencies();
  const { custody: _fixtureCustody, ...otherOwners } = fixture.dependencies;
  const mappedCustody = new ContainedTurnKernelCustodyAdapter(hostCustody, {
    attemptOwner: syntheticAttemptOwner,
    completionAfterMs: 100,
    hostBootId: "host-boot:one",
    hostInstanceId: "host-instance:one",
    startObservationAfterMs: 100,
    workspaceOwner: syntheticWorkspaceOwner("/synthetic/composed-workspace"),
  });
  const feature = createContainedTurnFeature(Object.freeze({
    ...otherOwners,
    custody: mappedCustody,
  }));
  const result = await feature.submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(result.status, "observed");
  assert.equal(result.status === "observed" && result.turn.status, "succeeded");
  assert.equal(fixture.providerCalls.value, 1);
  assert.equal(hostOpenCalls, 1);
  assert.equal(hostContainmentCalls, 1);
});

test("current seven-port composition closes true failed and cancelled observations", async t => {
  for (const row of [
    { outcome: "failed" as const, providerCode: 0 }, { outcome: "cancelled" as const, providerCode: 23 },
  ]) {
    await t.test(row.outcome, async () => {
      let evidence = runningEvidence();
      const hostCustody: ContainedTurnHostCustodyPort = Object.freeze({
        evidence: () => evidence,
        reserve: async () => Object.freeze({ custodyRef: `host-custody:composition:${row.outcome}` }),
        open: async () => {throw new Error("generic Host open must not serve kernel reservation");},
        release: async () => Object.freeze({ kind: "released" as const }),
        requestContainment: async () => {
          evidence = Object.freeze({
            ...evidence,
            closure: Object.freeze({ ...evidence.closure, status: "closed" as const }),
            guardianExit: Object.freeze({ code: 7, signal: null, status: "observed" as const }),
            providerExit: Object.freeze({ code: row.providerCode, signal: null, status: "observed" as const }),
            sealed: true,
            stderr: drain,
            stdout: drain,
          });
          return Object.freeze({ kind: "contained" as const, receiptRef: `host-containment:${row.outcome}` });
        },
      });
      const fixture = createDependencies();
      const { custody: _fixtureCustody, provider: fixtureProvider, ...otherOwners } = fixture.dependencies;
      const feature = createContainedTurnFeature(Object.freeze({
        ...otherOwners,
        custody: new ContainedTurnKernelCustodyAdapter(hostCustody, {
          attemptOwner: syntheticAttemptOwner,
          completionAfterMs: 100,
          hostBootId: "host-boot:matrix",
          hostInstanceId: "host-instance:matrix",
          startObservationAfterMs: 100,
          workspaceOwner: syntheticWorkspaceOwner("/synthetic/composed-workspace"),
        }),
        provider: Object.freeze({
          ...fixtureProvider,
          execute: async (input: Parameters<typeof fixtureProvider.execute>[0]) => {
            const observation = await fixtureProvider.execute(input);
            assert.equal(observation.kind, "completed");
            return Object.freeze({ kind: "completed" as const, outcome: row.outcome });
          },
        }),
      }));
      const result = await feature.submit.execute({
        commandId: `command:${row.outcome}`,
        expectedProvider: "codex",
        intent: { mode: "analysis", prompt: "inspect disposable state" },
        scope: { projectId: "project:one", tenantId: "tenant:one" },
      });
      assert.equal(result.status, "observed");
      assert.equal(result.status === "observed" && result.turn.status, row.outcome);
      assert.equal(fixture.providerCalls.value, 1);
    });
  }
});

test("protocol outcome, not independently varied OS exit, closes the current kernel", async t => {
  const matrix = [
    { guardianCode: 0, outcome: "succeeded" as const, providerCode: 17 },
    { guardianCode: 9, outcome: "failed" as const, providerCode: 0 },
    { guardianCode: 0, outcome: "cancelled" as const, providerCode: 2 },
  ];
  for (const row of matrix) {
    await t.test(row.outcome, async () => {
      const harness = createHarness(row);
      const started = await openAndStart(harness, row.outcome);
      assert.equal(started.kind, "execution_started");
      if (started.kind !== "execution_started") {return;}
      const executionBoundary = harness.custody.completionBoundary({
        attemptId, custodyId, operationId, phase: "execution",
      });
      assert.deepEqual(await started.execution, { kind: "completed", outcome: row.outcome });
      executionBoundary.release();
      const attestation = await attest(harness.custody);
      assert.equal(attestation.kind, "proved");
      if (attestation.kind !== "proved") {return;}
      assert.equal(attestation.executionClosureProof.binding.outcome, row.outcome);
      assert.equal(attestation.terminalObservationProof.binding.outcome, row.outcome);
      const closed = applyCurrentKernelClosure(attestation);
      assert.deepEqual(closed.providerExecution, {
        kind: "closed",
        outcome: row.outcome,
        proofId: attestation.executionClosureProof.proofId,
      });
      assert.equal(closed.output.fence.kind, "fenced");
      assert.deepEqual(closed.effect.kind, "resolved");
      assert.deepEqual(harness.counts, {
        containments: 1, executions: 1, opens: 1, processes: 1, releases: 0,
      });
    });
  }
});

test("missing raw provider exit or incomplete ingress remains ambiguous", async t => {
  for (const options of [
    { missingProviderExit: true },
    { stdoutStatus: "incomplete" as const },
    { stderrStatus: "incomplete" as const },
  ]) {
    await t.test(JSON.stringify(options), async () => {
      const harness = createHarness(options);
      const started = await openAndStart(harness, "failed");
      assert.equal(started.kind, "execution_started");
      if (started.kind !== "execution_started") {return;}
      assert.deepEqual(await started.execution, { kind: "completed", outcome: "failed" });
      const result = await attest(harness.custody);
      assert.equal(result.kind, "indeterminate");
    });
  }
});

test("cancellation before delegated spawn proves no start without another attempt", async () => {
  const harness = createHarness({ noStart: true });
  await openHarness(harness);
  const result = await harness.custody.start(startInput(harness, "cancelled", false));
  assert.equal(result.kind, "proved_no_start");
  assert.deepEqual(harness.counts, {
    containments: 1, executions: 1, opens: 1, processes: 0, releases: 0,
  });
  await assert.rejects(
    harness.custody.start(startInput(harness, "cancelled")),
    /already consumed/u,
  );
});

test("kernel reservation defers process creation to its one-use start callback", async () => {
  const harness = createHarness();
  await openHarness(harness);
  assert.deepEqual(harness.counts, {
    containments: 0, executions: 0, opens: 1, processes: 0, releases: 0,
  });
  const started = await harness.custody.start(Object.freeze({
    ...startInput(harness, "succeeded"),
    execute: async delegated => {
      harness.incrementExecution();
      delegated.createProcess(() => {
        harness.incrementProcess();
        return Object.freeze({ syntheticProcess: true });
      });
      assert.throws(
        () => delegated.createProcess(() => Object.freeze({ impossibleSecondProcess: true })),
        /one-use/u,
      );
      return Object.freeze({ kind: "completed" as const, outcome: "succeeded" as const });
    },
  }));
  assert.equal(started.kind, "execution_started");
  assert.deepEqual(harness.counts, {
    containments: 0, executions: 1, opens: 1, processes: 1, releases: 0,
  });
});

test("provider completion arriving after execution cutoff cannot be sealed", async () => {
  const harness = createHarness();
  await openHarness(harness);
  let resolveCompletion!: (value: { readonly kind: "completed"; readonly outcome: "succeeded" }) => void;
  const providerCompletion = new Promise<{ readonly kind: "completed"; readonly outcome: "succeeded" }>(
    resolve => {resolveCompletion = resolve;},
  );
  const started = await harness.custody.start(Object.freeze({
    ...startInput(harness, "succeeded"),
    execute: async delegated => {
      harness.incrementExecution();
      delegated.createProcess(() => {
        harness.incrementProcess();
        return Object.freeze({ syntheticProcess: true });
      });
      return providerCompletion;
    },
  }));
  assert.equal(started.kind, "execution_started");
  if (started.kind !== "execution_started") {return;}
  const boundary = harness.custody.completionBoundary({
    attemptId, custodyId, operationId, phase: "execution",
  });
  assert.equal((await boundary.expiration).kind, "expired");
  resolveCompletion(Object.freeze({ kind: "completed", outcome: "succeeded" }));
  assert.deepEqual(await started.execution, { kind: "completed", outcome: "succeeded" });
  boundary.release();
  assert.equal((await attest(harness.custody)).kind, "indeterminate");
});

test("invalid protocol completion cannot be converted into terminal truth", async () => {
  const harness = createHarness();
  await openHarness(harness);
  const conflictingObservation = Object.freeze({
    kind: "completed" as const,
    outcome: "succeeded" as const,
    reportedOutcome: "failed" as const,
  });
  const started = await harness.custody.start(Object.freeze({
    ...startInput(harness, "succeeded"),
    execute: async delegated => {
      harness.incrementExecution();
      delegated.createProcess(() => {
        harness.incrementProcess();
        return Object.freeze({ syntheticProcess: true });
      });
      return conflictingObservation;
    },
  }));
  assert.equal(started.kind, "execution_started");
  if (started.kind !== "execution_started") {return;}
  assert.deepEqual(await started.execution, conflictingObservation);
  assert.equal((await attest(harness.custody)).kind, "indeterminate");
});

test("cooperative closure proves execution and drain but cannot become physical containment", async () => {
  const harness = createHarness({ cooperative: true });
  const started = await openAndStart(harness, "succeeded");
  assert.equal(started.kind, "execution_started");
  if (started.kind !== "execution_started") {return;}
  assert.deepEqual(await started.execution, { kind: "completed", outcome: "succeeded" });
  const execution = await attest(harness.custody);
  assert.equal(execution.kind, "proved");
  const physicalInput = Object.freeze({
    attemptId,
    authorityVectorDigest: authorityDigest,
    custodyId,
    operationId,
    requestDigest: authorityDigest,
    requestId: "closure-request:cooperative-physical" as never,
  });
  assert.equal((await harness.custody.ensurePhysicalContainment(physicalInput)).kind, "indeterminate");
  assert.equal((await harness.custody.requestPhysicalContainment(physicalInput)).kind, "indeterminate");
});

test("start identity conflict is rejected before the provider callback", async () => {
  const harness = createHarness();
  await openHarness(harness);
  await assert.rejects(
    harness.custody.start(Object.freeze({
      ...startInput(harness, "succeeded"),
      intentMode: "workspace-write",
    })),
    /start identity conflict/u,
  );
  assert.deepEqual(harness.counts, { containments: 0, executions: 0, opens: 1, processes: 0, releases: 0 });
});

test("attestation is stable and containment cleanup remains retryable", async () => {
  const harness = createHarness({ releaseFailures: 1 });
  const started = await openAndStart(harness, "cancelled");
  assert.equal(started.kind, "execution_started");
  if (started.kind !== "execution_started") {return;}
  await started.execution;
  const first = await attest(harness.custody, 0);
  const repeated = await attest(harness.custody, 0);
  assert.equal(first.kind, "proved");
  assert.equal(repeated, first);
  // Pin deterministic redacted proof bytes for the synthetic Host observation.
  const binding = { attemptId, authorityVectorDigest: authorityDigest, effectId, operationId };
  assert.deepEqual(first, {
    executionClosureProof: {
      binding: { ...binding, outcome: "cancelled" },
      kind: "execution_closure",
      proofId: "proof:host-custody-adapter:execution-closure:sha256:873cd5d90b069fa922f31d75c839bd3b5ec49d7f8b2eed272d9f2a80a5b2fdf6",
    },
    kind: "proved",
    outputDrainProof: {
      binding: { ...binding, finalCursor: 0 },
      kind: "output_drain",
      proofId: "proof:host-custody-adapter:output-drain:sha256:e35ea1572468d983ed7379ccff6d48de087ef1ada7f485136e4c46960d29f337",
    },
    terminalObservationProof: {
      binding: { ...binding, outcome: "cancelled" },
      kind: "provider_terminal_observation",
      proofId: "proof:host-custody-adapter:terminal-observation:sha256:873cd5d90b069fa922f31d75c839bd3b5ec49d7f8b2eed272d9f2a80a5b2fdf6",
    },
  });
  assert.ok(Object.isFrozen(first));
  if (first.kind !== "proved") {return;}
  for (const proof of [first.executionClosureProof, first.outputDrainProof, first.terminalObservationProof]) {
    assert.ok(Object.isFrozen(proof));
    assert.ok(Object.isFrozen(proof.binding));
  }
  assert.equal((await attest(harness.custody, 1)).kind, "indeterminate");

  const cleanupPermit = containedTurnCleanupPermit({
    attemptId,
    custodyId,
    kind: "active",
    operationCutoffRevision: containedTurnOperationCutoffRevision(0),
    operationId,
    preparationToken,
    preparedOperationRevision: 1,
    providerAccessGrantRequestId: "provider-access-grant:synthetic",
    runtimeSecurityGrantRequestId: "runtime-security-grant:synthetic",
    workspaceId,
  }, "cleanup-nonce:synthetic");
  assert.equal(
    (await harness.custody.releaseRetiredReservation({ cleanupPermit })).kind,
    "indeterminate",
  );
  assert.equal(
    (await harness.custody.releaseRetiredReservation({ cleanupPermit })).kind,
    "released",
  );
  assert.equal(
    (await harness.custody.releaseRetiredReservation({ cleanupPermit })).kind,
    "already_released",
  );
  assert.equal(harness.counts.containments, 1);
  assert.equal(harness.counts.releases, 2);
});
