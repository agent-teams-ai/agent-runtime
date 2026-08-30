import type {
  DispatchConsumeResult,
  DispatchConsumptionRecordReceipt,
  DispatchConsumptionLifecycle,
  DispatchSettlementRecordReceipt,
  DispatchSettlementResult,
  PersistedDispatchConsumeResult,
  PersistedDispatchSettlementResult,
} from "../../dispatch-consumption-models.js";
import type {
  DispatchAuthorityHead,
  DispatchAuthorityScope,
} from "../../../domain/dispatch-authority-head.js";

export interface PersistedConsumption {
  readonly receipt: DispatchConsumptionRecordReceipt;
  readonly lifecycleState: DispatchConsumptionLifecycle;
  readonly settlement?: DispatchSettlementRecordReceipt;
}

export interface ConsumeTransactionSnapshot {
  readonly priorRequest?: {
    readonly scope: DispatchAuthorityScope;
    readonly providerId: string;
    readonly authorityGeneration: string;
    readonly operationId: string;
    readonly grantRequestId: string;
    readonly requestDigest: string;
    readonly requestFingerprint: string;
    readonly outcome: PersistedDispatchConsumeResult;
  };
  readonly authority?: DispatchAuthorityHead;
  readonly consumption?: PersistedConsumption;
}

export interface ConsumeTransactionDecision {
  readonly outcome: DispatchConsumeResult;
  readonly persistRequest?: {
    readonly requestDigest: string;
    readonly requestFingerprint: string;
    readonly outcome: PersistedDispatchConsumeResult;
  };
  readonly persistConsumption?: PersistedConsumption;
}

export interface SettlementTransactionSnapshot {
  readonly priorRequest?: {
    readonly scope: DispatchAuthorityScope;
    readonly providerId: string;
    readonly authorityGeneration: string;
    readonly operationId: string;
    readonly grantRequestId: string;
    readonly settlementRequestId: string;
    readonly consumptionDigest: string;
    readonly settlementDigest: string;
    readonly outcome: PersistedDispatchSettlementResult;
  };
  readonly consumption?: PersistedConsumption;
}

export type SettlementTransactionDecision =
  | { readonly result: DispatchSettlementResult; readonly persist?: never }
  | {
      readonly result: Extract<PersistedDispatchSettlementResult, { readonly status: "not_found" }>;
      readonly persist: { readonly settlementDigest: string; readonly settle: false };
    }
  | {
      readonly result: Extract<PersistedDispatchSettlementResult, { readonly status: "settled" }>;
      readonly persist: { readonly settlementDigest: string; readonly settle: true };
    };

export interface ObservedConsumptionRecord {
  readonly scope: DispatchAuthorityScope;
  readonly providerId: string;
  readonly authorityGeneration: string;
  readonly operationId: string;
  readonly grantRequestId: string;
  readonly requestDigest: string;
  readonly requestFingerprint: string;
  readonly outcome: PersistedDispatchConsumeResult;
  readonly consumption?: PersistedConsumption;
}

/**
 * Hosted adapters must implement each callback in one owner transaction. The
 * consume transaction locks the scoped authority head, request identity, and
 * operation consumption identity before reading, then persists the immutable
 * request outcome and (when present) receipt together. The settlement
 * transaction locks request and consumption identities and never deletes or
 * rewrites a receipt. Serializable retry must re-run the callback. A read
 * followed by a separate write does not implement this port.
 */
export interface DispatchConsumptionRepository {
  consumeAtomically(
    key: {
      readonly scope: DispatchAuthorityScope;
      readonly providerId: string;
      readonly authorityGeneration: string;
      readonly operationId: string;
      readonly grantRequestId: string;
    },
    decide: (snapshot: ConsumeTransactionSnapshot) => ConsumeTransactionDecision,
  ): Promise<DispatchConsumeResult>;
  observe(key: {
    readonly scope: DispatchAuthorityScope;
    readonly providerId: string;
    readonly authorityGeneration: string;
    readonly operationId: string;
    readonly grantRequestId: string;
  }): Promise<ObservedConsumptionRecord | undefined>;
  settleAtomically(
    key: {
      readonly scope: DispatchAuthorityScope;
      readonly providerId: string;
      readonly authorityGeneration: string;
      readonly operationId: string;
      readonly grantRequestId: string;
      readonly settlementRequestId: string;
      readonly consumptionDigest: string;
    },
    decide: (
      snapshot: SettlementTransactionSnapshot,
    ) => SettlementTransactionDecision,
  ): Promise<DispatchSettlementResult>;
}
