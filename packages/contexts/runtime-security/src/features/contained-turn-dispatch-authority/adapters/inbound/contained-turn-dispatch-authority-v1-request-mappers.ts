import type {
  ConsumeForDispatchInput,
  ObserveDispatchConsumptionInput,
  SettleDispatchConsumptionInput,
} from "../../contracts/contained-turn-dispatch-authority-v1.js";
import type {
  DispatchObservationQuery,
  DispatchSettlementRequest,
} from "../../application/dispatch-consumption-models.js";
import {
  isBoundedDispatchIdentifier,
  isSettlementDisposition,
} from "../../application/dispatch-consumption-models.js";
import type {
  DispatchAuthorityScope,
  DispatchConsumeRequest,
} from "../../domain/dispatch-authority-head.js";
import { snapshotExactDispatchRecord } from "../../domain/dispatch-exact-record.js";

const scopeFrom = (value: unknown): DispatchAuthorityScope | undefined => {
  const fields = snapshotExactDispatchRecord(value, ["tenantId", "projectId", "scopeDigest"]);
  if (fields === undefined || ![fields.tenantId, fields.projectId, fields.scopeDigest]
    .every(isBoundedDispatchIdentifier)) {return undefined;}
  return Object.freeze({ tenantId: fields.tenantId as string, projectId: fields.projectId as string,
    scopeDigest: fields.scopeDigest as string });
};

const consumeNames = [
  "purpose", "operationId", "scope", "grantRequestId", "requestDigest", "providerId",
  "authorityGeneration", "providerBindingDigest", "claimBindingDigest",
  "acceptedAuthorityDigest", "expectedAuthorityHeadDigest", "expectedAuthorityRevision",
  "expectedConstraintsDigest", "expectedContainmentPolicyDigest",
] as const;

const mapExpectedOperation = (
  input: ConsumeForDispatchInput | ObserveDispatchConsumptionInput,
): DispatchConsumeRequest | DispatchObservationQuery | undefined => {
  const fields = snapshotExactDispatchRecord(input, consumeNames);
  const scope = fields === undefined ? undefined : scopeFrom(fields.scope);
  if (fields === undefined || scope === undefined ||
      fields.purpose !== "contained-turn.provider-dispatch/v1" ||
      consumeNames.slice(1).filter(name => name !== "scope")
        .some(name => !isBoundedDispatchIdentifier(fields[name]))) {return undefined;}
  return Object.freeze({ purpose: fields.purpose, operationId: fields.operationId as string, scope,
    grantRequestId: fields.grantRequestId as string, requestDigest: fields.requestDigest as string,
    providerId: fields.providerId as string, authorityGeneration: fields.authorityGeneration as string,
    providerBindingDigest: fields.providerBindingDigest as string,
    claimBindingDigest: fields.claimBindingDigest as string,
    acceptedAuthorityDigest: fields.acceptedAuthorityDigest as string,
    expectedAuthorityHeadDigest: fields.expectedAuthorityHeadDigest as string,
    expectedAuthorityRevision: fields.expectedAuthorityRevision as string,
    expectedConstraintsDigest: fields.expectedConstraintsDigest as string,
    expectedContainmentPolicyDigest: fields.expectedContainmentPolicyDigest as string });
};

export const mapConsumeRequestFromV1 = (input: ConsumeForDispatchInput) =>
  mapExpectedOperation(input);
export const mapObservationQueryFromV1 = (input: ObserveDispatchConsumptionInput) =>
  mapExpectedOperation(input);

export const mapSettlementRequestFromV1 = (
  input: SettleDispatchConsumptionInput,
): DispatchSettlementRequest | undefined => {
  const fields = snapshotExactDispatchRecord(input, ["scope", "providerId", "authorityGeneration",
    "operationId", "grantRequestId", "settlementRequestId", "consumptionDigest", "disposition"]);
  const scope = fields === undefined ? undefined : scopeFrom(fields.scope);
  if (fields === undefined || scope === undefined ||
      ![fields.providerId, fields.authorityGeneration, fields.operationId, fields.grantRequestId,
        fields.settlementRequestId, fields.consumptionDigest].every(isBoundedDispatchIdentifier) ||
      !isSettlementDisposition(fields.disposition)) {return undefined;}
  return Object.freeze({ scope, providerId: fields.providerId as string,
    authorityGeneration: fields.authorityGeneration as string,
    operationId: fields.operationId as string, grantRequestId: fields.grantRequestId as string,
    settlementRequestId: fields.settlementRequestId as string,
    consumptionDigest: fields.consumptionDigest as string,
    disposition: fields.disposition });
};
