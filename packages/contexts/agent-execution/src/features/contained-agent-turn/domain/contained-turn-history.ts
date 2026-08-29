import {
  encodeContainedTurnCanonicalValue,
  type ContainedTurnCanonicalValue,
} from "./contained-turn-codecs.js";
import type { ContainedTurnKernelOperation } from "./contained-turn-kernel-model.js";

type AssertInvariant = (condition: boolean, message: string) => void;

const sameCanonicalValue = (left: unknown, right: unknown): boolean =>
  encodeContainedTurnCanonicalValue(left as ContainedTurnCanonicalValue) ===
  encodeContainedTurnCanonicalValue(right as ContainedTurnCanonicalValue);

const immutableProjection = (operation: ContainedTurnKernelOperation): string => encodeContainedTurnCanonicalValue({
  acceptedAuthorityVectorDigest: operation.acceptedAuthorityVectorDigest,
  adapterSnapshot: {
    adapterRevision: operation.adapterSnapshot.adapterRevision,
    binaryRevision: operation.adapterSnapshot.binaryRevision,
    capabilityManifestRevision: operation.adapterSnapshot.capabilityManifestRevision,
    provider: operation.adapterSnapshot.provider,
  },
  capabilityManifest: {
    effectCardinality: operation.capabilityManifest.effectCardinality,
    effectClass: operation.capabilityManifest.effectClass,
    manifestRevision: operation.capabilityManifest.manifestRevision,
    manifestVersion: operation.capabilityManifest.manifestVersion,
    provider: operation.capabilityManifest.provider,
    providerAttemptCardinality: operation.capabilityManifest.providerAttemptCardinality,
    requiredProofKinds: [...operation.capabilityManifest.requiredProofKinds],
    resourceScopeRevision: operation.capabilityManifest.resourceScopeRevision,
    supportedModes: [...operation.capabilityManifest.supportedModes],
    unknownCapabilityPolicy: operation.capabilityManifest.unknownCapabilityPolicy,
  },
  commandFingerprint: operation.commandFingerprint,
  commandId: operation.commandId,
  effectId: operation.effectId,
  intent: { mode: operation.intent.mode, prompt: operation.intent.prompt },
  operationId: operation.operationId,
  providerAccessSnapshot: {
    accessRef: operation.providerAccessSnapshot.accessRef,
    credentialBindingDigest: operation.providerAccessSnapshot.credentialBindingDigest,
    credentialBindingRef: operation.providerAccessSnapshot.credentialBindingRef,
    credentialGeneration: operation.providerAccessSnapshot.credentialGeneration,
    ownerAuthorityDigest: operation.providerAccessSnapshot.ownerAuthorityDigest,
    projectId: operation.providerAccessSnapshot.projectId,
    provider: operation.providerAccessSnapshot.provider,
    providerAccountRef: operation.providerAccessSnapshot.providerAccountRef,
    providerRouteRef: operation.providerAccessSnapshot.providerRouteRef,
    revision: operation.providerAccessSnapshot.revision,
    tenantId: operation.providerAccessSnapshot.tenantId,
  },
  schemaVersion: operation.schemaVersion,
  scope: { projectId: operation.scope.projectId, tenantId: operation.scope.tenantId },
});

// The count is the frozen write-once/append-only invariant matrix, not branching policy.
// oxlint-disable-next-line complexity
export const validateContainedTurnHistory = (
  candidate: ContainedTurnKernelOperation,
  previous: ContainedTurnKernelOperation,
  invariant: AssertInvariant,
): void => {
  invariant(candidate.revision === previous.revision + 1, "mutation revision must advance exactly once");
  invariant(immutableProjection(candidate) === immutableProjection(previous), "accepted identity, intent, scope, manifest, and authority are immutable");
  invariant(previous.terminal.kind !== "final" || candidate.terminal.kind === "final", "terminal truth never reopens");
  invariant(previous.output.fence.kind !== "fenced" || candidate.output.fence.kind === "fenced", "output fence never reopens");
  invariant(previous.admissionFence.kind !== "fenced" || candidate.admissionFence.kind === "fenced", "admission fence never reopens");
  if (previous.output.fence.kind === "fenced") {invariant(sameCanonicalValue(candidate.output.fence, previous.output.fence), "output fence truth is immutable");}
  if (previous.admissionFence.kind === "fenced") {invariant(sameCanonicalValue(candidate.admissionFence, previous.admissionFence), "admission fence truth is immutable");}
  invariant(candidate.output.chunks.length >= previous.output.chunks.length, "output is append-only");
  if (previous.output.fence.kind === "fenced") {invariant(candidate.output.chunks.length === previous.output.chunks.length, "canonical output cannot append after its fence");}
  if (previous.workspaceId !== undefined) {invariant(candidate.workspaceId === previous.workspaceId, "workspace identity is immutable after binding");}
  if (previous.custodyId !== undefined) {invariant(candidate.custodyId === previous.custodyId, "custody identity is immutable after binding");}
  if (previous.hostBootId !== undefined) {invariant(candidate.hostBootId === previous.hostBootId, "Host boot identity is immutable after binding");}
  if (previous.hostInstanceId !== undefined) {invariant(candidate.hostInstanceId === previous.hostInstanceId, "Host instance identity is immutable after binding");}
  if (previous.artifactManifestRef !== undefined) {
    invariant(candidate.artifactManifestRef === previous.artifactManifestRef, "artifact manifest identity is immutable after sealing");
  }
  if (previous.resultRef !== undefined) {
    invariant(candidate.resultRef === previous.resultRef, "canonical result identity is immutable after publication");
  }
  previous.output.chunks.forEach((chunk, index) => {
    invariant(sameCanonicalValue(candidate.output.chunks[index], chunk), "canonical output cannot be rewritten");
  });
  invariant(candidate.proofs.length >= previous.proofs.length, "proof ledger is append-only");
  previous.proofs.forEach((proof, index) => {
    invariant(sameCanonicalValue(candidate.proofs[index], proof), "proof evidence cannot be replaced or reordered");
  });
  if (previous.dispatch.kind !== "unclaimed") {invariant(sameCanonicalValue(candidate.dispatch, previous.dispatch), "dispatch claim or prevention cannot reopen or change");}
  if (previous.providerExecution.kind === "closed") {invariant(sameCanonicalValue(candidate.providerExecution, previous.providerExecution), "provider execution closure never reopens");}
  if (previous.providerProcessStart.kind === "execution_started" || previous.providerProcessStart.kind === "proved_no_start") {
    invariant(sameCanonicalValue(candidate.providerProcessStart, previous.providerProcessStart), "provider process start truth never reopens");
  }
  if (previous.providerAcceptance.kind === "accepted" || previous.providerAcceptance.kind === "not_accepted") {
    invariant(sameCanonicalValue(candidate.providerAcceptance, previous.providerAcceptance), "provider acceptance truth never reopens");
  }
  if (previous.containment.kind === "contained" || previous.containment.kind === "qualified_not_required") {
    invariant(sameCanonicalValue(candidate.containment, previous.containment), "containment closure never reopens");
  }
  if (previous.effect.kind === "resolved") {invariant(sameCanonicalValue(candidate.effect, previous.effect), "effect resolution never reopens");}
  if (previous.reconciliation.kind === "required") {invariant(candidate.reconciliation.kind === "required", "V1 reconciliation debt cannot be cleared by a turn mutation");}
  const candidateEvidenceIds = candidate.reconciliation.kind === "required"
    ? candidate.reconciliation.evidenceIds
    : [];
  if (previous.reconciliation.kind === "required") {
    invariant(
      previous.reconciliation.evidenceIds.every(evidenceId => candidateEvidenceIds.includes(evidenceId)),
      "reconciliation evidence is append-only",
    );
  }
  if (previous.terminal.kind === "final") {invariant(sameCanonicalValue(candidate.terminal, previous.terminal), "terminal truth is write-once");}
  if (previous.cancellation.kind === "requested") {
    invariant(candidate.cancellation.kind === "requested", "durable cancellation cannot reopen");
    if (candidate.cancellation.kind === "requested") {
      invariant(
        candidate.cancellation.command.cancellationCommandId === previous.cancellation.command.cancellationCommandId &&
          candidate.cancellation.command.fingerprint === previous.cancellation.command.fingerprint,
        "cancellation replay requires the exact command identity and fingerprint",
      );
    }
  }
};
