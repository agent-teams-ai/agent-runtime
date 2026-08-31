import assert from "node:assert/strict";
import test from "node:test";

import {
  ManualClock,
  delta,
  input,
  nextTurn,
  provider,
  success,
  waitFor,
} from "./claude-agent-sdk-contained-turn-provider.support.ts";

test("abandons a never-settling cancellation lookup when the iterator closes", async () => {
  const clock = new ManualClock();
  let iteratorStarted = false;
  let lookupStarted = false;
  let releaseIterator: (() => void) | undefined;
  const iteratorGate = new Promise<void>(resolve => { releaseIterator = resolve; });
  const adapter = provider(() => ({
    close: () => {},
    interrupt: async () => {},
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
  if (outcome.kind === "completed") {
    assert.equal(outcome.outcome, "succeeded");
  }
});

test("a never-settling emit is abandoned at the turn deadline and cannot manufacture closure later", async () => {
  const clock = new ManualClock();
  let emitStarted = false;
  let lateEmitCompleted = false;
  let releaseEmit: (() => void) | undefined;
  const emitGate = new Promise<void>(resolve => { releaseEmit = resolve; });
  const adapter = provider(() => ({
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() { yield delta("UNPROVEN_OUTPUT"); yield success("emit-timeout"); },
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
  const iteratorGate = new Promise<void>(resolve => { releaseIterator = resolve; });
  const adapter = provider(() => ({
    close: () => { closeCalled = true; releaseIterator?.(); },
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
  assert.equal((await outcomePromise).kind, "ambiguous");
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
    async *[Symbol.asyncIterator]() { yield success("close-timeout"); },
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
  const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
  const adapter = provider(() => ({
    close: () => {
      closeCalled = true;
      return closeGate;
    },
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() { yield success("late-close-settlement"); },
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
    close: () => { closeCalled = true; },
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
  const iteratorGate = new Promise<void>(resolve => { releaseIterator = resolve; });
  const adapter = provider(() => ({
    close: () => { closeCalled = true; releaseIterator?.(); },
    interrupt: async () => { interruptCalled = true; },
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
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          iteratorStarted = true;
          await new Promise<void>(() => {});
          return { done: true as const };
        },
      };
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
  const iteratorGate = new Promise<void>(resolve => { releaseIterator = resolve; });
  const adapter = provider(() => ({
    close: () => { closeCalled = true; releaseIterator?.(); },
    interrupt: async () => { interruptCalled = true; },
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
  const gate = new Promise<void>(resolve => { release = resolve; });
  const adapter = provider(() => {
    started = true;
    return {
      close: () => {},
      interrupt: async () => { release?.(); },
      async *[Symbol.asyncIterator]() {
        await gate;
        yield {
          errors: ["interrupted"],
          is_error: true,
          session_id: "session:i",
          subtype: "error_during_execution",
          type: "result",
          uuid: "result:i",
        };
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
  if (outcome.kind === "completed") {
    assert.equal(outcome.outcome, "failed");
  }
});

test("owns forced iterator drain and rejects late output before returning", async () => {
  const clock = new ManualClock();
  let started = false;
  let drained = false;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const output: string[] = [];
  const adapter = provider(() => {
    started = true;
    return {
      close: () => { release?.(); },
      interrupt: async () => { throw new Error("synthetic interrupt failure"); },
      async *[Symbol.asyncIterator]() {
        try {
          await gate;
          yield delta("TOO_LATE");
        } finally {
          drained = true;
        }
      },
    };
  }, { clock });
  const outcomePromise = adapter.execute({
    ...input(),
    emit: async chunk => { output.push(chunk.text); },
    isCancellationRequested: async () => true,
  });
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
