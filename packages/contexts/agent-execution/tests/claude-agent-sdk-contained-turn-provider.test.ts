import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test, { after } from "node:test";

import {
  ClaudeAgentSdkContainedTurnProvider,
  type ClaudeAgentSdkContainedTurnProviderOptions,
  type ClaudeAgentSdkControlClock,
} from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-contained-turn-provider.js";
import {
  ClaudeAgentSdkCurrentKernelAdapter,
  mapClaudeAgentSdkKernelObservation,
} from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-current-kernel-adapter.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import {
  claudeAgentSdkArguments,
  createClaudeAgentSdkLaunchPlan,
  createClaudeAgentSdkPrivateProjection,
  isClaudeAgentSdkPrivateProjectionUsable,
} from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import {
  createNodeContainedTurnArtifacts,
} from "../dist/features/contained-agent-turn/adapters/outbound/filesystem/node-contained-turn-artifacts.js";
import type {
  CustodiedProviderProcess,
  CustodiedSdkProcess,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";

const custodyRoot = await mkdtemp(join(tmpdir(), "ar-claude-provider-test-"));
after(async () => {await rm(custodyRoot, { recursive: true, force: true });});
const workspaceRef = join(custodyRoot, "workspace");
const privateRoot = join(custodyRoot, "private");
await Promise.all([
  mkdir(workspaceRef, { mode: 0o700 }),
  mkdir(join(privateRoot, "config"), { mode: 0o700, recursive: true }),
  mkdir(join(privateRoot, "home"), { mode: 0o700, recursive: true }),
  mkdir(join(privateRoot, "tmp"), { mode: 0o700, recursive: true }),
]);
const executablePath = "/synthetic/claude";
const privateProjection = createClaudeAgentSdkPrivateProjection({
  configRoot: join(privateRoot, "config"),
  homeRoot: join(privateRoot, "home"),
  projectionRef: "projection:claude-test",
  tempRoot: join(privateRoot, "tmp"),
  workspaceRef,
});
const binding = Object.freeze({
  adapterRevision: "claude-agent-sdk-contained-turn:0.3.251",
  binaryRevision: "@anthropic-ai/claude-agent-sdk:0.3.251+synthetic",
  capabilityManifestRevision: "contained-turn:v1:claude-agent-sdk:0.3.251",
  credentialBindingDigest: "credential:synthetic",
  provider: "claude" as const,
  providerRouteRef: "route:synthetic",
});
const manifest = Object.freeze({
  effectClass: "contained_unmediated_effect" as const,
  providerBinding: binding,
  supportedModes: Object.freeze(["analysis", "workspace-write"] as const),
});
const privateProjections = Object.freeze({ resolve: () => privateProjection });

const input = (mode: "analysis" | "workspace-write" = "analysis") => ({
  attemptId: "attempt:claude-test",
  custody: { custodyRef: "custody:claude-test" },
  effectId: "effect:claude-test",
  emit: async (_chunk: { readonly cursor: number; readonly kind: "assistant" | "diagnostic" | "progress"; readonly text: string }) => {},
  intent: { mode, prompt: "reply exactly OK" },
  isCancellationRequested: async () => false,
  operationId: "operation:claude-test",
  workspaceRef,
});
const inertProcess = (): CustodiedSdkProcess => ({
  exitCode: null, kill: () => true, killed: false, off: () => {}, on: () => {}, once: () => {},
  signalCode: null, stdin: undefined as never, stdout: undefined as never,
});
const inertRegistryProcess = (): CustodiedProviderProcess => ({
  closeInput: async () => {}, custodyRef: "custody:claude-test",
  stderr: { async *[Symbol.asyncIterator]() {} }, stdout: { async *[Symbol.asyncIterator]() {} },
  waitForExit: async () => ({ code: 0, signal: null }), write: async () => {},
});

type QueryFactory = NonNullable<ClaudeAgentSdkContainedTurnProviderOptions["queryFactory"]>;
const provider = (queryFactory: QueryFactory, options: Partial<ClaudeAgentSdkContainedTurnProviderOptions> = {}) =>
  new ClaudeAgentSdkContainedTurnProvider({
    cancellationPollMs: 1,
    executablePath,
    interruptGraceMs: 20,
    manifest,
    privateProjections,
    processes: { get: () => inertRegistryProcess(), start: () => inertProcess() },
    queryFactory,
    turnTimeoutMs: 1_000,
    ...options,
  });

const success = (id = "one") => ({
  is_error: false, result: "OK", session_id: `session:${id}`,
  subtype: "success" as const, type: "result" as const, uuid: `result:${id}`,
});
const delta = (text: string) => ({
  event: { delta: { text, type: "text_delta" }, type: "content_block_delta" },
  parent_tool_use_id: null, session_id: "session:stream", type: "stream_event", uuid: "stream:event",
});

test("uses only an external frozen private projection while tools remain workspace-bound", async () => {
  let captured: Parameters<Parameters<QueryFactory>[0]["options"]["spawnClaudeCodeProcess"]>[0] | undefined;
  const adapter = provider(queryInput => {
    assert.deepEqual(queryInput.options.env, privateProjection.environment);
    assert.deepEqual(queryInput.options.sandbox.filesystem, { allowRead: [workspaceRef], allowWrite: [] });
    captured = {
      args: [...claudeAgentSdkArguments("analysis", workspaceRef)], command: executablePath,
      cwd: workspaceRef, env: { ...privateProjection.environment }, signal: new AbortController().signal,
    };
    queryInput.options.spawnClaudeCodeProcess(captured);
    return { close: () => {}, interrupt: async () => {}, async *[Symbol.asyncIterator]() {yield success();} };
  });
  assert.equal((await adapter.execute(input())).kind, "completed");
  assert.ok(captured);
  assert.equal(captured.cwd, workspaceRef);
  assert.deepEqual(captured.env, privateProjection.environment);

  const plan = await createClaudeAgentSdkLaunchPlan({
    binaryRevision: binding.binaryRevision, executablePath, executableSha256: "0".repeat(64),
    privateProjection, workspaceRef,
  });
  assert.equal(plan.environment, privateProjection.environment);
  assert.ok(plan.delegatedArgumentVariants?.some(value => JSON.stringify(value) === JSON.stringify(captured?.args)));
  assert.throws(() => createClaudeAgentSdkPrivateProjection({
    configRoot: `${workspaceRef}/config`, homeRoot: "/tmp/private/home", projectionRef: "bad",
    tempRoot: "/tmp/private/tmp", workspaceRef,
  }), /disjoint/u);
});

test("rejects forward and reverse symlink aliases between private roots and the workspace", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-alias-"));
  t.after(async () => {await rm(root, { recursive: true, force: true });});
  const workspace = join(root, "workspace");
  const projection = join(root, "projection");
  await Promise.all([
    mkdir(workspace, { mode: 0o700 }),
    mkdir(join(projection, "config"), { mode: 0o700, recursive: true }),
    mkdir(join(projection, "home"), { mode: 0o700, recursive: true }),
    mkdir(join(projection, "tmp"), { mode: 0o700, recursive: true }),
  ]);

  const forwardAlias = join(root, "config-alias");
  await symlink(workspace, forwardAlias, "dir");
  const forwardProjection = createClaudeAgentSdkPrivateProjection({
    configRoot: forwardAlias,
    homeRoot: join(projection, "home"),
    projectionRef: "projection:forward-alias",
    tempRoot: join(projection, "tmp"),
    workspaceRef: workspace,
  });
  assert.equal(await isClaudeAgentSdkPrivateProjectionUsable(forwardProjection, workspace), false);
  await assert.rejects(createClaudeAgentSdkLaunchPlan({
    binaryRevision: binding.binaryRevision,
    executablePath,
    executableSha256: "0".repeat(64),
    privateProjection: forwardProjection,
    workspaceRef: workspace,
  }), /disjoint/u);

  const reverseAlias = join(root, "workspace-alias");
  await symlink(projection, reverseAlias, "dir");
  const reverseProjection = createClaudeAgentSdkPrivateProjection({
    configRoot: join(projection, "config"),
    homeRoot: join(projection, "home"),
    projectionRef: "projection:reverse-alias",
    tempRoot: join(projection, "tmp"),
    workspaceRef: reverseAlias,
  });
  assert.equal(await isClaudeAgentSdkPrivateProjectionUsable(reverseProjection, reverseAlias), false);
  await assert.rejects(createClaudeAgentSdkLaunchPlan({
    binaryRevision: binding.binaryRevision,
    executablePath,
    executableSha256: "0".repeat(64),
    privateProjection: reverseProjection,
    workspaceRef: reverseAlias,
  }), /disjoint/u);
});

test("emits zero-based cursors with exact continuity", async () => {
  const output: { cursor: number; text: string }[] = [];
  const adapter = provider(() => ({
    close: () => {}, interrupt: async () => {},
    async *[Symbol.asyncIterator]() {yield delta("A"); yield delta("B"); yield success();},
  }));
  const outcome = await adapter.execute({ ...input(), emit: async chunk => {output.push(chunk);} });
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(output, [{ cursor: 0, kind: "assistant", text: "A" }, { cursor: 1, kind: "assistant", text: "B" }]);
});

test("treats duplicate terminal results as ambiguous", async () => {
  const adapter = provider(() => ({
    close: () => {}, interrupt: async () => {},
    async *[Symbol.asyncIterator]() {yield success("one"); yield success("two");},
  }));
  assert.equal((await adapter.execute(input())).kind, "ambiguous");
});

test("treats a missing terminal result as ambiguous", async () => {
  const adapter = provider(() => ({
    close: () => {}, interrupt: async () => {},
    async *[Symbol.asyncIterator]() {yield { type: "system" };},
  }));
  assert.equal((await adapter.execute(input())).kind, "ambiguous");
});

test("treats iterator failure after a result as ambiguous", async () => {
  const adapter = provider(() => ({
    close: () => {}, interrupt: async () => {},
    async *[Symbol.asyncIterator]() {yield success(); throw new Error("/private/account credential-secret");},
  }));
  assert.equal((await adapter.execute(input())).kind, "ambiguous");
});

test("closes admission for callbacks after the terminal result", async () => {
  const output: string[] = [];
  const adapter = provider(() => ({
    close: () => {}, interrupt: async () => {},
    async *[Symbol.asyncIterator]() {yield success(); yield delta("LATE_SECRET");},
  }));
  const outcome = await adapter.execute({ ...input(), emit: async chunk => {output.push(chunk.text);} });
  assert.equal(outcome.kind, "ambiguous");
  assert.deepEqual(output, []);
});

test("emits only bounded typed diagnostics with redacted digests", async () => {
  const output: string[] = [];
  const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
  const adapter = provider(() => ({
    close: () => {}, interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      yield {
        errors: [`account@example.com /private/account ${secret} ${"x".repeat(50_000)}`],
        is_error: true, session_id: "session:error", subtype: "error_during_execution", type: "result", uuid: "result:error",
      };
    },
  }));
  const outcome = await adapter.execute({ ...input(), emit: async chunk => {output.push(chunk.text);} });
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {assert.equal(outcome.outcome, "failed");}
  assert.equal(output.length, 1);
  assert.ok((output[0]?.length ?? 0) < 256);
  assert.match(output[0] ?? "", /CLAUDE_EXECUTION_ERROR/u);
  assert.doesNotMatch(output[0] ?? "", /account|private|sk-ant|xxxxx/iu);
});

test("never emits the raw result of an error-marked success subtype", async () => {
  const output: { kind: string; text: string }[] = [];
  const credential = "sk-ant-synthetic-private-credential-0123456789";
  const privatePath = "/private/accounts/claude/.credentials.json";
  const adapter = provider(() => ({
    close: () => {}, interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      yield {
        is_error: true,
        result: `authentication failed for ${credential} at ${privatePath}`,
        session_id: "session:error-success",
        subtype: "success",
        type: "result",
        uuid: "result:error-success",
      };
    },
  }));
  const outcome = await adapter.execute({ ...input(), emit: async chunk => {output.push(chunk);} });
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {assert.equal(outcome.outcome, "failed");}
  assert.equal(output.length, 1);
  assert.equal(output[0]?.kind, "diagnostic");
  assert.ok((output[0]?.text.length ?? 0) < 256);
  assert.match(output[0]?.text ?? "", /CLAUDE_RESULT_ERROR/u);
  assert.doesNotMatch(output[0]?.text ?? "", /sk-ant|credential|private|accounts/iu);
});

test("preserves non-error success fallback and streamed-output controls", async () => {
  const fallback: string[] = [];
  const fallbackOutcome = await provider(() => ({
    close: () => {}, interrupt: async () => {},
    async *[Symbol.asyncIterator]() {yield success("fallback");},
  })).execute({ ...input(), emit: async chunk => {fallback.push(chunk.text);} });
  assert.equal(fallbackOutcome.kind, "completed");
  if (fallbackOutcome.kind === "completed") {assert.equal(fallbackOutcome.outcome, "succeeded");}
  assert.deepEqual(fallback, ["OK"]);

  const streamedOutput: string[] = [];
  const streamedOutcome = await provider(() => ({
    close: () => {}, interrupt: async () => {},
    async *[Symbol.asyncIterator]() {yield delta("STREAMED_OK"); yield success("streamed");},
  })).execute({ ...input(), emit: async chunk => {streamedOutput.push(chunk.text);} });
  assert.equal(streamedOutcome.kind, "completed");
  if (streamedOutcome.kind === "completed") {assert.equal(streamedOutcome.outcome, "succeeded");}
  assert.deepEqual(streamedOutput, ["STREAMED_OK"]);
});

class ManualClock implements ClaudeAgentSdkControlClock {
  #advanceBeforeRead: { milliseconds: number; reads: number } | undefined;
  #elapsed = 0;
  #reported = 0;
  readonly #waiters: Array<{
    due: number;
    reject: (error: Error) => void;
    resolve: () => void;
    signal: AbortSignal;
  }> = [];
  now(): number {
    if (this.#advanceBeforeRead?.reads === 0) {
      const { milliseconds } = this.#advanceBeforeRead;
      this.#advanceBeforeRead = undefined;
      this.advanceWithoutDelivery(milliseconds);
    } else if (this.#advanceBeforeRead !== undefined) {
      this.#advanceBeforeRead.reads -= 1;
    }
    return this.#reported;
  }
  wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {reject(new Error("aborted")); return;}
      const waiter = { due: this.#elapsed + milliseconds, reject, resolve, signal };
      this.#waiters.push(waiter);
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
  advance(milliseconds: number): void {
    this.advanceWithoutDelivery(milliseconds);
    for (const waiter of [...this.#waiters]) {
      if (waiter.due <= this.#elapsed) {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        if (!waiter.signal.aborted) {waiter.resolve();}
      }
    }
  }
  advanceWithoutDelivery(milliseconds: number): void {
    this.#elapsed += milliseconds;
    this.#reported += milliseconds;
  }
  advanceWithoutDeliveryBeforeRead(reads: number, milliseconds: number): void {
    this.#advanceBeforeRead = { milliseconds, reads };
  }
  activeWaiterCount(): number {return this.#waiters.filter(waiter => !waiter.signal.aborted).length;}
  rollback(milliseconds: number): void {this.#reported -= milliseconds;}
}

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {return;}
    await nextTurn();
  }
  assert.fail("timed out waiting for synthetic Claude callback");
};

test("streams intentional assistant text incrementally while redacting a later error result", async () => {
  const output: { kind: string; text: string }[] = [];
  const intentionalAssistantText = "assistant-visible sk-ant-intentional-output-0123456789";
  const rawDiagnostic = "SDK failure for sk-ant-private-diagnostic-9876543210 at /private/provider/config";
  let releaseResult: (() => void) | undefined;
  const resultGate = new Promise<void>(resolve => {releaseResult = resolve;});
  const adapter = provider(() => ({
    close: () => {}, interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      yield delta(intentionalAssistantText);
      await resultGate;
      yield {
        is_error: true, result: rawDiagnostic, session_id: "session:stream-error",
        subtype: "success", type: "result", uuid: "result:stream-error",
      };
    },
  }));
  let settled = false;
  const outcomePromise = adapter.execute({ ...input(), emit: async chunk => {output.push(chunk);} });
  void outcomePromise.then(() => {settled = true;});
  await waitFor(() => output.length === 1);
  assert.equal(settled, false);
  assert.deepEqual(output[0], { cursor: 0, kind: "assistant", text: intentionalAssistantText });
  releaseResult?.();
  const outcome = await outcomePromise;
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {assert.equal(outcome.outcome, "failed");}
  assert.equal(output.length, 2);
  assert.equal(output[1]?.kind, "diagnostic");
  assert.ok((output[1]?.text.length ?? 0) < 256);
  assert.doesNotMatch(output[1]?.text ?? "", /private-diagnostic|provider\/config|SDK failure/iu);
});

test("rejects a malformed assistant stream envelope without emitting its diagnostic-shaped field", async () => {
  const output: string[] = [];
  const adapter = provider(() => ({
    close: () => {}, interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      yield {
        event: {
          delta: { text: { diagnostic: "sk-ant-malformed-private-diagnostic" }, type: "text_delta" },
          type: "content_block_delta",
        },
        parent_tool_use_id: null,
        session_id: "session:malformed",
        type: "stream_event",
        uuid: "stream:malformed",
      };
      yield success("after-malformed");
    },
  }));
  const outcome = await adapter.execute({ ...input(), emit: async chunk => {output.push(chunk.text);} });
  assert.equal(outcome.kind, "ambiguous");
  assert.deepEqual(output, []);
});

test("abandons a never-settling cancellation lookup when the iterator closes", async () => {
  const clock = new ManualClock();
  let iteratorStarted = false;
  let lookupStarted = false;
  let releaseIterator: (() => void) | undefined;
  const iteratorGate = new Promise<void>(resolve => {releaseIterator = resolve;});
  const adapter = provider(() => ({
    close: () => {}, interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      iteratorStarted = true;
      await iteratorGate;
      yield success("lookup-abandoned");
    },
  }), { clock });
  const outcomePromise = adapter.execute({
    ...input(),
    isCancellationRequested: () => {
      lookupStarted = true;
      return new Promise<boolean>(() => {});
    },
  });
  await waitFor(() => iteratorStarted);
  clock.advance(1);
  await waitFor(() => lookupStarted);
  releaseIterator?.();
  const outcome = await outcomePromise;
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {assert.equal(outcome.outcome, "succeeded");}
});

test("a never-settling emit is abandoned at the turn deadline and cannot manufacture closure later", async () => {
  const clock = new ManualClock();
  let emitStarted = false;
  let lateEmitCompleted = false;
  let releaseEmit: (() => void) | undefined;
  const emitGate = new Promise<void>(resolve => {releaseEmit = resolve;});
  const adapter = provider(() => ({
    close: () => {}, interrupt: async () => {},
    async *[Symbol.asyncIterator]() {yield delta("UNPROVEN_OUTPUT"); yield success("emit-timeout");},
  }), { clock, interruptGraceMs: 5, turnTimeoutMs: 10 });
  const outcomePromise = adapter.execute({
    ...input(),
    emit: async () => {
      emitStarted = true;
      await emitGate;
      lateEmitCompleted = true;
    },
  });
  await waitFor(() => emitStarted);
  clock.advance(10);
  const outcome = await outcomePromise;
  assert.equal(outcome.kind, "ambiguous");
  releaseEmit?.();
  await nextTurn();
  assert.equal(lateEmitCompleted, true);
  assert.equal(outcome.kind, "ambiguous");
});

test("a never-settling interrupt is bounded and forced close cannot become success", async () => {
  const clock = new ManualClock();
  let closeCalled = false;
  let interruptCalled = false;
  let iteratorStarted = false;
  let releaseIterator: (() => void) | undefined;
  const iteratorGate = new Promise<void>(resolve => {releaseIterator = resolve;});
  const adapter = provider(() => ({
    close: () => {closeCalled = true; releaseIterator?.();},
    interrupt: () => {
      interruptCalled = true;
      return new Promise<unknown>(() => {});
    },
    async *[Symbol.asyncIterator]() {
      iteratorStarted = true;
      await iteratorGate;
      yield success("late-interrupt");
    },
  }), { clock });
  const outcomePromise = adapter.execute({ ...input(), isCancellationRequested: async () => true });
  await waitFor(() => iteratorStarted);
  clock.advance(1);
  await waitFor(() => interruptCalled);
  clock.advance(20);
  await waitFor(() => closeCalled);
  const outcome = await outcomePromise;
  assert.equal(outcome.kind, "ambiguous");
});

test("a never-settling close is bounded after ordinary iterator exhaustion", async () => {
  const clock = new ManualClock();
  let closeCalled = false;
  const adapter = provider(() => ({
    close: () => {
      closeCalled = true;
      return new Promise<void>(() => {});
    },
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() {yield success("close-timeout");},
  }), { clock });
  const outcomePromise = adapter.execute(input());
  await waitFor(() => closeCalled);
  clock.advance(40);
  assert.equal((await outcomePromise).kind, "ambiguous");
});

test("a fulfilled close after the absolute deadline is rejected before delayed timer delivery", async () => {
  const clock = new ManualClock();
  let closeCalled = false;
  let releaseClose: (() => void) | undefined;
  const closeGate = new Promise<void>(resolve => {releaseClose = resolve;});
  const adapter = provider(() => ({
    close: () => {
      closeCalled = true;
      return closeGate;
    },
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() {yield success("late-close-settlement");},
  }), { clock });
  const outcomePromise = adapter.execute(input());
  await waitFor(() => closeCalled);
  clock.advanceWithoutDelivery(41);
  releaseClose?.();
  assert.equal((await outcomePromise).kind, "ambiguous");
});

test("close is not invoked when its prechecked call seam observes an expired deadline", async () => {
  const clock = new ManualClock();
  let closeCalled = false;
  const adapter = provider(() => ({
    close: () => {closeCalled = true;},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      yield success("close-not-started");
      clock.advanceWithoutDeliveryBeforeRead(2, 41);
    },
  }), { clock });
  assert.equal((await adapter.execute(input())).kind, "ambiguous");
  assert.equal(closeCalled, false);
});

test("interrupt is not invoked when its prechecked call seam observes an expired deadline", async () => {
  const clock = new ManualClock();
  let closeCalled = false;
  let interruptCalled = false;
  let iteratorStarted = false;
  let releaseIterator: (() => void) | undefined;
  const iteratorGate = new Promise<void>(resolve => {releaseIterator = resolve;});
  const adapter = provider(() => ({
    close: () => {closeCalled = true; releaseIterator?.();},
    interrupt: async () => {interruptCalled = true;},
    async *[Symbol.asyncIterator]() {
      iteratorStarted = true;
      await iteratorGate;
      yield success("interrupt-not-started");
    },
  }), { clock, interruptGraceMs: 5 });
  const outcomePromise = adapter.execute({
    ...input(),
    isCancellationRequested: async () => {
      clock.advanceWithoutDeliveryBeforeRead(5, 5);
      return true;
    },
  });
  await waitFor(() => iteratorStarted);
  clock.advance(1);
  assert.equal((await outcomePromise).kind, "ambiguous");
  assert.equal(interruptCalled, false);
  assert.equal(closeCalled, true);
});

test("absolute stop deadline bounds a stuck iterator, lookup, interrupt, and close", async () => {
  const clock = new ManualClock();
  let closeCalled = false;
  let interruptCalled = false;
  let iteratorStarted = false;
  let lookupStarted = false;
  const adapter = provider(() => ({
    close: () => {
      closeCalled = true;
      return new Promise<void>(() => {});
    },
    interrupt: () => {
      interruptCalled = true;
      return new Promise<unknown>(() => {});
    },
    async *[Symbol.asyncIterator]() {
      iteratorStarted = true;
      await new Promise<void>(() => {});
    },
  }), { clock, interruptGraceMs: 5, turnTimeoutMs: 10 });
  const outcomePromise = adapter.execute({
    ...input(),
    isCancellationRequested: () => {
      lookupStarted = true;
      return new Promise<boolean>(() => {});
    },
  });
  await waitFor(() => iteratorStarted);
  clock.advance(1);
  await waitFor(() => lookupStarted);
  clock.advance(9);
  await waitFor(() => interruptCalled);
  clock.advance(5);
  await waitFor(() => closeCalled);
  clock.advance(5);
  assert.equal((await outcomePromise).kind, "ambiguous");
});

test("monotonic absolute deadlines survive a reported clock rollback", async () => {
  const clock = new ManualClock();
  let closeCalled = false;
  let interruptCalled = false;
  let iteratorStarted = false;
  let releaseIterator: (() => void) | undefined;
  const iteratorGate = new Promise<void>(resolve => {releaseIterator = resolve;});
  const adapter = provider(() => ({
    close: () => {closeCalled = true; releaseIterator?.();},
    interrupt: async () => {interruptCalled = true;},
    async *[Symbol.asyncIterator]() {
      iteratorStarted = true;
      await iteratorGate;
      yield success("clock-rollback");
    },
  }), { cancellationPollMs: 10, clock, interruptGraceMs: 5, turnTimeoutMs: 10 });
  const outcomePromise = adapter.execute(input());
  await waitFor(() => iteratorStarted);
  clock.rollback(10_000);
  clock.advance(10);
  await waitFor(() => interruptCalled);
  clock.advance(5);
  await waitFor(() => closeCalled);
  assert.equal((await outcomePromise).kind, "ambiguous");
});

test("an interrupt observation alone never manufactures cancellation", async () => {
  const clock = new ManualClock();
  let started = false;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const adapter = provider(() => {
    started = true;
    return {
      close: () => {}, interrupt: async () => {release?.();},
      async *[Symbol.asyncIterator]() {
        await gate;
        yield { errors: ["interrupted"], is_error: true, session_id: "session:i", subtype: "error_during_execution", type: "result", uuid: "result:i" };
      },
    };
  }, { clock });
  const outcomePromise = adapter.execute({ ...input(), isCancellationRequested: async () => true });
  await waitFor(() => started);
  clock.advance(1);
  await nextTurn();
  clock.advance(20);
  await nextTurn();
  clock.advance(20);
  const outcome = await outcomePromise;
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {assert.equal(outcome.outcome, "failed");}
});

test("owns forced iterator drain and rejects late output before returning", async () => {
  const clock = new ManualClock();
  let started = false;
  let drained = false;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const output: string[] = [];
  const adapter = provider(() => {
    started = true;
    return {
      close: () => {release?.();}, interrupt: async () => {throw new Error("synthetic interrupt failure");},
      async *[Symbol.asyncIterator]() {
        try {await gate; yield delta("TOO_LATE");} finally {drained = true;}
      },
    };
  }, { clock });
  const outcomePromise = adapter.execute({ ...input(), emit: async chunk => {output.push(chunk.text);}, isCancellationRequested: async () => true });
  await waitFor(() => started);
  clock.advance(1);
  await nextTurn();
  clock.advance(20);
  await nextTurn();
  clock.advance(20);
  const outcome = await outcomePromise;
  assert.equal(outcome.kind, "ambiguous");
  assert.equal(drained, true);
  assert.deepEqual(output, []);
});

test("external credential projection can never enter sealed workspace artifacts", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-exclusion-"));
  t.after(async () => {await import("node:fs/promises").then(fs => fs.rm(root, { recursive: true, force: true }));});
  const workspace = join(root, "workspace");
  const projectionRoot = join(root, "projection");
  const artifactsRoot = join(root, "artifacts");
  await Promise.all([
    mkdir(workspace),
    mkdir(join(projectionRoot, "config"), { recursive: true }),
    mkdir(join(projectionRoot, "home"), { recursive: true }),
    mkdir(join(projectionRoot, "tmp"), { recursive: true }),
  ]);
  await writeFile(join(workspace, "deliverable.txt"), "DELIVERABLE_ONLY");
  await writeFile(join(projectionRoot, "config", ".credentials.json"), "SYNTHETIC_CREDENTIAL_BYTES");
  const projection = createClaudeAgentSdkPrivateProjection({
    configRoot: join(projectionRoot, "config"), homeRoot: join(projectionRoot, "home"),
    projectionRef: "projection:artifact-test", tempRoot: join(projectionRoot, "tmp"), workspaceRef: workspace,
  });
  assert.equal(projection.environment.CLAUDE_CONFIG_DIR, join(projectionRoot, "config"));
  const artifacts = await createNodeContainedTurnArtifacts({ root: artifactsRoot });
  await artifacts.seal({ operationId: "operation:artifact-test", output: [], workspaceRef: workspace });
  const files = await readdir(artifactsRoot, { recursive: true });
  const contents = await Promise.all(files.map(async file => {
    try {return await readFile(join(artifactsRoot, file), "utf8");} catch {return "";}
  }));
  assert.match(contents.join("\n"), /DELIVERABLE_ONLY/u);
  assert.doesNotMatch(contents.join("\n"), /SYNTHETIC_CREDENTIAL_BYTES|\.credentials\.json/u);
});

const kernelAdapterSnapshot = Object.freeze({
  adapterRevision: binding.adapterRevision,
  binaryRevision: binding.binaryRevision,
  capabilityManifestRevision: binding.capabilityManifestRevision,
  provider: "claude" as const,
});
const kernelManifest = Object.freeze({
  effectCardinality: "one_coarse_effect_per_operation" as const,
  effectClass: "contained_unmediated_effect" as const,
  manifestRevision: binding.capabilityManifestRevision,
  manifestVersion: 1 as const,
  provider: "claude" as const,
  providerAttemptCardinality: "at_most_one" as const,
  requiredProofKinds: Object.freeze([
    "command_acceptance", "dispatch_authority", "execution_closure", "provider_terminal_observation",
    "output_drain", "host_custody", "workspace_closure", "artifact_manifest_seal",
    "effect_resolution", "containment_execution", "canonical_result_publication", "cutoff_enforcement",
  ] as const),
  resourceScopeRevision: "contained-turn:v1:claude-resource-scope",
  supportedModes: Object.freeze(["analysis", "workspace-write"] as const),
  unknownCapabilityPolicy: "fail_closed" as const,
});
const kernelAttemptId = containedTurnIdentity("attempt", "attempt:claude-kernel-test");
const kernelAuthorityVectorDigest = digestContainedTurnCanonicalValue(["kernel-authority"]);
const kernelCustodyId = containedTurnIdentity("custody", "custody:claude-kernel-test");
const kernelEffectId = containedTurnIdentity("effect", "effect:claude-kernel-test");
const kernelOperationId = containedTurnIdentity("operation", "operation:claude-kernel-test");
const kernelWorkspaceId = containedTurnIdentity("workspace", "workspace:opaque-claude-kernel-test");
const kernelStartProof = (overrides: Record<string, unknown> = {}) => Object.freeze({
  binding: Object.freeze({
    attemptId: kernelAttemptId,
    authorityVectorDigest: kernelAuthorityVectorDigest,
    custodyId: kernelCustodyId,
    effectId: kernelEffectId,
    hostBootId: containedTurnIdentity("host_boot", "host-boot:claude-kernel-test"),
    hostInstanceId: containedTurnIdentity("host_instance", "host-instance:claude-kernel-test"),
    operationId: kernelOperationId,
    ...overrides,
  }),
  kind: "provider_process_start" as const,
  proofId: containedTurnIdentity("proof", "proof:claude-kernel-start"),
});
const kernelInput = (
  overrides: Record<string, unknown> = {},
  startOverrides: Record<string, unknown> = {},
) => ({
  adapterSnapshot: kernelAdapterSnapshot,
  attemptId: kernelAttemptId,
  authorityVectorDigest: kernelAuthorityVectorDigest,
  custodyId: kernelCustodyId,
  effectId: kernelEffectId,
  emit: async (_chunk: { readonly cursor: number; readonly kind: "assistant" | "diagnostic" | "progress"; readonly text: string }) => {},
  intent: { mode: "analysis" as const, prompt: "reply exactly OK" },
  isCancellationRequested: async () => false,
  operationId: kernelOperationId,
  providerAccessSnapshot: {
    accessRef: "access:claude-test",
    credentialBindingDigest: "sha256:credential-test",
    credentialBindingRef: "credential:claude-test",
    credentialGeneration: 1,
    ownerAuthorityDigest: "sha256:provider-access-owner",
    projectId: "project:test",
    provider: "claude" as const,
    providerAccountRef: "account:claude-test",
    providerRouteRef: "route:claude-test",
    revision: 1,
    tenantId: "tenant:test",
  },
  start: {
    createProcess: <Process>(create: () => Process): Process => create(),
    observation: Promise.resolve({ kind: "execution_started" as const, proof: kernelStartProof() }),
    ...startOverrides,
  },
  workspaceId: kernelWorkspaceId,
  ...overrides,
});
const kernelProvider = (
  queryFactory: QueryFactory,
  options: Partial<ConstructorParameters<typeof ClaudeAgentSdkCurrentKernelAdapter>[0]> = {},
) => new ClaudeAgentSdkCurrentKernelAdapter({
  adapterSnapshot: kernelAdapterSnapshot,
  cancellationPollMs: 1,
  executablePath,
  interruptGraceMs: 5,
  manifest: kernelManifest,
  privateExecutions: {
    consume: async (request, consume) => {
      assert.deepEqual(request, {
        attemptId: kernelAttemptId,
        authorityVectorDigest: kernelAuthorityVectorDigest,
        custodyId: kernelCustodyId,
        effectId: kernelEffectId,
        operationId: kernelOperationId,
        workspaceId: kernelWorkspaceId,
      });
      return consume({ privateProjection, workspaceRef });
    },
  },
  processes: { get: () => inertRegistryProcess(), start: () => inertProcess() },
  queryFactory,
  turnTimeoutMs: 100,
  ...options,
});
const spawnedQuery = (
  messages: readonly unknown[],
  onSpawn?: () => void,
): QueryFactory => queryInput => {
  onSpawn?.();
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
    async *[Symbol.asyncIterator]() {for (const message of messages) {yield message;}},
  };
};

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
  assert.doesNotMatch(JSON.stringify(unknown), /legacy-raw-evidence|legacy-(?:acceptance|effect|execution|drain)/u);
});

test("current-kernel adapter streams incrementally and returns SDK logical success after exactly one Host-delegated spawn", async () => {
  let sdkSpawnRequests = 0;
  let hostDelegations = 0;
  let guardianSpawns = 0;
  let firstChunkBeforeTerminal = false;
  const adapter = kernelProvider(spawnedQuery([delta("O"), delta("K"), success("kernel")], () => {sdkSpawnRequests += 1;}), {
    processes: {
      get: () => inertRegistryProcess(),
      start: () => {guardianSpawns += 1; return inertProcess();},
    },
  });
  const outcome = await adapter.execute(kernelInput({
    emit: async () => {firstChunkBeforeTerminal = true;},
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
    errors: ["provider failed"], is_error: true, session_id: "session:failed",
    subtype: "error_during_execution", type: "result", uuid: "result:failed",
  }]));
  assert.deepEqual(await adapter.execute(kernelInput() as never), { kind: "completed", outcome: "failed" });
});

test("current-kernel adapter keeps absent or conflicting spawn evidence indeterminate", async () => {
  const absent = kernelProvider(() => ({
    close: () => {}, interrupt: async () => {},
    async *[Symbol.asyncIterator]() {yield success("without-spawn");},
  }));
  assert.equal((await absent.execute(kernelInput() as never)).kind, "indeterminate");

  let guardianSpawns = 0;
  const conflicting = kernelProvider(queryInput => {
    const spawnInput = {
      args: [...claudeAgentSdkArguments("analysis", workspaceRef)], command: executablePath,
      cwd: workspaceRef, env: { ...privateProjection.environment }, signal: new AbortController().signal,
    };
    queryInput.options.spawnClaudeCodeProcess(spawnInput);
    queryInput.options.spawnClaudeCodeProcess(spawnInput);
    return { close: () => {}, interrupt: async () => {}, async *[Symbol.asyncIterator]() {yield success("twice");} };
  }, {
    processes: {
      get: () => inertRegistryProcess(),
      start: () => {guardianSpawns += 1; return inertProcess();},
    },
  });
  assert.equal((await conflicting.execute(kernelInput() as never)).kind, "indeterminate");
  assert.equal(guardianSpawns, 1);
});

test("current-kernel adapter turns rejected output admission into indeterminate", async () => {
  const adapter = kernelProvider(spawnedQuery([delta("unadmitted"), success("admission")]));
  const outcome = await adapter.execute(kernelInput({
    emit: async () => {throw new Error("owner rejected output");},
  }) as never);
  assert.equal(outcome.kind, "indeterminate");
});

test("current-kernel adapter keeps a late SDK message after terminal indeterminate", async () => {
  const adapter = kernelProvider(spawnedQuery([success("terminal-first"), delta("late")]));
  assert.equal((await adapter.execute(kernelInput() as never)).kind, "indeterminate");
});

test("current-kernel adapter bounds a stuck iterator, cancellation lookup, interrupt and close", async () => {
  let now = 0;
  let interruptCalled = false;
  let closeCalled = false;
  const never = new Promise<void>(() => {});
  const adapter = kernelProvider(queryInput => {
    queryInput.options.spawnClaudeCodeProcess({
      args: [...claudeAgentSdkArguments("analysis", workspaceRef)], command: executablePath,
      cwd: workspaceRef, env: { ...privateProjection.environment }, signal: new AbortController().signal,
    });
    return {
      close: () => {closeCalled = true; return never as never;},
      interrupt: async () => {interruptCalled = true; await never;},
      async *[Symbol.asyncIterator]() {await never;},
    };
  }, {
    cancellationPollMs: 1,
    clock: {
      now: () => now,
      wait: async milliseconds => {now += milliseconds;},
    },
    interruptGraceMs: 2,
    turnTimeoutMs: 3,
  });
  const outcome = await Promise.race([
    adapter.execute(kernelInput({ isCancellationRequested: async () => await never }) as never),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("adapter deadline was not bounded")), 1_000)),
  ]);
  assert.equal(outcome.kind, "indeterminate");
  assert.equal(interruptCalled, false);
  assert.equal(closeCalled, false);
});

test("current-kernel adapter rejects a resolver result produced without its private callback", async () => {
  let guardianSpawns = 0;
  const adapter = kernelProvider(spawnedQuery([success("forged-without-callback")]), {
    privateExecutions: {
      consume: async () => ({ kind: "completed" as const, outcome: "succeeded" as const }),
    },
    processes: {
      get: () => inertRegistryProcess(),
      start: () => {guardianSpawns += 1; return inertProcess();},
    },
  });
  assert.equal((await adapter.execute(kernelInput() as never)).kind, "indeterminate");
  assert.equal(guardianSpawns, 0);
});

test("current-kernel adapter rejects two private callback invocations even when the resolver substitutes the first result", async () => {
  let guardianSpawns = 0;
  const adapter = kernelProvider(spawnedQuery([success("double-private-callback")]), {
    privateExecutions: {
      consume: async (_request, consume) => {
        const first = await consume({ privateProjection, workspaceRef });
        try {await consume({ privateProjection, workspaceRef });} catch {}
        return first;
      },
    },
    processes: {
      get: () => inertRegistryProcess(),
      start: () => {guardianSpawns += 1; return inertProcess();},
    },
  });
  assert.equal((await adapter.execute(kernelInput() as never)).kind, "indeterminate");
  assert.equal(guardianSpawns, 1);
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
    const observation = new Promise<never>((_resolve, reject) => {rejectObservation = reject;});
    const adapter = kernelProvider(spawnedQuery([success("rejected-start-observation")]), {
      clock,
      processes: {
        get: () => inertRegistryProcess(),
        start: () => {guardianSpawns += 1; return inertProcess();},
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
        start: () => {guardianSpawns += 1; return inertProcess();},
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
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("start observation was not bounded")), 1_000)),
    ]);
    assert.equal(outcome.kind, "indeterminate");
    assert.equal(guardianSpawns, 1);
  });
});

test("current-kernel adapter rejects a start observation delivered after the original absolute turn deadline", async () => {
  const clock = new ManualClock();
  let guardianSpawns = 0;
  let resolveObservation: ((value: { readonly kind: "execution_started"; readonly proof: ReturnType<typeof kernelStartProof> }) => void) | undefined;
  const observation = new Promise<{ readonly kind: "execution_started"; readonly proof: ReturnType<typeof kernelStartProof> }>(resolve => {
    resolveObservation = resolve;
  });
  const adapter = kernelProvider(spawnedQuery([success("late-start-observation")]), {
    clock,
    processes: {
      get: () => inertRegistryProcess(),
      start: () => {guardianSpawns += 1; return inertProcess();},
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
  const mutableOptions = {
    adapterSnapshot: kernelAdapterSnapshot,
    cancellationPollMs: 1,
    executablePath,
    interruptGraceMs: 5,
    manifest: kernelManifest,
    privateExecutions: {
      consume: async (_request: unknown, consume: (execution: { privateProjection: typeof privateProjection; workspaceRef: string }) => Promise<unknown>) => {
        originalResolverCalls += 1;
        return consume({ privateProjection, workspaceRef });
      },
    },
    processes: { get: () => inertRegistryProcess(), start: () => inertProcess() },
    queryFactory: spawnedQuery([success("snapshotted-options")]),
    turnTimeoutMs: 100,
  };
  const adapter = new ClaudeAgentSdkCurrentKernelAdapter(mutableOptions);
  mutableOptions.privateExecutions = {
    consume: async () => {
      replacementResolverCalls += 1;
      return { kind: "completed", outcome: "succeeded" };
    },
  };
  mutableOptions.queryFactory = () => {throw new Error("mutated query factory must not run");};
  assert.deepEqual(await adapter.execute(kernelInput() as never), { kind: "completed", outcome: "succeeded" });
  assert.deepEqual([originalResolverCalls, replacementResolverCalls], [1, 0]);
});
