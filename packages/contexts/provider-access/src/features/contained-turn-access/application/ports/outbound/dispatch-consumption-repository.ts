import type {
  DispatchBindingHead, DispatchConsumeOutcome, DispatchConsumedReceipt, DispatchScopeValue,
  DispatchSettlementOutcome,
} from "../../../domain/dispatch-consumption.js";

export interface DispatchConsumptionJournalEntry {
  readonly outcome: DispatchConsumeOutcome;
  readonly requestDigest: string;
  readonly scope: DispatchScopeValue;
}
export interface DispatchConsumptionTransaction {
  findBindingHead(): DispatchBindingHead | undefined;
  findConsumptionByDigest(consumptionDigest: string): DispatchConsumedReceipt | undefined;
  findGrantRequest(grantRequestId: string): DispatchConsumptionJournalEntry | undefined;
  findSettlement(settlementRequestId: string): DispatchSettlementOutcome | undefined;
  findSettlementByConsumption(consumptionDigest: string): DispatchSettlementOutcome | undefined;
  isBindingConsumed(): boolean;
  markBindingConsumed(receipt: DispatchConsumedReceipt): void;
  saveGrantRequest(grantRequestId: string, entry: DispatchConsumptionJournalEntry): void;
  saveSettlement(settlementRequestId: string, outcome: DispatchSettlementOutcome): void;
}
/**
 * Hosted implementations must use one owner-schema transaction that locks the exact
 * `(scopeDigest, provider)` head before reading it, uniquely journals grantRequestId,
 * persists the immutable canonical outcome and consumed receipt in that transaction,
 * and checks affected-row counts. Observation must read that journal, not reconstruct
 * an outcome from the mutable head. Settlement has its own unique request ledger and
 * may only advance consumed_pending to one terminal disposition. A PostgreSQL adapter
 * is intentionally not claimed until this package can declare `pg` without changing
 * the root lockfile and can verify its owner migration against restart/concurrency tests.
 */
export interface DispatchConsumptionRepository {
  transact<T>(input: { readonly provider?: "claude" | "codex"; readonly scopeDigest?: string },
    work: (transaction: DispatchConsumptionTransaction) => Promise<T>): Promise<T>;
  observeGrantRequest(input: { readonly grantRequestId: string; readonly scope: DispatchScopeValue }): Promise<DispatchConsumptionJournalEntry | undefined>;
}
