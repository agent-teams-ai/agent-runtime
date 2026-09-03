import type { ContainedTurnKernelCustodyPort } from "../../../application/ports/outbound/contained-turn-ports.js";
import { evidenceId, reservationIdentity } from "./contained-turn-kernel-custody-projections.js";
import type { KernelReservation } from "./contained-turn-kernel-custody-state.js";

type CompletionBoundaryInput = Parameters<ContainedTurnKernelCustodyPort["completionBoundary"]>[0];

export const openKernelCompletionBoundary = (
  input: CompletionBoundaryInput,
  reservation: KernelReservation,
  completionAfterMs: number,
): ReturnType<ContainedTurnKernelCustodyPort["completionBoundary"]> => {
  if (input.phase === "execution") {
    if (reservation.executionBoundaryOpened) {
      throw new TypeError("Host Custody execution boundary was already opened");
    }
    reservation.executionBoundaryOpened = true;
  }
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiration = new Promise<{
    readonly evidenceId: ReturnType<typeof evidenceId>;
    readonly kind: "expired";
  }>(resolve => {
    timer = setTimeout(() => {
      timer = undefined;
      if (released) {return;}
      if (input.phase === "start") {
        reservation.startBoundaryCutoff = true;
      } else if (reservation.providerCompletionState === "pending") {
        reservation.providerCompletionState = "cutoff";
      }
      resolve(Object.freeze({
        evidenceId: evidenceId("completion-deadline", Object.freeze({
          ...reservationIdentity(reservation),
          phase: input.phase,
        })),
        kind: "expired",
      }));
    }, completionAfterMs);
  });
  return Object.freeze({
    expiration,
    release: () => {
      if (released) {return;}
      released = true;
      if (timer !== undefined) {clearTimeout(timer); timer = undefined;}
    },
  });
};
