import {
  containedTurnAuthorityVectorDigest,
  containedTurnCommandFingerprint,
  containedTurnProviderAccessSnapshotDigest,
  containedTurnScopeDigest,
  type ContainedTurnAuthorityVector,
} from "../domain/contained-turn-authority.js";
import { containedTurnIdentity } from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import {
  assertContainedTurnExactRecord,
  detachAndFreezeContainedTurnValue,
} from "../domain/contained-turn-record.js";
import { createContainedTurnOperation } from "../domain/contained-turn-creation.js";
import {
  readContainedTurnOwnedOperation,
  recordContainedTurnRejectedDebt,
} from "./contained-turn-closure.js";
import {
  advanceContainedTurn,
  ContainedTurnCasLostError,
  ContainedTurnIndeterminateCommitError,
} from "./contained-turn-committer.js";
import { dispatchContainedTurn } from "./contained-turn-dispatch.js";
import { quarantineLosingContainedTurnWorkspace } from "./contained-turn-preparation-cleanup.js";
import type {
  ContainedTurnApplicationSubmitInput,
  ContainedTurnApplicationSubmitOutcome,
} from "./contained-turn-engine.js";
import {
  containedTurnOwnerStoreAuthority,
  sanitizeContainedTurnAcceptanceOutcome,
  sanitizeContainedTurnIdentificationOutcome,
} from "./contained-turn-store-authority.js";
import type { ContainedTurnKernelDependencies } from "./ports/outbound/contained-turn-ports.js";

type SubmitOptions = Readonly<{
  onAccepted?: (operation: ContainedTurnKernelOperation) => void;
}>;

const continueAfterAcceptance = async (
  dependencies: ContainedTurnKernelDependencies,
  accepted: Extract<ContainedTurnApplicationSubmitOutcome, { readonly status: "observed" }>["operation"],
  trustedScope: ContainedTurnApplicationSubmitInput["scope"],
): Promise<ContainedTurnApplicationSubmitOutcome> => {
  const current = await readContainedTurnOwnedOperation(dependencies, accepted.operationId, trustedScope);
  if (current === undefined || current.cancellation.kind === "requested") {
    return { operation: current ?? accepted, status: "observed" };
  }
  let workspace: Awaited<ReturnType<ContainedTurnKernelDependencies["workspace"]["create"]>>;
  try {
    workspace = await dependencies.workspace.create({ operationId: accepted.operationId, scope: trustedScope });
  } catch {
    return {
      operation: await recordContainedTurnRejectedDebt(
        dependencies, current, trustedScope, "workspace_create_rejected", "workspace",
      ),
      status: "observed",
    };
  }
  try {
    const bound = await advanceContainedTurn(dependencies, current, trustedScope, {
      kind: "bind_workspace",
      workspaceId: workspace.workspaceId,
    });
    return {
      operation: await dispatchContainedTurn(dependencies, bound, trustedScope),
      status: "observed",
    };
  } catch (error) {
    const cleaned = await quarantineLosingContainedTurnWorkspace(
      dependencies,
      error instanceof ContainedTurnIndeterminateCommitError ? error.operation : current,
      trustedScope,
      workspace.workspaceId,
    );
    if (error instanceof ContainedTurnIndeterminateCommitError) {
      return { operation: cleaned, status: "observed" };
    }
    if (!(error instanceof ContainedTurnCasLostError)) {
      return {
        operation: await recordContainedTurnRejectedDebt(
          dependencies, cleaned, trustedScope, "workspace_bind_rejected", "workspace",
        ),
        status: "observed",
      };
    }
    return { operation: cleaned, status: "observed" };
  }
};

const unsupportedSubmission = (
  dependencies: ContainedTurnKernelDependencies,
  input: ContainedTurnApplicationSubmitInput,
): Exclude<ContainedTurnApplicationSubmitOutcome, { readonly status: "observed" }> | undefined => {
  if (dependencies.provider.adapterSnapshot.provider !== input.expectedProvider) {
    return { code: "provider_mismatch", status: "unsupported" };
  }
  if (dependencies.provider.manifest.effectClass !== "contained_unmediated_effect") {
    return { code: "provider_unsupported", status: "unsupported" };
  }
  if (!dependencies.provider.manifest.supportedModes.includes(input.intent.mode)) {
    return { code: "mode_unsupported", status: "unsupported" };
  }
  return undefined;
};

export const submitContainedTurn = async (
  dependencies: ContainedTurnKernelDependencies,
  raw: ContainedTurnApplicationSubmitInput,
  options?: SubmitOptions,
): Promise<ContainedTurnApplicationSubmitOutcome> => {
  assertContainedTurnExactRecord("contained-turn submit", raw, [
    "commandId", "expectedProvider", "intent", "scope",
  ]);
  const input = detachAndFreezeContainedTurnValue(raw);
  const unsupported = unsupportedSubmission(dependencies, input);
  if (unsupported !== undefined) {return unsupported;}
  const adapter = dependencies.provider.adapterSnapshot;
  const manifest = dependencies.provider.manifest;
  const commandId = containedTurnIdentity("command", input.commandId);
  const commandFingerprint = containedTurnCommandFingerprint({
    intent: input.intent,
    provider: adapter.provider,
    scope: input.scope,
  });
  const identity = sanitizeContainedTurnIdentificationOutcome({
    commandId,
    outcome: await dependencies.operationStore.identifyAcceptance({
      commandFingerprint,
      commandId,
      scope: input.scope,
    }),
    scope: input.scope,
  });
  if (identity.kind === "not_found") {return { status: "denied" };}
  if (identity.kind === "fingerprint_conflict") {
    return { code: "command_fingerprint_conflict", status: "conflict" };
  }
  if (identity.kind === "replayed") {
    try {options?.onAccepted?.(identity.operation);} catch {}
    return { operation: identity.operation, status: "observed" };
  }
  const [access, security] = await Promise.all([
    dependencies.providerAccess.resolveForAcceptance({
      intent: input.intent,
      provider: adapter.provider,
      scope: input.scope,
    }),
    dependencies.security.authorizeForAcceptance({
      intent: input.intent,
      provider: adapter.provider,
      scope: input.scope,
    }),
  ]);
  if (access.kind !== "resolved" || security.kind !== "allowed") {return { status: "denied" };}
  const vector: ContainedTurnAuthorityVector = {
    adapterSnapshot: adapter,
    capabilityManifestRevision: manifest.manifestRevision,
    containmentPolicyDigest: security.containmentPolicyDigest,
    operationAuthorityRevision: identity.operationAuthorityRevision,
    providerAccessSnapshot: access.snapshot,
    scopeDigest: containedTurnScopeDigest(input.scope),
    securityAuthorityRevision: security.authorityRevision,
    securityDecisionDigest: security.decisionDigest,
  };
  const digest = containedTurnAuthorityVectorDigest(vector);
  const binding = { authorityVectorDigest: digest, operationId: identity.operationId };
  const candidate = createContainedTurnOperation({
    acceptanceProof: {
      binding: { ...binding, commandFingerprint, commandId },
      kind: "acceptance",
      proofId: identity.acceptanceProofId,
    },
    acceptedAuthorityVector: vector,
    adapterSnapshot: adapter,
    capabilityManifest: manifest,
    commandId,
    effectId: identity.effectId,
    intent: input.intent,
    operationId: identity.operationId,
    providerAccessAcceptanceProof: {
      binding: {
        ...binding,
        resolutionDigest: access.acceptanceResolutionDigest,
        snapshotDigest: containedTurnProviderAccessSnapshotDigest(access.snapshot),
      },
      kind: "provider_access_acceptance",
      proofId: access.acceptanceProofId,
    },
    providerAccessSnapshot: access.snapshot,
    runtimeSecurityAcceptanceProof: {
      binding: {
        ...binding,
        securityAuthorityRevision: security.authorityRevision,
        securityDecisionDigest: security.decisionDigest,
      },
      kind: "runtime_security_acceptance",
      proofId: security.acceptanceProofId,
    },
    schemaVersion: 2,
    scope: input.scope,
  });
  const accepted = sanitizeContainedTurnAcceptanceOutcome({
    candidate,
    outcome: await dependencies.operationStore.accept(
      candidate,
      containedTurnOwnerStoreAuthority(candidate, input.scope),
    ),
    scope: input.scope,
  });
  if (accepted.kind === "not_found") {return { status: "denied" };}
  if (accepted.kind === "fingerprint_conflict") {
    return { code: "command_fingerprint_conflict", status: "conflict" };
  }
  if (accepted.kind === "replayed") {
    try {options?.onAccepted?.(accepted.operation);} catch {}
    return { operation: accepted.operation, status: "observed" };
  }
  try {options?.onAccepted?.(accepted.operation);} catch {}
  return continueAfterAcceptance(dependencies, accepted.operation, input.scope);
};
