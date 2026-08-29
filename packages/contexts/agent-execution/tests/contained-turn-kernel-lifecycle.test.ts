import assert from "node:assert/strict";
import test from "node:test";

import {
  containedTurnCancellationFingerprint,
  containedTurnScopeDigest,
  type ContainedTurnCancellationCommand,
} from "../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import {
  digestContainedTurnCanonicalValue,
  type ContainedTurnCanonicalDigest,
} from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {
  containedTurnSatisfactionDigest,
  mutateContainedTurnOperation,
  validateContainedTurnOperation,
  type ContainedTurnKernelOperation,
} from "../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import { containedTurnIdentity } from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { type ContainedTurnProof } from "../dist/features/contained-agent-turn/domain/contained-turn-proofs.js";
import {
  adapterSnapshot,
  attemptBinding,
  authorityVector,
  commonBinding,
  createActiveOperation,
  createOperation,
  custodyId,
  expectInvariant,
  hostBootId,
  hostInstanceId,
  manifest,
  operationId,
  proofId,
  providerAccessSnapshot,
  scope,
  workspaceId,
} from "./contained-turn-kernel-fixtures.ts";

test("enforces contiguous output, exact final cursor, append-only history, and no reopen", () => {
  const operation = createActiveOperation();
  const withOutput = mutateContainedTurnOperation(operation, {
    kind: "append_output",
    output: { cursor: 0, kind: "assistant", text: "one" },
  });
  expectInvariant(
    () => mutateContainedTurnOperation(withOutput, { kind: "append_output", output: { cursor: 2, kind: "assistant", text: "gap" } }),
    /contiguous/u,
  );
  const fenced = { ...withOutput, output: { chunks: withOutput.output.chunks, fence: { finalCursor: 2, kind: "fenced" as const } } };
  expectInvariant(() => validateContainedTurnOperation(fenced), /final cursor/u);
  const rewritten = {
    ...withOutput,
    output: { chunks: [{ cursor: 0, kind: "assistant" as const, text: "rewritten" }], fence: withOutput.output.fence },
    revision: withOutput.revision + 1,
  };
  expectInvariant(() => validateContainedTurnOperation(rewritten, { previous: withOutput }), /cannot be rewritten/u);
});
test("ambiguity atomically fences output, records debt, and rejects later canonical output", () => {
  const operation = mutateContainedTurnOperation(createActiveOperation(), {
    kind: "append_output",
    output: { cursor: 0, kind: "progress", text: "before ambiguity" },
  });
  const ambiguityEvidenceId = containedTurnIdentity("evidence", "evidence:ambiguous");
  const ambiguous = mutateContainedTurnOperation(operation, { evidenceId: ambiguityEvidenceId, kind: "record_ambiguity" });
  assert.deepEqual(ambiguous.output.fence, { finalCursor: 1, kind: "fenced" });
  assert.deepEqual(ambiguous.reconciliation, { evidenceIds: [ambiguityEvidenceId], kind: "required" });
  expectInvariant(
    () => mutateContainedTurnOperation(ambiguous, { kind: "append_output", output: { cursor: 1, kind: "assistant", text: "late" } }),
    /cannot append after its fence|final cursor/u,
  );
  const clearedDebt = { ...ambiguous, reconciliation: { kind: "clear" as const }, revision: ambiguous.revision + 1 };
  expectInvariant(() => validateContainedTurnOperation(clearedDebt, { previous: ambiguous }), /reconciliation debt|cannot be cleared/u);
});

test("cancellation replay is keyed by exact command identity and canonical fingerprint", () => {
  const operation = createOperation();
  const cancellationCommandId = containedTurnIdentity("cancellation_command", "cancellation-command:1");
  const cancellationCommand: ContainedTurnCancellationCommand = {
    cancellationCommandId,
    fingerprint: containedTurnCancellationFingerprint({ cancellationCommandId, operationId, scopeDigest: containedTurnScopeDigest(scope) }),
    operationId,
    scopeDigest: containedTurnScopeDigest(scope),
  };
  const cancellationProof = {
    binding: { ...commonBinding, cancellationCommandId, cancellationFingerprint: cancellationCommand.fingerprint },
    kind: "cancellation" as const,
    proofId: proofId("proof:cancellation"),
  };
  const cutoffProof = {
    binding: { ...commonBinding, cancellationCommandId },
    kind: "cutoff" as const,
    proofId: proofId("proof:cutoff"),
  };
  const requested = mutateContainedTurnOperation(operation, {
    command: cancellationCommand, cutoffProof, kind: "request_cancellation", proof: cancellationProof,
  });
  assert.equal(requested.cancellation.kind, "requested");
  const replayed = mutateContainedTurnOperation(requested, {
    command: cancellationCommand, cutoffProof, kind: "request_cancellation", proof: cancellationProof,
  });
  assert.strictEqual(replayed, requested);
  const otherId = containedTurnIdentity("cancellation_command", "cancellation-command:2");
  const other = {
    ...cancellationCommand,
    cancellationCommandId: otherId,
    fingerprint: containedTurnCancellationFingerprint({ cancellationCommandId: otherId, operationId, scopeDigest: containedTurnScopeDigest(scope) }),
  };
  expectInvariant(
    () => mutateContainedTurnOperation(requested, { command: other, cutoffProof, kind: "request_cancellation", proof: cancellationProof }),
    /exact command/u,
  );

  const active = createActiveOperation();
  const activeCutoff = active.proofs.find(
    (proof): proof is Extract<ContainedTurnProof, { readonly kind: "cutoff" }> => proof.kind === "cutoff",
  );
  assert.notEqual(activeCutoff, undefined);
  if (activeCutoff !== undefined) {
    const activeCancellationProof: Extract<ContainedTurnProof, { readonly kind: "cancellation" }> = {
      binding: { ...commonBinding, cancellationCommandId, cancellationFingerprint: cancellationCommand.fingerprint },
      kind: "cancellation",
      proofId: proofId("proof:active-cancellation"),
    };
    const activeCancellation = mutateContainedTurnOperation(active, {
      command: cancellationCommand,
      cutoffProof: activeCutoff,
      kind: "request_cancellation",
      proof: activeCancellationProof,
    });
    assert.deepEqual(activeCancellation.admissionFence, active.admissionFence);
    assert.equal(activeCancellation.proofs.filter(proof => proof.kind === "cutoff").length, 1);
  }
});

const buildTerminalCandidate = (): ContainedTurnKernelOperation => {
  let operation = mutateContainedTurnOperation(createActiveOperation(), {
    kind: "append_output",
    output: { cursor: 0, kind: "assistant", text: "done" },
  });
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
  operation = mutateContainedTurnOperation(operation, {
    kind: "resolve_effect",
    proof: { binding: { ...attemptBinding, disposition: "committed" }, kind: "effect_resolution", proofId: proofId("proof:effect") },
  });
  operation = mutateContainedTurnOperation(operation, {
    artifactManifestRef: "artifact-manifest:1",
    kind: "seal_artifact",
    proof: { binding: { ...commonBinding, artifactManifestRef: "artifact-manifest:1", workspaceId }, kind: "artifact_manifest_seal", proofId: proofId("proof:artifact") },
  });
  operation = mutateContainedTurnOperation(operation, {
    kind: "publish_result",
    proof: { binding: { ...commonBinding, resultRef: "result:1" }, kind: "result_publication", proofId: proofId("proof:result") },
    resultRef: "result:1",
  });
  operation = mutateContainedTurnOperation(operation, {
    kind: "close_workspace",
    proof: { binding: { ...commonBinding, workspaceId }, kind: "workspace_closure", proofId: proofId("proof:workspace") },
  });
  operation = mutateContainedTurnOperation(operation, {
    kind: "record_containment",
    proof: {
      binding: {
        ...attemptBinding,
        adapterRevision: adapterSnapshot.adapterRevision,
        artifactManifestSealProofId: proofId("proof:artifact"),
        binaryRevision: adapterSnapshot.binaryRevision,
        capabilityManifestRevision: manifest.manifestRevision,
        containmentPolicyDigest: authorityVector.containmentPolicyDigest,
        credentialBindingDigest: providerAccessSnapshot.credentialBindingDigest,
        custodyId,
        cutoffProofId: proofId("proof:cutoff"),
        executionClosureProofId: proofId("proof:execution"),
        finalCursor: 1,
        hostBootId,
        hostInstanceId,
        immutableScopeDigest: authorityVector.scopeDigest,
        outputDrainProofId: proofId("proof:output-drain"),
        providerRouteRef: providerAccessSnapshot.providerRouteRef,
        terminalObservationProofId: proofId("proof:provider-terminal"),
        workspaceId,
      },
      kind: "containment",
      proofId: proofId("proof:containment"),
    },
  });
  const satisfactionDigest = containedTurnSatisfactionDigest(operation);
  const terminalProof: ContainedTurnProof = {
    binding: { ...commonBinding, satisfactionDigest, terminalOutcome: "succeeded" },
    kind: "terminal_truth",
    proofId: proofId("proof:terminal"),
  };
  return mutateContainedTurnOperation(operation, {
    kind: "finalize",
    proof: terminalProof as Extract<ContainedTurnProof, { kind: "terminal_truth" }>,
  });
};

test("accepts exact terminal proof closure and rejects false terminal truth or proof substitution", () => {
  const terminal = buildTerminalCandidate();
  assert.doesNotThrow(() => validateContainedTurnOperation(terminal));
  const impossibleDigest = {
    ...terminal,
    terminal: { ...terminal.terminal, satisfactionDigest: digestContainedTurnCanonicalValue({ false: "closure" }) as ContainedTurnCanonicalDigest },
  } as ContainedTurnKernelOperation;
  expectInvariant(() => validateContainedTurnOperation(impossibleDigest), /satisfaction digest|satisfaction mismatch/u);
  const containmentSubstitution = {
    ...terminal,
    containment: { kind: "contained" as const, proofId: proofId("proof:acceptance") },
  };
  expectInvariant(() => validateContainedTurnOperation(containmentSubstitution), /containment requires its own exact proof/u);
  const falseClosure = { ...terminal, resultRef: undefined } as unknown as ContainedTurnKernelOperation;
  expectInvariant(
    () => validateContainedTurnOperation(falseClosure),
    /exact closed record|result proof binding|artifact and result closure/u,
  );
});
