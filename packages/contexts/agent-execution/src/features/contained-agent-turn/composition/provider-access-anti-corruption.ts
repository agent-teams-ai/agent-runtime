import type { ContainedTurnProviderAccessPort } from "../application/ports/outbound/contained-turn-ports.js";
import {
  containedTurnProviderAccessSnapshotDigest,
  type ContainedTurnIntent,
  type ContainedTurnProvider,
  type ContainedTurnProviderAccessSnapshot,
  type ContainedTurnScope,
} from "../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../domain/contained-turn-identities.js";

interface OuterEvidence { readonly authorityDigest: string; readonly proofRef: string }
interface OuterBinding extends ContainedTurnScope {
  readonly accessRef: string;
  readonly credentialBindingDigest: string;
  readonly credentialBindingRef: string;
  readonly credentialGeneration: number;
  readonly provider: ContainedTurnProvider;
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly revision: number;
}

export interface OuterContainedTurnProviderAccess {
  readonly resolve: { execute(input: Readonly<{ provider: ContainedTurnProvider; scope: ContainedTurnScope }>): Promise<
    | { readonly binding: OuterBinding; readonly evidence: OuterEvidence; readonly kind: "resolved" }
    | { readonly evidence: OuterEvidence; readonly kind: "unavailable"; readonly reason: string }
  > };
  readonly revalidate: { execute(input: Readonly<{ binding: OuterBinding; provider: ContainedTurnProvider; scope: ContainedTurnScope }>): Promise<
    | { readonly binding: OuterBinding; readonly evidence: OuterEvidence; readonly kind: "valid" }
    | { readonly evidence: OuterEvidence; readonly kind: "rejected"; readonly reason: string }
  > };
}

const proofId = (evidence: OuterEvidence) => containedTurnIdentity("proof", `proof:provider-access:${evidence.proofRef}`);
const evidenceId = (evidence: OuterEvidence) => containedTurnIdentity("evidence", `evidence:provider-access:${evidence.proofRef}`);

const snapshot = (binding: OuterBinding, evidence: OuterEvidence): ContainedTurnProviderAccessSnapshot => Object.freeze({
  accessRef: binding.accessRef,
  credentialBindingDigest: digestContainedTurnCanonicalValue({ ownerDigest: binding.credentialBindingDigest }),
  credentialBindingRef: binding.credentialBindingRef,
  credentialGeneration: binding.credentialGeneration,
  ownerAuthorityDigest: evidence.authorityDigest,
  projectId: binding.projectId,
  provider: binding.provider,
  providerAccountRef: binding.providerAccountRef,
  providerRouteRef: binding.providerRouteRef,
  revision: binding.revision,
  tenantId: binding.tenantId,
});

const resolutionDigest = (binding: ContainedTurnProviderAccessSnapshot, evidence: OuterEvidence, phase: "acceptance" | "dispatch") =>
  digestContainedTurnCanonicalValue({
    bindingDigest: containedTurnProviderAccessSnapshotDigest(binding),
    ownerAuthorityDigest: evidence.authorityDigest,
    phase,
  });

/** The single composition ACL from Provider Access Published Language into the kernel port. */
export const createContainedTurnProviderAccessPort = (
  outer: OuterContainedTurnProviderAccess,
): ContainedTurnProviderAccessPort => Object.freeze({
  async resolveForAcceptance(input: Readonly<{ intent: ContainedTurnIntent; provider: ContainedTurnProvider; scope: ContainedTurnScope }>) {
    const outcome = await outer.resolve.execute({ provider: input.provider, scope: input.scope });
    if (outcome.kind === "resolved") {
      const binding = snapshot(outcome.binding, outcome.evidence);
      return Object.freeze({
        acceptanceProofId: proofId(outcome.evidence),
        acceptanceResolutionDigest: resolutionDigest(binding, outcome.evidence, "acceptance"),
        kind: "resolved" as const,
        snapshot: binding,
      });
    }
    if (outcome.reason === "revoked" || outcome.reason === "not_found") {
      return Object.freeze({ kind: "prevented" as const, preventionProofId: proofId(outcome.evidence), reason: "access_denied" as const });
    }
    return Object.freeze({ evidenceId: evidenceId(outcome.evidence), kind: "indeterminate" as const, reason: "authority_unknown" as const });
  },
  async revalidateForDispatch(input: Parameters<ContainedTurnProviderAccessPort["revalidateForDispatch"]>[0]) {
    const outerBinding: OuterBinding = Object.freeze({
      ...input.acceptedSnapshot,
      credentialBindingDigest: input.acceptedSnapshot.ownerAuthorityDigest,
    });
    const outcome = await outer.revalidate.execute({ binding: outerBinding, provider: input.acceptedSnapshot.provider, scope: input.scope });
    if (outcome.kind === "valid") {
      const binding = snapshot(outcome.binding, outcome.evidence);
      return Object.freeze({
        dispatchProofId: proofId(outcome.evidence),
        dispatchResolutionDigest: resolutionDigest(binding, outcome.evidence, "dispatch"),
        kind: "current" as const,
        snapshot: binding,
      });
    }
    if (outcome.reason === "revoked" || outcome.reason.endsWith("_changed") || outcome.reason === "credential_rotated" || outcome.reason === "revision_changed") {
      return Object.freeze({ kind: "prevented" as const, preventionProofId: proofId(outcome.evidence), reason: "access_revoked" as const });
    }
    return Object.freeze({ evidenceId: evidenceId(outcome.evidence), kind: "indeterminate" as const, reason: "authority_unknown" as const });
  },
});
