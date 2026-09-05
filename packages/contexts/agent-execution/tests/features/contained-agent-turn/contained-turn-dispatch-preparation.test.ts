import assert from "node:assert/strict";
import test from "node:test";

import { decodeContainedTurnPreparation } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-preparation-codec.js";
import {
  ContainedTurnStateQuarantineError,
  digestContainedTurnPostgresJson,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-state-codec.js";
import { reconcileContainedTurnClaimPreparation } from "../../../dist/features/contained-agent-turn/application/contained-turn-preparation-cleanup.js";
import { recoverContainedTurnCommittedGrantSettlements, recoverContainedTurnDispatchPreparations } from "../../../dist/features/contained-agent-turn/application/contained-turn-preparation-recovery.js";
import { claimContainedTurnWithConsumedGrants } from "../../../dist/features/contained-agent-turn/application/contained-turn-grant-claim.js";
import { normalizeContainedTurnConsumedGrantReceipt } from "../../../dist/features/contained-agent-turn/composition/dispatch-grant-anti-corruption.js";
import { createContainedTurnPreparationScopeDependencies } from "../../../dist/features/contained-agent-turn/composition/preparation-scope-anti-corruption.js";
import { containedTurnCancellationFingerprint, containedTurnScopeDigest } from "../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {
  completeContainedTurnDispatchGrantSubject,
  containedTurnDispatchGrantRequestId,
  validateContainedTurnConsumedGrantReceipts,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-authority.js";
import {
  CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT,
  claimContainedTurnDispatchPreparation,
  recordContainedTurnPreparationCleanup,
  retireContainedTurnDispatchPreparation,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-preparation.js";
import type { ContainedTurnKernelDependencies } from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import { mutateContainedTurnOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import {
  attemptId,
  createOperation,
  createReservedOperation,
  custodyId,
  effectId,
  operationId,
  preparationToken,
  scope,
  workspaceId,
} from "../../contained-turn-kernel-fixtures.ts";
import { consumedReceipt, grantSubject } from "./support/dispatch-grant-fixture.ts";
import { committedDispatchProofForClaim } from "./support/committed-dispatch-proof-fixture.ts";

const unusedMandatoryDependency = async (): Promise<never> => {
  throw new Error("unused mandatory dependency");
};

test("dispatch preparation cleanup retains possible winners and releases only proved losers", async () => {
  const initial = mutateContainedTurnOperation(createOperation(), { kind: "bind_workspace", workspaceId });
  const winner = createReservedOperation();
  const reservation = { attemptId, custodyId, preparationToken, workspaceId };
  const exercise = async (read: ContainedTurnKernelOperation | undefined, calls = 1) => {
    let current = read;
    const releases: unknown[] = [];
    const dependencies = {
      custody: { releaseReservation: async (input: unknown) => {releases.push(input);} },
      operationStore: {
        commit: async (input: { candidate: ContainedTurnKernelOperation }) => {
          current = input.candidate;
          return { kind: "applied" as const, operation: input.candidate };
        },
        read: async () => current,
      },
    } as unknown as ContainedTurnKernelDependencies;
    let result = initial;
    for (let index = 0; index < calls; index += 1) {
      result = (await reconcileContainedTurnClaimPreparation(
        dependencies, initial, scope, reservation,
      )).operation;
    }
    return { releases, result };
  };

  const sharedReservation = await exercise(winner, 2);
  assert.equal(sharedReservation.releases.length, 0, "a loser sharing the winning reservation cannot release it");
  assert.equal(sharedReservation.result.reconciliation.kind, "required", "lost claim acknowledgement records debt");

  const otherToken = containedTurnIdentity("preparation", "preparation:other-winner");
  if (winner.dispatch.kind !== "claimed") {assert.fail("fixture must be claimed");}
  const otherWinner = {
    ...winner,
    dispatch: { ...winner.dispatch, preparationToken: otherToken },
  } as ContainedTurnKernelOperation;
  assert.equal((await exercise(otherWinner)).releases.length, 1, "a stale claim loses to the durable different token");
  assert.equal((await exercise(initial)).releases.length, 1, "a durable pre-claim state proves safe release");
  assert.equal((await exercise()).releases.length, 0, "unknown ownership retains the possible winner");
});

test("claim then cancellation protects the winner while exact loser cleanup is monotone", () => {
  const subject = completeContainedTurnDispatchGrantSubject({
    ...grantSubject(), attemptId: containedTurnIdentity("attempt", "attempt:loser"),
    custodyId: containedTurnIdentity("custody", "custody:loser"),
    preparationToken: containedTurnIdentity("preparation", "preparation:loser"),
  });
  const receipts = validateContainedTurnConsumedGrantReceipts(subject, [
    consumedReceipt("provider_access", subject), consumedReceipt("runtime_security", subject),
  ]);
  const active = Object.freeze({
    attemptId: subject.attemptId,
    custodyId: subject.custodyId,
    kind: "active" as const,
    operationCutoffRevision: 0,
    operationId,
    preparationToken: subject.preparationToken,
    preparedOperationRevision: 1,
    providerAccessConsumptionReceipt: receipts[0],
    providerAccessGrantRequestId: receipts[0].grantRequestId,
    runtimeSecurityConsumptionReceipt: receipts[1],
    runtimeSecurityGrantRequestId: receipts[1].grantRequestId,
    workspaceId,
  });
  const winner = claimContainedTurnDispatchPreparation({
    ...active, attemptId, custodyId, preparationToken,
    providerAccessConsumptionReceipt: consumedReceipt("provider_access", grantSubject()) as typeof receipts[0],
    providerAccessGrantRequestId: grantSubject().providerAccessRequest.grantRequestId,
    runtimeSecurityConsumptionReceipt: consumedReceipt("runtime_security", grantSubject()) as typeof receipts[1],
    runtimeSecurityGrantRequestId: grantSubject().runtimeSecurityRequest.grantRequestId,
  });
  assert.notEqual(active.providerAccessGrantRequestId, winner.providerAccessGrantRequestId);
  assert.notEqual(active.runtimeSecurityGrantRequestId, winner.runtimeSecurityGrantRequestId);
  const claimed = createReservedOperation();
  const cancellationCommandId = containedTurnIdentity("cancellation_command", "cancellation-command:loser-cleanup");
  const command = { cancellationCommandId, operationId, scopeDigest: containedTurnScopeDigest(scope),
    fingerprint: containedTurnCancellationFingerprint({ cancellationCommandId, operationId, scopeDigest: containedTurnScopeDigest(scope) }) };
  const binding = { authorityVectorDigest: claimed.acceptedAuthorityVectorDigest, operationId, cancellationCommandId };
  const cancelled = mutateContainedTurnOperation(claimed, { command, kind: "request_cancellation",
    cutoffProof: { binding, kind: "cutoff", proofId: containedTurnIdentity("proof", "proof:loser-cutoff") },
    proof: { binding: { ...binding, cancellationFingerprint: command.fingerprint }, kind: "cancellation",
      proofId: containedTurnIdentity("proof", "proof:loser-cancellation") } });
  assert.equal(cancelled.operationCutoff.revision, active.operationCutoffRevision + 1);
  assert.deepEqual(cancelled.dispatch, claimed.dispatch);
  assert.throws(() => retireContainedTurnDispatchPreparation(winner, "winner"), /claimed dispatch preparation/u);
  const retired = retireContainedTurnDispatchPreparation(active, "retirement:1");
  assert.equal(retired.kind, "cleanup_pending");
  assert.throws(() => claimContainedTurnDispatchPreparation(retired), /never be claimed/u);
  if (retired.kind !== "cleanup_pending") {return;}
  assert.equal(retired.cleanupPermit.preparationToken, subject.preparationToken);
  assert.equal(retired.cleanupPermit.operationCutoffRevision, active.operationCutoffRevision);
  assert.throws(() => recordContainedTurnPreparationCleanup(winner, {
    permit: retired.cleanupPermit, target: "custody",
  }), /exact retired preparation permit/u);

  const wrongPermit = {
    ...retired.cleanupPermit,
    permitId: containedTurnIdentity("cleanup_permit", "cleanup-permit:substituted"),
  };
  assert.throws(
    () => recordContainedTurnPreparationCleanup(retired, { permit: wrongPermit, target: "custody" }),
    /exact retired preparation permit/u,
  );
  const custodyReleased = recordContainedTurnPreparationCleanup(retired, {
    permit: retired.cleanupPermit,
    target: "custody",
  });
  const accessSettled = recordContainedTurnPreparationCleanup(custodyReleased, {
    permit: retired.cleanupPermit,
    target: "provider_access",
  });
  const closed = recordContainedTurnPreparationCleanup(accessSettled, {
    permit: retired.cleanupPermit,
    target: "runtime_security",
  });
  assert.equal(closed.kind, "cleanup_closed");
  assert.strictEqual(recordContainedTurnPreparationCleanup(closed, {
    permit: retired.cleanupPermit,
    target: "runtime_security",
  }), closed, "exact cleanup replay preserves terminal evidence");
  assert.throws(() => claimContainedTurnDispatchPreparation(closed), /never be claimed/u);
  assert.equal(winner.kind, "claimed");
  assert.deepEqual(cancelled.dispatch, claimed.dispatch);
  assert.equal(cancelled.terminal.kind, "open");
});

test("trusted prevention settles only owners proved not consumed", () => {
  const active = Object.freeze({
    attemptId,
    custodyId,
    kind: "active" as const,
    operationCutoffRevision: 0,
    operationId,
    preparationToken,
    preparedOperationRevision: 1,
    providerAccessGrantRequestId: null,
    runtimeSecurityGrantRequestId: null,
    workspaceId,
  });
  const prevented = retireContainedTurnDispatchPreparation(
    active, "retirement:prevented", {}, {}, "prevention",
  );
  assert.equal(prevented.kind, "cleanup_pending");
  if (prevented.kind !== "cleanup_pending") {return;}
  assert.equal(prevented.providerAccessNotConsumed, true);
  assert.equal(prevented.providerAccessSettled, false);
  assert.equal(prevented.runtimeSecurityNotConsumed, true);
  assert.equal(prevented.runtimeSecuritySettled, false);
  assert.equal(recordContainedTurnPreparationCleanup(prevented, {
    permit: prevented.cleanupPermit,
    target: "custody",
  }).kind, "cleanup_closed");

  const unresolved = retireContainedTurnDispatchPreparation(active, "retirement:recovery");
  assert.equal(unresolved.kind, "cleanup_pending");
  if (unresolved.kind !== "cleanup_pending") {return;}
  assert.equal(unresolved.providerAccessSettled, false);
  assert.equal(unresolved.providerAccessNotConsumed, false);
  assert.equal(unresolved.runtimeSecuritySettled, false);
  assert.equal(unresolved.runtimeSecurityNotConsumed, false);
});

test("retirement durably preserves and reconciles every indeterminate grant consumption", () => {
  const providerAccessEvidenceId = containedTurnIdentity(
    "evidence", "evidence:provider-access-consumption-indeterminate",
  );
  const runtimeSecurityEvidenceId = containedTurnIdentity(
    "evidence", "evidence:runtime-security-consumption-indeterminate",
  );
  const active = Object.freeze({
    attemptId,
    custodyId,
    kind: "active" as const,
    operationCutoffRevision: 0,
    operationId,
    preparationToken,
    preparedOperationRevision: 1,
    providerAccessGrantRequestId: null,
    runtimeSecurityGrantRequestId: null,
    workspaceId,
  });
  const retired = retireContainedTurnDispatchPreparation(
    active,
    "retirement:indeterminate-consumption",
    {
      providerAccessGrantRequestId: `grant-request:${digestContainedTurnCanonicalValue({
        owner: "provider_access", request: "indeterminate-consumption",
      })}`,
    },
    { providerAccessEvidenceId, runtimeSecurityEvidenceId },
  );
  assert.equal(retired.kind, "cleanup_pending");
  if (retired.kind !== "cleanup_pending") {return;}
  assert.deepEqual(retired.cleanupEvidenceIds, [
    providerAccessEvidenceId,
    runtimeSecurityEvidenceId,
  ]);
  assert.equal(retired.providerAccessSettled, false);
  assert.equal(retired.runtimeSecuritySettled, false);
  assert.match(retired.providerAccessGrantRequestId ?? "", /^grant-request:sha256:[a-f0-9]{64}$/u);
  assert.equal(retired.providerAccessConsumptionEvidenceId, providerAccessEvidenceId);

  const custodyReleased = recordContainedTurnPreparationCleanup(retired, {
    permit: retired.cleanupPermit,
    target: "custody",
  });
  const settlementEvidenceId = containedTurnIdentity(
    "evidence", "evidence:provider-access-settlement-still-indeterminate",
  );
  const stillIndeterminate = recordContainedTurnPreparationCleanup(custodyReleased, {
    evidenceId: settlementEvidenceId,
    permit: retired.cleanupPermit,
    target: "provider_access",
  });
  assert.equal(stillIndeterminate.kind, "cleanup_pending");
  if (stillIndeterminate.kind !== "cleanup_pending") {return;}
  assert.equal(stillIndeterminate.providerAccessSettled, false);
  for (const target of ["provider_access", "runtime_security"] as const) {
    assert.throws(() => recordContainedTurnPreparationCleanup(stillIndeterminate, {
      permit: retired.cleanupPermit, target,
    }), /exact consumed grant receipt/u);
  }
});

test("cleanup evidence stops growing at its explicit cap without settling ambiguity", () => {
  const active = Object.freeze({
    attemptId,
    custodyId,
    kind: "active" as const,
    operationCutoffRevision: 0,
    operationId,
    preparationToken,
    preparedOperationRevision: 1,
    providerAccessGrantRequestId: `grant-request:${digestContainedTurnCanonicalValue({
      owner: "provider_access", request: "bounded-evidence",
    })}`,
    runtimeSecurityGrantRequestId: null,
    workspaceId,
  });
  const initialEvidenceId = containedTurnIdentity("evidence", "evidence:bounded-cleanup-initial");
  let pending = retireContainedTurnDispatchPreparation(
    active,
    "retirement:bounded-cleanup",
    {},
    { providerAccessEvidenceId: initialEvidenceId },
  );
  if (pending.kind !== "cleanup_pending") {assert.fail("bounded cleanup fixture did not retire");}
  for (let index = pending.cleanupEvidenceIds.length;
    index < CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT;
    index += 1) {
    const next = recordContainedTurnPreparationCleanup(pending, {
      evidenceId: containedTurnIdentity("evidence", `evidence:bounded-cleanup:${String(index)}`),
      permit: pending.cleanupPermit,
      target: "provider_access",
    });
    if (next.kind !== "cleanup_pending") {assert.fail("indeterminate evidence cannot close cleanup");}
    pending = next;
  }
  const historyAtCap = pending.cleanupEvidenceIds;
  const overflow = recordContainedTurnPreparationCleanup(pending, {
    evidenceId: containedTurnIdentity("evidence", "evidence:bounded-cleanup:overflow"),
    permit: pending.cleanupPermit,
    target: "provider_access",
  });
  assert.strictEqual(overflow, pending);
  assert.strictEqual(overflow.cleanupEvidenceIds, historyAtCap);
  assert.equal(overflow.providerAccessSettled, false);
  assert.equal(overflow.cleanupEvidenceIds.length, CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT);
  assert.equal(overflow.cleanupEvidenceIds.includes(initialEvidenceId), true);
});

test("persisted v2 cleanup debt upcasts for conservative recovery and oversized rows quarantine", async () => {
  const providerAccessGrantRequestId = `grant-request:${digestContainedTurnCanonicalValue({
    owner: "provider_access", request: "persisted-v2",
  })}`;
  const runtimeSecurityGrantRequestId = `grant-request:${digestContainedTurnCanonicalValue({
    owner: "runtime_security", request: "persisted-v2",
  })}`;
  const active = Object.freeze({
    attemptId,
    custodyId,
    kind: "active" as const,
    operationCutoffRevision: 0,
    operationId,
    preparationToken,
    preparedOperationRevision: 1,
    providerAccessGrantRequestId,
    runtimeSecurityGrantRequestId,
    workspaceId,
  });
  const retired = retireContainedTurnDispatchPreparation(active, "retirement:persisted-v2");
  if (retired.kind !== "cleanup_pending") {assert.fail("persisted v2 fixture did not retire");}
  const historicalEvidenceId = containedTurnIdentity("evidence", "evidence:persisted-v2-history");
  const {
    providerAccessConsumptionEvidenceId: _providerEvidence,
    runtimeSecurityConsumptionEvidenceId: _securityEvidence,
    ...legacyPayload
  } = retired;
  const v2Payload = {
    ...legacyPayload,
    cleanupEvidenceIds: [historicalEvidenceId],
    custodyReleased: true,
    providerAccessSettled: true,
    runtimeSecuritySettled: true,
  };
  const v2Row = { codecVersion: 2, payload: v2Payload };
  const decoded = decodeContainedTurnPreparation(v2Row, digestContainedTurnPostgresJson(v2Row), 2);
  assert.equal(decoded.kind, "cleanup_pending");
  if (decoded.kind !== "cleanup_pending") {return;}
  assert.deepEqual(decoded.cleanupEvidenceIds, [historicalEvidenceId]);
  assert.equal(decoded.custodyReleased, false);
  assert.equal(decoded.providerAccessSettled, false);
  assert.equal(decoded.runtimeSecuritySettled, false);

  let current = decoded;
  const recoveryCalls: string[] = [];
  const recoveryDependencies = {
    custody: { releaseRetiredReservation: async () => {
      recoveryCalls.push("custody"); return { kind: "released" as const };
    } },
    operationStore: {
      listDispatchPreparations: async () => [{ operation: createOperation(), preparation: decoded }],
      recordDispatchPreparationCleanup: async input => {
        current = recordContainedTurnPreparationCleanup(current, input);
        return current;
      },
    },
    providerAccess: { settleConsumedGrant: async input => {
      recoveryCalls.push(`provider_access:${input.grantRequestId ?? "missing"}`);
      return { kind: "settled" as const };
    } },
    security: { settleConsumedGrant: async input => {
      recoveryCalls.push(`runtime_security:${input.grantRequestId ?? "missing"}`);
      return { kind: "settled" as const };
    } },
  } as unknown as ContainedTurnKernelDependencies;
  assert.deepEqual(await recoverContainedTurnDispatchPreparations(recoveryDependencies, scope), {
    discovered: 1,
    retired: 0,
  });
  assert.deepEqual(recoveryCalls, ["custody"]);
  assert.equal(current.kind, "cleanup_pending");
  assert.equal(current.cleanupEvidenceIds.includes(historicalEvidenceId), true);

  const v1Retired = retireContainedTurnDispatchPreparation({
    ...active,
    providerAccessGrantRequestId: null,
    runtimeSecurityGrantRequestId: null,
  }, "retirement:persisted-v1");
  if (v1Retired.kind !== "cleanup_pending") {assert.fail("persisted v1 fixture did not retire");}
  const {
    providerAccessConsumptionEvidenceId: _v1ProviderEvidence,
    providerAccessGrantRequestId: _v1ProviderRequest,
    runtimeSecurityConsumptionEvidenceId: _v1SecurityEvidence,
    runtimeSecurityGrantRequestId: _v1SecurityRequest,
    ...v1Base
  } = v1Retired;
  const v1Decoded = decodeContainedTurnPreparation({
    ...v1Base,
    cleanupEvidenceIds: [historicalEvidenceId],
    custodyReleased: true,
    providerAccessSettled: true,
    runtimeSecuritySettled: true,
  }, null, 1);
  assert.equal(v1Decoded.kind, "cleanup_pending");
  if (v1Decoded.kind === "cleanup_pending") {
    assert.deepEqual(v1Decoded.cleanupEvidenceIds, [historicalEvidenceId]);
    assert.equal(v1Decoded.custodyReleased, false);
    assert.equal(v1Decoded.providerAccessSettled, false);
    assert.equal(v1Decoded.runtimeSecuritySettled, false);
  }

  const oversizedRow = {
    codecVersion: 3,
    payload: {
      ...decoded,
      cleanupEvidenceIds: Array.from(
        { length: CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT + 1 },
        (_unused, index) => containedTurnIdentity("evidence", `evidence:persisted-over-limit:${String(index)}`),
      ),
    },
  };
  assert.throws(
    () => decodeContainedTurnPreparation(
      oversizedRow, digestContainedTurnPostgresJson(oversizedRow), 3,
    ),
    (error: unknown) => error instanceof ContainedTurnStateQuarantineError && error.reason === "malformed",
  );
  let oversizedElementReads = 0;
  const oversizedEvidenceIds = Array.from(
    { length: CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT + 1 },
    (_unused, index) => containedTurnIdentity("evidence", `evidence:preflight-over-limit:${String(index)}`),
  );
  Object.defineProperty(oversizedEvidenceIds, 0, {
    enumerable: true,
    get: () => {
      oversizedElementReads += 1;
      return containedTurnIdentity("evidence", "evidence:preflight-over-limit:0");
    },
  });
  assert.throws(
    () => decodeContainedTurnPreparation({
      codecVersion: 3,
      payload: { ...decoded, cleanupEvidenceIds: oversizedEvidenceIds },
    }, "digest-must-not-be-evaluated", 3),
    (error: unknown) => error instanceof ContainedTurnStateQuarantineError && error.reason === "malformed",
  );
  assert.equal(oversizedElementReads, 0, "stored evidence is bounded before digest encoding");
});

test("restart recovery retires against the preparation revision rather than the advanced operation", async () => {
  const winner = createReservedOperation();
  const active = Object.freeze({
    attemptId: containedTurnIdentity("attempt", "attempt:recovery-loser"),
    custodyId: containedTurnIdentity("custody", "custody:recovery-loser"),
    kind: "active" as const,
    operationCutoffRevision: 0,
    operationId,
    preparationToken: containedTurnIdentity("preparation", "preparation:recovery-loser"),
    preparedOperationRevision: 1,
    providerAccessGrantRequestId: null,
    runtimeSecurityGrantRequestId: null,
    workspaceId,
  });
  assert.ok(winner.revision > active.preparedOperationRevision);
  let preparation = retireContainedTurnDispatchPreparation(active, "recovery-retirement");
  if (preparation.kind !== "cleanup_pending") {assert.fail("recovery fixture did not retire");}
  const retirementInputs: Array<{ expectedOperationRevision: number }> = [];
  let custodyReleases = 0;
  const dependencies = {
    custody: {
      releaseRetiredReservation: async () => {custodyReleases += 1; return { kind: "released" as const };},
    },
    operationStore: {
      listDispatchPreparations: async () => [{ operation: winner, preparation: active }],
      async recordDispatchPreparationCleanup(input) {
        assert.equal(this, dependencies.operationStore, "recovery preserves the owner method receiver");
        preparation = recordContainedTurnPreparationCleanup(preparation, input);
        return preparation;
      },
      retireDispatchPreparation: async input => {
        retirementInputs.push(input);
        return { kind: "retired" as const, preparation };
      },
    },
    providerAccess: { settleConsumedGrant: async () => {assert.fail("unknown legacy grant must not settle");} },
    security: { settleConsumedGrant: async () => {assert.fail("unknown legacy grant must not settle");} },
  } as unknown as ContainedTurnKernelDependencies;
  assert.deepEqual(await recoverContainedTurnDispatchPreparations(dependencies, scope), {
    discovered: 1,
    retired: 1,
  });
  assert.equal(retirementInputs[0]?.expectedOperationRevision, active.preparedOperationRevision);
  assert.equal(custodyReleases, 1);
  assert.equal(preparation.kind, "cleanup_pending", "custody release cannot close unproved owner obligations");
  assert.equal(preparation.custodyReleased, true);
  assert.equal(preparation.providerAccessSettled, false);
  assert.equal(preparation.runtimeSecuritySettled, false);
});

test("parallel grant consumption returns every indeterminate owner evidence", async () => {
  const operation = mutateContainedTurnOperation(createOperation(), { kind: "bind_workspace", workspaceId });
  const subject = grantSubject();
  const providerAccessEvidenceId = containedTurnIdentity(
    "evidence", "evidence:provider-access-parallel-indeterminate",
  );
  const runtimeSecurityEvidenceId = containedTurnIdentity(
    "evidence", "evidence:runtime-security-parallel-indeterminate",
  );
  const dependencies = {
    operationStore: { claimPreparedDispatch: unusedMandatoryDependency },
    providerAccess: {
      consumeForDispatch: async () => ({ evidenceId: providerAccessEvidenceId, kind: "indeterminate" as const }),
    },
    security: {
      consumeForDispatch: async () => ({ evidenceId: runtimeSecurityEvidenceId, kind: "indeterminate" as const }),
    },
  } as unknown as ContainedTurnKernelDependencies;
  const outcome = await claimContainedTurnWithConsumedGrants(
    dependencies,
    operation,
    scope,
    subject,
    {
      binding: {
        attemptId,
        authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
        custodyId,
        effectId,
        operationId,
      },
      kind: "host_custody",
      proofId: containedTurnIdentity("proof", "proof:parallel-indeterminate-host-custody"),
    },
  );
  assert.equal(outcome.kind, "indeterminate");
  if (outcome.kind === "indeterminate") {
    assert.equal(outcome.evidenceId, providerAccessEvidenceId);
    assert.deepEqual(outcome.consumptionEvidenceIds, {
      providerAccessEvidenceId,
      runtimeSecurityEvidenceId,
    });
    assert.equal(
      outcome.consumedGrantRequestIds.providerAccessGrantRequestId,
      containedTurnDispatchGrantRequestId("provider_access", subject),
    );
  }

  const rejected = await claimContainedTurnWithConsumedGrants(
    {
      ...dependencies,
      providerAccess: {
        consumeForDispatch: async () => {throw new Error("lost Provider Access acknowledgement");},
      },
    } as unknown as ContainedTurnKernelDependencies,
    operation,
    scope,
    subject,
    {
      binding: {
        attemptId,
        authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
        custodyId,
        effectId,
        operationId,
      },
      kind: "host_custody",
      proofId: containedTurnIdentity("proof", "proof:rejected-consumption-host-custody"),
    },
  );
  assert.equal(rejected.kind, "unavailable");
  if (rejected.kind !== "unavailable") {assert.fail("rejected owner call must remain unavailable");}
  assert.match(
    rejected.consumptionEvidenceIds.providerAccessEvidenceId ?? "",
    /^evidence:grant-consumption-unavailable:sha256:[a-f0-9]{64}$/u,
  );
  assert.equal(
    rejected.consumptionEvidenceIds.runtimeSecurityEvidenceId,
    runtimeSecurityEvidenceId,
  );
  assert.equal(
    rejected.consumedGrantRequestIds.providerAccessGrantRequestId,
    containedTurnDispatchGrantRequestId("provider_access", subject),
  );
});

test("normalized consumed receipts bind the exact final claim and reject replay conflicts", () => {
  const subject = grantSubject();
  const providerAccess = consumedReceipt("provider_access", subject);
  const runtimeSecurity = consumedReceipt("runtime_security", subject);
  const exact = validateContainedTurnConsumedGrantReceipts(subject, [providerAccess, runtimeSecurity]);
  const resanitized = validateContainedTurnConsumedGrantReceipts(subject, exact);
  assert.notStrictEqual(resanitized, exact);
  assert.deepEqual(resanitized, exact);
  assert.equal(Object.isFrozen(resanitized), true);
  assert.equal(Object.isFrozen(resanitized[0]), true);
  assert.throws(
    () => validateContainedTurnConsumedGrantReceipts(subject, [runtimeSecurity, providerAccess]),
    /ordered one per exact owner/u,
  );
  assert.throws(
    () => validateContainedTurnConsumedGrantReceipts(
      { ...subject, hostBootId: containedTurnIdentity("host_boot", "host-boot:restarted") },
      exact,
    ),
    /wrong claim binding/u,
  );
  assert.throws(
    () => validateContainedTurnConsumedGrantReceipts(subject, [
      { ...providerAccess, leakedOwnerEvidence: "forbidden" },
      runtimeSecurity,
    ]),
    /exact closed record/u,
  );
  for (const field of [
    "claimBindingDigest", "grantRequestDigest", "requestDigest",
  ] as const) {
    assert.throws(
      () => validateContainedTurnConsumedGrantReceipts(subject, [
        { ...providerAccess, [field]: "sha256:not-canonical" }, runtimeSecurity,
      ]),
      /digest/u,
    );
  }
  for (const grantRequestId of [
    "../../secret", "token=owner-secret", `grant-request:${"a".repeat(600)}`,
  ]) {
    assert.throws(
      () => validateContainedTurnConsumedGrantReceipts(subject, [
        { ...providerAccess, grantRequestId }, runtimeSecurity,
      ]),
      /exact final claim request|durable owner facts|digest/u,
    );
  }
  for (const cutoff of [-1, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.throws(
      () => validateContainedTurnConsumedGrantReceipts(subject, [
        { ...providerAccess, validThroughOperationCutoffRevision: cutoff }, runtimeSecurity,
      ]),
      /non-negative safe integer/u,
    );
  }
});

test("final claim follows both owner consumptions and only a fresh CAS exposes committed proof", async () => {
  const initial = mutateContainedTurnOperation(createOperation(), { kind: "bind_workspace", workspaceId });
  const subject = grantSubject();
  const normalizedReceipt = (owner: "provider_access" | "runtime_security") => consumedReceipt(owner, subject);
  const events: string[] = [];
  let observed = false;
  const winner = createReservedOperation();
  if (winner.dispatch.kind !== "claimed") {assert.fail("winner fixture is not claimed");}
  const durableWinner = Object.freeze({
    ...winner,
    dispatch: Object.freeze({
      ...winner.dispatch,
      grantReceipts: Object.freeze([
        normalizedReceipt("provider_access"), normalizedReceipt("runtime_security"),
      ]),
    }),
    proofs: Object.freeze(winner.proofs.map(proof => proof.kind === "provider_access_dispatch"
      ? Object.freeze({ ...proof, binding: Object.freeze({
        ...proof.binding, resolutionDigest: digestContainedTurnCanonicalValue(normalizedReceipt("provider_access") as never),
      }) })
      : proof.kind === "runtime_security_dispatch"
        ? Object.freeze({ ...proof, binding: Object.freeze({
          ...proof.binding, currentSecurityDecisionDigest: digestContainedTurnCanonicalValue(normalizedReceipt("runtime_security") as never),
        }) })
        : proof.kind === "host_custody"
          ? Object.freeze({
            binding: Object.freeze({ attemptId, authorityVectorDigest: initial.acceptedAuthorityVectorDigest,
              custodyId, effectId, operationId }), kind: "host_custody" as const,
            proofId: containedTurnIdentity("proof", "proof:dispatch-grant-host-custody"),
          })
          : proof)),
  });
  const committedDispatchProof = committedDispatchProofForClaim(
    durableWinner, subject, Object.freeze({
      binding: Object.freeze({ attemptId, authorityVectorDigest: initial.acceptedAuthorityVectorDigest,
        custodyId, effectId, operationId }), kind: "host_custody" as const,
      proofId: containedTurnIdentity("proof", "proof:dispatch-grant-host-custody"),
    }), durableWinner.dispatch.grantReceipts,
  );
  const dependencies = createContainedTurnPreparationScopeDependencies({
    operationStore: {
      preventIntent: async () => ({ kind: "denied" as const }),
      claimPreparedDispatch: async () => {
        events.push("agent-execution:final-claim");
        return observed
          ? { kind: "observed_claim" as const, operation: durableWinner }
          : { committedDispatchProof, kind: "claimed" as const, operation: durableWinner };
      },
      recordDispatchPreparationCleanup: unusedMandatoryDependency,
      retireDispatchPreparation: unusedMandatoryDependency,
    },
    providerAccess: {
      consumeForDispatch: async () => {
        events.push("provider-access:consumed");
        return { kind: "consumed" as const, receipt: normalizedReceipt("provider_access") };
      },
      settleConsumedGrant: async input => {events.push("provider-access:" + input.disposition); return { kind: "settled" as const };},
    },
    security: {
      consumeForDispatch: async () => {
        events.push("runtime-security:consumed");
        return { kind: "consumed" as const, receipt: normalizedReceipt("runtime_security") };
      },
      settleConsumedGrant: async input => {events.push("runtime-security:" + input.disposition); return { kind: "settled" as const };},
    },
    workspace: { ensureClosed: unusedMandatoryDependency, queryClosure: unusedMandatoryDependency },
    artifacts: { ensureSealed: unusedMandatoryDependency, querySeal: unusedMandatoryDependency },
    custody: {
      attestContainment: unusedMandatoryDependency,
      ensurePhysicalContainment: unusedMandatoryDependency,
      queryContainmentAttestation: unusedMandatoryDependency,
      queryPhysicalContainment: unusedMandatoryDependency,
      releaseRetiredReservation: unusedMandatoryDependency,
    },
    provider: {},
  } as unknown as ContainedTurnKernelDependencies);
  const hostCustodyProof = Object.freeze({
    binding: Object.freeze({
      attemptId,
      authorityVectorDigest: initial.acceptedAuthorityVectorDigest,
      custodyId,
      effectId,
      operationId,
    }),
    kind: "host_custody" as const,
    proofId: containedTurnIdentity("proof", "proof:dispatch-grant-host-custody"),
  });
  const claimed = await claimContainedTurnWithConsumedGrants(
    dependencies, initial, scope, subject, hostCustodyProof,
  );
  assert.equal(claimed.kind, "claimed");
  if (claimed.kind === "claimed") {assert.deepEqual(claimed.committedDispatchProof, committedDispatchProof);}
  assert.deepEqual(events, [
    "provider-access:consumed",
    "runtime-security:consumed",
    "agent-execution:final-claim",
    "provider-access:claim_committed",
    "runtime-security:claim_committed",
  ]);

  events.length = 0;
  assert.deepEqual(
    await recoverContainedTurnCommittedGrantSettlements(dependencies, durableWinner),
    { attempted: 2 },
  );
  assert.deepEqual(events, [
    "provider-access:claim_committed",
    "runtime-security:claim_committed",
  ], "lost settlement acknowledgements replay from receipts without consumption or claim");

  observed = true;
  events.length = 0;
  const replay = await claimContainedTurnWithConsumedGrants(
    dependencies, initial, scope, subject, hostCustodyProof,
  );
  assert.equal(replay.kind, "observed_claim");
  assert.equal("committedDispatchProof" in replay, false, "a replay cannot manufacture committed dispatch proof");
});

test("dispatch grant ACL preserves explicit owner facts without accepting opaque proof digests", () => {
  const subject = grantSubject();
  const raw = consumedReceipt("provider_access", subject);
  const { grantRequestDigest: _requestDigest, owner: _owner, validThroughOperationCutoffRevision: _cutoff, ...outer } = raw;
  const normalized = normalizeContainedTurnConsumedGrantReceipt("provider_access", subject, outer);
  assert.deepEqual(normalized.authorityFacts, subject.providerAccessExpectation);
  assert.equal(normalized.ownerEvidenceRef, raw.ownerEvidenceRef);
  assert.throws(() => normalizeContainedTurnConsumedGrantReceipt("provider_access", subject, {
    ...outer, grantRequestId: subject.runtimeSecurityRequest.grantRequestId,
  }), /substituted/u);
});
