import assert from "node:assert/strict";
import test from "node:test";

import { reconcileContainedTurnClaimPreparation } from "../dist/features/contained-agent-turn/application/contained-turn-preparation-cleanup.js";
import { claimContainedTurnWithConsumedGrants } from "../dist/features/contained-agent-turn/application/contained-turn-grant-claim.js";
import { normalizeContainedTurnConsumedGrantReceipt } from "../dist/features/contained-agent-turn/composition/dispatch-grant-anti-corruption.js";
import { createContainedTurnPreparationScopeDependencies } from "../dist/features/contained-agent-turn/composition/preparation-scope-anti-corruption.js";
import { containedTurnScopeDigest } from "../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {
  containedTurnDispatchClaimBindingDigest,
  validateContainedTurnConsumedGrantReceipts,
} from "../dist/features/contained-agent-turn/domain/contained-turn-dispatch-authority.js";
import {
  claimContainedTurnDispatchPreparation,
  recordContainedTurnPreparationCleanup,
  retireContainedTurnDispatchPreparation,
} from "../dist/features/contained-agent-turn/domain/contained-turn-dispatch-preparation.js";
import type { ContainedTurnKernelDependencies } from "../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { containedTurnIdentity } from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../dist/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import { mutateContainedTurnOperation } from "../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import {
  attemptId,
  createOperation,
  createReservedOperation,
  custodyId,
  effectId,
  executionGenerationId,
  hostBootId,
  hostInstanceId,
  operationId,
  preparationToken,
  scope,
  workspaceId,
} from "./contained-turn-kernel-fixtures.ts";

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

test("retirement closes the cleanup TOCTOU and exact permit replay is monotone", () => {
  const active = Object.freeze({
    attemptId,
    custodyId,
    kind: "active" as const,
    operationCutoffRevision: 0,
    operationId,
    preparationToken,
    preparedOperationRevision: 1,
    providerAccessGrantRequestId: "provider-access-grant:1",
    runtimeSecurityGrantRequestId: "runtime-security-grant:1",
    workspaceId,
  });
  const retired = retireContainedTurnDispatchPreparation(active, "retirement:1");
  assert.equal(retired.kind, "cleanup_pending");
  assert.throws(() => claimContainedTurnDispatchPreparation(retired), /never be claimed/u);
  if (retired.kind !== "cleanup_pending") {return;}

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
});

test("normalized consumed receipts bind the exact final claim and reject replay conflicts", () => {
  const subject = Object.freeze({
    attemptId,
    custodyId,
    effectId,
    executionGenerationId,
    hostBootId,
    hostInstanceId,
    operationCutoffRevision: 0,
    operationId,
    preparationToken,
    purpose: "contained_turn_provider_start_v1" as const,
    scopeDigest: containedTurnScopeDigest(scope),
    workspaceId,
  });
  const claimBindingDigest = containedTurnDispatchClaimBindingDigest(subject);
  const receipt = (owner: "provider_access" | "runtime_security") => {
    const grantRequestDigest = digestContainedTurnCanonicalValue({ owner, request: 1 });
    return Object.freeze({
      claimBindingDigest,
      grantRequestDigest,
      grantRequestId: `grant-request:${grantRequestDigest}`,
      owner,
      ownerAuthorityDigest: digestContainedTurnCanonicalValue({ authority: owner }),
      ownerReceiptDigest: digestContainedTurnCanonicalValue({ owner, receipt: 1 }),
      validThroughOperationCutoffRevision: 0,
    });
  };
  const providerAccess = receipt("provider_access");
  const runtimeSecurity = receipt("runtime_security");
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
    "claimBindingDigest", "grantRequestDigest", "ownerAuthorityDigest", "ownerReceiptDigest",
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
      /canonical digest-bound ID/u,
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

test("final claim follows both owner consumptions and only a fresh CAS exposes start authority", async () => {
  const subject = Object.freeze({
    attemptId,
    custodyId,
    effectId,
    executionGenerationId,
    hostBootId,
    hostInstanceId,
    operationCutoffRevision: 0,
    operationId,
    preparationToken,
    purpose: "contained_turn_provider_start_v1" as const,
    scopeDigest: containedTurnScopeDigest(scope),
    workspaceId,
  });
  const claimBindingDigest = containedTurnDispatchClaimBindingDigest(subject);
  const normalizedReceipt = (owner: "provider_access" | "runtime_security") => {
    const grantRequestDigest = digestContainedTurnCanonicalValue({ owner, request: "exact" });
    return {
      claimBindingDigest,
      grantRequestDigest,
      grantRequestId: `grant-request:${grantRequestDigest}`,
      owner,
      ownerAuthorityDigest: digestContainedTurnCanonicalValue({ owner, revision: 1 }),
      ownerReceiptDigest: digestContainedTurnCanonicalValue({ owner, state: "consumed_pending" }),
      validThroughOperationCutoffRevision: 0,
    };
  };
  const events: string[] = [];
  let observed = false;
  const winner = createReservedOperation();
  const dependencies = createContainedTurnPreparationScopeDependencies({
    operationStore: {
      claimPreparedDispatch: async () => {
        events.push("agent-execution:final-claim");
        return observed
          ? { kind: "observed_claim" as const, operation: winner }
          : { kind: "claimed" as const, operation: winner, startAuthority: "host-start-once:1" };
      },
      recordDispatchPreparationCleanup: unusedMandatoryDependency,
      retireDispatchPreparation: unusedMandatoryDependency,
    },
    providerAccess: {
      consumeForDispatch: async () => {
        events.push("provider-access:consumed");
        return { kind: "consumed" as const, receipt: normalizedReceipt("provider_access") };
      },
      settleConsumedGrant: unusedMandatoryDependency,
    },
    security: {
      consumeForDispatch: async () => {
        events.push("runtime-security:consumed");
        return { kind: "consumed" as const, receipt: normalizedReceipt("runtime_security") };
      },
      settleConsumedGrant: unusedMandatoryDependency,
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
  const initial = mutateContainedTurnOperation(createOperation(), { kind: "bind_workspace", workspaceId });
  const claimed = await claimContainedTurnWithConsumedGrants(dependencies, initial, scope, subject);
  assert.equal(claimed.kind, "claimed");
  if (claimed.kind === "claimed") {assert.equal(claimed.startAuthority, "host-start-once:1");}
  assert.deepEqual(events, [
    "provider-access:consumed",
    "runtime-security:consumed",
    "agent-execution:final-claim",
  ]);

  observed = true;
  events.length = 0;
  const replay = await claimContainedTurnWithConsumedGrants(dependencies, initial, scope, subject);
  assert.equal(replay.kind, "observed_claim");
  assert.equal("startAuthority" in replay, false, "a replay cannot manufacture one-use start authority");
});

test("dispatch grant ACL hashes every owner-local reference before it reaches Kernel", () => {
  const subject = {
    attemptId, custodyId, effectId, executionGenerationId, hostBootId, hostInstanceId,
    operationCutoffRevision: 0, operationId, preparationToken,
    purpose: "contained_turn_provider_start_v1" as const,
    scopeDigest: containedTurnScopeDigest(scope), workspaceId,
  };
  const raw = {
    grantRequestRef: "provider-secret-request-ref",
    ownerAuthorityRef: "provider-secret-authority-ref",
    ownerReceiptRef: "provider-secret-receipt-ref",
    validThroughOperationCutoffRevision: 0,
  };
  const normalized = normalizeContainedTurnConsumedGrantReceipt("provider_access", subject, raw);
  assert.equal(JSON.stringify(normalized).includes("provider-secret"), false);
  assert.match(normalized.grantRequestId, /^grant-request:sha256:/u);
});
