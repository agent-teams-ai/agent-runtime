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

test("prepared claim rejects same-owner extras and returns only a detached frozen Kernel projection", async () => {
  const withExtra = { ...winner, foreignAggregate: "must-not-leak" } as ContainedTurnKernelOperation;
  const rejected = await claimContainedTurnWithConsumedGrants(
    claimDependencies({ kind: "claimed", operation: withExtra, startAuthority: "start:scope-sanitization" }),
    initial, scope, subject,
  );
  assert.deepEqual(rejected, { kind: "unavailable" });

  const accepted = await claimContainedTurnWithConsumedGrants(
    claimDependencies({ kind: "claimed", operation: winner, startAuthority: "start:scope-sanitization" }),
    initial, scope, subject,
  );
  assert.equal(accepted.kind, "claimed");
  if (accepted.kind === "claimed") {
    assert.notStrictEqual(accepted.operation, winner);
    assert.deepEqual(accepted.operation, winner);
    assert.equal(Object.isFrozen(accepted), true);
    assert.equal(Object.isFrozen(accepted.operation), true);
  }
});

test("prepared claim rejects proxies, accessors, sparse or augmented arrays without invoking hostile code", async () => {
  let traps = 0;
  let getters = 0;
  const proxiedDispatch = new Proxy({ ...winner.dispatch }, {
    getOwnPropertyDescriptor: () => {traps += 1; throw new TypeError("trap must not run");},
    ownKeys: () => {traps += 1; throw new TypeError("trap must not run");},
  });
  const accessorOperation = structuredClone(winner);
  Object.defineProperty(accessorOperation, "revision", {
    enumerable: true,
    get: () => {getters += 1; return winner.revision;},
  });
  const augmentedProofs = [...winner.proofs] as ContainedTurnKernelOperation["proofs"] & { extra?: string };
  augmentedProofs.extra = "must-not-leak";
  const sparseProofs = [...winner.proofs];
  delete sparseProofs[0];
  const operations = [
    { ...winner, dispatch: proxiedDispatch },
    accessorOperation,
    { ...winner, proofs: augmentedProofs },
    { ...winner, proofs: sparseProofs },
  ] as ContainedTurnKernelOperation[];
  for (const operation of operations) {
    const result = await claimContainedTurnWithConsumedGrants(
      claimDependencies({ kind: "observed_claim", operation }), initial, scope, subject,
    );
    assert.deepEqual(result, { kind: "unavailable" });
  }
  const proxiedOutcome = new Proxy({ kind: "observed_claim" as const, operation: winner }, {
    ownKeys: () => {traps += 1; throw new TypeError("outcome trap must not run");},
  });
  assert.deepEqual(
    await claimContainedTurnWithConsumedGrants(claimDependencies(proxiedOutcome), initial, scope, subject),
    { kind: "unavailable" },
  );
  assert.equal(traps, 0);
  assert.equal(getters, 0);
});

test("prepared claim snapshots mutable aliases and rejects owner outcome extras", async () => {
  const mutableWinner = structuredClone(winner);
  const accepted = await claimContainedTurnWithConsumedGrants(
    claimDependencies({ kind: "observed_claim", operation: mutableWinner }), initial, scope, subject,
  );
  assert.equal(accepted.kind, "observed_claim");
  if (accepted.kind === "observed_claim") {
    mutableWinner.scope.tenantId = "tenant:mutated-after-return";
    assert.equal(accepted.operation.scope.tenantId, scope.tenantId);
    assert.notStrictEqual(accepted.operation.scope, mutableWinner.scope);
    assert.equal(Object.isFrozen(accepted.operation.scope), true);
  }
  const outcomeWithExtra = {
    kind: "observed_claim" as const,
    operation: winner,
    rawOwnerPayload: "must-not-leak",
  };
  assert.deepEqual(
    await claimContainedTurnWithConsumedGrants(claimDependencies(outcomeWithExtra), initial, scope, subject),
    { kind: "unavailable" },
  );
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
  assert.notStrictEqual(rejected.preparation, retiredPreparation);
  assert.deepEqual(rejected.preparation, retiredPreparation);
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
  if (closed.kind === "cleanup_closed") {
    assert.notStrictEqual(closed.preparation, current);
    assert.deepEqual(closed.preparation, current);
    assert.equal(Object.isFrozen(closed.preparation), true);
  }
});

test("cleanup permits reject extras, forged digest or ID, accessors, proxies, and cross-owner substitution", async () => {
  const attempts: ContainedTurnDispatchPreparation[] = [
    {
      ...retiredPreparation,
      cleanupPermit: { ...retiredPreparation.cleanupPermit, extra: "same-owner-extra" },
    } as ContainedTurnDispatchPreparation,
    {
      ...retiredPreparation,
      cleanupPermit: {
        ...retiredPreparation.cleanupPermit,
        permitDigest: digestContainedTurnCanonicalValue({ forged: "digest" }),
      },
    } as ContainedTurnDispatchPreparation,
    {
      ...retiredPreparation,
      cleanupPermit: {
        ...retiredPreparation.cleanupPermit,
        permitId: containedTurnIdentity("cleanup_permit", "cleanup-permit:forged"),
      },
    } as ContainedTurnDispatchPreparation,
    {
      ...retiredPreparation,
      cleanupPermit: {
        ...retiredPreparation.cleanupPermit,
        operationId: containedTurnIdentity("operation", "operation:foreign-permit-owner"),
      },
    } as ContainedTurnDispatchPreparation,
  ];
  const accessorPermit = { ...retiredPreparation.cleanupPermit };
  Object.defineProperty(accessorPermit, "permitDigest", {
    enumerable: true,
    get: () => retiredPreparation.cleanupPermit.permitDigest,
  });
  attempts.push({ ...retiredPreparation, cleanupPermit: accessorPermit } as ContainedTurnDispatchPreparation);
  attempts.push({
    ...retiredPreparation,
    cleanupPermit: new Proxy({ ...retiredPreparation.cleanupPermit }, {}),
  } as ContainedTurnDispatchPreparation);
  const augmentedEvidenceIds = [...retiredPreparation.cleanupEvidenceIds] as string[] & { extra?: string };
  augmentedEvidenceIds.extra = "must-not-leak";
  attempts.push({ ...retiredPreparation, cleanupEvidenceIds: augmentedEvidenceIds });
  const sparseEvidenceIds = ["evidence:scope-sanitization"];
  delete sparseEvidenceIds[0];
  attempts.push({ ...retiredPreparation, cleanupEvidenceIds: sparseEvidenceIds });

  for (const preparation of attempts) {
    let calls = 0;
    const dependencies = cleanupDependencies({ retirement: { kind: "retired", preparation: preparation as typeof retiredPreparation } });
    dependencies.custody.releaseRetiredReservation = async () => {calls += 1; return { kind: "released" };};
    dependencies.providerAccess.settleConsumedGrant = async () => {calls += 1; return { kind: "settled" };};
    dependencies.security.settleConsumedGrant = async () => {calls += 1; return { kind: "settled" };};
    const outcome = await retireAndCleanupContainedTurnPreparation(
      dependencies, initial, scope, subject, "reconciliation",
    );
    assert.deepEqual(outcome, { kind: "cleanup_pending", operation: initial });
    assert.equal(calls, 0);
  }
});

test("cleanup snapshots once before owner calls and never forwards or returns owner-store aggregates", async () => {
  const rawPermit = { ...retiredPreparation.cleanupPermit };
  const rawPreparation = {
    ...retiredPreparation,
    cleanupEvidenceIds: [],
    cleanupPermit: rawPermit,
  } as Extract<ContainedTurnDispatchPreparation, { readonly kind: "cleanup_pending" }>;
  const receivedPermits: unknown[] = [];
  const recordedAggregates: ContainedTurnDispatchPreparation[] = [];
  let current: ContainedTurnDispatchPreparation = retiredPreparation;
  const dependencies = cleanupDependencies({
    record: target => {
      current = recordContainedTurnPreparationCleanup(current, {
        permit: retiredPreparation.cleanupPermit,
        target,
      });
      const rawRecorded = { ...current } as ContainedTurnDispatchPreparation;
      recordedAggregates.push(rawRecorded);
      return rawRecorded;
    },
    retirement: { kind: "retired", preparation: rawPreparation },
  });
  dependencies.custody.releaseRetiredReservation = async input => {
    receivedPermits.push(input.cleanupPermit);
    rawPermit.operationId = containedTurnIdentity("operation", "operation:mutated-after-snapshot");
    return { kind: "released" };
  };
  dependencies.providerAccess.settleConsumedGrant = async input => {
    receivedPermits.push(input.cleanupPermit);
    return { kind: "settled" };
  };
  dependencies.security.settleConsumedGrant = async input => {
    receivedPermits.push(input.cleanupPermit);
    return { kind: "settled" };
  };

  const outcome = await retireAndCleanupContainedTurnPreparation(
    dependencies, initial, scope, subject, "reconciliation",
  );
  assert.equal(receivedPermits.length, 3);
  assert.equal(recordedAggregates.length, 3);
  assert.equal(outcome.kind, "cleanup_closed");
  for (const permit of receivedPermits) {
    assert.notStrictEqual(permit, rawPermit);
    assert.strictEqual(permit, receivedPermits[0]);
    assert.deepEqual(permit, retiredPreparation.cleanupPermit);
    assert.equal(Object.isFrozen(permit), true);
  }
  if (outcome.kind === "cleanup_closed") {
    assert.equal(recordedAggregates.includes(outcome.preparation), false);
    assert.equal(outcome.preparation.operationId, operationId);
    assert.equal(Object.isFrozen(outcome.preparation), true);
  }
});

test("cleanup rejects owner proxies, accessors, and outcome extras without invoking hostile code", async () => {
  let traps = 0;
  let getters = 0;
  const proxiedPreparation = new Proxy({ ...retiredPreparation }, {
    ownKeys: () => {traps += 1; throw new TypeError("preparation trap must not run");},
  });
  assert.deepEqual(
    await retireAndCleanupContainedTurnPreparation(
      cleanupDependencies({ retirement: { kind: "retired", preparation: proxiedPreparation } }),
      initial, scope, subject, "reconciliation",
    ),
    { kind: "cleanup_pending", operation: initial },
  );
  const dependencies = cleanupDependencies({ retirement: { kind: "retired", preparation: retiredPreparation } });
  dependencies.custody.releaseRetiredReservation = async () => {
    const outcome = {};
    Object.defineProperty(outcome, "kind", {
      enumerable: true,
      get: () => {getters += 1; return "released";},
    });
    return outcome as { readonly kind: "released" };
  };
  dependencies.providerAccess.settleConsumedGrant = async () =>
    ({ kind: "settled", rawOwnerPayload: "must-not-leak" }) as { readonly kind: "settled" };
  dependencies.security.settleConsumedGrant = async () => new Proxy({ kind: "settled" as const }, {
    ownKeys: () => {traps += 1; throw new TypeError("cleanup outcome trap must not run");},
  });
  const outcome = await retireAndCleanupContainedTurnPreparation(
    dependencies, initial, scope, subject, "reconciliation",
  );
  assert.equal(outcome.kind, "cleanup_pending");
  assert.equal(JSON.stringify(outcome).includes("must-not-leak"), false);
  assert.equal(traps, 0);
  assert.equal(getters, 0);
});
