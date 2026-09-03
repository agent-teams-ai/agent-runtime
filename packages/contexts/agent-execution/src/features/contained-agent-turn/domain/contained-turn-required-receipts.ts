import {
  digestContainedTurnCanonicalValue,
  type ContainedTurnCanonicalDigest,
  type ContainedTurnCanonicalValue,
} from "./contained-turn-codecs.js";
import type { ContainedTurnProof } from "./contained-turn-proofs.js";
import { assertContainedTurnCanonicalArray, assertContainedTurnExactRecord } from "./contained-turn-record.js";

export const CONTAINED_TURN_V1_REQUIRED_RECEIPTS = Object.freeze([
  "command_acceptance",
  "dispatch_claim_or_proved_no_dispatch",
  "provider_execution_closure_or_proved_no_start",
  "provider_terminal_observation_or_proved_no_start",
  "output_drain_and_fence_closure",
  "host_custody",
  "workspace_closure",
  "artifact_manifest_seal",
  "coarse_effect_resolution_or_reconciliation_debt",
  "containment_execution",
  "canonical_result_publication",
  "cutoff_enforcement_when_applicable",
] as const);

export type ContainedTurnRequiredReceipt = (typeof CONTAINED_TURN_V1_REQUIRED_RECEIPTS)[number];
export const CONTAINED_TURN_V1_REQUIRED_RECEIPT_SET_VERSION = "contained-turn-v1-required-receipts@1" as const;
export type ContainedTurnRequiredReceiptSetVersion = typeof CONTAINED_TURN_V1_REQUIRED_RECEIPT_SET_VERSION;

/** Exact operation-owned V1 snapshot. Its five fields mirror the accepted oracle authority. */
export interface ContainedTurnRequiredReceiptSet {
  readonly membershipFrozenAt: "command_acceptance";
  readonly membershipMutation: "forbidden";
  readonly receipts: typeof CONTAINED_TURN_V1_REQUIRED_RECEIPTS;
  readonly satisfaction: "typed_receipt_or_authority_defined_typed_non_applicability_proof";
  readonly setVersion: ContainedTurnRequiredReceiptSetVersion;
}

export interface ContainedTurnRequiredReceiptSnapshot {
  readonly digest: ContainedTurnCanonicalDigest;
  readonly set: ContainedTurnRequiredReceiptSet;
}

const requiredReceiptSetValue = (set: ContainedTurnRequiredReceiptSet): ContainedTurnCanonicalValue => ({
  membershipFrozenAt: set.membershipFrozenAt,
  membershipMutation: set.membershipMutation,
  receipts: [...set.receipts],
  satisfaction: set.satisfaction,
  setVersion: set.setVersion,
});

export const containedTurnRequiredReceiptSetDigest = (
  set: ContainedTurnRequiredReceiptSet,
): ContainedTurnCanonicalDigest => digestContainedTurnCanonicalValue(requiredReceiptSetValue(set));

export const createContainedTurnRequiredReceiptSnapshot = (): ContainedTurnRequiredReceiptSnapshot => {
  const set: ContainedTurnRequiredReceiptSet = Object.freeze({
    membershipFrozenAt: "command_acceptance",
    membershipMutation: "forbidden",
    receipts: CONTAINED_TURN_V1_REQUIRED_RECEIPTS,
    satisfaction: "typed_receipt_or_authority_defined_typed_non_applicability_proof",
    setVersion: CONTAINED_TURN_V1_REQUIRED_RECEIPT_SET_VERSION,
  });
  return Object.freeze({ digest: containedTurnRequiredReceiptSetDigest(set), set });
};

export const validateContainedTurnRequiredReceiptSnapshot = (
  snapshot: ContainedTurnRequiredReceiptSnapshot,
): void => {
  assertContainedTurnExactRecord("required receipt snapshot", snapshot, ["digest", "set"]);
  assertContainedTurnExactRecord("required receipt set", snapshot.set, [
    "membershipFrozenAt", "membershipMutation", "receipts", "satisfaction", "setVersion",
  ]);
  assertContainedTurnCanonicalArray(snapshot.set.receipts);
  const exactMembership = snapshot.set.receipts.length === CONTAINED_TURN_V1_REQUIRED_RECEIPTS.length &&
    snapshot.set.receipts.every((receipt, index) => receipt === CONTAINED_TURN_V1_REQUIRED_RECEIPTS[index]);
  if (
    snapshot.set.setVersion !== CONTAINED_TURN_V1_REQUIRED_RECEIPT_SET_VERSION ||
    snapshot.set.membershipFrozenAt !== "command_acceptance" ||
    snapshot.set.membershipMutation !== "forbidden" ||
    snapshot.set.satisfaction !== "typed_receipt_or_authority_defined_typed_non_applicability_proof" ||
    !exactMembership || snapshot.digest !== containedTurnRequiredReceiptSetDigest(snapshot.set)
  ) {
    throw new TypeError("unknown, corrupt, substituted, or mixed-version required receipt snapshot fails closed");
  }
};

const receiptForProof = (proof: ContainedTurnProof): ContainedTurnRequiredReceipt | undefined => {
  switch (proof.kind) {
    case "acceptance": return "command_acceptance";
    case "dispatch_claim":
    case "no_dispatch": return "dispatch_claim_or_proved_no_dispatch";
    case "execution_closure":
    case "no_start": return "provider_execution_closure_or_proved_no_start";
    case "provider_terminal_observation":
    case "provider_not_started": return "provider_terminal_observation_or_proved_no_start";
    case "output_drain":
    case "output_no_start_drain": return "output_drain_and_fence_closure";
    case "host_custody":
    case "host_custody_no_start": return "host_custody";
    case "workspace_closure": return "workspace_closure";
    case "artifact_manifest_seal": return "artifact_manifest_seal";
    case "effect_resolution":
    case "effect_no_start": return "coarse_effect_resolution_or_reconciliation_debt";
    case "containment":
    case "containment_not_required": return "containment_execution";
    case "result_publication": return "canonical_result_publication";
    case "cutoff": return "cutoff_enforcement_when_applicable";
    default: return undefined;
  }
};

export const containedTurnRequiredReceiptsSatisfied = (
  snapshot: ContainedTurnRequiredReceiptSnapshot,
  proofs: readonly ContainedTurnProof[],
): boolean => {
  validateContainedTurnRequiredReceiptSnapshot(snapshot);
  const satisfied = new Set(proofs.map(receiptForProof).filter(receipt => receipt !== undefined));
  return snapshot.set.receipts.every(receipt => satisfied.has(receipt));
};
