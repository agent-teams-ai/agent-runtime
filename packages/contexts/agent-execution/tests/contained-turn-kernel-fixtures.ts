import assert from "node:assert/strict";

import {
  containedTurnAuthorityVectorDigest,
  containedTurnCommandFingerprint,
  containedTurnProviderAccessSnapshotDigest,
  containedTurnScopeDigest,
  CONTAINED_TURN_REQUIRED_PROOF_KINDS,
  type ContainedTurnAuthorityVector,
  type ContainedTurnCapabilityManifest,
  type ContainedTurnProviderAccessSnapshot,
  type ContainedTurnProviderAdapterSnapshot,
} from "../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {
  createContainedTurnOperation,
  mutateContainedTurnOperation,
  validateContainedTurnOperation,
  type ContainedTurnKernelOperation,
} from "../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import { containedTurnIdentity } from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { type ContainedTurnProof } from "../dist/features/contained-agent-turn/domain/contained-turn-proofs.js";
import {
  CONTAINED_TURN_DEPENDENCY_NAMES,
  type ContainedTurnKernelDependencies,
} from "../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";

type SameUnion<Left, Right> =
  [Exclude<Left, Right>, Exclude<Right, Left>] extends [never, never] ? true : false;

export const dependencyNamesAreExhaustive: SameUnion<
  keyof ContainedTurnKernelDependencies,
  (typeof CONTAINED_TURN_DEPENDENCY_NAMES)[number]
> = true;

export const scope = Object.freeze({ projectId: "project:kernel", tenantId: "tenant:kernel" });
export const intent = Object.freeze({ mode: "analysis" as const, prompt: "Inspect the disposable workspace." });
export const adapterSnapshot: ContainedTurnProviderAdapterSnapshot = Object.freeze({
  adapterRevision: "adapter:codex:1",
  binaryRevision: "binary:codex:1",
  capabilityManifestRevision: "manifest:codex:1",
  provider: "codex",
});
export const providerAccessSnapshot: ContainedTurnProviderAccessSnapshot = Object.freeze({
  accessRef: "access:1",
  credentialBindingDigest: digestContainedTurnCanonicalValue({ binding: "opaque:1" }),
  credentialBindingRef: "credential-binding:1",
  credentialGeneration: 1,
  ownerAuthorityDigest: "authority-digest:one",
  projectId: "project:kernel",
  provider: "codex",
  providerAccountRef: "account:1",
  providerRouteRef: "provider-route:1",
  revision: 1,
  tenantId: "tenant:kernel",
});
export const manifest: ContainedTurnCapabilityManifest = Object.freeze({
  effectCardinality: "one_coarse_effect_per_operation",
  effectClass: "contained_unmediated_effect",
  manifestRevision: adapterSnapshot.capabilityManifestRevision,
  manifestVersion: 1,
  provider: "codex",
  providerAttemptCardinality: "at_most_one",
  requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS,
  resourceScopeRevision: "contained-workspace-network-credential:1",
  supportedModes: Object.freeze(["analysis", "workspace-write"] as const),
  unknownCapabilityPolicy: "fail_closed",
});
export const authorityVector: ContainedTurnAuthorityVector = Object.freeze({
  adapterSnapshot,
  capabilityManifestRevision: manifest.manifestRevision,
  containmentPolicyDigest: digestContainedTurnCanonicalValue({ policy: "contained-turn-v1" }),
  operationAuthorityRevision: "operation-authority:1",
  providerAccessSnapshot,
  scopeDigest: containedTurnScopeDigest(scope),
  securityAuthorityRevision: "security-authority:1",
  securityDecisionDigest: digestContainedTurnCanonicalValue({ decision: "allowed" }),
});

export const operationId = containedTurnIdentity("operation", "operation:1");
export const preparationToken = containedTurnIdentity("preparation", "preparation:1");
export const commandId = containedTurnIdentity("command", "command:1");
export const effectId = containedTurnIdentity("effect", "effect:1");
export const attemptId = containedTurnIdentity("attempt", "attempt:1");
export const custodyId = containedTurnIdentity("custody", "custody:1");
export const executionGenerationId = containedTurnIdentity("execution_generation", "execution-generation:1");
export const hostBootId = containedTurnIdentity("host_boot", "host-boot:1");
export const hostInstanceId = containedTurnIdentity("host_instance", "host-instance:1");
export const workspaceId = containedTurnIdentity("workspace", "workspace:1");
export const writerFence = containedTurnIdentity("writer_fence", "writer-fence:1");
export const proofId = (value: string) => containedTurnIdentity("proof", value);
export const authorityDigest = containedTurnAuthorityVectorDigest(authorityVector);
export const commandFingerprint = containedTurnCommandFingerprint({ intent, provider: "codex", scope });

export const acceptanceProof = Object.freeze({
  binding: Object.freeze({ authorityVectorDigest: authorityDigest, commandFingerprint, commandId, operationId }),
  kind: "acceptance" as const,
  proofId: proofId("proof:acceptance"),
});

export const providerAccessAcceptanceProof = Object.freeze({
  binding: Object.freeze({
    authorityVectorDigest: authorityDigest,
    operationId,
    resolutionDigest: digestContainedTurnCanonicalValue({ providerAccess: "resolved" }),
    snapshotDigest: containedTurnProviderAccessSnapshotDigest(providerAccessSnapshot),
  }),
  kind: "provider_access_acceptance" as const,
  proofId: proofId("proof:provider-access-acceptance"),
});

export const runtimeSecurityAcceptanceProof = Object.freeze({
  binding: Object.freeze({
    authorityVectorDigest: authorityDigest,
    operationId,
    securityAuthorityRevision: authorityVector.securityAuthorityRevision,
    securityDecisionDigest: authorityVector.securityDecisionDigest,
  }),
  kind: "runtime_security_acceptance" as const,
  proofId: proofId("proof:runtime-security-acceptance"),
});

export const createOperation = (
  overrides: Partial<Parameters<typeof createContainedTurnOperation>[0]> = {},
): ContainedTurnKernelOperation => {
  const selectedIntent = overrides.intent ?? intent;
  const selectedCommandId = overrides.commandId ?? commandId;
  const selectedOperationId = overrides.operationId ?? operationId;
  const selectedScope = overrides.scope ?? scope;
  const selectedAdapter = overrides.adapterSnapshot ?? adapterSnapshot;
  const selectedVector = overrides.acceptedAuthorityVector ?? authorityVector;
  const selectedFingerprint = containedTurnCommandFingerprint({
    intent: selectedIntent,
    provider: selectedAdapter.provider,
    scope: selectedScope,
  });
  const selectedAcceptance = overrides.acceptanceProof ?? {
    binding: {
      authorityVectorDigest: containedTurnAuthorityVectorDigest(selectedVector),
      commandFingerprint: selectedFingerprint,
      commandId: selectedCommandId,
      operationId: selectedOperationId,
    },
    kind: "acceptance" as const,
    proofId: proofId("proof:acceptance"),
  };
  const selectedAuthorityDigest = containedTurnAuthorityVectorDigest(selectedVector);
  const selectedProviderAccessAcceptance = overrides.providerAccessAcceptanceProof ?? {
    binding: {
      authorityVectorDigest: selectedAuthorityDigest,
      operationId: selectedOperationId,
      resolutionDigest: digestContainedTurnCanonicalValue({ providerAccess: "resolved" }),
      snapshotDigest: containedTurnProviderAccessSnapshotDigest(selectedVector.providerAccessSnapshot),
    },
    kind: "provider_access_acceptance" as const,
    proofId: proofId("proof:provider-access-acceptance"),
  };
  const selectedRuntimeSecurityAcceptance = overrides.runtimeSecurityAcceptanceProof ?? {
    binding: {
      authorityVectorDigest: selectedAuthorityDigest,
      operationId: selectedOperationId,
      securityAuthorityRevision: selectedVector.securityAuthorityRevision,
      securityDecisionDigest: selectedVector.securityDecisionDigest,
    },
    kind: "runtime_security_acceptance" as const,
    proofId: proofId("proof:runtime-security-acceptance"),
  };
  return createContainedTurnOperation({
    acceptanceProof: selectedAcceptance,
    acceptedAuthorityVector: authorityVector,
    adapterSnapshot,
    capabilityManifest: manifest,
    commandId,
    effectId,
    intent,
    operationId,
    providerAccessAcceptanceProof: selectedProviderAccessAcceptance,
    providerAccessSnapshot,
    runtimeSecurityAcceptanceProof: selectedRuntimeSecurityAcceptance,
    schemaVersion: 2,
    scope,
    ...overrides,
  });
};

export const commonBinding = Object.freeze({ authorityVectorDigest: authorityDigest, operationId });
export const attemptBinding = Object.freeze({ ...commonBinding, attemptId, effectId });

export const createReservedOperation = (): ContainedTurnKernelOperation => {
  const operation = mutateContainedTurnOperation(createOperation(), { kind: "bind_workspace", workspaceId });
  const providerAccessDispatchProof = {
    binding: {
      ...commonBinding,
      acceptedSnapshotDigest: containedTurnProviderAccessSnapshotDigest(providerAccessSnapshot),
      resolutionDigest: digestContainedTurnCanonicalValue({ providerAccess: "current" }),
    },
    kind: "provider_access_dispatch" as const,
    proofId: proofId("proof:provider-access-dispatch"),
  };
  const runtimeSecurityDispatchProof = {
    binding: {
      ...commonBinding,
      acceptedSecurityDecisionDigest: authorityVector.securityDecisionDigest,
      currentSecurityDecisionDigest: authorityVector.securityDecisionDigest,
      securityAuthorityRevision: authorityVector.securityAuthorityRevision,
    },
    kind: "runtime_security_dispatch" as const,
    proofId: proofId("proof:runtime-security-dispatch"),
  };
  const claimProof: ContainedTurnProof = {
    binding: {
      ...attemptBinding,
      preparationToken,
      providerAccessDispatchProofId: providerAccessDispatchProof.proofId,
      runtimeSecurityDispatchProofId: runtimeSecurityDispatchProof.proofId,
    },
    kind: "dispatch_claim",
    proofId: proofId("proof:claim"),
  };
  const cutoffProof: ContainedTurnProof = {
    binding: commonBinding,
    kind: "cutoff",
    proofId: proofId("proof:cutoff"),
  };
  const hostCustodyProof = {
    binding: { ...attemptBinding, custodyId },
    kind: "host_custody" as const,
    proofId: proofId("proof:host-custody"),
  };
  return mutateContainedTurnOperation(operation, {
    attemptId,
    claimProof: claimProof as Extract<ContainedTurnProof, { kind: "dispatch_claim" }>,
    custodyId,
    cutoffProof: cutoffProof as Extract<ContainedTurnProof, { kind: "cutoff" }>,
    executionGenerationId,
    hostBootId,
    hostCustodyProof,
    hostInstanceId,
    kind: "claim_dispatch",
    preparationToken,
    providerAccessDispatchProof,
    runtimeSecurityDispatchProof,
    writerFence,
  });
};

export const createActiveOperation = (): ContainedTurnKernelOperation => {
  const operation = createReservedOperation();
  const startProof: ContainedTurnProof = {
    binding: { ...attemptBinding, custodyId, hostBootId, hostInstanceId },
    kind: "provider_process_start",
    proofId: proofId("proof:process-start"),
  };
  const active = mutateContainedTurnOperation(operation, { kind: "record_process_start", proof: startProof });
  validateContainedTurnOperation(active);
  return active;
};

export const expectInvariant = (action: () => unknown, pattern: RegExp): void => assert.throws(action, pattern);
