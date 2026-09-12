import assert from "node:assert/strict";
import { test } from "node:test";

import { NodeHttpEgressBoundaryIds } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-http-egress-boundary-ids.js";

const namespace = "12345678-1234-4123-8123-123456789abc";

test("Host allocation uses one entropy namespace and never recycles an ambiguous bundle", () => {
  let calls = 0;
  const owner = new NodeHttpEgressBoundaryIds(() => { calls += 1; return namespace; });
  const ambiguous = owner.fresh();
  const snapshot = { ...ambiguous };
  const seen = new Set(Object.values(ambiguous));
  assert.equal(seen.size, 5);
  assert.ok(Object.isFrozen(ambiguous));
  assert.throws(() => { Object.assign(ambiguous, { connectionAttemptId: "replacement" }); }, TypeError);
  for (let index = 0; index < 1_000; index += 1) {
    const next = owner.fresh();
    for (const id of Object.values(next)) {
      assert.ok(!seen.has(id));
      assert.ok(id.length < 160);
      seen.add(id);
    }
  }
  assert.deepEqual(ambiguous, snapshot);
  assert.equal(calls, 1);
});

test("entropy failure and malformed entropy refuse construction without fallback", () => {
  const failure = new Error("entropy unavailable");
  assert.throws(() => new NodeHttpEgressBoundaryIds(() => { throw failure; }), error => error === failure);
  for (const invalid of ["", "caller-id", namespace.toUpperCase(), namespace.replace("4123", "1123")]) {
    assert.throws(() => new NodeHttpEgressBoundaryIds(() => invalid), TypeError);
  }
});

test("separate Host owners have separate namespaces and distinct role identities", () => {
  const left = new NodeHttpEgressBoundaryIds(() => namespace).fresh();
  const right = new NodeHttpEgressBoundaryIds(() => namespace.replace("12345678", "87654321")).fresh();
  assert.equal(new Set([...Object.values(left), ...Object.values(right)]).size, 10);
  assert.ok(left.connectionAttemptId.endsWith(":connection"));
  assert.ok(left.boundaryUseId.endsWith(":boundary"));
});

test("production entropy allocates separate owner namespaces without networking", () => {
  const left = new NodeHttpEgressBoundaryIds().fresh();
  const right = new NodeHttpEgressBoundaryIds().fresh();
  assert.equal(new Set([...Object.values(left), ...Object.values(right)]).size, 10);
});
