import assert from "node:assert/strict";
import test from "node:test";
import {subject} from "../../fixtures/host-http-egress-v4-fixture.ts";
import {v4Subject} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import {defaultContainedTurnPostgresIdentities} from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-operation-authority.js";

const product = () => ({...subject, attempt: {...subject.attempt,
  tenantId: "tenant-one", projectId: "62bb3e60-c8ad-4bf8-968f-f6237e95a330",
  operationId: defaultContainedTurnPostgresIdentities.nextId("operation", "accepted-test-command"),
  attemptId: defaultContainedTurnPostgresIdentities.nextId("attempt", "prepared-test-attempt"),
  custodyId: defaultContainedTurnPostgresIdentities.nextId("custody", "prepared-test-custody"),
  hostInstanceId: "host-instance:test-process", hostBootId: "host-boot:test-incarnation"},
  effectId: defaultContainedTurnPostgresIdentities.nextId("effect", "accepted-test-command"),
  workspaceId: "workspace:test-workspace",
  executionGenerationId: defaultContainedTurnPostgresIdentities.nextId("execution_generation", "test-generation")});

test("V4 preserves actual PostgreSQL-generated identities and opaque scope without rewriting ownership", () => {
  const value = product();
  assert.match(value.attempt.operationId, /^operation:sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(v4Subject(value), value);
  assert.deepEqual(v4Subject(subject), subject, "existing digest-only V4 identities remain unchanged");
});

for (const [key, value] of [
  ["operationId", "attempt:wrong-namespace"], ["operationId", "operation:"],
  ["hostBootId", "host-instance:wrong-namespace"], ["tenantId", "../host-path"],
  ["projectId", "project id"], ["tenantId", ""], ["projectId", "a".repeat(129)],
] as const) {
  test(`V4 refuses unsafe or wrong-namespace ${key}: ${JSON.stringify(value)}`, () => {
    const input = product();
    assert.throws(() => v4Subject({...input, attempt: {...input.attempt, [key]: value}}));
  });
}

test("opaque product identities do not loosen resource handles or authority digests", () => {
  const input = product();
  for (const field of ["networkHandle", "listenerHandle", "routeHandle"] as const) {
    assert.throws(() => v4Subject({...input, [field]: `${field.replace("Handle", "")}:opaque`}));
  }
  for (const field of ["acceptedAuthoritySha256", "committedClaimSha256", "scopeSha256", "observerSha256"] as const) {
    assert.throws(() => v4Subject({...input, [field]: "opaque"}));
  }
});
