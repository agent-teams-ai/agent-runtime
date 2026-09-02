import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CodexAppServerContainedTurnProvider,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.js";
import {
  applyCodexPassiveItemNotification,
  createCodexItemTextSegments,
  materializeCodexItemText,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-thread-item-lifecycle.js";
import {
  CodexAppServerTextSegments,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-text-segments.js";
import { agentMessage, emitAgentCompleted, emitAgentStarted, emitTurnStarted, generatedTurn } from "../../codex-app-server-test-messages.mjs";
import {
  FakeCodexProcess,
  boundary,
  executeInput,
  manifest,
  standardHandshake,
  syntheticPrivateRoot,
  syntheticTmp,
} from "../../codex-app-server-contained-turn-provider-fixture.ts";

const MAX_BYTES = 16_777_216;
const MAX_NOTIFICATIONS = 16_384;
const FRAGMENTS = 4_096;

type Admitted = Parameters<typeof createCodexItemTextSegments>[0];

const active = (type: string, item: Record<string, unknown>): Admitted => ({
  endpointObservations: [], id: String(item.id), item, type,
});

const progress = (item: Admitted, accumulation: NonNullable<ReturnType<typeof createCodexItemTextSegments>>) => ({
  activeItems: new Map([[item.id, item]]), itemTextSegments: new Map([[item.id, accumulation]]),
});

test("plan, command, and reasoning deltas materialize once after high fragment counts", () => {
  const plan = active("plan", {id: "plan", text: "", type: "plan"});
  const planText = createCodexItemTextSegments(plan, MAX_BYTES, MAX_NOTIFICATIONS);
  assert.ok(planText);
  for (let index = 0; index < FRAGMENTS; index += 1) {
    applyCodexPassiveItemNotification("item/plan/delta", {delta: "p", itemId: plan.id},
      progress(plan, planText), boundary);
  }
  const planSegments = planText.fields.get("text");
  assert.equal(planSegments?.materializationCount, 0);
  materializeCodexItemText(plan, planText);
  assert.equal(plan.item.text, "p".repeat(FRAGMENTS));
  assert.equal(planSegments?.materializationCount, 1);

  const command = active("commandExecution", {
    aggregatedOutput: "", id: "command", type: "commandExecution",
  });
  const commandText = createCodexItemTextSegments(command, MAX_BYTES, MAX_NOTIFICATIONS);
  assert.ok(commandText);
  for (let index = 0; index < FRAGMENTS; index += 1) {
    applyCodexPassiveItemNotification("item/commandExecution/outputDelta", {delta: "c", itemId: command.id},
      progress(command, commandText), boundary);
  }
  const commandSegments = commandText.fields.get("aggregatedOutput");
  materializeCodexItemText(command, commandText);
  assert.equal(command.item.aggregatedOutput, "c".repeat(FRAGMENTS));
  assert.equal(commandSegments?.materializationCount, 1);

  const reasoning = active("reasoning", {content: [], id: "reasoning", summary: [], type: "reasoning"});
  const reasoningText = createCodexItemTextSegments(reasoning, MAX_BYTES, MAX_NOTIFICATIONS);
  assert.ok(reasoningText);
  const reasoningProgress = progress(reasoning, reasoningText);
  applyCodexPassiveItemNotification("item/reasoning/summaryPartAdded",
    {itemId: reasoning.id, summaryIndex: 0}, reasoningProgress, boundary);
  for (let index = 0; index < FRAGMENTS; index += 1) {
    applyCodexPassiveItemNotification("item/reasoning/summaryTextDelta",
      {delta: "s", itemId: reasoning.id, summaryIndex: 0}, reasoningProgress, boundary);
    applyCodexPassiveItemNotification("item/reasoning/textDelta",
      {contentIndex: 0, delta: "r", itemId: reasoning.id}, reasoningProgress, boundary);
  }
  const summarySegments = reasoningText.fields.get("summary:0");
  const contentSegments = reasoningText.fields.get("content:0");
  materializeCodexItemText(reasoning, reasoningText);
  assert.deepEqual(reasoning.item.summary, ["s".repeat(FRAGMENTS)]);
  assert.deepEqual(reasoning.item.content, ["r".repeat(FRAGMENTS)]);
  assert.equal(summarySegments?.materializationCount, 1);
  assert.equal(contentSegments?.materializationCount, 1);
});

test("assistant item and whole turn each materialize exactly once at high fragment count", async () => {
  const text = "x".repeat(FRAGMENTS);
  const item = agentMessage("item:linear", text);
  const materializedChunkCounts: number[] = [];
  const original = CodexAppServerTextSegments.prototype.materialize;
  CodexAppServerTextSegments.prototype.materialize = function materialize(): string {
    materializedChunkCounts.push(this.chunkCount);
    return original.call(this);
  };
  try {
    const process = new FakeCodexProcess((message, target) => {
      if (standardHandshake(message, target) || message.method !== "turn/start") {return;}
      target.emit({id: message.id, result: {turn: generatedTurn("turn:linear", "inProgress")}});
      emitTurnStarted(target, "turn:linear");
      emitAgentStarted(target, "turn:linear", item.id);
      for (let index = 0; index < FRAGMENTS; index += 1) {
        target.emit({method: "item/agentMessage/delta", params: {
          delta: "x", itemId: item.id, threadId: "thread:test", turnId: "turn:linear",
        }});
      }
      emitAgentCompleted(target, "turn:linear", item.id, text);
      target.emit({method: "turn/completed", params: {
        threadId: "thread:test", turn: generatedTurn("turn:linear", "completed", null, [item]),
      }});
    });
    const output: string[] = [];
    const provider = new CodexAppServerContainedTurnProvider({
      boundary, manifest, privateRootPath: syntheticPrivateRoot, processes: {get: () => process}, tmpDir: syntheticTmp,
    });
    const outcome = await provider.execute({...executeInput(process), emit: async chunk => {output.push(chunk.text);}});
    assert.equal(outcome.kind, "completed");
    assert.deepEqual(output, [text]);
    assert.deepEqual(materializedChunkCounts, [FRAGMENTS, 1]);
  } finally {
    CodexAppServerTextSegments.prototype.materialize = original;
  }
});
