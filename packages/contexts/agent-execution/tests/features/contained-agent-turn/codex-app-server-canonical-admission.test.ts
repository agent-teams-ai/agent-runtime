import assert from "node:assert/strict";
import test from "node:test";
import { createCodexActiveTurnProgress, handleCodexActiveMessage } from "../../../src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-active-turn.ts";
import { agentMessage, generatedTurn } from "../../codex-app-server-test-messages.mjs";
import { boundary, executeInput, FakeCodexProcess } from "../../codex-app-server-contained-turn-provider-fixture.ts";

const fixture = () => {
  const output: unknown[] = [];
  const progress = createCodexActiveTurnProgress();
  const emitInput = { ...executeInput(new FakeCodexProcess(() => {})), emit: async (chunk: unknown) => { output.push(chunk); } };
  const send = (method: string, params: Record<string, unknown>) => handleCodexActiveMessage({
    boundary, emitInput, maxNotificationBytes: 16_777_216, maxNotifications: 16_384,
    message: { method, params }, mode: "analysis", observeProtocolTerminal: () => {},
    outputPolicy: { exactSensitiveTokens: [], privatePaths: [], privatePathPlatform: "linux" },
    progress, threadId: "thread:test", turnId: "turn:admission",
  });
  const item = (method: string, value: Record<string, unknown>) => send(method, {
    item: value, threadId: "thread:test", turnId: "turn:admission",
    ...(method === "item/started" ? { startedAtMs: 1 } : { completedAtMs: 2 }),
  });
  return { output, send, item };
};

test("Codex completed assistant and passive items remain private until full terminal reconciliation", async () => {
  const { output, send, item } = fixture();
  await send("turn/started", { threadId: "thread:test", turn: generatedTurn("turn:admission", "inProgress") });
  await item("item/started", agentMessage("assistant", ""));
  await send("item/agentMessage/delta", { delta: "ordinary output", itemId: "assistant", threadId: "thread:test", turnId: "turn:admission" });
  assert.deepEqual(output, []);
  const assistant = agentMessage("assistant", "ordinary output");
  await item("item/completed", assistant);
  assert.deepEqual(output, []);
  await item("item/started", { id: "plan", type: "plan", text: "" });
  await send("item/plan/delta", { delta: "private plan", itemId: "plan", threadId: "thread:test", turnId: "turn:admission" });
  const plan = { id: "plan", type: "plan", text: "private plan" };
  await item("item/completed", plan);
  assert.deepEqual(output, []);
  await send("turn/completed", { threadId: "thread:test", turn: generatedTurn("turn:admission", "completed", null, [assistant, plan]) });
  assert.deepEqual(output, [{ cursor: 0, kind: "assistant", text: "ordinary output" }]);
});

test("Codex terminal item substitution cannot leak previously completed assistant text", async () => {
  const { output, send, item } = fixture();
  await send("turn/started", { threadId: "thread:test", turn: generatedTurn("turn:admission", "inProgress") });
  await item("item/started", agentMessage("assistant", ""));
  await send("item/agentMessage/delta", { delta: "ordinary output", itemId: "assistant", threadId: "thread:test", turnId: "turn:admission" });
  await item("item/completed", agentMessage("assistant", "ordinary output"));
  await assert.rejects(send("turn/completed", { threadId: "thread:test", turn: generatedTurn("turn:admission", "completed", null, [agentMessage("assistant", "substituted")]) }));
  assert.deepEqual(output, []);
});
