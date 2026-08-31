import type { ContainedTurnScope } from "../domain/contained-turn-authority.js";
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
      const grantRequestId = target === "provider_access"
        ? preparation.providerAccessGrantRequestId
        : preparation.runtimeSecurityGrantRequestId;
      const consumptionEvidenceId = target === "provider_access"
        ? preparation.providerAccessConsumptionEvidenceId
        : preparation.runtimeSecurityConsumptionEvidenceId;
      if (grantRequestId === null && consumptionEvidenceId === null) {return;}
      const settlementIdentity = grantRequestId === null
        ? { consumptionEvidenceId: consumptionEvidenceId as ContainedTurnEvidenceId }
        : { grantRequestId };
      outcome = target === "provider_access"
        ? await dependencies.providerAccess.settleConsumedGrant({
          cleanupPermit: preparation.cleanupPermit, ...settlementIdentity,
        })
        : await dependencies.security.settleConsumedGrant({
          cleanupPermit: preparation.cleanupPermit, ...settlementIdentity,
        });
    }
  } catch {
    return;
  }
  const succeeded = ["released", "already_released", "settled", "already_settled"]
    .includes(outcome.kind);
  if (!succeeded && outcome.evidenceId === undefined) {return;}
  try {
    await record({
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
