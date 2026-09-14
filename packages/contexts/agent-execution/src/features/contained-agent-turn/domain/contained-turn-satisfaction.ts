import {
  digestContainedTurnCanonicalInput,
  type ContainedTurnCanonicalDigest,
} from "./contained-turn-codecs.js";
import type { ContainedTurnOutputValidatedOperation } from "./contained-turn-validation.js";

export const containedTurnSatisfactionDigest = (
  operation: ContainedTurnOutputValidatedOperation,
): ContainedTurnCanonicalDigest => digestContainedTurnCanonicalInput({
  artifactManifestRef: operation.artifactManifestRef ?? null,
  authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
  effectDisposition: operation.effect.kind === "resolved" ? operation.effect.disposition : "unresolved",
  outputDigest: digestContainedTurnCanonicalInput(operation.output.chunks),
  outputFinalCursor: operation.output.chunks.length,
  providerProcessStart: operation.providerProcessStart,
  proofs: operation.proofs
    .filter(proof => proof.kind !== "terminal_truth")
    .map(proof => ({
      kind: proof.kind,
      proofDigest: digestContainedTurnCanonicalInput(proof),
      proofId: proof.proofId,
    }))
    .toSorted((left, right) => left.proofId.localeCompare(right.proofId)),
  requiredReceiptSet: {
    digest: operation.requiredReceiptSetDigest,
    set: {
      membershipFrozenAt: operation.requiredReceiptSet.membershipFrozenAt,
      membershipMutation: operation.requiredReceiptSet.membershipMutation,
      receipts: [...operation.requiredReceiptSet.receipts],
      satisfaction: operation.requiredReceiptSet.satisfaction,
      setVersion: operation.requiredReceiptSet.setVersion,
    },
  },
  resultRef: operation.resultRef ?? null,
  version: 1,
});
