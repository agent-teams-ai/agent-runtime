import assert from "node:assert/strict";
import test from "node:test";

import {
  captureConsume,
  captureOperation,
  captureSettlement,
} from "../../../dist/features/contained-turn-dispatch-authority/adapters/outbound/postgres/records.js";

const operation = () => ({
  scope: {tenantId: "tenant", projectId: "project", scopeDigest: "digest"},
  providerId: "provider", authorityGeneration: "generation", operationId: "operation",
});

test("persisted dispatch selectors retain validated operation identity", () => {
  assert.deepEqual(captureOperation(operation()), operation());
  assert.deepEqual(captureConsume({...operation(), grantRequestId: "grant"}),
    {...operation(), grantRequestId: "grant"});
  assert.deepEqual(captureSettlement({...operation(), grantRequestId: "grant",
    settlementRequestId: "settlement", consumptionDigest: "consumption"}),
  {...operation(), grantRequestId: "grant", settlementRequestId: "settlement", consumptionDigest: "consumption"});
});

test("persisted dispatch selectors reject malformed operation members before use", () => {
  const cases = [
    [captureOperation, operation()],
    [captureConsume, {...operation(), grantRequestId: "grant"}],
    [captureSettlement, {...operation(), grantRequestId: "grant", settlementRequestId: "settlement",
      consumptionDigest: "consumption"}],
  ] as const;
  for (const [capture, fields] of cases) {
    assert.throws(() => capture({...fields, scope: {...fields.scope, tenantId: 1}}), TypeError);
    assert.throws(() => capture({...fields, providerId: {toString: () => "provider"}}), TypeError);
    assert.throws(() => capture({...fields, scope: {...fields.scope, unexpected: "extra"}}), TypeError);
  }
});
