import assert from "node:assert/strict";
import test from "node:test";
import { createContainedTurnFeature } from "../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import type { ContainedTurnKernelDependencies } from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { awaitFixtureGate, gate, intentHarness, prevention, submission } from "./support/intent-guard-fixture.ts";
import { IntentGuardSqlFixture } from "./support/intent-guard-sql-fixture.ts";
import { createDependencies } from "./support/contained-agent-turn-fixture.ts";

const proofId = (role: string) => containedTurnIdentity("proof", `proof:guard-closure:${role}`);

for (const resume of ["intent", "ordinary"] as const) {
test(`post-dispatch intent cancellation initiates containment before provider completion; ${resume} replay uses the same request`, { timeout: 5_000 }, async () => {
  const database = new IntentGuardSqlFixture();
  const entered = gate(); const release = gate();
  const runner = intentHarness(database.pool, { beforeProvider: async () => {entered.release(); await release.promise;} });
  const ensures: Parameters<ContainedTurnKernelDependencies["custody"]["ensurePhysicalContainment"]>[0][] = [];
  const queries: typeof ensures = [];
  const feature = createContainedTurnFeature({
    ...runner.dependencies,
    custody: {
      ...runner.dependencies.custody,
      ensurePhysicalContainment: async input => {
        ensures.push(input);
        return { kind: "indeterminate", evidenceId: containedTurnIdentity("evidence", "evidence:guard-containment-unknown") };
      },
      queryPhysicalContainment: async input => {
        queries.push(input);
        const current = await runner.store.read({ operationId: input.operationId, scope: submission.scope });
        assert.ok(current?.dispatch.kind === "claimed");
        return { kind: "proved", requestId: input.requestId, requestDigest: input.requestDigest, proof: {
          kind: "physical_containment", proofId: proofId("physical"), binding: {
            operationId: input.operationId, authorityVectorDigest: input.authorityVectorDigest,
            attemptId: input.attemptId, effectId: current.effectId, custodyId: input.custodyId,
            hostBootId: current.hostBootId!, hostInstanceId: current.hostInstanceId!,
          },
        } };
      },
    },
  });
  const pending = feature.submit.execute(submission);
  await awaitFixtureGate(entered.promise, pending);
  try {
    const command = prevention();
    const cancelled = await feature.cancel.execute({ prevention: command, scope: submission.scope });
    assert.ok(cancelled.kind === "committed");
    assert.equal(cancelled.receipt.disposition, "cutoff_requested");
    assert.equal(ensures.length, 1, "containment must start while the provider is still pending");
    const ref = { operationId: cancelled.receipt.operationId!, scope: submission.scope };
    const unknown = await runner.store.read(ref);
    assert.ok(unknown?.cancellation.kind === "requested");
    assert.equal(unknown.cancellation.command.cancellationCommandId, command.preventionCommandId);
    assert.equal(unknown.terminal.kind, "open");
    assert.equal(unknown.reconciliation.kind, "required");
    assert.equal(unknown.closureRecovery.kind, "required");
    assert.notEqual(unknown.providerAcceptance.kind, "not_accepted");
    runner.store.prepareCancellation = async () => {throw new Error("replay must not mint another cancellation command");};
    if (resume === "ordinary") {await feature.cancel.execute(ref);}
    else {assert.deepEqual(await feature.cancel.execute({ prevention: command, scope: submission.scope }), cancelled);}
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0], ensures[0]);
    const contained = await runner.store.read(ref);
    assert.equal(contained?.physicalContainment.kind, "contained");
    assert.equal(contained?.terminal.kind, "open");
    assert.equal(contained?.reconciliation.kind, "required");
    assert.deepEqual(contained?.dispatch, unknown.dispatch);
    assert.deepEqual(contained?.cancellation, unknown.cancellation);
    assert.deepEqual(await feature.cancel.execute({ prevention: command, scope: submission.scope }), cancelled);
    assert.equal(ensures.length, 1);
    assert.equal(queries.length, 1);
  } finally {release.release();}
  await pending;
  const replayed = await feature.submit.execute(submission);
  assert.ok(replayed.status === "observed" && replayed.turn.status === "reconcile_required");
  const unresolved = database.tables.operations[0]!.state.payload;
  assert.equal(unresolved.providerExecution.kind, "unknown");
  assert.equal(unresolved.providerAcceptance.kind, "unknown");
  assert.equal(unresolved.physicalContainment.kind, "contained");
  assert.equal(unresolved.terminal.kind, "open");
  assert.equal(runner.counts.provider, 1);
  assert.equal(runner.counts.custodyStart, 1);
});
}

// Exact synthetic receipts; the shared intent harness deliberately has no real workspace owner.
const withNoStartClosure = (dependencies: ContainedTurnKernelDependencies): ContainedTurnKernelDependencies => {
  const ensureClosed: ContainedTurnKernelDependencies["workspace"]["ensureClosed"] = async input => ({
    kind: "proved", requestId: input.requestId, requestDigest: input.requestDigest,
    proof: { kind: "workspace_closure", proofId: proofId("workspace"), binding: {
      operationId: input.operationId, authorityVectorDigest: input.authorityVectorDigest, workspaceId: input.workspaceId,
    } },
  });
  const ensureSealed: ContainedTurnKernelDependencies["artifacts"]["ensureSealed"] = async input => ({
    kind: "proved", requestId: input.requestId, requestDigest: input.requestDigest, proof: {
      artifactProof: { kind: "artifact_manifest_seal", proofId: proofId("artifact"), binding: {
        operationId: input.operationId, authorityVectorDigest: input.authorityVectorDigest,
        workspaceId: input.workspaceId, artifactManifestRef: "artifact:guard-closure",
      } },
      resultProof: { kind: "result_publication", proofId: proofId("result"), binding: {
        operationId: input.operationId, authorityVectorDigest: input.authorityVectorDigest, resultRef: "result:guard-closure",
      } },
    },
  });
  return {
    ...dependencies,
    workspace: { ...dependencies.workspace, ensureClosed, queryClosure: ensureClosed },
    artifacts: { ...dependencies.artifacts, ensureSealed, querySeal: input => ensureSealed({ ...input, output: [] }) },
  };
};

for (const resume of ["intent cancellation", "ordinary cancellation", "submission replay", "acceptance continuation"] as const) {
  test(`prevention after durable acceptance before workspace resumes exact no-start closure via ${resume}`, { timeout: 5_000 }, async () => {
    const database = new IntentGuardSqlFixture();
    const runner = intentHarness(database.pool);
    const entered = gate(); const release = gate();
    const accept = runner.store.accept.bind(runner.store);
    runner.store.accept = async (candidate, authority) => {
      const outcome = await accept(candidate, authority);
      entered.release(); await release.promise;
      return outcome;
    };
    const feature = createContainedTurnFeature(withNoStartClosure(runner.dependencies));
    const pending = feature.submit.execute(submission);
    await awaitFixtureGate(entered.promise, pending);
    try {
      const command = prevention();
      // The committed store boundary also models a crash before application closure runs.
      const committed = await runner.store.preventIntent({ command, scope: submission.scope });
      assert.ok(committed.kind === "committed");
      assert.equal(committed.receipt.disposition, "operation_fenced");
      const ref = { operationId: committed.receipt.operationId!, scope: submission.scope };
      const fenced = await runner.store.read(ref);
      assert.ok(fenced);
      assert.equal(fenced.workspaceId, undefined);
      assert.equal(fenced.dispatch.kind, "unclaimed");
      assert.equal(fenced.providerExecution.kind, "not_started");
      assert.equal(fenced.closureRecovery.kind, "clear");
      assert.equal(runner.counts.workspace, 0);
      runner.store.prepareCancellation = async () => {throw new Error("durable cancellation identity must be reused");};
      if (resume === "intent cancellation") {
        assert.deepEqual(await feature.cancel.execute({ prevention: command, scope: submission.scope }), committed);
      } else if (resume === "ordinary cancellation") {
        await feature.cancel.execute(ref);
      } else if (resume === "submission replay") {
        // A new factory and store emulate application reconstruction after receipt loss.
        const restarted = intentHarness(database.pool);
        await createContainedTurnFeature(withNoStartClosure(restarted.dependencies)).submit.execute(submission);
        assert.equal(restarted.counts.provider, 0);
        assert.equal(restarted.counts.custodyStart, 0);
      } else {
        release.release(); await pending;
      }
      const closed = await runner.store.read(ref);
      assert.ok(closed);
      assert.equal(closed.dispatch.kind, "prevented");
      assert.equal(closed.providerExecution.kind, "closed");
      assert.equal(closed.providerAcceptance.kind, "not_accepted");
      assert.equal(closed.terminal.kind, "final");
      assert.ok(closed.terminal.kind === "final" && closed.terminal.outcome === "cancelled");
      assert.equal(closed.reconciliation.kind, "clear");
      assert.equal(closed.closureRecovery.kind, "clear");
      assert.deepEqual(closed.requiredReceiptSet, fenced.requiredReceiptSet);
      assert.deepEqual(closed.cancellation, fenced.cancellation);
      assert.deepEqual(closed.admissionFence, fenced.admissionFence);
      assert.deepEqual(closed.operationCutoff, fenced.operationCutoff);
      for (const kind of ["no_dispatch", "no_start", "host_custody_no_start", "provider_not_started", "output_no_start_drain", "effect_no_start", "containment_not_required", "workspace_closure", "artifact_manifest_seal", "result_publication", "terminal_truth"]) {
        const proof = closed.proofs.find(candidate => candidate.kind === kind);
        assert.ok(proof, `missing ${kind} proof`);
        assert.equal(proof.binding.operationId, closed.operationId);
        assert.equal(proof.binding.authorityVectorDigest, closed.acceptedAuthorityVectorDigest);
      }
      await feature.cancel.execute(ref);
      assert.deepEqual(await feature.cancel.execute({ prevention: command, scope: submission.scope }), committed);
      await feature.submit.execute(submission);
      assert.deepEqual(await runner.store.read(ref), closed, "exact replay must not append proofs or change terminal truth");
    } finally {release.release();}
    await pending;
    assert.equal(runner.counts.provider, 0);
    assert.equal(runner.counts.custodyStart, 0);
    assert.equal(database.tables.preparations.length, 0);
  });
}

test("in-memory cancellation resumes no-start artifact debt without changing command or fence identity", { timeout: 5_000 }, async () => {
  const fixture = createDependencies({ artifactIndeterminate: true });
  const entered = gate(); const release = gate();
  const store = fixture.dependencies.operationStore;
  const accept = store.accept;
  store.accept = async (candidate, authority) => {
    const outcome = await accept(candidate, authority);
    entered.release(); await release.promise;
    return outcome;
  };
  const feature = createContainedTurnFeature(fixture.dependencies);
  const pending = feature.submit.execute(submission);
  await awaitFixtureGate(entered.promise, pending);
  try {
    const ref = { operationId: fixture.current()!.operationId, scope: submission.scope };
    const first = await feature.cancel.execute(ref);
    assert.ok(first.status === "observed" && first.turn.status === "reconcile_required");
    const unknown = fixture.current()!;
    assert.equal(unknown.dispatch.kind, "prevented");
    assert.equal(unknown.terminal.kind, "open");
    assert.ok(unknown.closureRecovery.kind === "required" && unknown.closureRecovery.stage === "artifact_seal");
    const request = unknown.closureRecovery;
    const recovered = withNoStartClosure(fixture.dependencies);
    const query = recovered.artifacts.querySeal;
    const replay = createContainedTurnFeature({
      ...recovered,
      artifacts: { ...recovered.artifacts, querySeal: async input => {
        assert.equal(input.requestId, request.requestId);
        assert.equal(input.requestDigest, request.requestDigest);
        return query(input);
      } },
    });
    store.prepareCancellation = async () => {throw new Error("replay must use the committed command");};
    const second = await replay.cancel.execute(ref);
    assert.ok(second.status === "observed" && second.turn.status === "cancelled");
    const closed = fixture.current()!;
    assert.deepEqual(closed.cancellation, unknown.cancellation);
    assert.deepEqual(closed.admissionFence, unknown.admissionFence);
    assert.deepEqual(closed.operationCutoff, unknown.operationCutoff);
    assert.equal(fixture.createdWorkspaces.length, 1);
    await replay.cancel.execute(ref);
    assert.deepEqual(fixture.current(), closed);
  } finally {release.release();}
  await pending;
  assert.equal(fixture.providerCalls.value, 0);
  assert.equal(fixture.openedCustodies.length, 0);
});
