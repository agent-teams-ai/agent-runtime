import assert from "node:assert/strict";
import { before, test } from "node:test";
import { resumeContainedTurnClosureStage } from "../../../dist/features/contained-agent-turn/application/contained-turn-closure-recovery.js";
import type { ContainedTurnKernelDependencies } from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { createContainedTurnFeature } from "../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import type { ContainedTurnClosureRecovery, ContainedTurnClosureStage } from "../../../dist/features/contained-agent-turn/domain/contained-turn-closure-recovery.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import type { ContainedTurnProof } from "../../../dist/features/contained-agent-turn/domain/contained-turn-proofs.js";
import { mutateContainedTurnOperation, type ContainedTurnKernelMutation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-transitions.js";
import { createDependencies } from "./support/contained-agent-turn-fixture.ts";
import { submission } from "./support/intent-guard-fixture.ts";

type PendingClosure = Extract<ContainedTurnClosureRecovery, { kind: "required" }>;
const stages = ["physical_containment", "artifact_seal", "workspace_close", "containment_attestation"] as const;
const snapshots: ContainedTurnKernelOperation[] = [];

before(async () => {
  const fixture = createDependencies();
  const store = fixture.dependencies.operationStore;
  const commit = store.commit;
  store.commit = async input => {
    snapshots.push(fixture.current()!);
    const outcome = await commit(input);
    if (outcome.kind === "applied") {snapshots.push(outcome.operation);}
    return outcome;
  };
  await createContainedTurnFeature(fixture.dependencies).submit.execute(submission);
  assert.equal(fixture.current()?.terminal.kind, "final");
  assert.equal(fixture.providerCalls.value, 1);
});

const stageSnapshots = (stage: typeof stages[number]) => {
  const pendingIndex = snapshots.findIndex(operation => operation.closureRecovery.kind === "required" && operation.closureRecovery.stage === stage);
  const pending = snapshots[pendingIndex]!;
  const initial = snapshots[pendingIndex - 1]!;
  const completed = snapshots.slice(pendingIndex).find(operation => operation.closureRecovery.kind === "clear")!;
  const later = snapshots.slice(pendingIndex).find(operation => operation.closureRecovery.kind === "required" && operation.closureRecovery.stage !== stage)
    ?? snapshots.at(-1)!;
  assert.ok(pending.closureRecovery.kind === "required");
  assert.ok(initial.revision < pending.revision && pending.revision < completed.revision);
  return { completed, initial, later, pending };
};

const complete = (stage: ContainedTurnClosureStage, request: PendingClosure, proofs: readonly ContainedTurnProof[]): ContainedTurnKernelMutation => {
  const proof = <Kind extends ContainedTurnProof["kind"]>(kind: Kind): Extract<ContainedTurnProof, { kind: Kind }> => {
    const found = proofs.find(candidate => candidate.kind === kind);
    assert.ok(found);
    return found as Extract<ContainedTurnProof, { kind: Kind }>;
  };
  switch (stage) {
    case "physical_containment": return { kind: "complete_physical_containment", proof: proof("physical_containment"), request };
    case "artifact_seal": return {
      kind: "complete_artifact_seal", request,
      artifactProof: proof("artifact_manifest_seal"), artifactManifestRef: proof("artifact_manifest_seal").binding.artifactManifestRef,
      resultProof: proof("result_publication"), resultRef: proof("result_publication").binding.resultRef,
    };
    case "workspace_close": return { kind: "complete_workspace_close", proof: proof("workspace_closure"), request };
    case "containment_attestation": return { kind: "complete_containment_attestation", proof: proof("containment"), request };
    default: throw new Error("no-workspace has no external closure driver");
  }
};

const driverFor = (stage: typeof stages[number]) => {
  const { completed, pending } = stageSnapshots(stage);
  const proofs = completed.proofs.filter(proof => !pending.proofs.some(previous => previous.proofId === proof.proofId));
  const counts = { ensure: 0, query: 0 };
  const driver = {
    complete: (request: PendingClosure, proof: readonly ContainedTurnProof[]) => complete(stage, request, proof),
    ensure: async (request: PendingClosure) => {
      counts.ensure += 1;
      return { kind: "proved" as const, proof: proofs, requestId: request.requestId, requestDigest: request.requestDigest };
    },
    query: async (request: PendingClosure) => {
      counts.query += 1;
      return { kind: "proved" as const, proof: proofs, requestId: request.requestId, requestDigest: request.requestDigest };
    },
    proofIds: (proof: readonly ContainedTurnProof[]) => proof.map(value => value.proofId),
    stage,
  };
  return { counts, driver };
};

const staleStore = (current: () => ContainedTurnKernelOperation): ContainedTurnKernelDependencies => ({
  operationStore: { commit: async () => ({ kind: "stale", current: current() }) },
} as unknown as ContainedTurnKernelDependencies);

for (const stage of stages) {
  for (const adoption of ["completed", "later"] as const) {
    for (const casAttempts of [1, 3]) {
      test(`${stage}: begin CAS adopts ${adoption} on attempt ${casAttempts} without repeating completed work`, async () => {
        const sequence = stageSnapshots(stage);
        const target = { ...sequence[adoption], revision: sequence[adoption].revision + casAttempts - 1 };
        let current = sequence.initial;
        let commits = 0;
        const dependencies = staleStore(() => {
          commits += 1;
          current = commits === casAttempts ? target : { ...current, revision: current.revision + 1 };
          return current;
        });
        const { counts, driver } = driverFor(stage);
        const result = await resumeContainedTurnClosureStage(dependencies, sequence.initial, submission.scope, driver);
        assert.deepEqual(result, { kind: "completed", operation: target });
        assert.deepEqual(counts, { ensure: 0, query: 0 });
        assert.equal(commits, casAttempts);
        assert.strictEqual(mutateContainedTurnOperation(target, { kind: "begin_closure_stage", stage }), target);
      });
    }
    for (const casAttempts of [1, 3]) {
      test(`${stage}: completion CAS ${casAttempts} recognizes its proof despite ${adoption} closure state`, async () => {
        const sequence = stageSnapshots(stage);
        const target = { ...sequence[adoption], revision: sequence[adoption].revision + casAttempts - 1 };
        let commits = 0;
        const dependencies = staleStore(() => {
          commits += 1;
          return commits === casAttempts ? target : { ...sequence.pending, revision: sequence.pending.revision + commits };
        });
        const { counts, driver } = driverFor(stage);
        const result = await resumeContainedTurnClosureStage(dependencies, sequence.pending, submission.scope, driver);
        assert.deepEqual(result, { kind: "completed", operation: target });
        assert.deepEqual(counts, { ensure: 0, query: 1 });
        assert.equal(commits, casAttempts);
      });
    }
  }
  for (const observation of ["indeterminate", "identity_conflict", "throws", "missing"] as const) {
    test(`${stage}: late ${observation} observation cannot attach old evidence to the next stage`, async () => {
      const { later, pending } = stageSnapshots(stage);
      let commits = 0;
      const dependencies = staleStore(() => {commits += 1; return later;});
      const { counts, driver } = driverFor(stage);
      const withoutQuery = { complete: driver.complete, ensure: driver.ensure, proofIds: driver.proofIds, stage };
      const query = async () => {
        counts.query += 1;
        if (observation === "throws") {throw new Error("late observer failure");}
        return { kind: observation === "identity_conflict" ? "identity_conflict" as const : "indeterminate" as const,
          evidenceId: containedTurnIdentity("evidence", "evidence:old-closure-observation") };
      };
      const result = await resumeContainedTurnClosureStage(dependencies, pending, submission.scope,
        observation === "missing" ? withoutQuery : { ...driver, query });
      assert.deepEqual(result, { kind: "completed", operation: later });
      assert.equal(commits, 1, "old evidence must not be committed against the adopted stage");
      assert.deepEqual(counts, { ensure: 0, query: observation === "missing" ? 0 : 1 });
    });
  }
}

test("an unfinished request keeps genuine closure and reconciliation debt without another ensure", async () => {
  const { pending } = stageSnapshots("physical_containment");
  let current = mutateContainedTurnOperation(pending, {
    kind: "record_reconciliation_debt", source: "store_commit",
    evidenceId: containedTurnIdentity("evidence", "evidence:genuine-provider-uncertainty"),
  });
  const original = current;
  const dependencies = { operationStore: { commit: async (input: { candidate: ContainedTurnKernelOperation }) => {
    current = input.candidate;
    return { kind: "applied", operation: current };
  } } } as unknown as ContainedTurnKernelDependencies;
  const { counts, driver } = driverFor("physical_containment");
  const result = await resumeContainedTurnClosureStage(dependencies, current, submission.scope, {
    ...driver,
    query: async () => ({ kind: "indeterminate", evidenceId: containedTurnIdentity("evidence", "evidence:genuine-closure-uncertainty") }),
  });
  assert.equal(result.kind, "debt");
  assert.equal(counts.ensure, 0);
  assert.deepEqual(current.reconciliation, original.reconciliation);
  assert.ok(current.closureRecovery.kind === "required" && original.closureRecovery.kind === "required");
  assert.equal(current.closureRecovery.requestId, original.closureRecovery.requestId);
  assert.equal(current.closureRecovery.evidenceIds.length, 1);
  assert.equal(current.terminal.kind, "open");
});

test("an old unknown observation cannot contaminate a refreshed request for the same unfinished stage", async () => {
  const { pending } = stageSnapshots("containment_attestation");
  assert.ok(pending.closureRecovery.kind === "required");
  const cutoffClosed = mutateContainedTurnOperation(pending, {
    kind: "record_reconciliation_debt", source: "store_commit",
    evidenceId: containedTurnIdentity("evidence", "evidence:concurrent-cutoff"),
  });
  const refreshed = mutateContainedTurnOperation(cutoffClosed, {
    kind: "refresh_containment_attestation_request", request: pending.closureRecovery,
  });
  assert.ok(refreshed.closureRecovery.kind === "required");
  assert.notEqual(refreshed.closureRecovery.requestId, pending.closureRecovery.requestId);
  let commits = 0;
  const dependencies = staleStore(() => {commits += 1; return refreshed;});
  const { counts, driver } = driverFor("containment_attestation");
  const result = await resumeContainedTurnClosureStage(dependencies, pending, submission.scope, {
    ...driver,
    query: async () => ({ kind: "indeterminate", evidenceId: containedTurnIdentity("evidence", "evidence:obsolete-request") }),
  });
  assert.deepEqual(result, { kind: "debt", operation: refreshed, reason: "indeterminate" });
  assert.equal(commits, 1);
  assert.equal(counts.ensure, 0);
  assert.deepEqual(refreshed.closureRecovery.evidenceIds, []);
});

test("completion adoption still rejects a substituted proof identity", async () => {
  const { pending, later } = stageSnapshots("physical_containment");
  const { counts, driver } = driverFor("physical_containment");
  const result = await resumeContainedTurnClosureStage(staleStore(() => later), pending, submission.scope, {
    ...driver,
    query: async request => {
      const outcome = await driver.query(request);
      return { ...outcome, proof: outcome.proof.map(proof => ({
        ...proof, proofId: containedTurnIdentity("proof", "proof:substituted-closure"),
      })) };
    },
  });
  assert.deepEqual(result, { kind: "debt", operation: later, reason: "identity_conflict" });
  assert.deepEqual(counts, { ensure: 0, query: 1 });
});
