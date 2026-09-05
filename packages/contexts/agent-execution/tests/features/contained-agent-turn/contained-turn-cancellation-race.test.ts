import assert from "node:assert/strict";
import test from "node:test";
import { createContainedTurnFeature } from "../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import type { ContainedTurnKernelDependencies } from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { awaitFixtureGate, gate, intentHarness, prevention, submission } from "./support/intent-guard-fixture.ts";
import { IntentGuardSqlFixture } from "./support/intent-guard-sql-fixture.ts";

for (const cancellation of ["ordinary", "intent"] as const) {
  for (const pauseAt of ["read", "begin_commit"] as const) {
    test(`${cancellation} cancellation adopts completed containment after stale ${pauseAt} without repeating it`, { timeout: 5_000 }, async () => {
      const database = new IntentGuardSqlFixture();
      const providerEntered = gate(); const providerRelease = gate();
      const staleEntered = gate(); const staleRelease = gate();
      const runner = intentHarness(database.pool, { beforeProvider: async () => {
        providerEntered.release(); await providerRelease.promise;
      } });
      const ensures: Parameters<ContainedTurnKernelDependencies["custody"]["ensurePhysicalContainment"]>[0][] = [];
      let queries = 0;
      const read = runner.store.read.bind(runner.store);
      const commit = runner.store.commit.bind(runner.store);
      let pauseEnabled = false;
      let paused = false;
      let staleCas = 0;
      runner.store.read = async input => {
        const current = await read(input);
        if (pauseEnabled && pauseAt === "read" && !paused) {
          paused = true; staleEntered.release(); await staleRelease.promise;
        }
        return current;
      };
      runner.store.commit = async input => {
        if (pauseEnabled && pauseAt === "begin_commit" && !paused && input.candidate.closureRecovery.kind === "required") {
          paused = true; staleEntered.release(); await staleRelease.promise;
        }
        const outcome = await commit(input);
        if (outcome.kind === "stale") {staleCas += 1;}
        return outcome;
      };
      const feature = createContainedTurnFeature({
        ...runner.dependencies,
        custody: {
          ...runner.dependencies.custody,
          ensurePhysicalContainment: async input => {
            ensures.push(input);
            const current = await read({ operationId: input.operationId, scope: submission.scope });
            assert.ok(current?.dispatch.kind === "claimed");
            return { kind: "proved", requestId: input.requestId, requestDigest: input.requestDigest, proof: {
              kind: "physical_containment", proofId: containedTurnIdentity("proof", "proof:cancellation-race:physical"), binding: {
                operationId: input.operationId, authorityVectorDigest: input.authorityVectorDigest,
                attemptId: input.attemptId, effectId: current.effectId, custodyId: input.custodyId,
                hostBootId: current.hostBootId!, hostInstanceId: current.hostInstanceId!,
              },
            } };
          },
          queryPhysicalContainment: async () => {
            queries += 1;
            throw new Error("completed containment must not be queried again");
          },
        },
      });
      const providerPending = feature.submit.execute(submission);
      await awaitFixtureGate(providerEntered.promise, providerPending);
      let stalePending: Promise<unknown> | undefined;
      try {
        const command = prevention();
        // Retain a real committed cutoff and reconciliation debt before either caller resumes closure.
        const cancellationReceipt = await runner.store.preventIntent({ command, scope: submission.scope });
        assert.ok(cancellationReceipt.kind === "committed");
        const ref = { operationId: cancellationReceipt.receipt.operationId!, scope: submission.scope };
        const before = await read(ref);
        assert.ok(before?.cancellation.kind === "requested");
        assert.equal(before.reconciliation.kind, "required");
        pauseEnabled = true;
        const cancel = () => cancellation === "ordinary"
          ? feature.cancel.execute(ref)
          : feature.cancel.execute({ prevention: command, scope: submission.scope });
        stalePending = cancel();
        await awaitFixtureGate(staleEntered.promise, stalePending);
        const winner = await cancel();
        const completed = await read(ref);
        assert.ok(completed);
        assert.equal(completed.physicalContainment.kind, "contained");
        assert.equal(completed.closureRecovery.kind, "clear");
        assert.deepEqual(completed.reconciliation, before.reconciliation);
        staleRelease.release();
        const [loser] = await Promise.allSettled([stalePending]);
        const adopted = await read(ref);
        assert.equal(ensures.length, 1, JSON.stringify({
          error: loser.status === "rejected" ? String(loser.reason) : null,
          closureRecovery: adopted?.closureRecovery,
          physicalContainment: adopted?.physicalContainment,
          requests: ensures,
        }));
        assert.ok(loser.status === "fulfilled");
        assert.deepEqual(loser.value, winner);
        assert.equal(staleCas, 1, "the paused caller must actually lose the stage CAS");
        assert.equal(queries, 0);
        assert.deepEqual(adopted, completed, "adoption must neither reopen closure nor append rejected debt");
        assert.deepEqual(completed.cancellation, before.cancellation);
        assert.deepEqual(completed.dispatch, before.dispatch);
        assert.equal(completed.terminal.kind, "open");
        await cancel();
        assert.deepEqual(await read(ref), completed);
      } finally {
        staleRelease.release(); providerRelease.release();
        await Promise.allSettled([stalePending, providerPending]);
      }
      assert.equal(ensures.length, 1);
      assert.equal(runner.counts.provider, 1);
      assert.equal(runner.counts.custodyStart, 1);
      const replay = await feature.submit.execute(submission);
      assert.ok(replay.status === "observed" && replay.turn.status === "reconcile_required");
      assert.equal(runner.counts.provider, 1);
    });
  }
}
