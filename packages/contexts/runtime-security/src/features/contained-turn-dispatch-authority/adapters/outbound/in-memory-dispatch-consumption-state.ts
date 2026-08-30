import type {
  DispatchConsumeResult,
  DispatchSettlementResult,
  PersistedDispatchConsumeResult,
  PersistedDispatchSettlementResult,
} from "../../application/dispatch-consumption-models.js";
import type { PersistedConsumption } from "../../application/ports/outbound/dispatch-consumption-repository.js";
import type {
  DispatchAuthorityHead,
  DispatchAuthorityScope,
} from "../../domain/dispatch-authority-head.js";

const canonical = (values: readonly string[]): string =>
  values.map(value => `${value.length}:${value}`).join("");

export const scopeKey = (scope: DispatchAuthorityScope): string =>
  canonical([scope.tenantId, scope.projectId, scope.scopeDigest]);

export const operationKey = (scope: DispatchAuthorityScope, providerId: string,
  authorityGeneration: string, operationId: string): string =>
  canonical([scopeKey(scope), providerId, authorityGeneration, operationId]);

export const requestKey = (scope: DispatchAuthorityScope, providerId: string,
  authorityGeneration: string, operationId: string, requestId: string): string =>
  canonical([scopeKey(scope), providerId, authorityGeneration, operationId, requestId]);

export const consumptionKey = (key: { readonly scope: DispatchAuthorityScope;
  readonly providerId: string; readonly authorityGeneration: string;
  readonly operationId: string; readonly grantRequestId: string;
  readonly consumptionDigest: string }): string => canonical([
    scopeKey(key.scope), key.providerId, key.authorityGeneration, key.operationId,
    key.grantRequestId, key.consumptionDigest,
  ]);

export const settlementRequestKey = (key: { readonly scope: DispatchAuthorityScope;
  readonly providerId: string; readonly authorityGeneration: string;
  readonly operationId: string; readonly grantRequestId: string;
  readonly settlementRequestId: string }): string => canonical([
    scopeKey(key.scope), key.providerId, key.authorityGeneration, key.operationId,
    key.grantRequestId, key.settlementRequestId,
  ]);

export interface ConsumeRequestRecord {
  readonly scope: DispatchAuthorityScope;
  readonly providerId: string;
  readonly authorityGeneration: string;
  readonly operationId: string;
  readonly grantRequestId: string;
  readonly requestDigest: string;
  readonly requestFingerprint: string;
  readonly outcome: PersistedDispatchConsumeResult;
  readonly operationKey: string;
}

export interface SettlementRequestRecord {
  readonly scope: DispatchAuthorityScope;
  readonly providerId: string;
  readonly authorityGeneration: string;
  readonly operationId: string;
  readonly grantRequestId: string;
  readonly settlementRequestId: string;
  readonly consumptionDigest: string;
  readonly settlementDigest: string;
  readonly outcome: PersistedDispatchSettlementResult;
}

export interface InMemoryDispatchConsumptionState {
  readonly authorities: Map<string, DispatchAuthorityHead>;
  readonly consumeRequests: Map<string, ConsumeRequestRecord>;
  readonly consumptionsByOperation: Map<string, PersistedConsumption>;
  readonly consumptionsByDigest: Map<string, PersistedConsumption>;
  readonly settlementRequests: Map<string, SettlementRequestRecord>;
  exclusive<Value>(work: () => Value): Promise<Value>;
}

export type ConsumeOperationResult = Promise<DispatchConsumeResult>;
export type SettlementOperationResult = Promise<DispatchSettlementResult>;
