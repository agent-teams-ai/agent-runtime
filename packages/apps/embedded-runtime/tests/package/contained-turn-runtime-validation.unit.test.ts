import assert from "node:assert/strict";
import test from "node:test";
import { snapshotContainedTurnProviderSelection } from
  "../../dist/composition/contained-turn-provider-selection.js";
import { copyInput, copySubmitOutcome } from
  "../../dist/composition/contained-turn-runtime-validation.js";
import type { OwnerSubmitOutcome } from
  "../../src/composition/contained-turn-composition-types.js";

const invalidSelection = /Contained turn provider selection is invalid/u;

test("selection rejects a Proxy stable within each snapshot but switching between snapshots", () => {
  let reads = 0;
  const selectedProvider = new Proxy({kind: "codex", owner: {}}, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key === "kind" && descriptor !== undefined) {
        reads += 1;
        return {...descriptor, value: reads <= 2 ? "codex" : "claude"};
      }
      return descriptor;
    },
  });
  const input = {selectedProvider};
  assert.throws(() => {
    snapshotContainedTurnProviderSelection(input);
    snapshotContainedTurnProviderSelection(input);
  }, invalidSelection);
  assert.equal(reads, 0);
});

test("selection rejects dependency and selection Proxies before reflection, including revoked Proxies", () => {
  let traps = 0;
  const handler = {
    getOwnPropertyDescriptor() {traps += 1; throw new Error("private trap");},
    getPrototypeOf() {traps += 1; throw new Error("private trap");},
    ownKeys() {traps += 1; throw new Error("private trap");},
  };
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const proxy of [new Proxy({}, handler), new Proxy({}, {}), revoked.proxy]) {
    assert.throws(() => snapshotContainedTurnProviderSelection(proxy), invalidSelection);
    assert.throws(() => snapshotContainedTurnProviderSelection({selectedProvider: proxy}), invalidSelection);
  }
  assert.equal(traps, 0);
});

test("selection preserves mutable, frozen and null-prototype ordinary structural inputs", () => {
  for (const kind of ["codex", "claude"] as const) {
    const owner = {};
    for (const selectedProvider of [
      {kind, owner}, Object.freeze({kind, owner}),
      Object.assign(Object.create(null), {kind, owner}),
    ]) {
      for (const input of [{selectedProvider}, Object.assign(Object.create(null), {selectedProvider})]) {
        const snapshot = snapshotContainedTurnProviderSelection(input);
        assert.deepEqual(snapshot.selection, {kind, owner});
        snapshot.assertStable();
        assert.equal(Object.isFrozen(snapshot.selection), true);
      }
    }
  }
});

test("input publishes only the mode captured and validated once", () => {
  for (const mode of ["analysis", "workspace-write"] as const) {
    let reads = 0;
    const copied = copyInput({commandId: "command-1", expectedProvider: "codex", intent: {
      get mode() {reads += 1; return reads === 1 ? mode : "unvalidated" as never;},
      prompt: "synthetic prompt",
    }});
    assert.deepEqual(copied, {
      commandId: "command-1", expectedProvider: "codex", intent: {mode, prompt: "synthetic prompt"},
    });
    assert.equal(reads, 1);
    assert.equal(Object.isFrozen(copied?.intent), true);
  }
});

test("invalid or throwing input modes remain rejected", () => {
  for (const mode of ["unknown", undefined, null]) {
    assert.equal(copyInput({commandId: "command-1", expectedProvider: "codex",
      intent: {mode: mode as never, prompt: "synthetic prompt"}}), undefined);
  }
  assert.equal(copyInput({commandId: "command-1", expectedProvider: "codex", intent: {
    get mode(): never {throw new Error("private mode");}, prompt: "synthetic prompt",
  }}), undefined);
});

test("submit copies every supported unsupported code including caller_invalid", () => {
  for (const code of ["caller_invalid", "mode_unsupported", "provider_mismatch", "provider_unsupported"] as const) {
    const outcome = {status: "unsupported", code} satisfies OwnerSubmitOutcome;
    const copied = copySubmitOutcome(outcome);
    assert.deepEqual(copied, {outcome});
    assert.notEqual(copied.outcome, outcome);
    assert.equal(Object.isFrozen(copied.outcome), true);
  }
});

test("submit still fails closed on unknown unsupported codes", () => {
  assert.throws(() => copySubmitOutcome({status: "unsupported", code: "unknown"}),
    {code: "malformed_owner_outcome"});
});
