import assert from "node:assert/strict";
import test from "node:test";
import { containedTurnOwnerStoreAuthority } from "../../../dist/features/contained-agent-turn/application/contained-turn-store-authority.js";
import { createContainedTurnFeature } from "../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { mutateContainedTurnOperation, validateContainedTurnOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import { createDependencies } from "./support/contained-agent-turn-fixture.ts";
import { awaitFixtureGate, gate, submission } from "./support/intent-guard-fixture.ts";

test("cancellation after prevention preserves the sole cutoff and rejects conflicting replay", async () => {
  const fixture = createDependencies({ dispatchPrevented: true, artifactIndeterminate: true });
  await createContainedTurnFeature(fixture.dependencies).submit.execute(submission);
  const before = fixture.current();
  assert.ok(before?.dispatch.kind === "prevented" && before.operationCutoff.kind === "closed");
  assert.equal(before.operationCutoff.reason, "prevention");
  assert.equal(before.terminal.kind, "open");
  const prepared = await fixture.dependencies.operationStore.prepareCancellation({
    authority: containedTurnOwnerStoreAuthority(before, submission.scope), operation: before,
  });
  const mutation = { kind: "request_cancellation" as const, command: prepared.command, proof: prepared.proof, cutoffProof: prepared.cutoffProof };
  const cancelled = mutateContainedTurnOperation(before, mutation);
  assert.equal(cancelled.cancellation.kind, "requested");
  assert.deepEqual(cancelled.operationCutoff, before.operationCutoff);
  assert.deepEqual(cancelled.admissionFence, before.admissionFence);
  assert.deepEqual(cancelled.output, before.output);
  assert.deepEqual(cancelled.dispatch, before.dispatch);
  assert.deepEqual(cancelled.providerExecution, before.providerExecution);
  assert.deepEqual(cancelled.closureRecovery, before.closureRecovery);
  assert.deepEqual(cancelled.proofs, [...before.proofs, prepared.proof]);
  assert.equal(cancelled.revision, before.revision + 1);
  assert.equal(cancelled.terminal.kind, "open");
  assert.strictEqual(mutateContainedTurnOperation(cancelled, mutation), cancelled);
  for (const operation of [before, cancelled]) {
    assert.throws(() => mutateContainedTurnOperation(operation, { ...mutation, command: {
      ...prepared.command, operationId: containedTurnIdentity("operation", "operation:foreign"),
    } }), /subject|fingerprint/u);
    assert.throws(() => mutateContainedTurnOperation(operation, { ...mutation, proof: {
      ...prepared.proof, binding: { ...prepared.proof.binding, cancellationCommandId: containedTurnIdentity("cancellation_command", "cancellation-command:foreign") },
    } }), /binding mismatch/u);
    assert.throws(() => mutateContainedTurnOperation(operation, { ...mutation, cutoffProof: {
      ...prepared.cutoffProof, binding: { ...prepared.cutoffProof.binding, operationId: containedTurnIdentity("operation", "operation:foreign") },
    } }), /binding mismatch/u);
    assert.throws(() => mutateContainedTurnOperation(operation, { ...mutation, cutoffProof: {
      ...prepared.cutoffProof, binding: { ...prepared.cutoffProof.binding, cancellationCommandId: containedTurnIdentity("cancellation_command", "cancellation-command:foreign") },
    } }), /command|binding mismatch/u);
  }
  assert.throws(() => mutateContainedTurnOperation(cancelled, { ...mutation, proof: {
    ...prepared.proof, proofId: containedTurnIdentity("proof", "proof:substituted-cancellation"),
  } }), /exact command and proof identity/u);
  assert.throws(() => validateContainedTurnOperation({ ...cancelled, operationCutoff: {
    kind: "closed", proofId: prepared.cutoffProof.proofId, reason: "cancellation", revision: before.operationCutoff.revision + 1,
  }, proofs: [...cancelled.proofs, prepared.cutoffProof], revision: cancelled.revision + 1 }, { previous: cancelled }), /cutoff authority cannot be replaced/u);
  assert.equal(fixture.providerCalls.value, 0);
  assert.equal(fixture.custodyStartInputs.length, 0);
});

for (const race of ["already_prevented", "prevention_wins_cas"] as const) {
  test(`durable cancellation resumes pending closure when ${race}`, { timeout: 5_000 }, async t => {
    const options = { dispatchPrevented: true, artifactIndeterminate: true };
    const fixture = createDependencies(options);
    const store = fixture.dependencies.operationStore;
    const entered = gate(); const resume = gate();
    t.after(resume.release);
    let enabled = false; let paused = false; let staleRequests = 0;
    const read = store.read;
    store.read = async input => {
      const current = await read(input);
      if (enabled && !paused) {paused = true; entered.release(); await resume.promise;}
      return current;
    };
    const requestCancellation = store.requestCancellation;
    store.requestCancellation = async input => {
      const result = await requestCancellation(input);
      if (result.kind === "stale") {staleRequests += 1;}
      return result;
    };
    const sealingRequests: string[] = [];
    const queryRequests: string[] = [];
    const bindGate = gate(); const continueSubmission = gate();
    t.after(continueSubmission.release);
    const commit = store.commit;
    store.commit = async input => {
      const result = await commit(input);
      if (race === "prevention_wins_cas" && result.kind === "applied" &&
          result.operation.dispatch.kind === "unclaimed" && result.operation.workspaceId !== undefined) {
        bindGate.release(); await continueSubmission.promise;
      }
      return result;
    };
    const feature = createContainedTurnFeature({
      ...fixture.dependencies,
      artifacts: { ...fixture.dependencies.artifacts,
        ensureSealed: async input => {
          sealingRequests.push(input.requestId);
          return fixture.dependencies.artifacts.ensureSealed(input);
        },
        querySeal: async input => {
          queryRequests.push(input.requestId);
          return fixture.dependencies.artifacts.querySeal!(input);
        },
      },
    });
    const submitting = feature.submit.execute(submission);
    if (race === "prevention_wins_cas") {await awaitFixtureGate(bindGate.promise, submitting);}
    else {await submitting;}
    const ref = { operationId: fixture.current()!.operationId, scope: submission.scope };
    enabled = true;
    const cancelling = feature.cancel.execute(ref);
    await awaitFixtureGate(entered.promise, cancelling);
    continueSubmission.release();
    await submitting;
    const before = fixture.current();
    assert.ok(before?.dispatch.kind === "prevented" && before.closureRecovery.kind === "required");
    assert.equal(before.closureRecovery.stage, "artifact_seal");
    assert.equal(before.cancellation.kind, "open");
    resume.release();
    const result = await cancelling;
    assert.ok(result.status === "observed" && result.turn.status === "reconcile_required");
    const cancelled = fixture.current();
    assert.ok(cancelled?.cancellation.kind === "requested");
    assert.deepEqual(cancelled.operationCutoff, before.operationCutoff);
    assert.deepEqual(cancelled.providerExecution, before.providerExecution);
    assert.deepEqual(cancelled.dispatch, before.dispatch);
    assert.deepEqual(cancelled.admissionFence, before.admissionFence);
    assert.deepEqual(cancelled.output, before.output);
    assert.deepEqual(cancelled.closureRecovery, before.closureRecovery);
    assert.equal(cancelled.terminal.kind, "open");
    assert.equal(staleRequests, race === "prevention_wins_cas" ? 1 : 0);
    await feature.cancel.execute(ref);
    assert.deepEqual(fixture.current(), { ...cancelled, revision: fixture.current()!.revision },
      "closure observation may advance revision; cancellation replay cannot append another command or cutoff");
    options.artifactIndeterminate = false;
    await feature.cancel.execute(ref);
    const closed = fixture.current();
    assert.ok(closed?.terminal.kind === "final");
    assert.equal(closed.terminal.outcome, "failed", "later cancellation must preserve the prevention outcome");
    assert.deepEqual(closed.cancellation, cancelled.cancellation);
    assert.deepEqual(closed.operationCutoff, before.operationCutoff);
    assert.deepEqual(closed.providerExecution, before.providerExecution);
    assert.deepEqual(sealingRequests, [before.closureRecovery.requestId]);
    assert.ok(queryRequests.length >= 2 && queryRequests.every(id => id === before.closureRecovery.requestId));
    assert.equal(closed.proofs.filter(proof => proof.kind === "cutoff").length, 1);
    assert.equal(closed.proofs.filter(proof => proof.kind === "cancellation").length, 1);
    assert.equal(fixture.providerCalls.value, 0);
    assert.equal(fixture.custodyStartInputs.length, 0);
    await feature.cancel.execute(ref);
    assert.deepEqual(fixture.current(), closed);
  });
}
