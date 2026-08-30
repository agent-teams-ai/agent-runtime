import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeAgentSdkContainedTurnProvider } from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-contained-turn-provider.js";
import {
  claudeAgentSdkArguments,
  createClaudeAgentSdkEnvironment,
  createClaudeAgentSdkLaunchPlan,
} from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import type { CustodiedProviderProcess, CustodiedSdkProcess } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";

const workspaceRef = "/tmp/agent-runtime-claude-contained-turn";
const executablePath = "/synthetic/claude";
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
  exitCode: null,
  kill: () => true,
  killed: false,
  off: () => {},
  on: () => {},
  once: () => {},
  signalCode: null,
  stdin: undefined as never,
  stdout: undefined as never,
});

const inertRegistryProcess = (): CustodiedProviderProcess => ({
  closeInput: async () => {},
  custodyRef: "custody:claude-test",
  stderr: { async *[Symbol.asyncIterator]() {} },
  stdout: { async *[Symbol.asyncIterator]() {} },
  waitForExit: async () => ({ code: 0, signal: null }),
  write: async () => {},
});

test("exact Claude SDK 0.3.251 arguments match the delegated Host Custody authority", async () => {
  for (const mode of ["analysis", "workspace-write"] as const) {
    let captured: {
      readonly arguments: readonly string[];
      readonly command: string;
      readonly cwd: string | undefined;
      readonly environment: Readonly<Record<string, string | undefined>>;
    } | undefined;
    const provider = new ClaudeAgentSdkContainedTurnProvider({
      executablePath,
      manifest,
      processes: {
        get: () => {},
        start(_custodyRef, sdkInput) {
          captured = sdkInput;
          throw new Error("synthetic stop before process start");
        },
      },
    });
    const outcome = await provider.execute(input(mode));
    assert.equal(outcome.kind, "not_accepted");
    assert.ok(captured);
    assert.equal(captured.command, executablePath);
    assert.equal(captured.cwd, workspaceRef);
    assert.deepEqual(captured.arguments, claudeAgentSdkArguments(mode, workspaceRef));
    assert.deepEqual(captured.environment, createClaudeAgentSdkEnvironment(workspaceRef));

    const plan = createClaudeAgentSdkLaunchPlan({
      binaryRevision: binding.binaryRevision,
      environment: createClaudeAgentSdkEnvironment(workspaceRef),
      executablePath,
      executableSha256: "0".repeat(64),
      workspaceRef,
    });
    assert.ok(plan.delegatedArgumentVariants?.some(variant => JSON.stringify(variant) === JSON.stringify(captured?.arguments)));
  }
});

test("streams one successful Claude result through the provider-neutral contract", async () => {
  let started = false;
  let closed = false;
  const output: string[] = [];
  const provider = new ClaudeAgentSdkContainedTurnProvider({
    cancellationPollMs: 1,
    executablePath,
    interruptGraceMs: 5,
    manifest,
    processes: {
      get: () => started ? inertRegistryProcess() : undefined,
      start(_custodyRef, sdkInput) {
        assert.deepEqual(sdkInput.arguments, claudeAgentSdkArguments("analysis", workspaceRef));
        started = true;
        return inertProcess();
      },
    },
    queryFactory(queryInput) {
      queryInput.options.spawnClaudeCodeProcess({
        args: [...claudeAgentSdkArguments("analysis", workspaceRef)],
        command: executablePath,
        cwd: workspaceRef,
        env: { ...createClaudeAgentSdkEnvironment(workspaceRef) },
        signal: new AbortController().signal,
      });
      return {
        close: () => {closed = true;},
        interrupt: async () => {},
        async *[Symbol.asyncIterator]() {
          yield {
            event: { delta: { text: "OK", type: "text_delta" }, type: "content_block_delta" },
            parent_tool_use_id: null,
            type: "stream_event",
          };
          yield { is_error: false, result: "OK", session_id: "session:one", subtype: "success", type: "result", uuid: "result:one" };
        },
      };
    },
    turnTimeoutMs: 1_000,
  });
  const outcome = await provider.execute({
    ...input(),
    emit: async chunk => {output.push(chunk.text);},
  });
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {assert.equal(outcome.outcome, "succeeded");}
  assert.deepEqual(output, ["OK"]);
  assert.equal(started, true);
  assert.equal(closed, true);
});

test("uses the SDK interrupt path for durable cancellation", async () => {
  let release: (() => void) | undefined;
  let interrupted = false;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const provider = new ClaudeAgentSdkContainedTurnProvider({
    cancellationPollMs: 1,
    executablePath,
    interruptGraceMs: 20,
    manifest,
    processes: {
      get: () => inertRegistryProcess(),
      start: () => inertProcess(),
    },
    queryFactory(queryInput) {
      queryInput.options.spawnClaudeCodeProcess({
        args: [...claudeAgentSdkArguments("analysis", workspaceRef)],
        command: executablePath,
        cwd: workspaceRef,
        env: { ...createClaudeAgentSdkEnvironment(workspaceRef) },
        signal: new AbortController().signal,
      });
      return {
        close: () => {},
        interrupt: async () => {interrupted = true; release?.();},
        async *[Symbol.asyncIterator]() {
          await gate;
          yield { errors: ["interrupted"], is_error: true, session_id: "session:cancel", subtype: "error_during_execution", type: "result", uuid: "result:cancel" };
        },
      };
    },
    turnTimeoutMs: 1_000,
  });
  const outcome = await provider.execute({ ...input(), isCancellationRequested: async () => true });
  assert.equal(interrupted, true);
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {assert.equal(outcome.outcome, "cancelled");}
});

test("treats a missing Claude terminal result as ambiguous", async () => {
  const provider = new ClaudeAgentSdkContainedTurnProvider({
    executablePath,
    manifest,
    processes: { get: () => inertRegistryProcess(), start: () => inertProcess() },
    queryFactory: () => ({
      close: () => {},
      interrupt: async () => {},
      async *[Symbol.asyncIterator]() {yield { type: "system" };},
    }),
  });
  assert.equal((await provider.execute(input())).kind, "ambiguous");
});
