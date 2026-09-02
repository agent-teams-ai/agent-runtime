import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CodexAppServerContainedTurnProvider,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.js";
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

type OutputChunk = { readonly cursor: number; readonly kind: string; readonly text: string };

const assertContainmentRequired = (
  outcome: Awaited<ReturnType<CodexAppServerContainedTurnProvider["execute"]>>,
): void => {
  assert.equal(outcome.kind, "ambiguous");
  assert.equal("containmentRequired" in outcome && outcome.containmentRequired, true);
  assert.equal("integrationRequired" in outcome && outcome.integrationRequired,
    "kernel-custody-containment-reconciliation/v1");
  assert.equal("outputDrainProven" in outcome && outcome.outputDrainProven, false);
};

const executeAssistantItems = async (
  turnId: string,
  texts: readonly string[],
  sensitiveOutputTokens: readonly string[] = [],
  firstItemDeltaBoundary?: number,
) => {
  const output: OutputChunk[] = [];
  const items = texts.map((text, index) => agentMessage(`item:${index}`, text));
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method !== "turn/start") {return;}
    target.emit({ id: message.id, result: { turn: generatedTurn(turnId, "inProgress") } });
    emitTurnStarted(target, turnId);
    for (const [index, item] of items.entries()) {
      emitAgentStarted(target, turnId, item.id);
      const deltas = index === 0 && firstItemDeltaBoundary !== undefined
        ? [item.text.slice(0, firstItemDeltaBoundary), item.text.slice(firstItemDeltaBoundary)]
        : [item.text];
      for (const delta of deltas) {
        target.emit({ method: "item/agentMessage/delta", params: {
          delta, itemId: item.id, threadId: "thread:test", turnId,
        } });
      }
      emitAgentCompleted(target, turnId, item.id, item.text);
    }
    target.emit({ method: "turn/completed", params: {
      threadId: "thread:test", turn: generatedTurn(turnId, "completed", null, items),
    } });
  });
  const provider = new CodexAppServerContainedTurnProvider({
    boundary, manifest, privateRootPath: syntheticPrivateRoot, processes: { get: () => process },
    sensitiveOutputTokens, tmpDir: syntheticTmp,
  });
  const outcome = await provider.execute({
    ...executeInput(process), emit: async chunk => {output.push(chunk);},
  });
  return { outcome, output };
};

test("fails closed when a credential marker is the only sensitive assistant value", async () => {
  const credential = "CREDENTIAL_MARKER<synthetic-only-sensitive-value>";
  const evidence = await executeAssistantItems("turn:credential-marker", [credential]);
  assertContainmentRequired(evidence.outcome);
  assert.deepEqual(evidence.output, []);
  assert.equal(JSON.stringify(evidence).includes(credential), false);
});

test("fails closed when a credential marker spans assistant deltas", async () => {
  const credential = "CREDENTIAL_MARKER<synthetic-delta-boundary>";
  const evidence = await executeAssistantItems("turn:credential-marker-delta", [credential], [], 13);
  assertContainmentRequired(evidence.outcome);
  assert.deepEqual(evidence.output, []);
  assert.equal(JSON.stringify(evidence).includes(credential), false);
});

test("fails closed when a credential marker spans completed assistant items", async () => {
  const credential = "CREDENTIAL_MARKER<synthetic-split-boundary>";
  const splitAt = 11;
  const evidence = await executeAssistantItems("turn:credential-marker-split", [
    "ordinary assistant text\n",
    credential.slice(0, splitAt),
    credential.slice(splitAt),
  ]);
  assertContainmentRequired(evidence.outcome);
  assert.deepEqual(evidence.output, [{ cursor: 0, kind: "assistant", text: "ordinary assistant text\n" }]);
  assert.equal(JSON.stringify(evidence).includes(credential), false);
});

test("fails closed when an OpenAI credential shape spans assistant items", async () => {
  const credential = "sk-proj_0123456789abcdefghijklmnop";
  const evidence = await executeAssistantItems("turn:credential-shape-split", [
    credential.slice(0, 9), credential.slice(9),
  ]);
  assertContainmentRequired(evidence.outcome);
  assert.deepEqual(evidence.output, []);
  assert.equal(JSON.stringify(evidence).includes(credential), false);
});

test("preserves ordinary assistant output around credential-like prose", async () => {
  const text = "Use a placeholder such as sk-short in analysis";
  const evidence = await executeAssistantItems("turn:ordinary-output", [text]);
  assert.equal(evidence.outcome.kind, "completed");
  assert.equal(evidence.output.map(chunk => chunk.text).join(""), text);
  assert.deepEqual(evidence.output.map(chunk => chunk.cursor), [0, 1]);
});

test("redacts a sensitive token split across separate completed assistant items at the canonical sink", async () => {
  const privateSecret = "AR_PRIVATE_SPLIT_SENTINEL_1f82";
  const firstText = `valid assistant text\n${privateSecret.slice(0, 16)}`;
  const secondText = privateSecret.slice(16);
  const evidence = await executeAssistantItems("turn:split", [firstText, secondText], [privateSecret]);
  assertContainmentRequired(evidence.outcome);
  assert.deepEqual(evidence.output, [{ cursor: 0, kind: "assistant", text: "valid assistant text\n" }]);
  assert.equal(JSON.stringify(evidence).includes(privateSecret), false);
});

test("redacts the launch-authorized private root itself from the canonical sink", async () => {
  const splitAt = Math.floor(syntheticPrivateRoot.length / 2);
  const evidence = await executeAssistantItems("turn:private-root", [
    "public assistant chunk", syntheticPrivateRoot.slice(0, splitAt), syntheticPrivateRoot.slice(splitAt),
  ]);
  assertContainmentRequired(evidence.outcome);
  assert.deepEqual(evidence.output, [{ cursor: 0, kind: "assistant", text: "public assistant chunk" }]);
  assert.equal(JSON.stringify(evidence).includes(syntheticPrivateRoot), false);
});

test("retains overlapping token prefixes and discards a terminal prefix with deterministic cursors", async () => {
  const evidence = await executeAssistantItems("turn:prefixes", ["alphaAB", "XbetaB", "YomegaABC"], [
    "ABCD", "BCD", "!",
  ]);
  assert.equal(evidence.outcome.kind, "completed");
  assert.deepEqual(evidence.output, [
    { cursor: 0, kind: "assistant", text: "alpha" },
    { cursor: 1, kind: "assistant", text: "ABXbeta" },
    { cursor: 2, kind: "assistant", text: "BYomega" },
  ]);
  const process = new FakeCodexProcess(() => {});
  assert.throws(() => new CodexAppServerContainedTurnProvider({
    boundary, manifest, privateRootPath: syntheticPrivateRoot, processes: { get: () => process },
    sensitiveOutputTokens: [""], tmpDir: syntheticTmp,
  }), /bounded non-empty string/u);
});
