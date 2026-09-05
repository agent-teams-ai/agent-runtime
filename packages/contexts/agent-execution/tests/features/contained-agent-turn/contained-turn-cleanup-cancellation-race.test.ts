import assert from "node:assert/strict";
import test from "node:test";

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
  test(`cancellation cannot infer cleanup closure from ${unavailable} owner enumeration`, async t => {
    const race = createCleanupRace({ pause: "recorded" });
    t.after(race.release);
    const submission = race.feature.submit.execute(submissionInput);
    await awaitFixtureGate(race.entered, submission);
    const { listDispatchPreparations: _list, ...operationStore } = race.configured.operationStore;
    const cancellationFeature = createContainedTurnFeature({
      ...race.configured,
      operationStore: {
        ...operationStore,
        ...(unavailable === "missing" ? {} : { listDispatchPreparations: async () => {throw new Error("enumeration unavailable");} }),
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
