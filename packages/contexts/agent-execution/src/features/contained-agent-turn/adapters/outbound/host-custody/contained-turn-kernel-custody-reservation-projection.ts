import type {HostCustodyEvidence} from "./custodied-provider-process.js";
import {sameReservation} from "./contained-turn-kernel-custody-state.js";
import type {ContainedTurnKernelCustodyPort} from "../../../application/ports/outbound/contained-turn-ports.js";
import type {ContainedTurnKernelCustodyAdapterOptions, KernelOpenInput} from "./contained-turn-kernel-custody-contracts.js";
import type {ContainedTurnKernelCustodyLaunchAuthority, KernelReservation} from "./contained-turn-kernel-custody-state.js";
import {evidenceId, hostEvidenceProjection, openIdentity, proofId, canonicalDigest, projectProviderObservation, reservationIdentity, type SealedProviderCompletion} from "./contained-turn-kernel-custody-projections.js";
export function createKernelReservation(input: KernelOpenInput, authority: ContainedTurnKernelCustodyLaunchAuthority,
 identityDigest: ReturnType<typeof openIdentity>, custodyRef: string): KernelReservation {
  return {
    attemptId: input.attemptId,
    authorityVectorDigest: input.authorityVectorDigest,
    commandId: input.commandId,
    custodyId: input.custodyId,
    effectId: input.effectId,
    executionBoundaryOpened: false,
    intentMode: authority.intentMode,
    kernelOpenIdentityDigest: openIdentity(input, {
      intentMode: input.intentMode,
      workspaceRef: "owner-private-workspace-not-reconsumed",
    }),
    openIdentityDigest: identityDigest,
    operationId: input.operationId,
    operationCutoffRevision: input.operationCutoffRevision,
    operationRevision: input.operationRevision,
    preparationToken: input.preparationToken,
    projectId: input.providerAccessSnapshot.projectId,
    processStartProved: false,
    providerCompletionState: "pending",
    provider: input.adapterSnapshot.provider,
    released: false,
    startBoundaryCutoff: false,
    started: false,
    tenantId: input.providerAccessSnapshot.tenantId,
    underlyingCustodyRef: custodyRef,
    workspaceId: input.workspaceId,
  };
}
export function kernelOpenOutcome(reservation: KernelReservation, host: Pick<Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>, "hostBootId" | "hostInstanceId">): Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>> {
  return Object.freeze({
    custodyId: reservation.custodyId,
    hostBootId: host.hostBootId,
    hostCustodyProof: Object.freeze({
      binding: Object.freeze({
        attemptId: reservation.attemptId,
        authorityVectorDigest: reservation.authorityVectorDigest,
        custodyId: reservation.custodyId,
        effectId: reservation.effectId,
        operationId: reservation.operationId,
      }),
      kind: "host_custody",
      proofId: proofId("reservation", Object.freeze({
        openIdentityDigest: reservation.openIdentityDigest,
        underlyingCustodyRefDigest: canonicalDigest(reservation.underlyingCustodyRef),
      })),
    }),
    hostInstanceId: host.hostInstanceId,
  });
}
export function sealProviderCompletion(reservation: KernelReservation, value: unknown): void {
  if (reservation.providerCompletionState !== "pending") {return;}
  const projected = projectProviderObservation(value);
  if (projected.kind !== "completed") {
    reservation.providerCompletionState = "ambiguous";
    return;
  }
  const completion: SealedProviderCompletion = Object.freeze({
    digest: canonicalDigest(Object.freeze({
      ...reservationIdentity(reservation),
      outcome: projected.outcome,
      proofDigest: reservation.proofDigest ?? null,
    })),
    outcome: projected.outcome,
  });
  reservation.providerCompletion = completion;
  reservation.providerCompletionState = "sealed";
}

export function kernelIndeterminate(
  source: string,
  reservation: KernelReservation,
  evidence?: HostCustodyEvidence,
  ): {
  readonly evidenceId: ReturnType<typeof evidenceId>;
  readonly kind: "indeterminate";
  } {
  return Object.freeze({
    evidenceId: evidenceId(source, Object.freeze({
      evidence: evidence === undefined ? null : hostEvidenceProjection(evidence),
      proofDigest: reservation.proofDigest ?? null,
      providerCompletionState: reservation.providerCompletionState,
      reservation: reservationIdentity(reservation),
    })),
    kind: "indeterminate",
  });
}

export function readKernelReservation(
  reservations: ReadonlyMap<string, KernelReservation>,
  input: Readonly<{ readonly attemptId: string; readonly custodyId: string; readonly operationId: string }>,
  ): KernelReservation {
  const reservation = reservations.get(input.custodyId);
  if (reservation === undefined || !sameReservation(reservation, input)) {
    throw new TypeError("Host Custody kernel reservation is unavailable");
  }
  return reservation;
}

export const hasPreparationCallback = (value: Exclude<ContainedTurnKernelCustodyAdapterOptions["postClaimPreparation"], "current-owner"> | null | undefined): boolean => typeof value?.prepareClaimed === "function";
export const isSupportedIntent = (value: unknown): boolean => value === "analysis" || value === "workspace-write";
export const startWasCutOff = (reservation: {readonly startBoundaryCutoff: boolean}): boolean => reservation.startBoundaryCutoff;
