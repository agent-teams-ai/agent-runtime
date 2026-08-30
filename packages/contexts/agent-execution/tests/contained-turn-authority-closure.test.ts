import assert from "node:assert/strict";
import test from "node:test";

import { resumeContainedTurnClosureStage } from "../dist/features/contained-agent-turn/application/contained-turn-closure-recovery.js";
import type { ContainedTurnKernelDependencies } from "../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {
  appendContainedTurnOutputForOwnerStore,
  mutateContainedTurnOperation,
  type ContainedTurnKernelOperation,
} from "../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import type { ContainedTurnProof } from "../dist/features/contained-agent-turn/domain/contained-turn-proofs.js";
import {
  attemptBinding, createActiveOperation, custodyId, hostBootId, hostInstanceId,
  proofId, scope,
} from "./contained-turn-kernel-fixtures.ts";

const buildClosedExecution = (): ContainedTurnKernelOperation => {
  let operation = appendContainedTurnOutputForOwnerStore(
    createActiveOperation(), { cursor: 0, kind: "assistant", text: "done" },
  );
  operation = mutateContainedTurnOperation(operation, {
    kind: "record_provider_acceptance",
    proof: { binding: { ...attemptBinding, disposition: "accepted" }, kind: "provider_acceptance", proofId: proofId("proof:provider-acceptance") },
  });
  operation = mutateContainedTurnOperation(operation, {
    executionProof: { binding: { ...attemptBinding, outcome: "succeeded" }, kind: "execution_closure", proofId: proofId("proof:execution") },
    kind: "close_provider_execution",
    terminalObservationProof: { binding: { ...attemptBinding, outcome: "succeeded" }, kind: "provider_terminal_observation", proofId: proofId("proof:provider-terminal") },
  });
  operation = mutateContainedTurnOperation(operation, {
    kind: "drain_output",
    proof: { binding: { ...attemptBinding, finalCursor: 1 }, kind: "output_drain", proofId: proofId("proof:output-drain") },
  });
  return mutateContainedTurnOperation(operation, {
    kind: "resolve_effect",
    proof: { binding: { ...attemptBinding, disposition: "committed" }, kind: "effect_resolution", proofId: proofId("proof:effect") },
  });
};

const physicalProof: Extract<ContainedTurnProof, { kind: "physical_containment" }> = {
  binding: { ...attemptBinding, custodyId, hostBootId, hostInstanceId },
  kind: "physical_containment",
  proofId: proofId("proof:physical-containment"),
};

test("recoverable closure adopts post-effect proof through a CAS race without repeating the effect", async () => {
  const crashed = mutateContainedTurnOperation(buildClosedExecution(), {
    kind: "begin_closure_stage", stage: "physical_containment",
  });
  if (crashed.closureRecovery.kind !== "required") {assert.fail("closure request must be durable");}
  const durableRequest = crashed.closureRecovery;
  let current = crashed;
  let completionCasAttempts = 0;
  let ensureCalls = 0;
  const dependencies = { operationStore: { commit: async (input: { candidate: ContainedTurnKernelOperation }) => {
    if (input.candidate.closureRecovery.kind === "clear" && completionCasAttempts++ === 0) {
      return { current, kind: "stale" as const };
    }
    current = input.candidate;
    return { kind: "applied" as const, operation: current };
  } } } as unknown as ContainedTurnKernelDependencies;
  const recovered = await resumeContainedTurnClosureStage(dependencies, crashed, scope, {
    complete: (request, proof: typeof physicalProof) => ({ kind: "complete_physical_containment", proof, request }),
    ensure: async request => {
      ensureCalls += 1;
      assert.deepEqual(
        [request.requestId, request.requestDigest],
        [durableRequest.requestId, durableRequest.requestDigest],
      );
      return { kind: "proved", proof: physicalProof, requestDigest: request.requestDigest, requestId: request.requestId };
    },
    proofIds: proof => [proof.proofId],
    stage: "physical_containment",
  });
  assert.equal(recovered.kind, "completed");
  assert.equal(ensureCalls, 1);
  assert.equal(completionCasAttempts, 2);
  assert.deepEqual(recovered.operation.physicalContainment, { kind: "contained", proofId: physicalProof.proofId });
  assert.equal(recovered.operation.proofs.filter(proof => proof.proofId === physicalProof.proofId).length, 1);
});

test("closure request replay is exact and a concurrent stage or digest substitution conflicts", () => {
  const pending = mutateContainedTurnOperation(buildClosedExecution(), {
    kind: "begin_closure_stage", stage: "physical_containment",
  });
  if (pending.closureRecovery.kind !== "required") {assert.fail("closure debt must be durable");}
  assert.strictEqual(mutateContainedTurnOperation(pending, {
    kind: "begin_closure_stage", stage: "physical_containment",
  }), pending);
  assert.throws(() => mutateContainedTurnOperation(pending, {
    kind: "begin_closure_stage", stage: "artifact_seal",
  }), /one exact closure stage/u);
  assert.throws(() => mutateContainedTurnOperation(pending, {
    kind: "complete_physical_containment",
    proof: physicalProof,
    request: { ...pending.closureRecovery, requestDigest: digestContainedTurnCanonicalValue({ conflict: true }) },
  }), /closure proof\/request substitution/u);
});
