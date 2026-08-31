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
import { normalizeContainedTurnConsumedGrantReceipt, type OuterContainedTurnConsumedGrantReceipt } from "./dispatch-grant-anti-corruption.js";

interface OuterEvidence {
  readonly authorityDigest: string;
  readonly bindingAuthorityDigest: string;
  readonly proofRef: string;
  readonly purpose: "acceptance" | "dispatch";
}
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
  readonly consumeDispatchGrant: { execute(input: Readonly<{ subject: Parameters<ContainedTurnProviderAccessPort["consumeForDispatch"]>[0]["subject"] }>): Promise<
    | { readonly kind: "consumed"; readonly receipt: OuterContainedTurnConsumedGrantReceipt }
    | { readonly kind: "prevented"; readonly proofRef: string }
    | { readonly evidenceRef: string; readonly kind: "indeterminate" }
  > };
  readonly resolve: { execute(input: Readonly<{ provider: ContainedTurnProvider; scope: ContainedTurnScope }>): Promise<
    | { readonly binding: OuterBinding; readonly evidence: OuterEvidence; readonly kind: "resolved" }
    | { readonly evidence: OuterEvidence; readonly kind: "unavailable"; readonly reason: string }
  > };
  readonly revalidate: { execute(input: Readonly<{ binding: OuterBinding; provider: ContainedTurnProvider; scope: ContainedTurnScope }>): Promise<
    | { readonly binding: OuterBinding; readonly evidence: OuterEvidence; readonly kind: "valid" }
    | { readonly evidence: OuterEvidence; readonly kind: "rejected"; readonly reason: string }
  > };
  readonly settleDispatchGrant: { execute(input: Readonly<{
    permitDigest: string;
    permitId: string;
  } & (
    | { readonly grantRequestId: string; readonly consumptionEvidenceId?: never }
    | { readonly consumptionEvidenceId: string; readonly grantRequestId?: never }
  )>): Promise<
    | { readonly kind: "already_settled" | "settled" }
    | { readonly evidenceRef: string; readonly kind: "indeterminate" }
  > };
}

/**
 * Published-language references are opaque owner data.  They may be long
 * Unicode strings, so they must never be interpolated into the Kernel's
 * bounded ASCII identity vocabulary.  The digest also binds the complete
 * owner evidence packet, preventing a proofRef from being substituted across
 * authority heads or purposes.
 */
const opaqueEvidenceDigest = (evidence: OuterEvidence): string =>
  digestContainedTurnCanonicalValue({
    authorityDigest: evidence.authorityDigest,
    bindingAuthorityDigest: evidence.bindingAuthorityDigest,
    proofRef: evidence.proofRef,
    purpose: evidence.purpose,
  });

const proofId = (evidence: OuterEvidence, purpose: OuterEvidence["purpose"]) => containedTurnIdentity(
  "proof", `proof:provider-access:${purpose}:${opaqueEvidenceDigest(evidence)}`,
);
const evidenceId = (evidence: OuterEvidence, purpose: OuterEvidence["purpose"]) => containedTurnIdentity(
  "evidence", `evidence:provider-access:${purpose}:${opaqueEvidenceDigest(evidence)}`,
);

const snapshot = (binding: OuterBinding, evidence: OuterEvidence): ContainedTurnProviderAccessSnapshot => Object.freeze({
  accessRef: binding.accessRef,
  credentialBindingDigest: digestContainedTurnCanonicalValue({ ownerDigest: binding.credentialBindingDigest }),
  credentialBindingRef: binding.credentialBindingRef,
  credentialGeneration: binding.credentialGeneration,
  ownerAuthorityDigest: evidence.bindingAuthorityDigest,
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
    proofPurpose: evidence.purpose,
    proofRef: evidence.proofRef,
  });

/** The single composition ACL from Provider Access Published Language into the kernel port. */
export const createContainedTurnProviderAccessPort = (
  outer: OuterContainedTurnProviderAccess,
): ContainedTurnProviderAccessPort => Object.freeze({
  async consumeForDispatch(input: Parameters<ContainedTurnProviderAccessPort["consumeForDispatch"]>[0]) {
    const outcome = await outer.consumeDispatchGrant.execute(input);
    if (outcome.kind === "consumed") {
      return Object.freeze({
        kind: "consumed" as const,
        receipt: normalizeContainedTurnConsumedGrantReceipt("provider_access", input.subject, outcome.receipt),
      });
    }
    return outcome.kind === "prevented"
      ? Object.freeze({ kind: "prevented" as const, preventionProofId: containedTurnIdentity("proof", `proof:provider-access:grant:${digestContainedTurnCanonicalValue({ proofRef: outcome.proofRef })}`) })
      : Object.freeze({ evidenceId: containedTurnIdentity("evidence", `evidence:provider-access:grant:${digestContainedTurnCanonicalValue({ evidenceRef: outcome.evidenceRef })}`), kind: "indeterminate" as const });
  },
  async resolveForAcceptance(input: Readonly<{ intent: ContainedTurnIntent; provider: ContainedTurnProvider; scope: ContainedTurnScope }>) {
    const outcome = await outer.resolve.execute({ provider: input.provider, scope: input.scope });
    if (outcome.evidence.purpose !== "acceptance") {
      return Object.freeze({ evidenceId: evidenceId(outcome.evidence, "acceptance"), kind: "indeterminate" as const, reason: "authority_unknown" as const });
    }
    if (outcome.kind === "resolved") {
      const binding = snapshot(outcome.binding, outcome.evidence);
      return Object.freeze({
        acceptanceProofId: proofId(outcome.evidence, "acceptance"),
        acceptanceResolutionDigest: resolutionDigest(binding, outcome.evidence, "acceptance"),
        kind: "resolved" as const,
        snapshot: binding,
      });
    }
    if (outcome.reason === "revoked" || outcome.reason === "not_found") {
      return Object.freeze({ kind: "prevented" as const, preventionProofId: proofId(outcome.evidence, "acceptance"), reason: "access_denied" as const });
    }
    return Object.freeze({ evidenceId: evidenceId(outcome.evidence, "acceptance"), kind: "indeterminate" as const, reason: "authority_unknown" as const });
  },
  async revalidateForDispatch(input: Parameters<ContainedTurnProviderAccessPort["revalidateForDispatch"]>[0]) {
    const outerBinding: OuterBinding = Object.freeze({
      ...input.acceptedSnapshot,
      credentialBindingDigest: input.acceptedSnapshot.ownerAuthorityDigest,
    });
    const outcome = await outer.revalidate.execute({ binding: outerBinding, provider: input.acceptedSnapshot.provider, scope: input.scope });
    if (outcome.evidence.purpose !== "dispatch") {
      return Object.freeze({ evidenceId: evidenceId(outcome.evidence, "dispatch"), kind: "indeterminate" as const, reason: "authority_unknown" as const });
    }
    if (outcome.kind === "valid") {
      const binding = snapshot(outcome.binding, outcome.evidence);
      return Object.freeze({
        dispatchProofId: proofId(outcome.evidence, "dispatch"),
        dispatchResolutionDigest: resolutionDigest(binding, outcome.evidence, "dispatch"),
        kind: "current" as const,
        snapshot: binding,
      });
    }
    if (outcome.reason === "revoked" || outcome.reason.endsWith("_changed") || outcome.reason === "credential_rotated" || outcome.reason === "revision_changed") {
      return Object.freeze({ kind: "prevented" as const, preventionProofId: proofId(outcome.evidence, "dispatch"), reason: "access_revoked" as const });
    }
    return Object.freeze({ evidenceId: evidenceId(outcome.evidence, "dispatch"), kind: "indeterminate" as const, reason: "authority_unknown" as const });
  },
  async settleConsumedGrant(input: Parameters<ContainedTurnProviderAccessPort["settleConsumedGrant"]>[0]) {
    const outcome = await outer.settleDispatchGrant.execute({
      ...("grantRequestId" in input
        ? { grantRequestId: input.grantRequestId }
        : { consumptionEvidenceId: input.consumptionEvidenceId }),
      permitDigest: input.cleanupPermit.permitDigest,
      permitId: input.cleanupPermit.permitId,
    });
    return outcome.kind === "indeterminate"
      ? Object.freeze({ evidenceId: containedTurnIdentity("evidence", `evidence:provider-access:settle:${digestContainedTurnCanonicalValue({ evidenceRef: outcome.evidenceRef })}`), kind: "indeterminate" as const })
      : outcome;
  },
});
