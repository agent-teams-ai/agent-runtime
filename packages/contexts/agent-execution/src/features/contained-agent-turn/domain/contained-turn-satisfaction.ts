import {
  digestContainedTurnCanonicalValue,
  type ContainedTurnCanonicalDigest,
  type ContainedTurnCanonicalValue,
} from "./contained-turn-codecs.js";
import type { ContainedTurnKernelOperation } from "./contained-turn-kernel-model.js";

export const containedTurnSatisfactionDigest = (
  operation: ContainedTurnKernelOperation,
): ContainedTurnCanonicalDigest => digestContainedTurnCanonicalValue({
  artifactManifestRef: operation.artifactManifestRef ?? null,
  authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
  effectDisposition: operation.effect.kind === "resolved" ? operation.effect.disposition : "unresolved",
  outputDigest: digestContainedTurnCanonicalValue(operation.output.chunks as unknown as ContainedTurnCanonicalValue),
  outputFinalCursor: operation.output.chunks.length,
  providerProcessStart: operation.providerProcessStart,
  proofs: operation.proofs
    .filter(proof => proof.kind !== "terminal_truth")
    .map(proof => ({
      kind: proof.kind,
      proofDigest: digestContainedTurnCanonicalValue(proof as unknown as ContainedTurnCanonicalValue),
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
