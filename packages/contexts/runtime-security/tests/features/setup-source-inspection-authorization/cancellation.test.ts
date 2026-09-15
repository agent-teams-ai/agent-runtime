import assert from "node:assert/strict";
import test from "node:test";
import { rethrowClaudeCodeCancellation as rethrowCancellation } from "../../../dist/features/setup-source-inspection-authorization/application/claude-code-path-authorization.js";

test("cancellation preserves boundary rejection identity, including plain named objects", () => {
  for (const reason of [new DOMException("cancelled", "AbortError"), {name: "AbortError"}]) {
    assert.throws(() => rethrowCancellation(reason), error => error === reason);
  }
  for (const reason of [undefined, null, "AbortError", {name: "Error"}, new Error("unavailable")]) {
    assert.doesNotThrow(() => rethrowCancellation(reason));
  }
});

test("an aborted signal takes precedence over the boundary rejection", () => {
  const controller = new AbortController();
  const reason = {cancelledBy: "caller"};
  controller.abort(reason);
  assert.throws(() => rethrowCancellation({name: "AbortError"}, controller.signal), error => error === reason);
});
