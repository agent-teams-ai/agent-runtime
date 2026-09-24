export type { ContainedTurnAcceptedAuthorityHandoff } from "../../contained-turn-accepted-authority.js";
export type {
  ContainedTurnClosureDebtId,
  ContainedTurnClosureRecovery,
  ContainedTurnClosureRequestId,
  ContainedTurnClosureStage,
  ContainedTurnNoWorkspaceClosureFact,
  ContainedTurnPendingClosure,
} from "../../../domain/contained-turn-closure-recovery.js";
export type { CreateContainedTurnOperationInput } from "../../../domain/contained-turn-creation.js";
export type { ContainedTurnKernelMutation } from "../../../domain/contained-turn-kernel-mutations.js";
export type {
  CONTAINED_TURN_V1_REQUIRED_RECEIPTS,
  CONTAINED_TURN_V1_REQUIRED_RECEIPT_SET_VERSION,
  ContainedTurnRequiredReceipt,
  ContainedTurnRequiredReceiptSet,
  ContainedTurnRequiredReceiptSnapshot,
  ContainedTurnRequiredReceiptSetVersion,
} from "../../../domain/contained-turn-required-receipts.js";
import type { ContainedTurnAuthorityScope } from "../../../domain/contained-turn-authority.js";
import type {
  ContainedTurnEvidenceId,
  ContainedTurnOperationId,
  ContainedTurnWorkspaceId,
} from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnProof } from "../../../domain/contained-turn-proofs.js";
import { assertContainedTurnExactRecord } from "../../../domain/contained-turn-record.js";
import type {
  ContainedTurnKernelSecurityPort,
  ContainedTurnProviderAccessPort,
} from "./contained-turn-authority-ports.js";
import type {
  ContainedTurnClosureRequest,
  ContainedTurnKernelArtifactPort,
  EnsureContainedTurnClosureOutcome,
} from "./contained-turn-closure-ports.js";
import type {
  ContainedTurnKernelCustodyPort,
  ContainedTurnKernelProviderPort,
} from "./contained-turn-execution-ports.js";
import type { ContainedTurnKernelOperationStore } from "./contained-turn-operation-store.js";

export type {
  ContainedTurnKernelSecurityPort,
  ContainedTurnProviderAccessPort,
  ResolveContainedTurnProviderAccessOutcome,
  RevalidateContainedTurnProviderAccessOutcome,
  SettleContainedTurnConsumedGrantInput,
} from "./contained-turn-authority-ports.js";
export type {
  ContainedTurnClosureRequest,
  ContainedTurnKernelArtifactPort,
  EnsureContainedTurnClosureOutcome,
} from "./contained-turn-closure-ports.js";
export type {
  ContainedTurnKernelCustodyPort,
  ContainedTurnKernelDelegatedStart,
  ContainedTurnKernelProcessStartObservation,
  ContainedTurnKernelProviderObservation,
  ContainedTurnKernelProviderPort,
} from "./contained-turn-execution-ports.js";
export type {
  AcceptContainedTurnKernelOperationOutcome,
  AppendContainedTurnKernelOutputOutcome,
  CommitContainedTurnKernelOperationOutcome,
  ContainedTurnKernelOperationStore,
  ContainedTurnOwnerStoreAuthority,
  IdentifyContainedTurnAcceptanceOutcome,
} from "./contained-turn-operation-store.js";

export interface ContainedTurnKernelWorkspacePort {
  ensureClosed(input: Readonly<ContainedTurnClosureRequest & { operationId: ContainedTurnOperationId; workspaceId: ContainedTurnWorkspaceId }>): Promise<EnsureContainedTurnClosureOutcome<Extract<ContainedTurnProof, { readonly kind: "workspace_closure" }>>>;
  queryClosure(input: Readonly<ContainedTurnClosureRequest & { operationId: ContainedTurnOperationId; workspaceId: ContainedTurnWorkspaceId }>): Promise<EnsureContainedTurnClosureOutcome<Extract<ContainedTurnProof, { readonly kind: "workspace_closure" }>>>;
  close(input: Readonly<{ operationId: ContainedTurnOperationId; workspaceId: ContainedTurnWorkspaceId }>): Promise<
    | { readonly kind: "closed"; readonly proof: Extract<ContainedTurnProof, { readonly kind: "workspace_closure" }> }
    | { readonly evidenceId: ContainedTurnEvidenceId; readonly kind: "indeterminate" }
  >;
  create(input: Readonly<{ operationId: ContainedTurnOperationId; scope: ContainedTurnAuthorityScope }>): Promise<{ readonly workspaceId: ContainedTurnWorkspaceId }>;
  /** Idempotently quarantines only the exact losing operation-scoped workspace. */
  quarantine(input: Readonly<{
    evidenceId: ContainedTurnEvidenceId;
    operationId: ContainedTurnOperationId;
    workspaceId: ContainedTurnWorkspaceId;
  }>): Promise<void>;
}

export interface ContainedTurnKernelDependencies {
  readonly operationStore: ContainedTurnKernelOperationStore;
  readonly security: ContainedTurnKernelSecurityPort;
  readonly providerAccess: ContainedTurnProviderAccessPort;
  readonly workspace: ContainedTurnKernelWorkspacePort;
  readonly artifacts: ContainedTurnKernelArtifactPort;
  readonly custody: ContainedTurnKernelCustodyPort;
  readonly provider: ContainedTurnKernelProviderPort;
}

export const CONTAINED_TURN_DEPENDENCY_NAMES = Object.freeze([
  "operationStore",
  "security",
  "providerAccess",
  "workspace",
  "artifacts",
  "custody",
  "provider",
] as const satisfies readonly (keyof ContainedTurnKernelDependencies)[]);

/** Runtime guard used by the Pure DI factory to reject dependency bags and hidden authorities. */
export const validateContainedTurnKernelDependencies = (
  dependencies: ContainedTurnKernelDependencies,
): void => {
  assertContainedTurnExactRecord(
    "contained-turn composition dependencies",
    dependencies,
    CONTAINED_TURN_DEPENDENCY_NAMES,
  );
  const requiredMethods = Object.freeze({
    artifacts: ["ensureSealed", "querySeal"],
    custody: ["attestContainment", "ensurePhysicalContainment", "queryContainmentAttestation", "queryPhysicalContainment", "releaseRetiredReservation"],
    operationStore: ["preventIntent", "claimPreparedDispatch", "recordDispatchPreparationCleanup", "retireDispatchPreparation"],
    providerAccess: ["consumeForDispatch", "settleConsumedGrant"],
    security: ["consumeForDispatch", "settleConsumedGrant"],
    workspace: ["ensureClosed", "queryClosure"],
  } as const);
  for (const [owner, methods] of Object.entries(requiredMethods)) {
    const port = dependencies[owner as keyof typeof requiredMethods];
    for (const method of methods) {
      if (typeof Reflect.get(port, method) !== "function") {
        throw new TypeError(`contained-turn production dependency ${owner}.${method} is mandatory`);
      }
    }
  }
};
