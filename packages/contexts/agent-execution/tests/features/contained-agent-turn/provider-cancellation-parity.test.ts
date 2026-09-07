import assert from "node:assert/strict";
import { test } from "node:test";

import { emitTurnStarted, generatedTurn } from "../../codex-app-server-test-messages.mjs";
import {
  FakeCodexProcess,
  createProvider as createCodexProvider,
  executeInput as codexExecuteInput,
  standardHandshake,
} from "../../codex-app-server-contained-turn-provider-fixture.ts";
import {
  ManualClock,
  input as claudeInput,
  provider as createClaudeProvider,
  waitFor,
} from "../../claude-agent-sdk-contained-turn-provider.support.ts";

// Both fixtures run the same shape of scenario: a caller requests cancellation
// while the provider turn is still in flight, and the adapter observes the
// request and forwards an interrupt. Codex's App Server exposes a distinct
// interrupted terminal state; the Claude Agent SDK does not, so the two
// adapters cannot converge on the same product-level outcome for this case.
// This is the accepted carve-out recorded in
// docs/architecture/contained-agent-turn-v1-delivery-plan.md ("Required
// tests"): Codex closes `completed`/`cancelled`, Claude closes `ambiguous`
// (product status `reconcile_required`), never `cancelled`.

test("Codex observes durable cancellation as a completed cancelled outcome", async () => {
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) { return; }
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:parity-cancel", "inProgress") } });
      emitTurnStarted(target, "turn:parity-cancel");
    }
    if (message.method === "turn/interrupt") {
      target.emit({ id: message.id, result: {} });
      target.emit({
        method: "turn/completed",
        params: { threadId: "thread:test", turn: generatedTurn("turn:parity-cancel", "interrupted") },
      });
    }
  });
  const outcome = await createCodexProvider(process).execute(codexExecuteInput(process, async () => true));
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {
    assert.equal(outcome.outcome, "cancelled");
  }
});

test("Claude never produces a cancelled outcome for the same cancel-during-stream scenario", async () => {
  const clock = new ManualClock();
  let started = false;
  let interrupted = false;
  let drained = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const adapter = createClaudeProvider(() => ({
    close: () => {},
    interrupt: async () => { interrupted = true; release(); },
    async *[Symbol.asyncIterator]() {
      started = true;
      await gate;
      yield* [];
      drained = true;
    },
  }), { clock });
  const outcomePromise = adapter.execute({ ...claudeInput(), isCancellationRequested: async () => true });
  await waitFor(() => started);
  clock.advance(1);
  const outcome = await outcomePromise;
  assert.equal(interrupted, true);
  assert.equal(drained, true);

  // Structural proof, not just a value check: only the "completed" outcome
  // kind carries an "outcome" field at all, so an "ambiguous" outcome can
  // never read as "cancelled" -- the SDK gives the adapter no channel to
  // report it, unlike Codex above.
  assert.equal(outcome.kind, "ambiguous");
  assert.equal("outcome" in outcome, false);
});
