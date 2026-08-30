import {
  containedTurnProviderAccessSnapshotDigest,
  type ContainedTurnScope,
} from "../domain/contained-turn-authority.js";
import {
  encodeContainedTurnCanonicalValue,
  type ContainedTurnCanonicalValue,
} from "../domain/contained-turn-codecs.js";
import type {
  ContainedTurnEvidenceId,
  ContainedTurnProofId,
} from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import { containedTurnOutputWriteAuthority } from "../domain/contained-turn-output-authority.js";
import {
  mutateContainedTurnOperation,
  type ContainedTurnKernelMutation,
} from "../domain/contained-turn-transitions.js";
import {
  closeContainedTurnExecution,
  closeContainedTurnPhysicalContainment,
  closeContainedTurnWithoutExecution,
  readContainedTurnOwnedOperation,
  recordContainedTurnRejectedDebt,
  redactedContainedTurnEvidenceId,
} from "./contained-turn-closure.js";
import {
  advanceContainedTurn,
  appendContainedTurnCanonicalOutput,
  ContainedTurnCasLostError,
  durableContainedTurnDebtOperation,
  recordContainedTurnReconciliationDebt,
} from "./contained-turn-committer.js";
import {
  containedTurnOwnerStoreAuthority,
  sanitizeContainedTurnOwnerStoreOutcome,
} from "./contained-turn-store-authority.js";
import type {
  ContainedTurnKernelDependencies,
  ContainedTurnKernelProviderObservation,
} from "./ports/outbound/contained-turn-ports.js";

const sameSnapshot = (left: unknown, right: unknown): boolean =>
  encodeContainedTurnCanonicalValue(left as ContainedTurnCanonicalValue) ===
  encodeContainedTurnCanonicalValue(right as ContainedTurnCanonicalValue);

const preventContainedTurnDispatch = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  preventionProofId: ContainedTurnProofId,
): Promise<ContainedTurnKernelOperation> => {
  let proofs: Awaited<ReturnType<ContainedTurnKernelDependencies["operationStore"]["proofsForPrevention"]>>;
  try {
    proofs = await dependencies.operationStore.proofsForPrevention({
      authority: containedTurnOwnerStoreAuthority(operation, trustedScope),
      operation,
      preventionProofId,
    });
    if (proofs.noDispatchProof.proofId !== preventionProofId) {
      throw new TypeError("dispatch prevention must preserve the exact authority proof identity");
    }
  } catch {
    return recordContainedTurnRejectedDebt(
      dependencies, operation, trustedScope, "dispatch_prevention_rejected", "dispatch_authority",
    );
  }
  const prevented = await advanceContainedTurn(dependencies, operation, trustedScope, {
    ...proofs,
    kind: "prevent_dispatch",
  });
  return closeContainedTurnWithoutExecution(dependencies, prevented, trustedScope);
};

const claimContainedTurnDispatch = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation> => {
  if (initial.workspaceId === undefined) {return initial;}
  const workspaceId = initial.workspaceId;
  let prepared: Awaited<ReturnType<ContainedTurnKernelDependencies["operationStore"]["prepareDispatch"]>>;
  try {
    prepared = await dependencies.operationStore.prepareDispatch({
      authority: containedTurnOwnerStoreAuthority(initial, trustedScope),
      operation: initial,
    });
  } catch {
    return recordContainedTurnRejectedDebt(
      dependencies, initial, trustedScope, "dispatch_preparation_rejected", "dispatch_authority",
    );
  }
  let custody: Awaited<ReturnType<ContainedTurnKernelDependencies["custody"]["open"]>>;
  try {
    custody = await dependencies.custody.open({
      adapterSnapshot: initial.adapterSnapshot,
      attemptId: prepared.attemptId,
      authorityVectorDigest: initial.acceptedAuthorityVectorDigest,
      custodyId: prepared.custodyId,
      operationId: initial.operationId,
      providerAccessSnapshot: initial.providerAccessSnapshot,
      workspaceId,
    });
  } catch {
    return recordContainedTurnRejectedDebt(
      dependencies, initial, trustedScope, "custody_open_rejected", "dispatch_authority",
    );
  }
  let access: Awaited<ReturnType<ContainedTurnKernelDependencies["providerAccess"]["revalidateForDispatch"]>>;
  let security: Awaited<ReturnType<ContainedTurnKernelDependencies["security"]["revalidateForDispatch"]>>;
  try {
    [access, security] = await Promise.all([
      dependencies.providerAccess.revalidateForDispatch({
        acceptedSnapshot: initial.providerAccessSnapshot,
        operationId: initial.operationId,
        scope: trustedScope,
      }),
      dependencies.security.revalidateForDispatch({
        decisionDigest: initial.acceptedAuthorityVector.securityDecisionDigest,
        operationId: initial.operationId,
        scope: trustedScope,
        securityAuthorityRevision: initial.acceptedAuthorityVector.securityAuthorityRevision,
      }),
    ]);
  } catch {
    return recordContainedTurnRejectedDebt(
      dependencies, initial, trustedScope, "dispatch_authority_rejected", "dispatch_authority",
    );
  }
  const preventionProofId = access.kind === "prevented"
    ? access.preventionProofId
    : security.kind === "prevented"
      ? security.preventionProofId
      : undefined;
  if (preventionProofId !== undefined) {
    return preventContainedTurnDispatch(dependencies, initial, trustedScope, preventionProofId);
  }
  const authorityEvidenceId = access.kind === "indeterminate"
    ? access.evidenceId
    : security.kind === "indeterminate"
      ? security.evidenceId
      : undefined;
  if (authorityEvidenceId !== undefined) {
    return recordContainedTurnReconciliationDebt(
      dependencies, initial, trustedScope, authorityEvidenceId, "dispatch_authority",
    );
  }
  if (access.kind !== "current" || security.kind !== "current" ||
      !sameSnapshot(access.snapshot, initial.providerAccessSnapshot)) {
    return recordContainedTurnRejectedDebt(
      dependencies, initial, trustedScope, "dispatch_authority_mismatch", "dispatch_authority",
    );
  }
  const operationBinding = {
    authorityVectorDigest: initial.acceptedAuthorityVectorDigest,
    operationId: initial.operationId,
  };
  const providerAccessDispatchProof = {
    binding: {
      ...operationBinding,
      acceptedSnapshotDigest: containedTurnProviderAccessSnapshotDigest(initial.providerAccessSnapshot),
      resolutionDigest: access.dispatchResolutionDigest,
    },
    kind: "provider_access_dispatch" as const,
    proofId: access.dispatchProofId,
  };
  const runtimeSecurityDispatchProof = {
    binding: {
      ...operationBinding,
      acceptedSecurityDecisionDigest: initial.acceptedAuthorityVector.securityDecisionDigest,
      currentSecurityDecisionDigest: security.dispatchDecisionDigest,
      securityAuthorityRevision: initial.acceptedAuthorityVector.securityAuthorityRevision,
    },
    kind: "runtime_security_dispatch" as const,
    proofId: security.proofId,
  };
  const attemptBinding = {
    ...operationBinding,
    attemptId: prepared.attemptId,
    effectId: initial.effectId,
  };
  const mutation: ContainedTurnKernelMutation = {
    attemptId: prepared.attemptId,
    claimProof: {
      binding: {
        ...attemptBinding,
        providerAccessDispatchProofId: access.dispatchProofId,
        runtimeSecurityDispatchProofId: security.proofId,
      },
      kind: "dispatch_claim",
      proofId: prepared.claimProofId,
    },
    custodyId: prepared.custodyId,
    cutoffProof: { binding: operationBinding, kind: "cutoff", proofId: prepared.cutoffProofId },
    executionGenerationId: prepared.executionGenerationId,
    hostBootId: custody.hostBootId,
    hostCustodyProof: custody.hostCustodyProof,
    hostInstanceId: custody.hostInstanceId,
    kind: "claim_dispatch",
    providerAccessDispatchProof,
    runtimeSecurityDispatchProof,
    writerFence: prepared.writerFence,
  };
  const outcome = sanitizeContainedTurnOwnerStoreOutcome({
    authority: containedTurnOwnerStoreAuthority(initial, trustedScope),
    outcome: await dependencies.operationStore.claimDispatch({
      authority: containedTurnOwnerStoreAuthority(initial, trustedScope),
      candidate: mutateContainedTurnOperation(initial, mutation),
      dispatchAuthority: {
        acceptedProviderAccessSnapshotDigest: containedTurnProviderAccessSnapshotDigest(initial.providerAccessSnapshot),
        acceptedSecurityDecisionDigest: initial.acceptedAuthorityVector.securityDecisionDigest,
        providerAccessDispatchProofId: access.dispatchProofId,
        providerAccessRevision: initial.providerAccessSnapshot.revision,
        runtimeSecurityDispatchProofId: security.proofId,
        securityAuthorityRevision: initial.acceptedAuthorityVector.securityAuthorityRevision,
      },
      expectedRevision: initial.revision,
    }),
  });
  if (outcome.kind === "indeterminate") {return durableContainedTurnDebtOperation(outcome);}
  if (outcome.kind !== "applied") {throw new ContainedTurnCasLostError("dispatch claim lost its authority CAS");}
  return outcome.operation;
};

const closeUnknownStart = async (
  dependencies: ContainedTurnKernelDependencies,
  claimed: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
  evidenceId: ContainedTurnEvidenceId,
): Promise<ContainedTurnKernelOperation> => {
  let current = await readContainedTurnOwnedOperation(
    dependencies, claimed.operationId, trustedScope,
  ) ?? claimed;
  if (current.providerProcessStart.kind === "pending") {
    current = await advanceContainedTurn(dependencies, current, trustedScope, {
      evidenceId,
      kind: "record_process_start_unknown",
    });
  } else if (current.reconciliation.kind === "clear") {
    current = await recordContainedTurnRejectedDebt(
      dependencies, current, trustedScope, "custody_start_rejected", "store_commit",
    );
  }
  return closeContainedTurnPhysicalContainment(dependencies, current, trustedScope);
};

const startContainedTurnExecution = async (
  dependencies: ContainedTurnKernelDependencies,
  claimed: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation> => {
  if (claimed.dispatch.kind !== "claimed" || claimed.custodyId === undefined ||
      claimed.workspaceId === undefined) {
    return claimed;
  }
  const custodyId = claimed.custodyId;
  const dispatch = claimed.dispatch;
  const workspaceId = claimed.workspaceId;
  let current = claimed;
  let releasePersistedStart!: () => void;
  const persistedStart = new Promise<void>(resolve => {releasePersistedStart = resolve;});
  const outputAuthority = containedTurnOutputWriteAuthority(claimed);
  let start: Awaited<ReturnType<ContainedTurnKernelDependencies["custody"]["start"]>>;
  try {
    start = await dependencies.custody.start({
      attemptId: dispatch.attemptId,
      custodyId,
      execute: delegatedStart => dependencies.provider.execute({
        adapterSnapshot: current.adapterSnapshot,
        attemptId: dispatch.attemptId,
        authorityVectorDigest: current.acceptedAuthorityVectorDigest,
        custodyId,
        effectId: current.effectId,
        emit: async output => {
          await persistedStart;
          current = await appendContainedTurnCanonicalOutput({
            authority: outputAuthority,
            dependencies,
            operation: current,
            output,
            trustedScope,
          });
        },
        intent: current.intent,
        isCancellationRequested: async () =>
          (await readContainedTurnOwnedOperation(dependencies, current.operationId, trustedScope))
            ?.cancellation.kind === "requested",
        operationId: current.operationId,
        providerAccessSnapshot: current.providerAccessSnapshot,
        start: delegatedStart,
        workspaceId,
      }),
      intent: claimed.intent,
      operationId: claimed.operationId,
      workspaceId,
    });
  } catch {
    releasePersistedStart();
    return closeUnknownStart(
      dependencies,
      claimed,
      trustedScope,
      redactedContainedTurnEvidenceId(claimed, "custody_start_rejected"),
    );
  }
  if (start.kind === "indeterminate") {
    releasePersistedStart();
    return closeUnknownStart(dependencies, claimed, trustedScope, start.evidenceId);
  }
  try {
    current = await advanceContainedTurn(dependencies, claimed, trustedScope, {
      kind: start.kind === "execution_started" ? "record_process_start" : "record_process_no_start",
      proof: start.proof,
    } as ContainedTurnKernelMutation);
  } catch {
    return closeUnknownStart(
      dependencies,
      claimed,
      trustedScope,
      redactedContainedTurnEvidenceId(claimed, "custody_start_rejected"),
    );
  } finally {
    releasePersistedStart();
  }
  if (start.kind === "execution_started") {
    let outcome: ContainedTurnKernelProviderObservation;
    try {
      outcome = await start.execution;
    } catch {
      outcome = {
        evidenceId: redactedContainedTurnEvidenceId(current, "provider_execution_rejected"),
        kind: "indeterminate",
      };
    }
    return closeContainedTurnExecution(dependencies, current, trustedScope, outcome);
  }
  let proofs: Awaited<ReturnType<ContainedTurnKernelDependencies["operationStore"]["proofsForProcessNoStart"]>>;
  try {
    proofs = await dependencies.operationStore.proofsForProcessNoStart({
      authority: containedTurnOwnerStoreAuthority(current, trustedScope),
      operation: current,
    });
  } catch {
    return recordContainedTurnRejectedDebt(
      dependencies, current, trustedScope, "no_start_bookkeeping_rejected", "store_commit",
    );
  }
  current = await advanceContainedTurn(dependencies, current, trustedScope, {
    ...proofs,
    kind: "close_process_no_start",
  });
  return closeContainedTurnWithoutExecution(dependencies, current, trustedScope);
};

export const dispatchContainedTurn = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
  trustedScope: ContainedTurnScope,
): Promise<ContainedTurnKernelOperation> => {
  const claimed = await claimContainedTurnDispatch(dependencies, initial, trustedScope);
  return claimed.dispatch.kind === "claimed"
    ? startContainedTurnExecution(dependencies, claimed, trustedScope)
    : claimed;
};
