import assert from "node:assert/strict";
import test from "node:test";

import { containedTurnPreparationToken } from "../../../dist/features/contained-agent-turn/application/contained-turn-preparation-cleanup.js";
import { createContainedTurnPreparationScopeDependencies } from "../../../dist/features/contained-agent-turn/composition/preparation-scope-anti-corruption.js";
import { createContainedTurnFeature } from "../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import type { ContainedTurnKernelDependencies } from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { awaitFixtureGate, createDependencies, operationId } from "./support/contained-agent-turn-fixture.ts";

const scope = Object.freeze({ projectId: "project:one", tenantId: "tenant:one" });
const submissionInput = Object.freeze({
  commandId: "command:one", expectedProvider: "codex" as const,
  intent: { mode: "analysis" as const, prompt: "synthetic cleanup cancellation interleaving" },
  scope,
});
const targets = ["custody", "provider_access", "runtime_security"] as const;
type CleanupTarget = typeof targets[number];

const createCleanupRace = (options: Readonly<{
  indeterminate?: CleanupTarget;
  extraPreparations?: number;
  closeExtraPreparations?: boolean;
  pause: CleanupTarget | "recorded";
}>) => {
  // Both grants are consumed before the final claim loses. No provider starts.
  const fixture = createDependencies({ staleClaimAuthority: true });
  const { dependencies } = fixture;
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const calls = { custody: 0, provider_access: 0, runtime_security: 0 };
  const evidenceId = containedTurnIdentity("evidence", "evidence:cleanup-race-indeterminate");
  let terminalCommits = 0;
  let workspaceClosures = 0;
  let artifactSeals = 0;
  const cleanup = async <Outcome>(target: CleanupTarget, effect: () => Promise<Outcome>) => {
    calls[target] += 1;
    if (options.pause === target) {
      entered.resolve();
      await resume.promise;
    }
    return target === options.indeterminate
      ? { evidenceId, kind: "indeterminate" as const }
      : effect();
  };
  const configured: ContainedTurnKernelDependencies = {
    ...dependencies,
    custody: {
      ...dependencies.custody,
      releaseRetiredReservation: input => cleanup("custody", () => dependencies.custody.releaseRetiredReservation(input)),
    },
    providerAccess: {
      ...dependencies.providerAccess,
      settleConsumedGrant: input => cleanup("provider_access", () => dependencies.providerAccess.settleConsumedGrant(input)),
    },
    security: {
      ...dependencies.security,
      settleConsumedGrant: input => cleanup("runtime_security", () => dependencies.security.settleConsumedGrant(input)),
    },
    workspace: {
      ...dependencies.workspace,
      ensureClosed: input => {workspaceClosures += 1; return dependencies.workspace.ensureClosed(input);},
    },
    artifacts: {
      ...dependencies.artifacts,
      ensureSealed: input => {artifactSeals += 1; return dependencies.artifacts.ensureSealed(input);},
    },
    operationStore: {
      ...dependencies.operationStore,
      prepareDispatch: async input => {
        for (let index = 0; index < (options.extraPreparations ?? 0); index += 1) {
          const prepared = await dependencies.operationStore.prepareDispatch(input);
          if (options.closeExtraPreparations === true) {
            const preparationToken = containedTurnPreparationToken({ ...prepared, operationId });
            const retired = await dependencies.operationStore.retireDispatchPreparation({
              authority: input.authority, expectedOperationCutoffRevision: input.operation.operationCutoff.revision,
              expectedOperationRevision: input.operation.revision, preparationToken, reason: "prevention",
            });
            if (retired.kind !== "retired") {assert.fail("extra preparation did not retire");}
            await dependencies.operationStore.recordDispatchPreparationCleanup({
              authority: input.authority, permit: retired.preparation.cleanupPermit, target: "custody",
            });
          }
        }
        return dependencies.operationStore.prepareDispatch(input);
      },
      commit: async input => {
        const outcome = await dependencies.operationStore.commit(input);
        if (outcome.kind === "applied" && outcome.operation.terminal.kind === "final") {terminalCommits += 1;}
        return outcome;
      },
      recordDispatchPreparationCleanup: async input => {
        const recorded = await dependencies.operationStore.recordDispatchPreparationCleanup(input);
        if (options.pause === "recorded" && input.target === "runtime_security") {
          // Both grant settlement calls and their durable records have finished,
          // but the submitting continuation has not inspected cleanup.kind yet.
          entered.resolve();
          await resume.promise;
        }
        return recorded;
      },
    },
  };
  return {
    ...fixture, calls, configured, entered: entered.promise, evidenceId,
    feature: createContainedTurnFeature(configured),
    effects: () => ({ artifactSeals, terminalCommits, workspaceClosures }),
    release: () => {resume.resolve();},
  };
};

for (const target of targets) {
  test(`cancellation after both grant settlements cannot terminalize indeterminate ${target} cleanup`, async t => {
    const race = createCleanupRace({ indeterminate: target, pause: "recorded" });
    t.after(race.release);
    const submission = race.feature.submit.execute(submissionInput);
    await awaitFixtureGate(race.entered, submission);
    let cancelled: Awaited<ReturnType<typeof race.feature.cancel.execute>>;
    try {
      cancelled = await race.feature.cancel.execute({ operationId, scope });
    } finally {race.release();}
    const submitted = await submission;

    assert.equal(cancelled.status, "observed");
    if (cancelled.status !== "observed") {assert.fail("missing cancellation observation");}
    assert.equal(cancelled.turn.status, "reconcile_required");
    assert.equal(submitted.status, "observed");
    if (submitted.status !== "observed") {assert.fail("missing submission observation");}
    assert.equal(submitted.turn.status, "reconcile_required");
    assert.equal(race.current()?.terminal.kind, "open");
    assert.equal(race.current()?.reconciliation.kind, "required");
    assert.equal(race.current()?.operationCutoff.kind, "closed");
    const rows = await race.dependencies.operationStore.listDispatchPreparations!({ scope });
    assert.equal(rows.length, 1);
    const preparation = rows[0]?.preparation;
    if (preparation?.kind !== "cleanup_pending") {assert.fail("cleanup must remain durably recoverable");}
    assert.equal(preparation.custodyReleased, target !== "custody");
    assert.equal(preparation.providerAccessSettled, target !== "provider_access");
    assert.equal(preparation.runtimeSecuritySettled, target !== "runtime_security");
    assert.ok(preparation.cleanupEvidenceIds.includes(race.evidenceId));
    assert.ok(preparation.providerAccessConsumptionReceipt !== undefined);
    assert.ok(preparation.runtimeSecurityConsumptionReceipt !== undefined);
    assert.notEqual(preparation.providerAccessGrantRequestId, preparation.runtimeSecurityGrantRequestId);
    await race.feature.observe.execute({ operationId, scope });
    await race.feature.cancel.execute({ operationId, scope });
    assert.deepEqual(race.calls, { custody: 1, provider_access: 1, runtime_security: 1 }, "no automatic cleanup retry");
    assert.equal(race.providerCalls.value, 0);
    assert.equal(race.custodyStartInputs.length, 0);
    assert.deepEqual(race.effects(), { artifactSeals: 0, terminalCommits: 0, workspaceClosures: 0 });
  });
}

for (const target of targets) {
  test(`cancellation remains nonterminal while authoritative ${target} cleanup is pending`, async t => {
    const race = createCleanupRace({ pause: target });
    t.after(race.release);
    const submission = race.feature.submit.execute(submissionInput);
    await awaitFixtureGate(race.entered, submission);
    let cancelled: Awaited<ReturnType<typeof race.feature.cancel.execute>>;
    try {
      cancelled = await race.feature.cancel.execute({ operationId, scope });
    } finally {race.release();}
    await submission;
    assert.equal(cancelled.status, "observed");
    if (cancelled.status !== "observed") {assert.fail("missing cancellation observation");}
    assert.equal(cancelled.turn.status, "reconcile_required");
    assert.equal(race.current()?.terminal.kind, "open", "late cleanup alone cannot rewrite operation debt");
    assert.equal(race.current()?.reconciliation.kind, "required");
    assert.deepEqual(race.calls, { custody: 1, provider_access: 1, runtime_security: 1 });
    assert.deepEqual(await race.dependencies.operationStore.listDispatchPreparations!({ scope }), []);
    assert.equal(race.providerCalls.value, 0);
    assert.equal(race.custodyStartInputs.length, 0);
    assert.deepEqual(race.effects(), { artifactSeals: 0, terminalCommits: 0, workspaceClosures: 0 });
  });
}

test("cancellation may terminalize after custody and both grants have authoritative cleanup closure", async t => {
  const race = createCleanupRace({ pause: "recorded" });
  t.after(race.release);
  const submission = race.feature.submit.execute(submissionInput);
  await awaitFixtureGate(race.entered, submission);
  let cancelled: Awaited<ReturnType<typeof race.feature.cancel.execute>>;
  try {
    cancelled = await race.feature.cancel.execute({ operationId, scope });
  } finally {race.release();}
  await submission;
  assert.equal(cancelled.status, "observed");
  if (cancelled.status !== "observed") {assert.fail("missing cancellation observation");}
  assert.equal(cancelled.turn.status, "cancelled");
  assert.equal(race.current()?.terminal.kind, "final");
  assert.equal(race.current()?.reconciliation.kind, "clear");
  assert.deepEqual(await race.dependencies.operationStore.listDispatchPreparations!({ scope }), []);
  assert.deepEqual(race.calls, { custody: 1, provider_access: 1, runtime_security: 1 });
  assert.equal(race.providerCalls.value, 0);
  assert.deepEqual(race.effects(), { artifactSeals: 1, terminalCommits: 1, workspaceClosures: 1 });
});

for (const unavailable of ["missing", "rejected"] as const) {
  test(`cancellation cannot infer cleanup closure from ${unavailable} owner closure proof`, async t => {
    const race = createCleanupRace({ pause: "recorded" });
    t.after(race.release);
    const submission = race.feature.submit.execute(submissionInput);
    await awaitFixtureGate(race.entered, submission);
    const { proveDispatchPreparationClosure: _proof, ...operationStore } = race.configured.operationStore;
    const cancellationFeature = createContainedTurnFeature({
      ...race.configured,
      operationStore: {
        ...operationStore,
        ...(unavailable === "missing" ? {} : { proveDispatchPreparationClosure: async () => {throw new Error("closure proof unavailable");} }),
      },
    });
    let cancelled: Awaited<ReturnType<typeof cancellationFeature.cancel.execute>>;
    try {
      cancelled = await cancellationFeature.cancel.execute({ operationId, scope });
    } finally {race.release();}
    await submission;
    assert.equal(cancelled.status, "observed");
    if (cancelled.status !== "observed") {assert.fail("missing cancellation observation");}
    assert.equal(cancelled.turn.status, "reconcile_required");
    assert.equal(race.current()?.terminal.kind, "open");
    assert.equal(race.current()?.reconciliation.kind, "required");
    assert.equal(race.providerCalls.value, 0);
    assert.deepEqual(race.calls, { custody: 1, provider_access: 1, runtime_security: 1 });
    assert.deepEqual(race.effects(), { artifactSeals: 0, terminalCommits: 0, workspaceClosures: 0 });
  });
}

for (const attack of ["proxy .some", "sparse list", "omitted row", "foreign row", "1,000-row truncation"] as const) {
  test(`cleanup completeness rejects ${attack} as cancellation authority`, async t => {
    const race = createCleanupRace({
      indeterminate: "custody", pause: "recorded",
      ...(attack === "1,000-row truncation" ? { extraPreparations: 1_000 } : {}),
    });
    t.after(race.release);
    const submission = race.feature.submit.execute(submissionInput);
    await awaitFixtureGate(race.entered, submission);
    const authoritative = await race.dependencies.operationStore.listDispatchPreparations!({ scope, limit: 1_000 });
    const pending = authoritative.find(row => row.preparation.kind === "cleanup_pending");
    assert.ok(pending);
    assert.equal(pending.preparation.kind, "cleanup_pending");
    assert.equal(pending.preparation.custodyReleased, false);
    let reads = 0;
    const cancellationFeature = createContainedTurnFeature({
      ...race.configured,
      operationStore: {
        ...race.configured.operationStore,
        listDispatchPreparations: async () => {
          reads += 1;
          if (attack === "proxy .some") {
            return new Proxy(authoritative, { get: (target, key, receiver) =>
              key === "some" ? () => false : Reflect.get(target, key, receiver) });
          }
          if (attack === "sparse list") {const sparse: never[] = []; sparse.length = 1; return sparse;}
          if (attack === "foreign row") {
            return [{ ...pending, preparation: { ...pending.preparation,
              operationId: containedTurnIdentity("operation", "operation:foreign"),
            } }];
          }
          return [];
        },
      },
    });
    const cancelled = await cancellationFeature.cancel.execute({ operationId, scope });
    race.release();
    await submission;
    assert.equal(cancelled.status, "observed");
    if (cancelled.status !== "observed") {assert.fail("missing cancellation observation");}
    assert.equal(cancelled.turn.status, "reconcile_required");
    assert.equal(race.current()?.terminal.kind, "open");
    assert.equal(reads, 0, "recovery enumeration is never closure authority");
    assert.deepEqual(race.effects(), { artifactSeals: 0, terminalCommits: 0, workspaceClosures: 0 });
  });
}

test("cleanup completeness fences concurrent insertion at the current cancelled revision", async t => {
  const race = createCleanupRace({ pause: "recorded" });
  t.after(race.release);
  const submission = race.feature.submit.execute(submissionInput);
  await awaitFixtureGate(race.entered, submission);
  await race.feature.cancel.execute({ operationId, scope });
  const operation = race.current()!;
  assert.equal(operation.operationCutoff.kind, "closed");
  await assert.rejects(race.dependencies.operationStore.prepareDispatch({
    authority: { commandId: operation.commandId, effectId: operation.effectId, operationId, scope },
    operation,
  }), /fence/);
  race.release();
  await submission;
});

for (const attack of ["stale revision", "stale cutoff", "unsupported", "partial", "foreign operation", "foreign scope",
  "unknown key", "accessor", "proxy", "prototype", "sparse proof", "oversized value", "oversized count", "missing count", "negative count", "symbol key"] as const) {
  test(`cleanup completeness rejects ${attack} proof before cancellation closure`, async t => {
    const race = createCleanupRace({ pause: "recorded" });
    t.after(race.release);
    const submission = race.feature.submit.execute(submissionInput);
    await awaitFixtureGate(race.entered, submission);
    let getterCalls = 0;
    const cancellationFeature = createContainedTurnFeature({
      ...race.configured,
      operationStore: {
        ...race.configured.operationStore,
        proveDispatchPreparationClosure: async () => {
          const operation = race.current()!;
          const proof = {
            kind: "closed", version: 1, purpose: "contained_turn_preparation_closure_v1",
            completeness: "all_operation_preparations", preparationCount: 1,
            operationId, commandId: operation.commandId, effectId: operation.effectId,
            tenantId: scope.tenantId, projectId: scope.projectId,
            operationRevision: operation.revision, operationCutoffRevision: operation.operationCutoff.revision,
            admissionFenceProofId: operation.admissionFence.kind === "fenced" ? operation.admissionFence.proofId : "",
          };
          if (attack === "stale revision") {return { ...proof, operationRevision: proof.operationRevision - 1 };}
          if (attack === "stale cutoff") {return { ...proof, operationCutoffRevision: proof.operationCutoffRevision - 1 };}
          if (attack === "unsupported") {return { kind: "unsupported" };}
          if (attack === "partial") {return { ...proof, completeness: "partial" };}
          if (attack === "foreign operation") {return { ...proof, operationId: "operation:foreign" };}
          if (attack === "foreign scope") {return { ...proof, tenantId: "tenant:foreign" };}
          if (attack === "unknown key") {return { ...proof, extra: true };}
          if (attack === "proxy") {return new Proxy(proof, {});}
          if (attack === "prototype") {return Object.assign(Object.create(null), proof);}
          if (attack === "sparse proof") {const sparse: never[] = []; sparse.length = 1; return sparse;}
          if (attack === "oversized count") {return { ...proof, preparationCount: 1_001 };}
          if (attack === "negative count") {return { ...proof, preparationCount: -1 };}
          if (attack === "missing count") {const { preparationCount: _count, ...missing } = proof; return missing;}
          if (attack === "symbol key") {return { ...proof, [Symbol("unproved")]: true };}
          if (attack === "oversized value") {return { ...proof, tenantId: "t".repeat(65_537) };}
          return Object.defineProperty(proof, "completeness", { get: () => {
            getterCalls += 1; return "all_operation_preparations";
          } });
        },
      } as ContainedTurnKernelDependencies["operationStore"],
    });
    const cancelled = await cancellationFeature.cancel.execute({ operationId, scope });
    race.release();
    await submission;
    assert.equal(cancelled.status, "observed");
    if (cancelled.status !== "observed") {assert.fail("missing cancellation observation");}
    assert.equal(cancelled.turn.status, "reconcile_required");
    assert.equal(race.current()?.terminal.kind, "open");
    assert.equal(getterCalls, 0);
    assert.deepEqual(race.effects(), { artifactSeals: 0, terminalCommits: 0, workspaceClosures: 0 });
  });
}

for (const count of [1_000, 1_001]) {
  test(`cleanup completeness bounds the entire authoritative set of ${count} closed preparations`, async t => {
    const race = createCleanupRace({ pause: "recorded", extraPreparations: count - 1, closeExtraPreparations: true });
    t.after(race.release);
    const submission = race.feature.submit.execute(submissionInput);
    await awaitFixtureGate(race.entered, submission);
    assert.deepEqual(await race.dependencies.operationStore.listDispatchPreparations!({ scope }), []);
    const cancelled = await race.feature.cancel.execute({ operationId, scope });
    race.release();
    await submission;
    assert.equal(cancelled.status, "observed");
    if (cancelled.status !== "observed") {assert.fail("missing cancellation observation");}
    assert.equal(cancelled.turn.status, count === 1_000 ? "cancelled" : "reconcile_required");
    assert.equal(race.current()?.terminal.kind, count === 1_000 ? "final" : "open");
  });
}

test("cleanup closure proof is detached once before application use", async t => {
  const race = createCleanupRace({ pause: "recorded" });
  t.after(race.release);
  const submission = race.feature.submit.execute(submissionInput);
  await awaitFixtureGate(race.entered, submission);
  await race.feature.cancel.execute({ operationId, scope });
  const operation = race.current()!;
  const input = {
    authority: { commandId: operation.commandId, effectId: operation.effectId, operationId, scope },
    expectedOperationCutoffRevision: operation.operationCutoff.revision, expectedOperationRevision: operation.revision,
  };
  const original = { ...await race.dependencies.operationStore.proveDispatchPreparationClosure!(input) };
  const projected = createContainedTurnPreparationScopeDependencies({
    ...race.configured,
    operationStore: { ...race.configured.operationStore, proveDispatchPreparationClosure: async () => original as never },
  });
  const proof = await projected.operationStore.proveDispatchPreparationClosure!(input);
  assert.ok(proof);
  assert.ok(Object.isFrozen(proof));
  original.operationRevision = 0;
  original.operationId = "operation:substituted";
  assert.equal(proof.operationRevision, operation.revision);
  assert.equal(proof.operationId, operationId);
  race.release();
  await submission;
});
