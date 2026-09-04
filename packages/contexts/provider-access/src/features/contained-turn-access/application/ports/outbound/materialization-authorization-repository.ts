import type { DispatchBindingHead, DispatchConsumedReceipt, DispatchSettlementOutcome } from "../../../domain/dispatch-consumption.js";
import type { MaterializationRecord } from "../../../domain/materialization-authorization.js";

export interface MaterializationAuthorizationTransaction {
  controlTime(): Promise<number>;
  findBindingHead(): Promise<DispatchBindingHead | undefined>;
  findConsumption(): Promise<DispatchConsumedReceipt | undefined>;
  findMaterializationByConsumption(): Promise<MaterializationRecord | undefined>;
  findMaterializationRequest(): Promise<MaterializationRecord | undefined>;
  findSettlementByConsumption(): Promise<DispatchSettlementOutcome | undefined>;
  saveMaterialization(record: MaterializationRecord): Promise<void>;
}

export interface MaterializationAuthorizationRepository {
  /** Request identity is owner-global; callers must apply disclosure-safe scope checks before returning the record. */
  observeMaterializationRequest(materializationRequestId: string): Promise<MaterializationRecord | undefined>;
  /** Serializes the canonical head, settlement, one-use claim, and lifecycle record as one owner boundary. */
  transact<T>(selector: {
    readonly materializationRequestId: string;
    readonly provider: "claude" | "codex";
    readonly projectId: string;
    readonly scopeDigest: string;
    readonly settledConsumptionDigest: string;
    readonly tenantId: string;
  }, work: (transaction: MaterializationAuthorizationTransaction) => Promise<T>): Promise<T>;
}
