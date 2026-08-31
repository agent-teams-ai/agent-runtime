import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT,
  CodexAppServerCurrentKernelAdapter,
} from "../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import {
  FakeCodexProcess,
  boundary,
  createProvider,
  rejectInitialize,
  standardHandshake,
} from "./codex-app-server-contained-turn-provider-fixture.ts";
import {
  agentMessage,
  emitAgentCompleted,
  emitAgentStarted,
  emitTurnStarted,
  generatedTurn,
} from "./codex-app-server-test-messages.mjs";

const providerAccessSnapshot = Object.freeze({
  accessRef: "access:codex:test",
  credentialBindingDigest: "credential:test" as ReturnType<typeof digestContainedTurnCanonicalValue>,
  credentialBindingRef: "credential-binding:codex:test",
  credentialGeneration: 1,
  ownerAuthorityDigest: "provider-access-authority:codex:test",
  projectId: "project:codex:test",
  provider: "codex" as const,
  providerAccountRef: "account:codex:test",
  providerRouteRef: "provider-route:test",
  revision: 1,
  tenantId: "tenant:codex:test",
});

const kernelInput = (
  process: FakeCodexProcess,
  cancellation: () => Promise<boolean> = async () => false,
) => {
  let delegatedStarts = 0;
  const output: { readonly cursor: number; readonly kind: string; readonly text: string }[] = [];
  const input = {
    adapterSnapshot: CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT,
    attemptId: containedTurnIdentity("attempt", "attempt:codex:kernel:test"),
    authorityVectorDigest: digestContainedTurnCanonicalValue({ authority: "codex:kernel:test" }),
    custodyId: containedTurnIdentity("custody", process.custodyRef),
    effectId: containedTurnIdentity("effect", "effect:codex:kernel:test"),
    emit: async (chunk: { readonly cursor: number; readonly kind: "assistant" | "diagnostic" | "progress"; readonly text: string }) => {
      output.push(chunk);
    },
    intent: Object.freeze({ mode: "analysis" as const, prompt: "Inspect only this disposable workspace." }),
    isCancellationRequested: cancellation,
    operationId: containedTurnIdentity("operation", "operation:codex:kernel:test"),
    providerAccessSnapshot,
    start: {
      createProcess<Process>(createProcess: () => Process): Process {
        delegatedStarts += 1;
        return createProcess();
      },
      observation: Promise.resolve({
        evidenceId: containedTurnIdentity("evidence", "evidence:codex:synthetic-start"),
        kind: "indeterminate" as const,
      }),
    },
    workspaceId: containedTurnIdentity("workspace", "workspace:codex:opaque:test"),
  };
  return { delegatedStarts: () => delegatedStarts, input, output };
};

const createAdapter = (process: FakeCodexProcess, onPrepare?: () => void) =>
  new CodexAppServerCurrentKernelAdapter({
    attempts: {
      async prepare(input) {
        onPrepare?.();
        assert.equal(input.workspaceId, "workspace:codex:opaque:test");
        return {
          createProcess: () => ({
            custody: { custodyRef: process.custodyRef },
            provider: createProvider(process),
            workspaceRef: boundary.workspaceRef,
          }),
        };
      },
    },
  });

test("admits incremental output and success only from the reviewed protocol terminal", async () => {
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:kernel:success", "inProgress") } });
      emitTurnStarted(target, "turn:kernel:success");
      emitAgentStarted(target, "turn:kernel:success", "item:kernel:success");
      target.emit({ method: "item/agentMessage/delta", params: {
        delta: "bounded", itemId: "item:kernel:success", threadId: "thread:test", turnId: "turn:kernel:success",
      } });
      emitAgentCompleted(target, "turn:kernel:success", "item:kernel:success", "bounded");
      target.emit({ method: "turn/completed", params: {
        threadId: "thread:test",
        turn: generatedTurn("turn:kernel:success", "completed", null,
          [agentMessage("item:kernel:success", "bounded")]),
      } });
    }
  });
  const execution = kernelInput(process);
  assert.deepEqual(await createAdapter(process).execute(execution.input), {
    kind: "completed", outcome: "succeeded",
  });
  assert.deepEqual(execution.output, [{ cursor: 0, kind: "assistant", text: "bounded" }]);
  assert.equal(execution.delegatedStarts(), 1);
});

test("maps validated failed and cancelled terminals without exit-code inference", async () => {
  const failure = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:kernel:failed", "inProgress") } });
      emitTurnStarted(target, "turn:kernel:failed");
      target.emit({ method: "turn/completed", params: {
        threadId: "thread:test",
        turn: generatedTurn("turn:kernel:failed", "failed", {
          additionalDetails: null, codexErrorInfo: null, message: "synthetic failure",
        }),
      } });
    }
  });
  const failedExecution = kernelInput(failure);
  assert.deepEqual(await createAdapter(failure).execute(failedExecution.input), {
    kind: "completed", outcome: "failed",
  });
  assert.equal(failedExecution.delegatedStarts(), 1);

  const cancelled = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:kernel:cancelled", "inProgress") } });
      emitTurnStarted(target, "turn:kernel:cancelled");
    }
    if (message.method === "turn/interrupt") {
      target.emit({ id: message.id, result: {} });
      target.emit({ method: "turn/completed", params: {
        threadId: "thread:test", turn: generatedTurn("turn:kernel:cancelled", "interrupted"),
      } });
    }
  });
  const cancelledExecution = kernelInput(cancelled, async () => true);
  assert.deepEqual(await createAdapter(cancelled).execute(cancelledExecution.input), {
    kind: "completed", outcome: "cancelled",
  });
  assert.equal(cancelledExecution.delegatedStarts(), 1);
});

test("keeps missing, not-accepted, and unknown terminal evidence indeterminate with no retry", async () => {
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ error: { code: -32_000, message: "synthetic rejection" }, id: message.id });
    }
  });
  const execution = kernelInput(process);
  const outcome = await createAdapter(process).execute(execution.input);
  assert.equal(outcome.kind, "indeterminate");
  assert.equal(execution.delegatedStarts(), 1);
  assert.equal(process.requests.filter(message => message.method === "turn/start").length, 1);

  const notAccepted = new FakeCodexProcess(rejectInitialize);
  const notAcceptedExecution = kernelInput(notAccepted);
  assert.equal((await createAdapter(notAccepted).execute(notAcceptedExecution.input)).kind, "indeterminate");
  assert.equal(notAcceptedExecution.delegatedStarts(), 1);
  assert.equal(notAccepted.requests.filter(message => message.method === "turn/start").length, 0);
});

test("keeps stale, late, and conflicting terminal output indeterminate", async () => {
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:kernel:late", "inProgress") } });
      emitTurnStarted(target, "turn:kernel:late");
      target.emit({ method: "turn/completed", params: {
        threadId: "thread:test", turn: generatedTurn("turn:kernel:late", "completed"),
      } });
      target.emit({ method: "turn/completed", params: {
        threadId: "thread:test",
        turn: generatedTurn("turn:kernel:late", "failed", {
          additionalDetails: null, codexErrorInfo: null, message: "late conflicting terminal",
        }),
      } });
    }
  });
  const execution = kernelInput(process);
  assert.equal((await createAdapter(process).execute(execution.input)).kind, "indeterminate");
  assert.deepEqual(execution.output, []);
  assert.equal(execution.delegatedStarts(), 1);
});

test("rejects mismatched current-kernel and prepared-attempt identities", async () => {
  const process = new FakeCodexProcess(() => {});
  let preparations = 0;
  const mismatch = kernelInput(process);
  const authorityOutcome = await createAdapter(process, () => {preparations += 1;}).execute({
    ...mismatch.input,
    adapterSnapshot: { ...CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT, binaryRevision: "binary:substituted" },
  });
  assert.equal(authorityOutcome.kind, "indeterminate");
  assert.equal(preparations, 0);
  assert.equal(mismatch.delegatedStarts(), 0);

  const prepared = kernelInput(process);
  const adapter = new CodexAppServerCurrentKernelAdapter({
    attempts: {
      async prepare() {
        return {
          createProcess: () => ({
            custody: { custodyRef: "custody:substituted" },
            provider: createProvider(process),
            workspaceRef: boundary.workspaceRef,
          }),
        };
      },
    },
  });
  assert.equal((await adapter.execute(prepared.input)).kind, "indeterminate");
  assert.equal(prepared.delegatedStarts(), 1);
  assert.equal(process.requests.length, 0);
});
