import type { ContainedTurnScope } from "../domain/contained-turn-authority.js";
import { containedTurnGrantSettlementRequestId } from "../domain/contained-turn-dispatch-authority.js";
import type {
  ContainedTurnDispatchPreparation,
} from "../domain/contained-turn-dispatch-preparation.js";
import type { ContainedTurnEvidenceId } from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import type { ContainedTurnKernelDependencies } from "./ports/outbound/contained-turn-ports.js";
import { containedTurnOwnerStoreAuthority } from "./contained-turn-store-authority.js";

const completeTarget = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  preparation: Extract<ContainedTurnDispatchPreparation, { readonly kind: "cleanup_pending" }>,
  target: "custody" | "provider_access" | "runtime_security",
): Promise<void> => {
  const record = dependencies.operationStore.recordDispatchPreparationCleanup;
  let outcome: { readonly evidenceId?: ContainedTurnEvidenceId; readonly kind: string };
  try {
    if (target === "custody") {
      outcome = await dependencies.custody.releaseRetiredReservation({
        cleanupPermit: preparation.cleanupPermit,
      });
    } else {
      const receipt = target === "provider_access"
        ? preparation.providerAccessConsumptionReceipt
        : preparation.runtimeSecurityConsumptionReceipt;
      if (receipt === undefined) {return;}
      outcome = target === "provider_access"
        ? await dependencies.providerAccess.settleConsumedGrant({
          disposition: "abandoned_without_claim", receipt: preparation.providerAccessConsumptionReceipt as NonNullable<typeof preparation.providerAccessConsumptionReceipt>,
          settlementRequestId: containedTurnGrantSettlementRequestId(receipt, "abandoned_without_claim"),
        })
        : await dependencies.security.settleConsumedGrant({
          disposition: "abandoned_without_claim", receipt: preparation.runtimeSecurityConsumptionReceipt as NonNullable<typeof preparation.runtimeSecurityConsumptionReceipt>,
          settlementRequestId: containedTurnGrantSettlementRequestId(receipt, "abandoned_without_claim"),
        });
    }
  } catch {
    return;
  }
  const succeeded = ["released", "already_released", "settled", "already_settled"]
    .includes(outcome.kind);
  if (!succeeded && outcome.evidenceId === undefined) {return;}
  try {
    await record.call(dependencies.operationStore, {
      authority: containedTurnOwnerStoreAuthority(operation, operation.scope),
      ...(succeeded ? {} : { evidenceId: outcome.evidenceId }),
      permit: preparation.cleanupPermit,
      target,
    });
  } catch {}
};

export const recoverContainedTurnDispatchPreparations = async (
  dependencies: ContainedTurnKernelDependencies,
  scope: ContainedTurnScope,
): Promise<Readonly<{ discovered: number; retired: number }>> => {
  const list = dependencies.operationStore.listDispatchPreparations?.bind(dependencies.operationStore);
  if (list === undefined) {
    throw new TypeError("the durable owner store does not support preparation recovery");
  }
  const rows = await list({ kinds: ["active", "cleanup_pending"], scope });
  let retired = 0;
  for (const row of rows) {
    let preparation = row.preparation;
    if (preparation.kind === "active") {
      const result = await dependencies.operationStore.retireDispatchPreparation({
        authority: containedTurnOwnerStoreAuthority(row.operation, scope),
        expectedOperationCutoffRevision: preparation.operationCutoffRevision,
        expectedOperationRevision: preparation.preparedOperationRevision,
        preparationToken: preparation.preparationToken,
        reason: "reconciliation",
      });
      if (result.kind !== "retired") {continue;}
      preparation = result.preparation;
      retired += 1;
    }
    if (preparation.kind !== "cleanup_pending") {continue;}
    if (!preparation.custodyReleased) {
      await completeTarget(dependencies, row.operation, preparation, "custody");
    }
    if (!preparation.providerAccessSettled) {
      await completeTarget(dependencies, row.operation, preparation, "provider_access");
    }
    if (!preparation.runtimeSecuritySettled) {
      await completeTarget(dependencies, row.operation, preparation, "runtime_security");
    }
  }
  return Object.freeze({ discovered: rows.length, retired });
};

/** Replays idempotent owner settlements from complete durable claim receipts. */
export const recoverContainedTurnCommittedGrantSettlements = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
): Promise<Readonly<{ attempted: 0 | 2 }>> => {
  if (operation.dispatch.kind !== "claimed") {return Object.freeze({ attempted: 0 });}
  const [providerAccessReceipt, runtimeSecurityReceipt] = operation.dispatch.grantReceipts;
  await Promise.allSettled([
    dependencies.providerAccess.settleConsumedGrant({
      disposition: "claim_committed",
      receipt: providerAccessReceipt,
      settlementRequestId: containedTurnGrantSettlementRequestId(
        providerAccessReceipt, "claim_committed",
      ),
    }),
    dependencies.security.settleConsumedGrant({
      disposition: "claim_committed",
      receipt: runtimeSecurityReceipt,
      settlementRequestId: containedTurnGrantSettlementRequestId(
        runtimeSecurityReceipt, "claim_committed",
      ),
    }),
  ]);
  return Object.freeze({ attempted: 2 });
};
