import assert from "node:assert/strict";
import test from "node:test";
import { snapshotCancellationProof } from "../dist/composition/contained-turn-cancellation-proof.js";

const terminal = () => ({
  artifactManifestRef: "artifact", commandId: "command", effectId: "effect",
  operationId: "operation", output: [], provider: "provider", resultRef: "result",
  revision: 1, status: "cancelled",
});
const proof = (turn: object, expected = "operation") =>
  snapshotCancellationProof({ status: "observed", turn }, expected);

for (const field of [
  "operationId", "commandId", "effectId", "artifactManifestRef", "resultRef", "provider",
]) {
  test(`cancellation proof rejects reserved authority namespace in ${field}`, () => {
    for (const value of ["runtime-access-authority:private", "prefix:runtime-access-authority:private"]) {
      assert.deepEqual(proof({ ...terminal(), [field]: value },
        field === "operationId" ? value : "operation"), { kind: "contract_violation" });
    }
  });
}

test("cancellation proof retains owner and provider identity limits", () => {
  for (const field of ["operationId", "commandId", "effectId", "artifactManifestRef", "resultRef", "provider"]) {
    const limit = field === "provider" ? 128 : 512;
    const value = "a".repeat(limit);
    assert.deepEqual(proof({ ...terminal(), [field]: value },
      field === "operationId" ? value : "operation"), { kind: "terminal", status: "cancelled" });
    assert.deepEqual(proof({ ...terminal(), [field]: value + "a" },
      field === "operationId" ? value + "a" : "operation"), { kind: "contract_violation" });
  }
});

test("cancellation proof keeps terminal evidence and operation matching mandatory", () => {
  for (const status of ["cancelled", "failed", "succeeded"]) {
    assert.deepEqual(proof({ ...terminal(), status }), { kind: "terminal", status });
    assert.deepEqual(proof({ ...terminal(), status, resultRef: undefined }), { kind: "contract_violation" });
  }
  assert.deepEqual(proof(terminal(), "different"), { kind: "operation_mismatch" });
  assert.deepEqual(proof({ ...terminal(), status: "reconcile_required" }),
    { kind: "nonterminal", status: "reconcile_required" });
});

test("cancellation proof rejects throwing owner fields and malformed output", () => {
  assert.deepEqual(proof({ ...terminal(), get provider() { throw new Error("synthetic"); } }),
    { kind: "contract_violation" });
  for (const output of [
    [{ cursor: 0, kind: "assistant", text: "x".repeat(1_000_001) }],
    Array.from({ length: 10_001 }, () => ({ cursor: 0, kind: "assistant", text: "" })),
    [{ cursor: 0, kind: "assistant", text: "" }, { cursor: 0, kind: "assistant", text: "" }],
  ]) {
    assert.deepEqual(proof({ ...terminal(), output }), { kind: "contract_violation" });
  }
});
