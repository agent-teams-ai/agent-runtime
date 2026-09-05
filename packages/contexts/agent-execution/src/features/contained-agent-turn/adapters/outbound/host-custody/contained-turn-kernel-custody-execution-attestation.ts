import type { ContainedTurnKernelCustodyPort } from "../../../application/ports/outbound/contained-turn-ports.js";
import type { HostCustodyEvidence } from "./custodied-provider-process.js";
import {
  completionProjection,
  hostEvidenceProjection,
  proofId,
  reservationIdentity,
  type ReservationProofAuthority,
  type SealedProviderCompletion,
} from "./contained-turn-kernel-custody-projections.js";

type ExecutionAttestation = Extract<
  Awaited<ReturnType<ContainedTurnKernelCustodyPort["attestExecutionClosure"]>>,
  { readonly kind: "proved" }
>;

/**
 * Projects verified closure observations into immutable, redacted kernel proofs.
 * The custody adapter owns admission, Host observation, and cursor replay checks.
 */
export const createExecutionAttestation = (
  reservation: ReservationProofAuthority,
  observed: HostCustodyEvidence,
  completion: SealedProviderCompletion,
  receiptRef: string,
  finalCursor: number,
): ExecutionAttestation => {
  const binding = Object.freeze({
    attemptId: reservation.attemptId,
    authorityVectorDigest: reservation.authorityVectorDigest,
    effectId: reservation.effectId,
    operationId: reservation.operationId,
  });
  const closureProjection = Object.freeze({
    completion: completionProjection(completion),
    evidence: hostEvidenceProjection(observed),
    proofDigest: reservation.proofDigest ?? null,
    receiptRef,
    reservation: reservationIdentity(reservation),
  });
  return Object.freeze({
    executionClosureProof: Object.freeze({
      binding: Object.freeze({ ...binding, outcome: completion.outcome }),
      kind: "execution_closure",
      proofId: proofId("execution-closure", closureProjection),
    }),
    kind: "proved",
    outputDrainProof: Object.freeze({
      binding: Object.freeze({ ...binding, finalCursor }),
      kind: "output_drain",
      proofId: proofId("output-drain", Object.freeze({
        closure: closureProjection,
        finalCursor,
      })),
    }),
    terminalObservationProof: Object.freeze({
      binding: Object.freeze({ ...binding, outcome: completion.outcome }),
      kind: "provider_terminal_observation",
      proofId: proofId("terminal-observation", closureProjection),
    }),
  });
};
