import assert from "node:assert/strict";
import test from "node:test";
import {
  ContainedTurnConstructionCleanupError,
  disposeAfterContainedTurnConstructionFailure,
} from "../dist/composition/contained-turn-construction-failure.js";

test("construction cleanup preserves the primary failure when cleanup succeeds", () => {
  const primary = new Error("synthetic primary");
  let disposals = 0;
  assert.throws(() => disposeAfterContainedTurnConstructionFailure(primary, () => { disposals += 1; }),
    error => error === primary);
  assert.equal(disposals, 1);
});

test("construction cleanup failure exposes only its fixed diagnostic without inspecting either failure", () => {
  let reads = 0;
  const hostile = new Proxy(new Error("synthetic-secret-path"), {
    get() { reads += 1; throw new Error("must not read"); },
    getOwnPropertyDescriptor() { reads += 1; throw new Error("must not reflect"); },
    getPrototypeOf() { reads += 1; throw new Error("must not classify"); },
    ownKeys() { reads += 1; throw new Error("must not enumerate"); },
  });
  let disposals = 0;
  assert.throws(() => disposeAfterContainedTurnConstructionFailure(hostile, () => {
    disposals += 1;
    throw hostile;
  }), error => {
    assert.ok(error instanceof ContainedTurnConstructionCleanupError);
    assert.equal(error.code, "contained_turn_construction_cleanup_failed");
    assert.equal(error.message, "Contained turn construction cleanup failed");
    assert.deepEqual(Reflect.ownKeys(error).toSorted(), ["code", "message", "name"]);
    assert.ok(Object.isFrozen(error));
    return true;
  });
  assert.equal(disposals, 1);
  assert.equal(reads, 0);
});
