import assert from "node:assert/strict";
import test from "node:test";

import { closeContainedTurnPhysicalContainment, closeContainedTurnWithoutExecution } from "../dist/features/contained-agent-turn/application/contained-turn-closure.js";
import {
  closeContainedTurnNoWorkspaceObligations,
  resumeContainedTurnClosureStage,
} from "../dist/features/contained-agent-turn/application/contained-turn-closure-recovery.js";
import type { ContainedTurnKernelDependencies } from "../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { containedTurnCancellationFingerprint } from "../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import {
  appendContainedTurnOutputForOwnerStore,
  mutateContainedTurnOperation,
  validateContainedTurnOperation,
  type ContainedTurnKernelOperation,
} from "../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import type { ContainedTurnProof } from "../dist/features/contained-agent-turn/domain/contained-turn-proofs.js";
import { containedTurnSatisfactionDigest } from "../dist/features/contained-agent-turn/domain/contained-turn-satisfaction.js";
import {
  attemptBinding, commonBinding, createActiveOperation, createOperation, createReservedOperation, custodyId, effectId, hostBootId, hostInstanceId,
  operationId, proofId, scope, workspaceId,
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

test("recovery after a durable closure request queries evidence and adopts it through a CAS race", async () => {
  const crashed = mutateContainedTurnOperation(buildClosedExecution(), {
    kind: "begin_closure_stage", stage: "physical_containment",
  });
  if (crashed.closureRecovery.kind !== "required") {assert.fail("closure request must be durable");}
  const durableRequest = crashed.closureRecovery;
  let current = crashed;
  let completionCasAttempts = 0;
  let ensureCalls = 0;
  let queryCalls = 0;
  const dependencies = { operationStore: { commit: async (input: { candidate: ContainedTurnKernelOperation }) => {
    if (input.candidate.closureRecovery.kind === "clear" && completionCasAttempts++ === 0) {
      return { current, kind: "stale" as const };
    }
    current = input.candidate;
    return { kind: "applied" as const, operation: current };
  } } } as unknown as ContainedTurnKernelDependencies;
  const recovered = await resumeContainedTurnClosureStage(dependencies, crashed, scope, {
    complete: (request, proof: typeof physicalProof) => ({ kind: "complete_physical_containment", proof, request }),
    ensure: async () => {
      ensureCalls += 1;
      throw new Error("a durable request must be observed, not issued again");
    },
    query: async request => {
      queryCalls += 1;
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
  assert.equal(ensureCalls, 0);
  assert.equal(queryCalls, 1);
  assert.equal(completionCasAttempts, 2);
  assert.deepEqual(recovered.operation.physicalContainment, { kind: "contained", proofId: physicalProof.proofId });
  assert.equal(recovered.operation.proofs.filter(proof => proof.proofId === physicalProof.proofId).length, 1);
});

test("missing observation after a closure request stays durable debt across repeated recovery", async () => {
  let current = mutateContainedTurnOperation(buildClosedExecution(), {
    kind: "begin_closure_stage", stage: "physical_containment",
  });
  let ensureCalls = 0;
  const dependencies = { operationStore: { commit: async (input: { candidate: ContainedTurnKernelOperation }) => {
    current = input.candidate;
    return { kind: "applied" as const, operation: current };
  } } } as unknown as ContainedTurnKernelDependencies;
  const driver = {
    complete: (request: Extract<typeof current.closureRecovery, { kind: "required" }>, proof: typeof physicalProof) => ({ kind: "complete_physical_containment" as const, proof, request }),
    ensure: async () => {
      ensureCalls += 1;
      return { kind: "proved" as const, proof: physicalProof, requestDigest: "never", requestId: "never" } as never;
    },
    proofIds: (proof: typeof physicalProof) => [proof.proofId],
    stage: "physical_containment" as const,
  };
  const first = await resumeContainedTurnClosureStage(dependencies, current, scope, driver);
  const second = await resumeContainedTurnClosureStage(dependencies, first.operation, scope, driver);
  assert.equal(first.kind, "debt");
  assert.equal(second.kind, "debt");
  assert.equal(ensureCalls, 0);
  assert.equal(second.operation.closureRecovery.kind, "required");
  if (second.operation.closureRecovery.kind === "required") {
    assert.equal(second.operation.closureRecovery.evidenceIds.length, 1);
  }
});

test("a throwing post-request effect preserves closure debt and never uses the legacy fallback", async () => {
  let current = createReservedOperation();
  let legacyCalls = 0;
  const dependencies = {
    custody: {
      ensurePhysicalContainment: async () => {throw new Error("ack lost after request");},
      requestPhysicalContainment: async () => {
        legacyCalls += 1;
        throw new Error("legacy fallback must not run");
      },
    },
    operationStore: { commit: async (input: { candidate: ContainedTurnKernelOperation }) => {
      current = input.candidate;
      return { kind: "applied" as const, operation: current };
    } },
  } as unknown as ContainedTurnKernelDependencies;
  const closed = await closeContainedTurnPhysicalContainment(dependencies, current, scope);
  assert.equal(closed.closureRecovery.kind, "required");
  assert.equal(closed.terminal.kind, "open");
  assert.equal(legacyCalls, 0);
  if (closed.closureRecovery.kind === "required") {
    assert.equal(closed.closureRecovery.stage, "physical_containment");
    assert.equal(closed.closureRecovery.evidenceIds.length, 1);
  }
});

const createPreWorkspaceCancellation = (): ContainedTurnKernelOperation => {
  const cancellationCommandId = containedTurnIdentity("cancellation_command", "cancellation-command:pre-workspace");
  const command = {
    cancellationCommandId,
    fingerprint: containedTurnCancellationFingerprint({ cancellationCommandId, operationId, scopeDigest: createOperation().acceptedAuthorityVector.scopeDigest }),
    operationId,
    scopeDigest: createOperation().acceptedAuthorityVector.scopeDigest,
  };
  let operation = mutateContainedTurnOperation(createOperation(), {
    command,
    cutoffProof: { binding: { ...commonBinding, cancellationCommandId }, kind: "cutoff", proofId: proofId("proof:cancel-cutoff:pre-workspace") },
    kind: "request_cancellation",
    proof: { binding: { ...commonBinding, cancellationCommandId, cancellationFingerprint: command.fingerprint }, kind: "cancellation", proofId: proofId("proof:cancellation:pre-workspace") },
  });
  operation = mutateContainedTurnOperation(operation, {
    containmentProof: { binding: { ...commonBinding, effectId }, kind: "containment_not_required", proofId: proofId("proof:containment-na:pre-workspace") },
    cutoffProof: operation.proofs.find(proof => proof.kind === "cutoff") as Extract<ContainedTurnProof, { kind: "cutoff" }>,
    effectProof: { binding: { ...commonBinding, disposition: "not_committed", effectId }, kind: "effect_no_start", proofId: proofId("proof:effect-na:pre-workspace") },
    executionProof: { binding: { ...commonBinding, effectId }, kind: "no_start", proofId: proofId("proof:no-start:pre-workspace") },
    hostCustodyProof: { binding: { ...commonBinding, effectId }, kind: "host_custody_no_start", proofId: proofId("proof:custody-na:pre-workspace") },
    kind: "prevent_dispatch",
    noDispatchProof: { binding: { ...commonBinding, effectId }, kind: "no_dispatch", proofId: proofId("proof:no-dispatch:pre-workspace") },
    outputProof: { binding: { ...commonBinding, finalCursor: 0 }, kind: "output_no_start_drain", proofId: proofId("proof:output-na:pre-workspace") },
    providerProof: { binding: { ...commonBinding, effectId }, kind: "provider_not_started", proofId: proofId("proof:provider-na:pre-workspace") },
  });
  return operation;
};

test("pre-workspace cancellation closes only with an authority-bound no-workspace fact", async () => {
  let current = createPreWorkspaceCancellation();
  const dependencies = { operationStore: {
    commit: async (input: { candidate: ContainedTurnKernelOperation; expectedRevision: number }) => {
      assert.equal(input.expectedRevision, current.revision);
      validateContainedTurnOperation(input.candidate, { previous: current });
      current = input.candidate;
      return { kind: "applied" as const, operation: current };
    },
    terminalProof: async (input: { operation: ContainedTurnKernelOperation; satisfactionDigest: ReturnType<typeof containedTurnSatisfactionDigest> }) => ({
      binding: {
        ...commonBinding,
        requiredReceiptSetDigest: input.operation.requiredReceiptSetDigest,
        requiredReceiptSetVersion: input.operation.requiredReceiptSet.setVersion,
        satisfactionDigest: input.satisfactionDigest,
        terminalOutcome: "cancelled" as const,
      },
      kind: "terminal_truth" as const,
      proofId: proofId("proof:terminal:pre-workspace"),
    }),
  } } as unknown as ContainedTurnKernelDependencies;
  const closed = await closeContainedTurnWithoutExecution(dependencies, current, scope);
  assert.equal(closed.terminal.kind, "final");
  assert.equal(closed.closureRecovery.kind, "proved_no_workspace");
  assert.equal(closed.workspaceId, undefined);
  assert.equal(closed.artifactManifestRef, undefined);
  assert.equal(closed.resultRef, undefined);
  if (closed.closureRecovery.kind === "proved_no_workspace") {
    const forged = {
      ...closed,
      closureRecovery: {
        ...closed.closureRecovery,
        fact: { ...closed.closureRecovery.fact, authorityVectorDigest: digestContainedTurnCanonicalValue({ stale: true }) },
      },
    } as ContainedTurnKernelOperation;
    assert.throws(() => validateContainedTurnOperation(forged), /authority-bound/u);
  }
});

test("repeated no-workspace recovery preserves the exact monotonic closure fact", async () => {
  let current = createPreWorkspaceCancellation();
  let commits = 0;
  const dependencies = { operationStore: { commit: async (input: { candidate: ContainedTurnKernelOperation }) => {
    validateContainedTurnOperation(input.candidate, { previous: current });
    commits += 1;
    current = input.candidate;
    return { kind: "applied" as const, operation: current };
  } } } as unknown as ContainedTurnKernelDependencies;
  const first = await closeContainedTurnNoWorkspaceObligations(dependencies, current, scope);
  const second = await closeContainedTurnNoWorkspaceObligations(dependencies, first, scope);
  assert.equal(first.closureRecovery.kind, "proved_no_workspace");
  assert.strictEqual(second, first);
  assert.equal(commits, 2);
  assert.throws(
    () => validateContainedTurnOperation({ ...second, closureRecovery: { kind: "clear" } }, { previous: second }),
    /cannot reopen/u,
  );
});

test("sealed artifact and result references cannot bypass exact workspace-close observation", async () => {
  let current = mutateContainedTurnOperation(buildClosedExecution(), {
    kind: "record_physical_containment", proof: physicalProof,
  });
  current = mutateContainedTurnOperation(current, {
    artifactManifestRef: "artifact-manifest:sealed",
    kind: "seal_artifact",
    proof: { binding: { ...commonBinding, artifactManifestRef: "artifact-manifest:sealed", workspaceId }, kind: "artifact_manifest_seal", proofId: proofId("proof:artifact:sealed") },
  });
  current = mutateContainedTurnOperation(current, {
    kind: "publish_result",
    proof: { binding: { ...commonBinding, resultRef: "result:sealed" }, kind: "result_publication", proofId: proofId("proof:result:sealed") },
    resultRef: "result:sealed",
  });
  let legacyCloseCalls = 0;
  const dependencies = {
    operationStore: { commit: async (input: { candidate: ContainedTurnKernelOperation }) => {
      current = input.candidate;
      return { kind: "applied" as const, operation: current };
    } },
    workspace: { close: async () => {
      legacyCloseCalls += 1;
      throw new Error("legacy close must not run");
    } },
  } as unknown as ContainedTurnKernelDependencies;
  const closed = await closeContainedTurnWithoutExecution(dependencies, current, scope);
  assert.equal(closed.terminal.kind, "open");
  assert.equal(closed.closureRecovery.kind, "required");
  if (closed.closureRecovery.kind === "required") {assert.equal(closed.closureRecovery.stage, "workspace_close");}
  assert.equal(legacyCloseCalls, 0);
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
