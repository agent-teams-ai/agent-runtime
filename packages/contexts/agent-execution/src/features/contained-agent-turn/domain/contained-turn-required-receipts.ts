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

function validateRequiredReceiptSet(set: unknown): asserts set is ContainedTurnRequiredReceiptSet {
  assertContainedTurnExactRecord("required receipt set", set, [
    "membershipFrozenAt", "membershipMutation", "receipts", "satisfaction", "setVersion",
  ]);
  assertContainedTurnCanonicalArray(set.receipts);
  const exactMembership = set.receipts.length === CONTAINED_TURN_V1_REQUIRED_RECEIPTS.length &&
    set.receipts.every((receipt, index) => receipt === CONTAINED_TURN_V1_REQUIRED_RECEIPTS[index]);
  if (
    set.setVersion !== CONTAINED_TURN_V1_REQUIRED_RECEIPT_SET_VERSION ||
    set.membershipFrozenAt !== "command_acceptance" ||
    set.membershipMutation !== "forbidden" ||
    set.satisfaction !== "typed_receipt_or_authority_defined_typed_non_applicability_proof" || !exactMembership
  ) {
    throw new TypeError("unknown, corrupt, substituted, or mixed-version required receipt snapshot fails closed");
  }
}

export function validateContainedTurnRequiredReceiptSnapshot(
  snapshot: unknown,
): asserts snapshot is ContainedTurnRequiredReceiptSnapshot {
  assertContainedTurnExactRecord("required receipt snapshot", snapshot, ["digest", "set"]);
  validateRequiredReceiptSet(snapshot.set);
  if (snapshot.digest !== containedTurnRequiredReceiptSetDigest(snapshot.set)) {
    throw new TypeError("unknown, corrupt, substituted, or mixed-version required receipt snapshot fails closed");
  }
}

const RECEIPT_BY_PROOF_KIND = Object.freeze({
  acceptance: "command_acceptance",
  dispatch_claim: "dispatch_claim_or_proved_no_dispatch",
  no_dispatch: "dispatch_claim_or_proved_no_dispatch",
  execution_closure: "provider_execution_closure_or_proved_no_start",
  no_start: "provider_execution_closure_or_proved_no_start",
  provider_terminal_observation: "provider_terminal_observation_or_proved_no_start",
  provider_not_started: "provider_terminal_observation_or_proved_no_start",
  output_drain: "output_drain_and_fence_closure",
  output_no_start_drain: "output_drain_and_fence_closure",
  host_custody: "host_custody",
  host_custody_no_start: "host_custody",
  workspace_closure: "workspace_closure",
  artifact_manifest_seal: "artifact_manifest_seal",
  effect_resolution: "coarse_effect_resolution_or_reconciliation_debt",
  effect_no_start: "coarse_effect_resolution_or_reconciliation_debt",
  containment: "containment_execution",
  containment_not_required: "containment_execution",
  result_publication: "canonical_result_publication",
  cutoff: "cutoff_enforcement_when_applicable",
  cancellation: undefined,
  physical_containment: undefined,
  provider_acceptance: undefined,
  provider_access_acceptance: undefined,
  provider_access_dispatch: undefined,
  provider_process_no_start: undefined,
  provider_process_start: undefined,
  runtime_security_acceptance: undefined,
  runtime_security_dispatch: undefined,
  terminal_truth: undefined,
} satisfies Record<ContainedTurnProof["kind"], ContainedTurnRequiredReceipt | undefined>);

const receiptForProof = (proof: ContainedTurnProof): ContainedTurnRequiredReceipt | undefined => {
  const kind = proof.kind;
  return Object.hasOwn(RECEIPT_BY_PROOF_KIND, kind) ? RECEIPT_BY_PROOF_KIND[kind] : undefined;
};

export const containedTurnRequiredReceiptsSatisfied = (
  snapshot: ContainedTurnRequiredReceiptSnapshot,
  proofs: readonly ContainedTurnProof[],
): boolean => {
  validateContainedTurnRequiredReceiptSnapshot(snapshot);
  const satisfied = new Set(proofs.map(receiptForProof).filter(receipt => receipt !== undefined));
  return snapshot.set.receipts.every(receipt => satisfied.has(receipt));
};
