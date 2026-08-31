import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  mapClaudeAgentSdkKernelObservation,
} from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-current-kernel-adapter.js";
import {
  claudeAgentSdkArguments,
  createClaudeAgentSdkPrivateProjection,
} from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import {
  createNodeContainedTurnArtifacts,
} from "../dist/features/contained-agent-turn/adapters/outbound/filesystem/node-contained-turn-artifacts.js";
import {
  createNodeContainedTurnWorkspace,
} from "../dist/features/contained-agent-turn/adapters/outbound/filesystem/node-contained-turn-workspace.js";
import {
  delta,
  executablePath,
  inertProcess,
  inertRegistryProcess,
  kernelInput,
  kernelProvider,
  ManualClock,
  privateProjection,
  spawnedQuery,
  success,
  waitFor,
  workspaceRef,
} from "./claude-agent-sdk-contained-turn-provider.support.ts";

test("external credential projection can never enter sealed workspace artifacts", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-exclusion-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const canonicalProjectRoot = join(root, "canonical-project");
  const disposableRoot = join(root, "disposable");
  const workspaceRoot = join(disposableRoot, "workspaces");
  const projectionRoot = join(root, "projection");
  const artifactsRoot = join(disposableRoot, "artifacts");
  const rehydrationRoot = join(disposableRoot, "rehydration");
  await Promise.all([
    mkdir(disposableRoot, { mode: 0o700 }),
    mkdir(projectionRoot, { mode: 0o700 }),
  ]);
  await Promise.all([
    mkdir(canonicalProjectRoot, { mode: 0o700 }),
    mkdir(workspaceRoot, { mode: 0o700 }),
    mkdir(artifactsRoot, { mode: 0o700 }),
    mkdir(rehydrationRoot, { mode: 0o700 }),
    mkdir(join(projectionRoot, "config"), { mode: 0o700 }),
    mkdir(join(projectionRoot, "home"), { mode: 0o700 }),
    mkdir(join(projectionRoot, "tmp"), { mode: 0o700 }),
  ]);
  const scope = Object.freeze({ projectId: "project:artifact-test", tenantId: "tenant:artifact-test" });
  const operationId = "operation:artifact-test";
  const workspaceOwner = await createNodeContainedTurnWorkspace({
    canonicalProjectRoot,
    disposableRoot,
    root: workspaceRoot,
  });
  const created = await workspaceOwner.create({ operationId, scope });
  await writeFile(join(created.workspaceRef, "deliverable.txt"), "DELIVERABLE_ONLY");
  await writeFile(join(projectionRoot, "config", ".credentials.json"), "SYNTHETIC_CREDENTIAL_BYTES");
  const projection = createClaudeAgentSdkPrivateProjection({
    configRoot: join(projectionRoot, "config"),
    homeRoot: join(projectionRoot, "home"),
    projectionRef: "projection:artifact-test",
    tempRoot: join(projectionRoot, "tmp"),
    workspaceRef: created.workspaceRef,
  });
  assert.equal(projection.environment.CLAUDE_CONFIG_DIR, join(projectionRoot, "config"));
  const artifacts = await createNodeContainedTurnArtifacts({
    canonicalProjectRoot,
    disposableRoot,
    rehydrationRoot,
    root: artifactsRoot,
    workspaceRoot,
  });
  await artifacts.seal({ operationId, output: [], scope, workspaceRef: created.workspaceRef });
  const files = await readdir(artifactsRoot, { recursive: true });
  const contents = await Promise.all(files.map(async file => {
    try {
      return await readFile(join(artifactsRoot, file), "utf8");
    } catch {
      return "";
    }
  }));
  const artifactEvidence = [...files, ...contents].join("\n");
  assert.match(artifactEvidence, /DELIVERABLE_ONLY/u);
  assert.doesNotMatch(artifactEvidence, /SYNTHETIC_CREDENTIAL_BYTES|\.credentials\.json/u);
});

test("current-kernel mapper preserves only validated terminal outcomes and discards legacy receipts", () => {
  const currentInput = kernelInput() as never;
  for (const outcome of ["succeeded", "failed", "cancelled"] as const) {
    assert.deepEqual(mapClaudeAgentSdkKernelObservation(currentInput, {
      acceptanceReceiptRef: "legacy-acceptance",
      effectDisposition: "committed",
      effectReceiptRef: "legacy-effect",
      executionReceiptRef: "legacy-execution",
      kind: "completed",
      outcome,
      outputDrainReceiptRef: "legacy-drain",
    }), { kind: "completed", outcome });
  }
  const unknown = mapClaudeAgentSdkKernelObservation(currentInput, {
    evidenceRef: "legacy-raw-evidence",
    kind: "ambiguous",
  });
  assert.equal(unknown.kind, "indeterminate");
  assert.doesNotMatch(
    JSON.stringify(unknown),
    /legacy-raw-evidence|legacy-(?:acceptance|effect|execution|drain)/u,
  );
});

test("current-kernel adapter streams incrementally and returns SDK logical success after exactly one Host-delegated spawn", async () => {
  let sdkSpawnRequests = 0;
  let hostDelegations = 0;
  let guardianSpawns = 0;
  let firstChunkBeforeTerminal = false;
  const adapter = kernelProvider(
    spawnedQuery([delta("O"), delta("K"), success("kernel")], () => { sdkSpawnRequests += 1; }),
    {
      processes: {
        get: () => inertRegistryProcess(),
        start: () => {
          guardianSpawns += 1;
          return inertProcess();
        },
      },
    },
  );
  const outcome = await adapter.execute(kernelInput({
    emit: async () => { firstChunkBeforeTerminal = true; },
  }, {
    createProcess: <Process>(create: () => Process): Process => {
      hostDelegations += 1;
      return create();
    },
  }) as never);
  assert.deepEqual(outcome, { kind: "completed", outcome: "succeeded" });
  assert.equal(firstChunkBeforeTerminal, true);
  assert.deepEqual([sdkSpawnRequests, hostDelegations, guardianSpawns], [1, 1, 1]);
});

test("current-kernel adapter maps a validated SDK error terminal to logical failure, never Exit 0 success", async () => {
  const adapter = kernelProvider(spawnedQuery([{
    errors: ["provider failed"],
    is_error: true,
    session_id: "session:failed",
    subtype: "error_during_execution",
    type: "result",
    uuid: "result:failed",
  }]));
  assert.deepEqual(await adapter.execute(kernelInput() as never), { kind: "completed", outcome: "failed" });
});

test("current-kernel adapter keeps absent or conflicting spawn evidence indeterminate", async () => {
  const absent = kernelProvider(() => ({
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() { yield success("without-spawn"); },
  }));
  assert.equal((await absent.execute(kernelInput() as never)).kind, "indeterminate");

  let guardianSpawns = 0;
  const conflicting = kernelProvider(queryInput => {
    const spawnInput = {
      args: [...claudeAgentSdkArguments("analysis", workspaceRef)],
      command: executablePath,
      cwd: workspaceRef,
      env: { ...privateProjection.environment },
      signal: new AbortController().signal,
    };
    queryInput.options.spawnClaudeCodeProcess(spawnInput);
    queryInput.options.spawnClaudeCodeProcess(spawnInput);
    return {
      close: () => {},
      interrupt: async () => {},
      async *[Symbol.asyncIterator]() { yield success("twice"); },
    };
  }, {
    processes: {
      get: () => inertRegistryProcess(),
      start: () => {
        guardianSpawns += 1;
        return inertProcess();
      },
    },
  });
  assert.equal((await conflicting.execute(kernelInput() as never)).kind, "indeterminate");
  assert.equal(guardianSpawns, 1);
});

test("current-kernel adapter turns rejected output admission into indeterminate", async () => {
  const adapter = kernelProvider(spawnedQuery([delta("unadmitted"), success("admission")]));
  const outcome = await adapter.execute(kernelInput({
    emit: async () => { throw new Error("owner rejected output"); },
  }) as never);
  assert.equal(outcome.kind, "indeterminate");
});

test("current-kernel adapter keeps a late SDK message after terminal indeterminate", async () => {
  const adapter = kernelProvider(spawnedQuery([success("terminal-first"), delta("late")]));
  assert.equal((await adapter.execute(kernelInput() as never)).kind, "indeterminate");

  const clock = new ManualClock();
  let releaseTerminal: (() => void) | undefined;
  const terminalGate = new Promise<void>(resolve => {
    releaseTerminal = resolve;
  });
  let queryStarted = false;
  const lateTerminal = kernelProvider(queryInput => {
    queryStarted = true;
    queryInput.options.spawnClaudeCodeProcess({
      args: [...claudeAgentSdkArguments("analysis", workspaceRef)],
      command: executablePath,
      cwd: workspaceRef,
      env: { ...privateProjection.environment },
      signal: new AbortController().signal,
    });
    return {
      close: () => {},
      interrupt: async () => {},
      async *[Symbol.asyncIterator]() {
        await terminalGate;
        yield success("terminal-after-150ms");
      },
    };
  }, { clock });
  const lateOutcome = lateTerminal.execute(kernelInput() as never);
  await waitFor(() => queryStarted && clock.activeWaiterCount() > 0);
  clock.advanceWithoutDelivery(150);
  releaseTerminal?.();
  assert.equal((await lateOutcome).kind, "indeterminate");
});

test("current-kernel adapter bounds a stuck iterator, cancellation lookup, interrupt and close", async () => {
  let now = 0;
  let interruptCalled = false;
  let closeCalled = false;
  const never = new Promise<void>(() => {});
  const adapter = kernelProvider(queryInput => {
    queryInput.options.spawnClaudeCodeProcess({
      args: [...claudeAgentSdkArguments("analysis", workspaceRef)],
      command: executablePath,
      cwd: workspaceRef,
      env: { ...privateProjection.environment },
      signal: new AbortController().signal,
    });
    return {
      close: () => {
        closeCalled = true;
        return never as never;
      },
      interrupt: async () => {
        interruptCalled = true;
        await never;
      },
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            await never;
            return { done: true as const };
          },
        };
      },
    };
  }, {
    cancellationPollMs: 1,
    clock: {
      now: () => now,
      wait: async milliseconds => { now += milliseconds; },
    },
    interruptGraceMs: 2,
    turnTimeoutMs: 3,
  });
  const outcome = await Promise.race([
    adapter.execute(kernelInput({ isCancellationRequested: async () => await never }) as never),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("adapter deadline was not bounded")), 1_000);
    }),
  ]);
  assert.equal(outcome.kind, "indeterminate");
  assert.equal(interruptCalled, false);
  assert.equal(closeCalled, false);
});
