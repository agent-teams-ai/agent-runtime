export type RootLifecycleResult =
  | "accepted"
  | "operation_acceptance_aborted"
  | "operation_acceptance_integrity_contradiction"
  | "operation_acceptance_replayed"
  | "operation_acceptance_stale_current_receipt"
  | "operation_acceptance_winner_committed_current_receipt"
  | "operation_abort_replayed"
  | "retention_obligation_set_required"
  | "retention_obligation_integrity_contradiction"
  | "root_establishment_forbidden_current_receipt"
  | "root_establishment_receipt_replayed"
  | "root_lifecycle_integrity_contradiction"
  | "semantic_root_establishment_race"
  | "semantic_root_released";

const has = (facts: ReadonlySet<string>, fact: string): boolean => facts.has(fact);

export const retentionObligationSetIsExact = (
  facts: ReadonlySet<string>,
): boolean => [
  "retention_obligation_set_pinned",
  "retention_obligation_schema_revision_pinned",
  "retention_obligation_policy_revision_pinned",
  "retention_obligation_capability_revision_pinned",
  "retention_obligation_set_digest_exact",
].every((fact) => has(facts, fact)) &&
  (has(facts, "retention_obligation_set_open") ||
    has(facts, "retention_obligation_set_sealed"));

export const retentionObligationSetIsOpenAndExact = (
  facts: ReadonlySet<string>,
): boolean => retentionObligationSetIsExact(facts) &&
  has(facts, "retention_obligation_set_open") &&
  !has(facts, "retention_obligation_set_sealed");

const acceptancePathRequested = (facts: ReadonlySet<string>): boolean => [
  "operation_acceptance_accept_requested",
  "operation_acceptance_accept_cas_won",
  "operation_acceptance_exact_replay",
].some((fact) => has(facts, fact));

const abortPathRequested = (facts: ReadonlySet<string>): boolean => [
  "operation_acceptance_abort_requested",
  "operation_acceptance_abort_cas_won",
  "operation_abort_exact_replay",
].some((fact) => has(facts, fact));

const acceptanceStateIsContradictory = (facts: ReadonlySet<string>): boolean => {
  const accepted = has(facts, "operation_acceptance_state_accepted");
  const aborted = has(facts, "operation_acceptance_state_aborted");
  return (accepted && aborted) ||
    (accepted && has(facts, "operation_acceptance_abort_cas_won")) ||
    (aborted && has(facts, "operation_acceptance_accept_cas_won")) ||
    (accepted && has(facts, "operation_acceptance_aborted_receipt_exact")) ||
    (aborted && has(facts, "operation_acceptance_committed")) ||
    (has(facts, "operation_acceptance_accept_cas_won") &&
      has(facts, "operation_acceptance_abort_cas_won"));
};

const evaluateConcurrentAcceptance = (
  facts: ReadonlySet<string>,
): RootLifecycleResult | undefined => {
  const concurrent = has(facts, "operation_acceptance_accept_requested") &&
    has(facts, "operation_acceptance_abort_requested");
  if (!concurrent) {
    return undefined;
  }
  const acceptWon = has(facts, "operation_acceptance_accept_cas_won");
  const abortWon = has(facts, "operation_acceptance_abort_cas_won");
  const pending = has(facts, "operation_acceptance_revision_pending");
  const accepted = has(facts, "operation_acceptance_state_accepted");
  const aborted = has(facts, "operation_acceptance_state_aborted");
  const contradictoryEvidence = (accepted && aborted) ||
    (accepted && has(facts, "operation_acceptance_aborted_receipt_exact")) ||
    (aborted && has(facts, "operation_acceptance_committed"));
  if (!pending || acceptWon === abortWon || contradictoryEvidence) {
    return "operation_acceptance_integrity_contradiction";
  }
  const acceptComplete = acceptWon &&
    accepted && !aborted &&
    has(facts, "operation_acceptance_committed") &&
    has(facts, "operation_acceptance_transaction_complete") &&
    !has(facts, "operation_abort_transaction_complete");
  const abortComplete = abortWon &&
    aborted && !accepted &&
    has(facts, "operation_abort_transaction_complete") &&
    has(facts, "operation_acceptance_aborted_receipt_exact") &&
    !has(facts, "operation_acceptance_transaction_complete");
  return acceptComplete || abortComplete
    ? "operation_acceptance_winner_committed_current_receipt"
    : "operation_acceptance_integrity_contradiction";
};

const evaluateAcceptanceReplay = (
  facts: ReadonlySet<string>,
): RootLifecycleResult | undefined => {
  if (has(facts, "operation_acceptance_exact_replay")) {
    return has(facts, "operation_acceptance_state_accepted") &&
      has(facts, "operation_acceptance_transaction_complete")
      ? "operation_acceptance_replayed"
      : "operation_acceptance_stale_current_receipt";
  }
  if (!has(facts, "operation_abort_exact_replay")) {
    return undefined;
  }
  return has(facts, "operation_acceptance_state_aborted") &&
    has(facts, "operation_abort_transaction_complete") &&
    has(facts, "operation_acceptance_aborted_receipt_exact")
    ? "operation_abort_replayed"
    : "operation_acceptance_stale_current_receipt";
};

const evaluatePendingAcceptance = (
  facts: ReadonlySet<string>,
  acceptPath: boolean,
): RootLifecycleResult => {
  const pending = has(facts, "operation_acceptance_revision_pending");
  if (acceptPath) {
    return pending && has(facts, "operation_acceptance_accept_cas_won") &&
      has(facts, "operation_acceptance_state_accepted") &&
      has(facts, "operation_acceptance_committed") &&
      has(facts, "operation_acceptance_transaction_complete")
      ? "accepted"
      : "operation_acceptance_stale_current_receipt";
  }
  return pending && has(facts, "operation_acceptance_abort_cas_won") &&
    has(facts, "operation_acceptance_state_aborted") &&
    has(facts, "operation_abort_transaction_complete") &&
    has(facts, "operation_acceptance_aborted_receipt_exact")
    ? "operation_acceptance_aborted"
    : "operation_acceptance_stale_current_receipt";
};

export const evaluateAcceptanceTransition = (
  facts: ReadonlySet<string>,
): RootLifecycleResult | undefined => {
  const acceptPath = acceptancePathRequested(facts);
  const abortPath = abortPathRequested(facts);
  const accepted = has(facts, "operation_acceptance_state_accepted");
  const aborted = has(facts, "operation_acceptance_state_aborted");
  const contradictoryEvidence =
    (accepted && has(facts, "operation_acceptance_aborted_receipt_exact")) ||
    (aborted && has(facts, "operation_acceptance_committed"));
  if (!acceptPath && !abortPath && !contradictoryEvidence && !(accepted && aborted)) {
    return undefined;
  }
  const concurrent = evaluateConcurrentAcceptance(facts);
  if (concurrent !== undefined) {
    return concurrent;
  }
  if (acceptanceStateIsContradictory(facts)) {
    return "operation_acceptance_integrity_contradiction";
  }
  const replay = evaluateAcceptanceReplay(facts);
  return replay ?? evaluatePendingAcceptance(facts, acceptPath);
};

const rootRequestLifecycleIsPresent = (facts: ReadonlySet<string>): boolean => [
  "root_request_state_pending",
  "root_request_state_established",
  "root_request_state_establishment_forbidden",
  "ensure_semantic_retention_requested",
  "root_abort_release_requested",
  "root_request_exact_replay",
  "same_revision_root_and_abort_cas_both_won",
].some((fact) => has(facts, fact));

export const ENSURE_ROOT_ESTABLISHMENT_WINNER_FENCES = [
  {
    fact: "collection_or_tombstone_cas_won",
    currentOutcome: "semantic_root_establishment_race",
    staleOutcome: "semantic_root_establishment_race",
  },
  {
    fact: "host_custody_collection_cas_won",
    currentOutcome: "semantic_root_establishment_race",
    staleOutcome: "semantic_root_establishment_race",
  },
  {
    fact: "retention_obligation_seal_cas_won",
    currentOutcome: "retention_obligation_integrity_contradiction",
    staleOutcome: "retention_obligation_set_required",
  },
  {
    fact: "root_abort_release_cas_won",
    currentOutcome: "root_lifecycle_integrity_contradiction",
    staleOutcome: "root_lifecycle_integrity_contradiction",
  },
] as const satisfies readonly {
  fact: string;
  currentOutcome: RootLifecycleResult;
  staleOutcome: RootLifecycleResult;
}[];

const evaluateEnsureWinnerFence = (
  facts: ReadonlySet<string>,
): RootLifecycleResult | undefined => {
  const winner = ENSURE_ROOT_ESTABLISHMENT_WINNER_FENCES.find(
    ({ fact }) => has(facts, fact),
  );
  if (winner === undefined) {
    return undefined;
  }
  return has(facts, "retention_obligation_set_open")
    ? winner.currentOutcome
    : winner.staleOutcome;
};

export const evaluateRootRequestLifecycle = (
  facts: ReadonlySet<string>,
): RootLifecycleResult | undefined => {
  if (!rootRequestLifecycleIsPresent(facts)) {
    return undefined;
  }
  if (has(facts, "same_revision_root_and_abort_cas_both_won")) {
    return "root_lifecycle_integrity_contradiction";
  }
  const stable = has(facts, "root_request_id_stable");
  const forbidden = has(facts, "root_request_state_establishment_forbidden") &&
    has(facts, "establishment_forbidden_tombstone_durable") &&
    has(facts, "root_establishment_rejected_receipt_durable");
  if ((has(facts, "ensure_semantic_retention_requested") ||
      has(facts, "root_request_exact_replay")) && forbidden) {
    return stable
      ? "root_establishment_forbidden_current_receipt"
      : "root_lifecycle_integrity_contradiction";
  }
  if (has(facts, "root_request_exact_replay")) {
    const invalidDigest = has(facts, "retention_obligation_set_digest_wrong") ||
      has(facts, "retention_obligation_set_weaker");
    const establishedReplay = stable &&
      has(facts, "root_request_state_established") &&
      has(facts, "root_request_generation_current") &&
      !has(facts, "root_request_generation_stale") &&
      !invalidDigest &&
      has(facts, "retention_obligation_set_digest_exact") &&
      has(facts, "root_establishment_receipt_durable");
    return establishedReplay
      ? "root_establishment_receipt_replayed"
      : "root_lifecycle_integrity_contradiction";
  }
  if (has(facts, "root_abort_release_requested")) {
    const releaseWon = stable && has(facts, "root_abort_release_cas_won") &&
      has(facts, "operation_acceptance_aborted_receipt_exact") && forbidden;
    return releaseWon
      ? "semantic_root_released"
      : "root_lifecycle_integrity_contradiction";
  }
  if (!has(facts, "ensure_semantic_retention_requested")) {
    return "root_lifecycle_integrity_contradiction";
  }
  const winnerFence = evaluateEnsureWinnerFence(facts);
  if (winnerFence !== undefined) {
    return winnerFence;
  }
  const established = stable && has(facts, "root_cas_won") &&
    has(facts, "root_request_state_established") &&
    retentionObligationSetIsOpenAndExact(facts);
  return established ? "accepted" : "retention_obligation_set_required";
};
