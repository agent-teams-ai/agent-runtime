import assert from "node:assert/strict";
import test from "node:test";

import { decodeContainedTurnPreparation, encodeContainedTurnPreparation } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-preparation-codec.js";
import { ContainedTurnStateQuarantineError, digestContainedTurnPostgresJson } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-state-codec.js";
import { bindContainedTurnPreparationGrantRequests, recordContainedTurnPreparationCleanup, retireContainedTurnDispatchPreparation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-preparation.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { createReservedOperation } from "../../contained-turn-kernel-fixtures.ts";
import { postgresClaimInput } from "./support/postgres-committed-dispatch-fixture.ts";

const operation = createReservedOperation();
if (operation.dispatch.kind !== "claimed") {throw new Error("fixture must be claimed");}
const claim = postgresClaimInput(operation, operation.workspaceId!, {
  attemptId: operation.dispatch.attemptId, custodyId: operation.custodyId!,
  executionGenerationId: operation.dispatch.executionGenerationId,
  claimProofId: containedTurnIdentity("proof", "proof:codec-claim"),
  cutoffProofId: containedTurnIdentity("proof", "proof:codec-cutoff"),
  writerFence: containedTurnIdentity("writer_fence", "writer-fence:codec"),
}, "settlement-codec");
const receipts = claim.receipts;
const active = Object.freeze({
  attemptId: operation.dispatch.attemptId, custodyId: operation.custodyId!, kind: "active" as const,
  operationCutoffRevision: operation.dispatch.operationCutoffRevision, operationId: operation.operationId,
  preparationToken: claim.preparationToken, preparedOperationRevision: operation.revision - 1,
  providerAccessGrantRequestId: null, runtimeSecurityGrantRequestId: null, workspaceId: operation.workspaceId!,
});
const decode = (payload: object, codecVersion = 6) => {
  if (codecVersion === 1) {return decodeContainedTurnPreparation(payload, null, 1);}
  const envelope = { codecVersion, payload };
  return decodeContainedTurnPreparation(envelope, digestContainedTurnPostgresJson(envelope), codecVersion);
};

test("null identities remain owner debt across retirement, custody release and every legacy codec", () => {
  const retired = retireContainedTurnDispatchPreparation(active, "settlement-codec");
  if (retired.kind !== "cleanup_pending") {throw new Error("missing retirement");}
  const pending = recordContainedTurnPreparationCleanup(retired, { permit: retired.cleanupPermit, target: "custody" });
  assert.equal(pending.kind, "cleanup_pending");
  for (const target of ["provider_access", "runtime_security"] as const) {
    assert.throws(() => recordContainedTurnPreparationCleanup(pending, { permit: retired.cleanupPermit, target }), /exact consumed grant receipt/u);
  }
  for (const codecVersion of [1, 2, 3, 4]) {
    const historical = { ...retired, custodyReleased: true, providerAccessSettled: true, runtimeSecuritySettled: true };
    const upcast = codecVersion === 1
      ? decodeContainedTurnPreparation(historical, null, 1) : decode(historical, codecVersion);
    assert.equal(upcast.kind, "cleanup_pending");
    if (upcast.kind !== "cleanup_pending") {throw new Error("missing legacy debt");}
    assert.equal(upcast.providerAccessSettled, false);
    assert.equal(upcast.runtimeSecuritySettled, false);
    assert.deepEqual(upcast.cleanupPermit, retired.cleanupPermit);
  }
  const encoded = encodeContainedTurnPreparation(pending);
  assert.equal(encoded.codecVersion, 6);
  assert.deepEqual(decodeContainedTurnPreparation(JSON.parse(encoded.json), encoded.digest, 6), pending);
});

test("every legacy codec quarantines malformed settlement and custody flags before normalization", () => {
  const pending = retireContainedTurnDispatchPreparation(active, "legacy-flags");
  for (const codecVersion of [1, 2, 3, 4]) {
    for (const field of ["providerAccessSettled", "runtimeSecuritySettled", "custodyReleased"]) {
      for (const value of ["true", "false", 0, 1, null, {}, [], "x".repeat(513)]) {
        assert.throws(() => decode({ ...pending, [field]: value }, codecVersion), error =>
          error instanceof ContainedTurnStateQuarantineError && error.reason === "malformed" &&
          error.codecVersion === codecVersion, `codec ${codecVersion}: ${field}`);
      }
    }
  }
});

test("legacy fields discarded by upcasting still require valid types and bounds", () => {
  const pending = retireContainedTurnDispatchPreparation(active, "legacy-fields");
  if (pending.kind !== "cleanup_pending") {throw new Error("missing legacy preparation");}
  const bound = bindContainedTurnPreparationGrantRequests(pending, {
    providerAccessConsumptionReceipt: receipts[0], runtimeSecurityConsumptionReceipt: receipts[1],
  });
  const { cleanupPermit, custodyReleased: _custody, providerAccessSettled: _access,
    runtimeSecuritySettled: _security, ...rest } = bound;
  const closed = { ...rest, cleanupPermitId: cleanupPermit.permitId, kind: "cleanup_closed" };
  const malformed = (payload: object, version: number) => assert.throws(() => decode(payload, version), error =>
    error instanceof ContainedTurnStateQuarantineError && error.reason === "malformed" && error.codecVersion === version);
  for (const field of ["providerAccessGrantRequestId", "runtimeSecurityGrantRequestId"]) {
    for (const value of [false, 42, {}, [], "", "x".repeat(513), "bad\u0000identity"]) {
      malformed({ ...pending, [field]: value }, 1);
    }
  }
  for (const version of [1, 2, 3, 4]) {
    if (version > 1) {assert.equal(decode(closed, version).kind, "cleanup_closed");}
    for (const field of ["providerAccessConsumptionEvidenceId", "runtimeSecurityConsumptionEvidenceId"]) {
      for (const value of [false, 42, {}, [], "", "evidence:", "evidence:" + "x".repeat(504)]) {
        malformed({ ...pending, [field]: value }, version);
      }
    }
    for (const cleanupEvidenceIds of [null, "evidence:one", 1, {}, [42], ["custody:wrong"],
      ["evidence:" + "x".repeat(504)], Array.from({ length: 65 }, (_, index) => `evidence:${index}`)]) {
      malformed({ ...pending, cleanupEvidenceIds }, version);
      if (version > 1) {malformed({ ...closed, cleanupEvidenceIds }, version);}
    }
    for (const patch of [
      { preparedOperationRevision: -1 }, { preparedOperationRevision: Number.MAX_SAFE_INTEGER + 1 },
      { operationCutoffRevision: "0" }, { cleanupPermit: null }, { unexpected: true },
      { providerAccessConsumptionReceipt: 42 },
    ]) {malformed({ ...pending, ...patch }, version);}
  }
});

test("valid prior preparation versions retain identity and conservative cleanup debt", () => {
  const pending = retireContainedTurnDispatchPreparation(active, "valid-legacy");
  if (pending.kind !== "cleanup_pending") {throw new Error("missing legacy preparation");}
  const { providerAccessGrantRequestId: _accessRequest, runtimeSecurityGrantRequestId: _securityRequest,
    ...v1Active } = active;
  assert.deepEqual(decode(v1Active, 1), active);
  assert.deepEqual(decode({ ...v1Active, providerAccessGrantRequestId: "x".repeat(512) }, 1), active);
  assert.deepEqual(decode({ ...v1Active, kind: "claimed" }, 1), { ...active, kind: "claimed" });
  const { providerAccessConsumptionEvidenceId: _accessEvidence,
    runtimeSecurityConsumptionEvidenceId: _securityEvidence, ...v2Pending } = pending;
  for (const codecVersion of [1, 2, 3, 4]) {
    const historical = {
      ...(codecVersion <= 2 ? v2Pending : pending),
      ...(codecVersion === 1 ? {
        providerAccessGrantRequestId: "provider-access-grant:legacy-placeholder",
        runtimeSecurityGrantRequestId: "runtime-security-grant:legacy-placeholder",
      } : {}),
    };
    for (const flag of [true, false]) {
      assert.deepEqual(decode({ ...historical, custodyReleased: flag,
        providerAccessSettled: flag, runtimeSecuritySettled: flag }, codecVersion), pending);
    }
    assert.deepEqual(decode(active, codecVersion), active);
    assert.deepEqual(decode({ ...active, kind: "claimed" }, codecVersion), { ...active, kind: "claimed" });
  }
});

test("late exact receipts preserve the retirement permit and each settlement closes only its owner", () => {
  const retired = retireContainedTurnDispatchPreparation(active, "late-receipts");
  if (retired.kind !== "cleanup_pending") {throw new Error("missing retirement");}
  const bound = bindContainedTurnPreparationGrantRequests(retired, {
    providerAccessConsumptionReceipt: receipts[0], runtimeSecurityConsumptionReceipt: receipts[1],
  });
  assert.deepEqual(bound.cleanupPermit, retired.cleanupPermit);
  assert.equal(bound.providerAccessSettled, false);
  assert.equal(bound.runtimeSecuritySettled, false);
  const custody = recordContainedTurnPreparationCleanup(bound, { permit: bound.cleanupPermit, target: "custody" });
  const access = recordContainedTurnPreparationCleanup(custody, { permit: bound.cleanupPermit, target: "provider_access" });
  assert.equal(access.kind, "cleanup_pending");
  const closed = recordContainedTurnPreparationCleanup(access, { permit: bound.cleanupPermit, target: "runtime_security" });
  assert.equal(closed.kind, "cleanup_closed");
  assert.deepEqual(decode(closed), closed);
  assert.throws(() => bindContainedTurnPreparationGrantRequests(bound, {
    providerAccessConsumptionReceipt: { ...receipts[0], ownerEvidenceRef: "substituted" },
  }), /substitution/u);
});

test("strict bounded codec rejects unproved closure and malformed settlement receipts", () => {
  const retired = retireContainedTurnDispatchPreparation(active, "malformed-receipts");
  if (retired.kind !== "cleanup_pending") {throw new Error("missing retirement");}
  const bound = bindContainedTurnPreparationGrantRequests(retired, {
    providerAccessConsumptionReceipt: receipts[0], runtimeSecurityConsumptionReceipt: receipts[1],
  });
  for (const invalid of [
    { ...retired, providerAccessSettled: true },
    { ...bound, unexpected: true },
    { ...bound, providerAccessConsumptionReceipt: null },
    { ...bound, providerAccessConsumptionReceipt: { ...receipts[0], unexpected: true } },
    { ...bound, providerAccessConsumptionReceipt: { ...receipts[0], owner: "runtime_security" } },
    { ...bound, providerAccessConsumptionReceipt: { ...receipts[0], scope: { ...receipts[0].scope, projectId: "foreign" } } },
    { ...bound, providerAccessConsumptionReceipt: { ...receipts[0], ownerEvidenceRef: "x".repeat(100_000) } },
    { ...bound, cleanupEvidenceIds: Array.from({ length: 65 }, (_, index) => `evidence:${index}`) },
  ]) {assert.throws(() => decode(invalid));}
  const { cleanupPermit, custodyReleased: _custody, providerAccessSettled: _access, runtimeSecuritySettled: _security, ...rest } = retired;
  const unprovedClosed = { ...rest, cleanupPermitId: cleanupPermit.permitId, kind: "cleanup_closed" };
  for (const codecVersion of [2, 3, 4, 5, 6]) {assert.throws(() => decode(unprovedClosed, codecVersion));}
  assert.throws(() => decode(bound, 7), /unsupported/u);
  const encoded = encodeContainedTurnPreparation(bound);
  assert.throws(() => decodeContainedTurnPreparation(JSON.parse(encoded.json), "0".repeat(64), 6), /digest/u);
});
