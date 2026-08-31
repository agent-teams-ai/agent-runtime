import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaudeAgentSdkCurrentKernelAdapter,
} from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-current-kernel-adapter.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { claudeAgentSdkArguments } from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import {
  ManualClock,
  executablePath,
  inertProcess,
  inertRegistryProcess,
  kernelAdapterSnapshot,
  kernelCustodyId,
  kernelEffectId,
  kernelInput,
  kernelManifest,
  kernelOperationId,
  kernelProvider,
  kernelStartProof,
  kernelWorkspaceId,
  nextTurn,
  privateProjection,
  privateDirectoryCustody,
  spawnedQuery,
  success,
  waitFor,
  workspaceRef,
} from "./claude-agent-sdk-contained-turn-provider.support.ts";

test("current-kernel adapter rejects a resolver result produced without its private callback", async () => {
  let guardianSpawns = 0;
  const adapter = kernelProvider(spawnedQuery([success("forged-without-callback")]), {
    privateExecutions: {
      consume: async () => ({ kind: "completed" as const, outcome: "succeeded" as const }),
    },
    processes: {
      get: () => inertRegistryProcess(),
      start: () => {
        guardianSpawns += 1;
        return inertProcess();
      },
    },
  });
  assert.equal((await adapter.execute(kernelInput() as never)).kind, "indeterminate");
  assert.equal(guardianSpawns, 0);
});

test("current-kernel adapter makes a duplicate private callback effect-free and indeterminate", async () => {
  let guardianSpawns = 0;
  const adapter = kernelProvider(spawnedQuery([success("double-private-callback")]), {
    privateExecutions: {
      consume: async (_request, consume) => {
        const first = await consume({ privateProjection, workspaceRef });
        const duplicate = await consume({ privateProjection, workspaceRef });
        assert.equal(duplicate.kind, "indeterminate");
        return first;
      },
    },
    processes: {
      get: () => inertRegistryProcess(),
      start: () => {
        guardianSpawns += 1;
        return inertProcess();
      },
    },
  });
  assert.equal((await adapter.execute(kernelInput() as never)).kind, "indeterminate");
  assert.equal(guardianSpawns, 1);
});

test("current-kernel adapter drains a callback already started before its resolver rejects", async () => {
  let iteratorStarted = false;
  let releaseIterator: (() => void) | undefined;
  const iteratorGate = new Promise<void>(resolve => { releaseIterator = resolve; });
  const adapter = kernelProvider(queryInput => {
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
        iteratorStarted = true;
        await iteratorGate;
        yield success("callback-before-resolver-rejection");
      },
    };
  }, {
    privateExecutions: {
      consume: async (_request, consume) => {
        void consume({ privateProjection, workspaceRef });
        await waitFor(() => iteratorStarted);
        throw new Error("synthetic resolver rejection after callback");
      },
    },
  });
  let settled = false;
  const outcomePromise = adapter.execute(kernelInput() as never);
  void outcomePromise.then(() => {
    settled = true;
    return settled;
  });
  await waitFor(() => iteratorStarted);
  await nextTurn();
  assert.equal(settled, false);
  releaseIterator?.();
  assert.equal((await outcomePromise).kind, "indeterminate");
});

test("current-kernel adapter observes a callback rejection after resolver rejection", async t => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => { process.off("unhandledRejection", onUnhandled); });
  const adapter = kernelProvider(() => {
    throw new Error("synthetic callback execution rejection");
  }, {
    privateExecutions: {
      consume: async (_request, consume) => {
        void consume({ privateProjection, workspaceRef });
        throw new Error("synthetic resolver rejection after callback rejection");
      },
    },
  });
  assert.equal((await adapter.execute(kernelInput() as never)).kind, "indeterminate");
  await nextTurn();
  await nextTurn();
  assert.deepEqual(unhandled, []);
});

test("current-kernel adapter makes a retained callback invoked after resolver settlement effect-free", async () => {
  let retained: ((execution: {
    privateProjection: typeof privateProjection;
    workspaceRef: string;
  }) => Promise<unknown>) | undefined;
  let queryCalls = 0;
  let guardianSpawns = 0;
  const adapter = kernelProvider(() => {
    queryCalls += 1;
    throw new Error("late callback must not reach provider code");
  }, {
    privateExecutions: {
      consume: async (_request, consume) => {
        retained = consume;
      },
    },
    processes: {
      get: () => inertRegistryProcess(),
      start: () => {
        guardianSpawns += 1;
        return inertProcess();
      },
    },
  });
  assert.equal((await adapter.execute(kernelInput() as never)).kind, "indeterminate");
  assert.ok(retained);
  const late = await retained({ privateProjection, workspaceRef });
  assert.equal((late as { kind: string }).kind, "indeterminate");
  assert.deepEqual([queryCalls, guardianSpawns], [0, 0]);
});

test("current-kernel adapter makes callbacks queued on an already-settled resolver effect-free", async t => {
  for (const settlement of ["fulfilled", "rejected"] as const) {
    await t.test(settlement, async () => {
      let queryCalls = 0;
      let hostDelegations = 0;
      let guardianSpawns = 0;
      const adapter = kernelProvider(() => {
        queryCalls += 1;
        throw new Error("settled resolver callback must not reach provider code");
      }, {
        privateExecutions: {
          consume(_request, consume) {
            if (settlement === "fulfilled") {
              const settled = Promise.resolve();
              void settled.then(() => {
                void consume({ privateProjection, workspaceRef });
                return settlement;
              });
              return settled;
            }
            const settled = Promise.reject<void>(new Error("synthetic resolver rejection"));
            void settled.catch(() => {
              void consume({ privateProjection, workspaceRef });
              return settlement;
            });
            return settled;
          },
        },
        processes: {
          get: () => inertRegistryProcess(),
          start: () => {
            guardianSpawns += 1;
            return inertProcess();
          },
        },
      });
      const outcome = await adapter.execute(kernelInput({}, {
        createProcess: <Process>(create: () => Process): Process => {
          hostDelegations += 1;
          return create();
        },
      }) as never);
      await nextTurn();
      assert.equal(outcome.kind, "indeterminate");
      assert.deepEqual([queryCalls, hostDelegations, guardianSpawns], [0, 0, 0]);
    });
  }
});

test("current-kernel adapter rejects a resolver substitute for the exactly-once callback result", async () => {
  const adapter = kernelProvider(spawnedQuery([success("substituted-private-result")]), {
    privateExecutions: {
      consume: async (_request, consume) => {
        const actual = await consume({ privateProjection, workspaceRef });
        return { ...actual };
      },
    },
  });
  assert.equal((await adapter.execute(kernelInput() as never)).kind, "indeterminate");
});

test("current-kernel private execution lookup is bound to the exact attempt and authority identities", async () => {
  const differentAttemptId = containedTurnIdentity("attempt", "attempt:claude-kernel-different");
  const differentAuthority = digestContainedTurnCanonicalValue(["different-kernel-authority"]);
  const differentProof = kernelStartProof({
    attemptId: differentAttemptId,
    authorityVectorDigest: differentAuthority,
  });
  let observedRequest: unknown;
  const adapter = kernelProvider(spawnedQuery([success("different-private-identity")]), {
    privateExecutions: {
      consume: async (request, consume) => {
        observedRequest = request;
        return consume({ privateProjection, workspaceRef });
      },
    },
  });
  const outcome = await adapter.execute(kernelInput({
    attemptId: differentAttemptId,
    authorityVectorDigest: differentAuthority,
  }, {
    observation: Promise.resolve({ kind: "execution_started" as const, proof: differentProof }),
  }) as never);
  assert.deepEqual(outcome, { kind: "completed", outcome: "succeeded" });
  assert.deepEqual(observedRequest, {
    attemptId: differentAttemptId,
    authorityVectorDigest: differentAuthority,
    custodyId: kernelCustodyId,
    effectId: kernelEffectId,
    operationId: kernelOperationId,
    workspaceId: kernelWorkspaceId,
  });
});

test("current-kernel adapter rejects every wrong-bound Host start observation", async t => {
  const rows = [
    { field: "operationId", value: containedTurnIdentity("operation", "operation:wrong-start") },
    { field: "attemptId", value: containedTurnIdentity("attempt", "attempt:wrong-start") },
    { field: "custodyId", value: containedTurnIdentity("custody", "custody:wrong-start") },
    { field: "effectId", value: containedTurnIdentity("effect", "effect:wrong-start") },
    { field: "authorityVectorDigest", value: digestContainedTurnCanonicalValue(["wrong-start-authority"]) },
  ] as const;
  for (const row of rows) {
    await t.test(row.field, async () => {
      const adapter = kernelProvider(spawnedQuery([success(`wrong-start-${row.field}`)]));
      const proof = kernelStartProof({ [row.field]: row.value });
      const outcome = await adapter.execute(kernelInput({}, {
        observation: Promise.resolve({ kind: "execution_started" as const, proof }),
      }) as never);
      assert.equal(outcome.kind, "indeterminate");
    });
  }
});

test("current-kernel adapter keeps rejected and never-resolving start observations indeterminate", async t => {
  await t.test("rejected", async () => {
    const clock = new ManualClock();
    let guardianSpawns = 0;
    let rejectObservation: ((error: Error) => void) | undefined;
    const observation = new Promise<never>((_resolve, reject) => { rejectObservation = reject; });
    const adapter = kernelProvider(spawnedQuery([success("rejected-start-observation")]), {
      clock,
      processes: {
        get: () => inertRegistryProcess(),
        start: () => {
          guardianSpawns += 1;
          return inertProcess();
        },
      },
      turnTimeoutMs: 10,
    });
    const outcomePromise = adapter.execute(kernelInput({}, { observation }) as never);
    await waitFor(() => guardianSpawns === 1 && clock.activeWaiterCount() === 1);
    rejectObservation?.(new Error("synthetic missing start observation"));
    const outcome = await outcomePromise;
    assert.equal(outcome.kind, "indeterminate");
  });

  await t.test("never resolving", async () => {
    const clock = new ManualClock();
    let guardianSpawns = 0;
    const adapter = kernelProvider(spawnedQuery([success("never-start-observation")]), {
      clock,
      processes: {
        get: () => inertRegistryProcess(),
        start: () => {
          guardianSpawns += 1;
          return inertProcess();
        },
      },
      turnTimeoutMs: 10,
    });
    const outcomePromise = adapter.execute(kernelInput({}, {
      observation: new Promise(() => {}),
    }) as never);
    await waitFor(() => guardianSpawns === 1 && clock.activeWaiterCount() === 1);
    clock.advance(10);
    const outcome = await Promise.race([
      outcomePromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("start observation was not bounded")), 1_000);
      }),
    ]);
    assert.equal(outcome.kind, "indeterminate");
    assert.equal(guardianSpawns, 1);
  });
});

test("current-kernel adapter rejects a start observation delivered after the original absolute turn deadline", async () => {
  const clock = new ManualClock();
  let guardianSpawns = 0;
  let resolveObservation: ((value: {
    readonly kind: "execution_started";
    readonly proof: ReturnType<typeof kernelStartProof>;
  }) => void) | undefined;
  const observation = new Promise<{
    readonly kind: "execution_started";
    readonly proof: ReturnType<typeof kernelStartProof>;
  }>(resolve => {
    resolveObservation = resolve;
  });
  const adapter = kernelProvider(spawnedQuery([success("late-start-observation")]), {
    clock,
    processes: {
      get: () => inertRegistryProcess(),
      start: () => {
        guardianSpawns += 1;
        return inertProcess();
      },
    },
    turnTimeoutMs: 10,
  });
  const outcomePromise = adapter.execute(kernelInput({}, { observation }) as never);
  await waitFor(() => guardianSpawns === 1 && clock.activeWaiterCount() === 1);
  clock.advance(10);
  const outcome = await outcomePromise;
  assert.equal(outcome.kind, "indeterminate");
  resolveObservation?.({ kind: "execution_started", proof: kernelStartProof() });
  await nextTurn();
  assert.equal(guardianSpawns, 1);
});

test("current-kernel adapter snapshots mutable constructor options before execution", async () => {
  let originalResolverCalls = 0;
  let replacementResolverCalls = 0;
  let originalProcessStarts = 0;
  let replacementProcessStarts = 0;
  let originalClockReads = 0;
  let originalClockWaits = 0;
  let replacementClockCalls = 0;
  const privateExecutions = {
    ownerState: "original",
    async consume(
      this: { ownerState: string },
      _request: unknown,
      consume: (execution: {
        privateProjection: typeof privateProjection;
        workspaceRef: string;
      }) => Promise<unknown>,
    ) {
      assert.equal(this.ownerState, "original");
      originalResolverCalls += 1;
      return consume({ privateProjection, workspaceRef });
    },
  };
  const processes = {
    ownerState: "original",
    get(this: { ownerState: string }) {
      assert.equal(this.ownerState, "original");
      return inertRegistryProcess();
    },
    start(this: { ownerState: string }) {
      assert.equal(this.ownerState, "original");
      originalProcessStarts += 1;
      return inertProcess();
    },
  };
  const clock = {
    elapsed: 0,
    now(this: { elapsed: number }) {
      originalClockReads += 1;
      return this.elapsed;
    },
    wait(this: { elapsed: number }, _milliseconds: number, signal: AbortSignal): Promise<void> {
      originalClockWaits += 1;
      return new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  const mutableOptions = {
    adapterSnapshot: kernelAdapterSnapshot,
    cancellationPollMs: 1,
    executablePath,
    interruptGraceMs: 5,
    manifest: kernelManifest,
    privateDirectoryCustody,
    clock,
    privateExecutions,
    processes,
    queryFactory: spawnedQuery([success("snapshotted-options")]),
    turnTimeoutMs: 100,
  };
  const adapter = new ClaudeAgentSdkCurrentKernelAdapter(mutableOptions);
  privateExecutions.consume = async () => {
    replacementResolverCalls += 1;
    return { kind: "completed", outcome: "succeeded" };
  };
  processes.get = () => inertRegistryProcess();
  processes.start = () => {
    replacementProcessStarts += 1;
    return inertProcess();
  };
  clock.now = () => {
    replacementClockCalls += 1;
    throw new Error("replacement clock now must not run");
  };
  clock.wait = async () => {
    replacementClockCalls += 1;
    throw new Error("replacement clock wait must not run");
  };
  mutableOptions.privateExecutions = {
    consume: async () => {
      replacementResolverCalls += 1;
      return { kind: "completed", outcome: "succeeded" };
    },
  };
  mutableOptions.queryFactory = () => {
    throw new Error("mutated query factory must not run");
  };
  assert.deepEqual(
    await adapter.execute(kernelInput() as never),
    { kind: "completed", outcome: "succeeded" },
  );
  assert.deepEqual([originalResolverCalls, replacementResolverCalls], [1, 0]);
  assert.deepEqual([originalProcessStarts, replacementProcessStarts], [1, 0]);
  assert.ok(originalClockReads > 0);
  assert.ok(originalClockWaits > 0);
  assert.equal(replacementClockCalls, 0);
});
