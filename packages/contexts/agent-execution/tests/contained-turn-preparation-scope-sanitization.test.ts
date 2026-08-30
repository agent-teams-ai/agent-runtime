import assert from "node:assert/strict";
import test from "node:test";

import { claimContainedTurnWithConsumedGrants } from "../dist/features/contained-agent-turn/application/contained-turn-grant-claim.js";
import { retireAndCleanupContainedTurnPreparation } from "../dist/features/contained-agent-turn/application/contained-turn-preparation-cleanup.js";
import type { ContainedTurnKernelDependencies } from "../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { containedTurnScopeDigest } from "../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnDispatchClaimBindingDigest } from "../dist/features/contained-agent-turn/domain/contained-turn-dispatch-authority.js";
import {
  recordContainedTurnPreparationCleanup,
  retireContainedTurnDispatchPreparation,
  type ContainedTurnDispatchPreparation,
} from "../dist/features/contained-agent-turn/domain/contained-turn-dispatch-preparation.js";
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

const initial = mutateContainedTurnOperation(createOperation(), { kind: "bind_workspace", workspaceId });
const winner = createReservedOperation();
const subject = Object.freeze({
  attemptId,
  custodyId,
  effectId,
  executionGenerationId,
  hostBootId,
  hostInstanceId,
  operationCutoffRevision: initial.operationCutoff.revision,
  operationId,
  preparationToken,
  purpose: "contained_turn_provider_start_v1" as const,
  scopeDigest: containedTurnScopeDigest(scope),
  workspaceId,
});

const consumedReceipt = (owner: "provider_access" | "runtime_security") => Object.freeze({
  claimBindingDigest: containedTurnDispatchClaimBindingDigest(subject),
  grantRequestDigest: digestContainedTurnCanonicalValue({ owner, request: "scope-sanitization" }),
  grantRequestId: `${owner}:grant:scope-sanitization`,
  owner,
  ownerAuthorityDigest: digestContainedTurnCanonicalValue({ owner, revision: 1 }),
  ownerReceiptDigest: digestContainedTurnCanonicalValue({ owner, state: "consumed_pending" }),
  validThroughOperationCutoffRevision: initial.operationCutoff.revision,
});

const claimDependencies = (
  outcome: Awaited<ReturnType<NonNullable<ContainedTurnKernelDependencies["operationStore"]["claimPreparedDispatch"]>>>,
): ContainedTurnKernelDependencies => ({
  operationStore: { claimPreparedDispatch: async () => outcome },
  providerAccess: {
    consumeForDispatch: async () => ({ kind: "consumed", receipt: consumedReceipt("provider_access") }),
  },
  security: {
    consumeForDispatch: async () => ({ kind: "consumed", receipt: consumedReceipt("runtime_security") }),
  },
} as unknown as ContainedTurnKernelDependencies);

const foreignOperationMutations: readonly ((operation: ContainedTurnKernelOperation) => ContainedTurnKernelOperation)[] = [
  operation => ({ ...operation, scope: { ...operation.scope, tenantId: "tenant:foreign" } }),
  operation => ({ ...operation, scope: { ...operation.scope, projectId: "project:foreign" } }),
  operation => ({ ...operation, operationId: containedTurnIdentity("operation", "operation:foreign") }),
  operation => ({ ...operation, commandId: containedTurnIdentity("command", "command:foreign") }),
  operation => ({ ...operation, effectId: containedTurnIdentity("effect", "effect:foreign") }),
  operation => operation.dispatch.kind === "claimed"
    ? { ...operation, dispatch: { ...operation.dispatch, preparationToken: containedTurnIdentity("preparation", "preparation:foreign") } }
    : operation,
  operation => operation.dispatch.kind === "claimed"
    ? { ...operation, dispatch: { ...operation.dispatch, attemptId: containedTurnIdentity("attempt", "attempt:foreign") } }
    : operation,
  operation => operation.dispatch.kind === "claimed"
    ? { ...operation, dispatch: { ...operation.dispatch, executionGenerationId: containedTurnIdentity("execution_generation", "execution-generation:foreign") } }
    : operation,
  operation => operation.dispatch.kind === "claimed"
    ? { ...operation, dispatch: { ...operation.dispatch, operationCutoffRevision: 1 } }
    : operation,
  operation => ({ ...operation, custodyId: containedTurnIdentity("custody", "custody:foreign") }),
  operation => ({ ...operation, hostBootId: containedTurnIdentity("host_boot", "host-boot:foreign") }),
  operation => ({ ...operation, hostInstanceId: containedTurnIdentity("host_instance", "host-instance:foreign") }),
  operation => ({ ...operation, workspaceId: containedTurnIdentity("workspace", "workspace:foreign") }),
];

test("prepared claim claimed, observed, and stale outcomes collapse foreign owner aggregates", async () => {
  for (const mutate of foreignOperationMutations) {
    const foreign = { ...mutate(winner), foreignAggregate: "must-not-leak" } as ContainedTurnKernelOperation;
    for (const outcome of [
      { kind: "claimed" as const, operation: foreign, startAuthority: "foreign-start" },
      { kind: "observed_claim" as const, operation: foreign },
      { current: foreign, kind: "stale" as const },
    ]) {
      const result = await claimContainedTurnWithConsumedGrants(
        claimDependencies(outcome), initial, scope, subject,
      );
      assert.deepEqual(result, { kind: "unavailable" });
      assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
    }
  }
});

const activePreparation = Object.freeze({
  attemptId,
  custodyId,
  kind: "active" as const,
  operationCutoffRevision: initial.operationCutoff.revision,
  operationId,
  preparationToken,
  preparedOperationRevision: initial.revision,
  providerAccessGrantRequestId: "provider-access-grant:scope-sanitization",
  runtimeSecurityGrantRequestId: "runtime-security-grant:scope-sanitization",
  workspaceId,
});
const retiredPreparation = retireContainedTurnDispatchPreparation(activePreparation, "retirement:scope-sanitization");
if (retiredPreparation.kind !== "cleanup_pending") {throw new TypeError("fixture retirement failed");}

const cleanupDependencies = (input: Readonly<{
  record?: (target: "custody" | "provider_access" | "runtime_security") => ContainedTurnDispatchPreparation;
  retirement: Awaited<ReturnType<NonNullable<ContainedTurnKernelDependencies["operationStore"]["retireDispatchPreparation"]>>>;
}>): ContainedTurnKernelDependencies => ({
  custody: { releaseRetiredReservation: async () => ({ kind: "released" }) },
  operationStore: {
    recordDispatchPreparationCleanup: async ({ target }) => input.record?.(target) ?? retiredPreparation,
    retireDispatchPreparation: async () => input.retirement,
  },
  providerAccess: { settleConsumedGrant: async () => ({ kind: "settled" }) },
  security: { settleConsumedGrant: async () => ({ kind: "settled" }) },
} as unknown as ContainedTurnKernelDependencies);

test("retirement claimed and stale outcomes never adopt foreign operation or preparation owners", async () => {
  for (const mutate of foreignOperationMutations) {
    const foreign = { ...mutate(winner), foreignAggregate: "must-not-leak" } as ContainedTurnKernelOperation;
    const claimed = await retireAndCleanupContainedTurnPreparation(
      cleanupDependencies({ retirement: { kind: "claimed", operation: foreign } }),
      initial, scope, subject, "reconciliation",
    );
    assert.deepEqual(claimed, { kind: "cleanup_pending", operation: initial });

    const stale = await retireAndCleanupContainedTurnPreparation(
      cleanupDependencies({ retirement: { current: foreign, kind: "stale" } }),
      initial, scope, subject, "reconciliation",
    );
    assert.deepEqual(stale, { kind: "cleanup_pending", operation: initial });
    assert.equal(JSON.stringify([claimed, stale]).includes("must-not-leak"), false);
  }

  const foreignPreparation = {
    ...retiredPreparation,
    operationId: containedTurnIdentity("operation", "operation:foreign-preparation"),
    foreignAggregate: "must-not-leak",
  } as ContainedTurnDispatchPreparation;
  const retired = await retireAndCleanupContainedTurnPreparation(
    cleanupDependencies({ retirement: { kind: "retired", preparation: foreignPreparation as typeof retiredPreparation } }),
    initial, scope, subject, "reconciliation",
  );
  assert.deepEqual(retired, { kind: "cleanup_pending", operation: initial });
});

test("cleanup record outcomes adopt only exact preparation and permit owner identities", async () => {
  const foreignPreparation = {
    ...retiredPreparation,
    providerAccessGrantRequestId: "provider-access-grant:foreign",
    foreignAggregate: "must-not-leak",
  } as ContainedTurnDispatchPreparation;
  const rejected = await retireAndCleanupContainedTurnPreparation(
    cleanupDependencies({
      record: () => foreignPreparation,
      retirement: { kind: "retired", preparation: retiredPreparation },
    }),
    initial, scope, subject, "reconciliation",
  );
  assert.equal(rejected.kind, "cleanup_pending");
  assert.strictEqual(rejected.preparation, retiredPreparation);
  assert.equal(JSON.stringify(rejected).includes("must-not-leak"), false);

  let current: ContainedTurnDispatchPreparation = retiredPreparation;
  const closed = await retireAndCleanupContainedTurnPreparation(
    cleanupDependencies({
      record: target => {
        current = recordContainedTurnPreparationCleanup(current, {
          permit: retiredPreparation.cleanupPermit,
          target,
        });
        return current;
      },
      retirement: { kind: "retired", preparation: retiredPreparation },
    }),
    initial, scope, subject, "reconciliation",
  );
  assert.equal(closed.kind, "cleanup_closed");
  if (closed.kind === "cleanup_closed") {assert.strictEqual(closed.preparation, current);}
});
