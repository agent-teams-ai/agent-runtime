import type { ContainedTurnProof } from "../../../domain/contained-turn-proofs.js";
import type { ContainedTurnKernelCustodyPort } from "../../../application/ports/outbound/contained-turn-ports.js";
import type { KernelOpenInput } from "./contained-turn-kernel-custody-contracts.js";
import type {
  SealedProviderCompletion,
  canonicalDigest,
  openIdentity,
} from "./contained-turn-kernel-custody-projections.js";

export interface ContainedTurnKernelCustodyLaunchAuthority {
  readonly intentMode: "analysis" | "workspace-write";
  readonly workspaceRef: string;
}

type ExecutionAttestation = Extract<
  Awaited<ReturnType<ContainedTurnKernelCustodyPort["attestExecutionClosure"]>>,
  { readonly kind: "proved" }
>;

export interface KernelReservation {
  readonly attemptId: KernelOpenInput["attemptId"];
  readonly authorityVectorDigest: KernelOpenInput["authorityVectorDigest"];
  readonly commandId: KernelOpenInput["commandId"];
  readonly custodyId: KernelOpenInput["custodyId"];
  readonly effectId: KernelOpenInput["effectId"];
  readonly intentMode: ContainedTurnKernelCustodyLaunchAuthority["intentMode"];
  readonly kernelOpenIdentityDigest: ReturnType<typeof openIdentity>;
  readonly openIdentityDigest: ReturnType<typeof openIdentity>;
  readonly operationId: KernelOpenInput["operationId"];
  readonly operationCutoffRevision: KernelOpenInput["operationCutoffRevision"];
  readonly operationRevision: KernelOpenInput["operationRevision"];
  readonly preparationToken: KernelOpenInput["preparationToken"];
  readonly projectId: KernelOpenInput["providerAccessSnapshot"]["projectId"];
  readonly provider: KernelOpenInput["adapterSnapshot"]["provider"];
  readonly tenantId: KernelOpenInput["providerAccessSnapshot"]["tenantId"];
  readonly underlyingCustodyRef: string;
  readonly workspaceId: KernelOpenInput["workspaceId"];
  containmentReceiptRef?: string;
  executionAttestation?: Readonly<{
    readonly finalCursor: number;
    readonly result: ExecutionAttestation;
  }>;
  executionBoundaryOpened: boolean;
  physicalProof?: Extract<ContainedTurnProof, { readonly kind: "physical_containment" }>;
  processStartProved: boolean;
  providerCompletion?: SealedProviderCompletion;
  providerCompletionState: "ambiguous" | "cutoff" | "pending" | "sealed";
  released: boolean;
  proofDigest?: ReturnType<typeof canonicalDigest>;
  startBoundaryCutoff: boolean;
  started: boolean;
}

export const sameReservation = (
  reservation: KernelReservation,
  input: Readonly<{ readonly attemptId: string; readonly custodyId: string; readonly operationId: string }>,
): boolean => reservation.attemptId === input.attemptId &&
  reservation.custodyId === input.custodyId &&
  reservation.operationId === input.operationId;
