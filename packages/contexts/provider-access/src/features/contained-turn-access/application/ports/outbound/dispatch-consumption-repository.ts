import type {
  DispatchBindingHead, DispatchConsumeOutcome, DispatchConsumedReceipt, DispatchExpectationValue, DispatchProvider, DispatchScopeValue,
  DispatchSettlementOutcome,
} from "../../../domain/dispatch-consumption.js";

export interface DispatchConsumptionJournalEntry {
  readonly binding: DispatchExpectationValue;
  readonly claimBindingDigest: string;
  readonly grantRequestId: string;
  readonly operationId: string;
  readonly outcome: DispatchConsumeOutcome;
  readonly provider: DispatchProvider;
  readonly purpose: "contained-turn.provider-dispatch/v1";
  /** Server-derived digest of the validated semantic request; never caller authority. */
  readonly requestDigest: string;
  readonly scope: DispatchScopeValue;
}
export type DispatchConsumptionTransactionSelector =
  | { readonly grantRequestId: string; readonly kind: "consume"; readonly provider: DispatchProvider; readonly scope: DispatchScopeValue }
  | { readonly consumptionDigest: string; readonly expectedAuthorityHeadDigest: string; readonly kind: "settle";
      readonly operationId: string; readonly provider: DispatchProvider; readonly scope: DispatchScopeValue;
      readonly settlementRequestId: string };
export interface DispatchConsumptionTransaction {
  controlTime(): Promise<number>;
  findBindingHead(): Promise<DispatchBindingHead | undefined>;
  findConsumption(): Promise<DispatchConsumedReceipt | undefined>;
  findGrantRequest(): Promise<DispatchConsumptionJournalEntry | undefined>;
  findSettlement(): Promise<DispatchSettlementOutcome | undefined>;
  findSettlementByConsumption(): Promise<DispatchSettlementOutcome | undefined>;
  isBindingConsumed(): Promise<boolean>;
  markBindingConsumed(receipt: DispatchConsumedReceipt): Promise<void>;
  saveGrantRequest(entry: DispatchConsumptionJournalEntry): Promise<void>;
  saveSettlement(outcome: DispatchSettlementOutcome): Promise<void>;
}
/**
 * Implementations serialize one unit of work and select/lock only rows named by
 * the complete selector. Every operation is awaitable so a PostgreSQL adapter
 * can issue targeted queries without preloading a ledger. `controlTime` must be
 * sampled within that same transaction. Owner decisions remain in application code.
 */
export interface DispatchConsumptionRepository {
  transact<T>(selector: DispatchConsumptionTransactionSelector,
    work: (transaction: DispatchConsumptionTransaction) => Promise<T>): Promise<T>;
  observeGrantRequest(input: { readonly grantRequestId: string; readonly provider: DispatchProvider; readonly scope: DispatchScopeValue }):
    Promise<DispatchConsumptionJournalEntry | undefined>;
}
