import type { ContainedTurnKernelCustodyPort } from "../../../application/ports/outbound/contained-turn-ports.js";
import {
  validateCommittedDispatchProofV1,
  type CommittedDispatchProofV1,
} from "../../../domain/committed-dispatch-proof-v1.js";
import type { KernelReservation } from "./contained-turn-kernel-custody-state.js";

type StartInput = Parameters<ContainedTurnKernelCustodyPort["start"]>[0];
type HostProofBinding = Readonly<Pick<
  CommittedDispatchProofV1,
  "hostBootId" | "hostCustodyProofId" | "hostInstanceId"
>>;

const proofMatchesReservation = (
  proof: CommittedDispatchProofV1,
  reservation: KernelReservation,
  host: HostProofBinding,
): boolean => proof.attemptId === reservation.attemptId &&
  proof.acceptedAuthorityVectorDigest === reservation.authorityVectorDigest &&
  proof.commandId === reservation.commandId && proof.custodyId === reservation.custodyId &&
  proof.effectId === reservation.effectId && proof.hostBootId === host.hostBootId &&
  proof.hostCustodyProofId === host.hostCustodyProofId &&
  proof.hostInstanceId === host.hostInstanceId && proof.operationId === reservation.operationId &&
  proof.operationCutoffRevision === reservation.operationCutoffRevision &&
  proof.committedOperationRevision === reservation.operationRevision &&
  proof.preparationToken === reservation.preparationToken && proof.projectId === reservation.projectId &&
  proof.provider === reservation.provider && proof.tenantId === reservation.tenantId &&
  proof.workspaceId === reservation.workspaceId;

/** Synchronously admits and consumes the exact committed authority for one reserved start. */
export const admitCommittedDispatchStart = (
  input: StartInput,
  reservation: KernelReservation,
  host: HostProofBinding,
): void => {
  if (reservation.started) {throw new TypeError("Host Custody start authority was already consumed");}
  if (reservation.released) {throw new TypeError("Host Custody start authority belongs to a released reservation");}
  const proof = validateCommittedDispatchProofV1(input.committedDispatchProof);
  if (!proofMatchesReservation(proof, reservation, host)) {
    throw new TypeError("Host Custody committed dispatch proof conflicts with its reservation");
  }
  if (reservation.workspaceId !== input.workspaceId || reservation.intentMode !== input.intent.mode) {
    throw new TypeError("Host Custody start identity conflict");
  }
  reservation.proofDigest = proof.proofDigest;
  reservation.started = true;
};
