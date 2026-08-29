import { CONTAINED_TURN_REQUIRED_PROOF_KINDS } from "./contained-turn-authority.js";
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
  requiredProofKinds: [...CONTAINED_TURN_REQUIRED_PROOF_KINDS],
  resultRef: operation.resultRef ?? null,
  version: 1,
});
