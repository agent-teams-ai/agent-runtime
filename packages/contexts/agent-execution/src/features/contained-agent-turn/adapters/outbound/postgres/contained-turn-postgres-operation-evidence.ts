import type {
  ContainedTurnKernelOperationStore,
} from "../../../application/ports/outbound/contained-turn-ports.js";
import { containedTurnCancellationFingerprint } from "../../../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../../../domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../../domain/contained-turn-identities.js";
import { containedTurnSatisfactionDigest } from "../../../domain/contained-turn-satisfaction.js";
import {
  assertContainedTurnPostgresAuthority as assertAuthority,
  containedTurnPostgresAttemptBinding as attemptBinding,
  type ContainedTurnPostgresIdentitySource,
  containedTurnPostgresOperationBinding as operationBinding,
} from "./contained-turn-postgres-operation-authority.js";

export class ContainedTurnPostgresOperationEvidence {
  readonly #identities: ContainedTurnPostgresIdentitySource;

  public constructor(identities: ContainedTurnPostgresIdentitySource) {
    this.#identities = identities;
  }

  public async prepareCancellation(
    input: Parameters<ContainedTurnKernelOperationStore["prepareCancellation"]>[0],
  ) {
    assertAuthority(input.authority, input.operation);
    const cancellationSeed = digestContainedTurnCanonicalValue({
      operationId: input.operation.operationId,
      revision: input.operation.revision,
      scopeDigest: input.operation.acceptedAuthorityVector.scopeDigest,
    });
    const cancellationCommandId = containedTurnIdentity("cancellation_command", this.#identities.nextId("cancellation_command", `cancellation:${cancellationSeed}:command`));
    const fingerprint = containedTurnCancellationFingerprint({ cancellationCommandId, operationId: input.operation.operationId, scopeDigest: input.operation.acceptedAuthorityVector.scopeDigest });
    return Object.freeze({
      command: Object.freeze({ cancellationCommandId, fingerprint, operationId: input.operation.operationId, scopeDigest: input.operation.acceptedAuthorityVector.scopeDigest }),
      cutoffProof: Object.freeze({ binding: { ...operationBinding(input.operation), cancellationCommandId }, kind: "cutoff" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `cancellation:${cancellationSeed}:cutoff`)) }),
      preventionProofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `cancellation:${cancellationSeed}:prevention`)),
      proof: Object.freeze({ binding: { ...operationBinding(input.operation), cancellationCommandId, cancellationFingerprint: fingerprint }, kind: "cancellation" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `cancellation:${cancellationSeed}:command`)) }),
    });
  }

  public async proofsForAcceptedEffect(
    input: Parameters<ContainedTurnKernelOperationStore["proofsForAcceptedEffect"]>[0],
  ) {
    assertAuthority(input.authority, input.operation);
    const binding = attemptBinding(input.operation);
    const seed = digestContainedTurnCanonicalValue({
      attemptId: binding.attemptId,
      operationId: input.operation.operationId,
      revision: input.operation.revision,
    });
    return Object.freeze({
      acceptanceProof: { binding: { ...binding, disposition: "accepted" as const }, kind: "provider_acceptance" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `effect:${seed}:acceptance`)) },
      effectProof: { binding: { ...binding, disposition: "committed" as const }, kind: "effect_resolution" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `effect:${seed}:resolution`)) },
      kind: "proved" as const,
    });
  }

  public async proofsForProcessNoStart(
    input: Parameters<ContainedTurnKernelOperationStore["proofsForProcessNoStart"]>[0],
  ) {
    assertAuthority(input.authority, input.operation);
    const binding = operationBinding(input.operation);
    const seed = digestContainedTurnCanonicalValue({ operationId: input.operation.operationId, revision: input.operation.revision });
    const proof = (role: string) => containedTurnIdentity("proof", this.#identities.nextId("proof", `no-start:${seed}:${role}`));
    return Object.freeze({
      containmentProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "containment_not_required" as const, proofId: proof("containment") },
      effectProof: { binding: { ...binding, disposition: "not_committed" as const, effectId: input.operation.effectId }, kind: "effect_no_start" as const, proofId: proof("effect") },
      executionProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "no_start" as const, proofId: proof("execution") },
      outputProof: { binding: { ...binding, finalCursor: input.operation.output.chunks.length }, kind: "output_no_start_drain" as const, proofId: proof("output") },
      providerProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "provider_not_started" as const, proofId: proof("provider") },
    });
  }

  public async proofsForPrevention(
    input: Parameters<ContainedTurnKernelOperationStore["proofsForPrevention"]>[0],
  ) {
    assertAuthority(input.authority, input.operation);
    const binding = operationBinding(input.operation);
    const seed = digestContainedTurnCanonicalValue({
      operationId: input.operation.operationId,
      preventionProofId: input.preventionProofId,
      revision: input.operation.revision,
    });
    const proof = (role: string) => containedTurnIdentity("proof", this.#identities.nextId("proof", `prevention:${seed}:${role}`));
    return Object.freeze({
      containmentProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "containment_not_required" as const, proofId: proof("containment") },
      cutoffProof: { binding, kind: "cutoff" as const, proofId: proof("cutoff") },
      effectProof: { binding: { ...binding, disposition: "not_committed" as const, effectId: input.operation.effectId }, kind: "effect_no_start" as const, proofId: proof("effect") },
      executionProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "no_start" as const, proofId: proof("execution") },
      hostCustodyProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "host_custody_no_start" as const, proofId: proof("custody") },
      noDispatchProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "no_dispatch" as const, proofId: input.preventionProofId },
      outputProof: { binding: { ...binding, finalCursor: 0 }, kind: "output_no_start_drain" as const, proofId: proof("output") },
      providerProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "provider_not_started" as const, proofId: proof("provider") },
    });
  }

  public async terminalProof(
    input: Parameters<ContainedTurnKernelOperationStore["terminalProof"]>[0],
  ) {
    assertAuthority(input.authority, input.operation);
    if (input.satisfactionDigest !== containedTurnSatisfactionDigest(input.operation) || input.operation.providerExecution.kind !== "closed") {throw new TypeError("terminal proof precondition mismatch");}
    const seed = digestContainedTurnCanonicalValue({
      operationId: input.operation.operationId,
      revision: input.operation.revision,
      satisfactionDigest: input.satisfactionDigest,
    });
    return Object.freeze({
      binding: { ...operationBinding(input.operation), requiredReceiptSetDigest: input.operation.requiredReceiptSetDigest, requiredReceiptSetVersion: input.operation.requiredReceiptSet.setVersion, satisfactionDigest: input.satisfactionDigest, terminalOutcome: input.operation.providerExecution.outcome },
      kind: "terminal_truth" as const,
      proofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `terminal:${seed}`)),
    });
  }
}
