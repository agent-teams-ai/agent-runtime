import type {
  ContainedTurnDispatchConsumptionV1, ConsumeForDispatchInput, ConsumeForDispatchOutcome,
  DispatchConsumptionBindingExpectation, DispatchConsumptionPrevention, DispatchConsumptionReceipt,
  DispatchConsumptionScope, DispatchConsumptionSettlementReceipt, ObserveDispatchConsumptionInput,
  SettleDispatchConsumptionInput, SettleDispatchConsumptionOutcome,
} from "../../contracts/dispatch-consumption-v1.js";
import type { DispatchConsumptionUseCases } from "../../application/dispatch-consumption-v1.js";
import {
  snapshotDispatchDigest, snapshotDispatchExpectation, snapshotDispatchId, snapshotDispatchScope,
  type DispatchConsumeCommand, type DispatchConsumedReceipt, type DispatchDisposition,
  type DispatchExpectationValue, type DispatchPrevention, type DispatchScopeValue, type DispatchSettlementReceipt,
} from "../../domain/dispatch-consumption.js";
import { exactDispatchDataRecord } from "../dispatch-consumption-data.js";

const dataRecord = exactDispatchDataRecord;

const scopeFrom = (value: unknown): DispatchScopeValue => {
  const record = dataRecord("scope", value, ["projectId", "scopeDigest", "tenantId"]);
  return snapshotDispatchScope(record);
};

export const consumeCommandFromContract = (value: ConsumeForDispatchInput): DispatchConsumeCommand => {
  const input = dataRecord("consume input", value, [
    "binding", "claimBindingDigest", "grantRequestId", "operationId", "provider", "purpose", "requestDigest", "scope",
  ]);
  const binding = dataRecord("binding", input.binding, [
    "acceptedAuthorityDigest", "accessRef", "authorityHeadDigest", "bindingDigest", "bindingRevision",
    "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "providerAccountRef", "providerRouteRef",
  ]);
  if (input.purpose !== "contained-turn.provider-dispatch/v1") {throw new TypeError("purpose is invalid");}
  if (input.provider !== "claude" && input.provider !== "codex") {throw new TypeError("provider is invalid");}
  return Object.freeze({
    binding: snapshotDispatchExpectation(binding),
    claimBindingDigest: snapshotDispatchDigest("claimBindingDigest", input.claimBindingDigest),
    grantRequestId: snapshotDispatchId("grantRequestId", input.grantRequestId),
    operationId: snapshotDispatchId("operationId", input.operationId), provider: input.provider, purpose: input.purpose,
    requestDigest: snapshotDispatchDigest("requestDigest", input.requestDigest), scope: scopeFrom(input.scope),
  });
};

export const unsignedConsumeCommandFromContract = (
  value: Omit<ConsumeForDispatchInput, "claimBindingDigest" | "requestDigest">,
): Omit<DispatchConsumeCommand, "claimBindingDigest" | "requestDigest"> => {
  const input = dataRecord("unsigned consume input", value, ["binding", "grantRequestId", "operationId", "provider", "purpose", "scope"]);
  const binding = dataRecord("binding", input.binding, [
    "acceptedAuthorityDigest", "accessRef", "authorityHeadDigest", "bindingDigest", "bindingRevision",
    "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "providerAccountRef", "providerRouteRef",
  ]);
  if (input.purpose !== "contained-turn.provider-dispatch/v1") {throw new TypeError("purpose is invalid");}
  if (input.provider !== "claude" && input.provider !== "codex") {throw new TypeError("provider is invalid");}
  return Object.freeze({
    binding: snapshotDispatchExpectation(binding),
    grantRequestId: snapshotDispatchId("grantRequestId", input.grantRequestId),
    operationId: snapshotDispatchId("operationId", input.operationId), provider: input.provider, purpose: input.purpose,
    scope: scopeFrom(input.scope),
  });
};

export const observeInputFromContract = (value: ObserveDispatchConsumptionInput) => {
  const input = dataRecord("observe input", value, ["grantRequestId", "provider", "requestDigest", "scope"]);
  if (input.provider !== "claude" && input.provider !== "codex") {throw new TypeError("provider is invalid");}
  return Object.freeze({
    grantRequestId: snapshotDispatchId("grantRequestId", input.grantRequestId), provider: input.provider,
    requestDigest: snapshotDispatchDigest("requestDigest", input.requestDigest), scope: scopeFrom(input.scope),
  });
};

export const settlementInputFromContract = (value: SettleDispatchConsumptionInput) => {
  const input = dataRecord("settlement input", value, [
    "consumptionDigest", "disposition", "expectedBinding", "operationId", "provider", "scope", "settlementRequestId",
  ]);
  if (input.disposition !== "claim_committed" && input.disposition !== "abandoned_without_claim") {
    throw new TypeError("disposition is invalid");
  }
  if (input.provider !== "claude" && input.provider !== "codex") {throw new TypeError("provider is invalid");}
  const expectedBinding = dataRecord("expected binding", input.expectedBinding, [
    "acceptedAuthorityDigest", "accessRef", "authorityHeadDigest", "bindingDigest", "bindingRevision",
    "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "providerAccountRef", "providerRouteRef",
  ]);
  return Object.freeze({
    consumptionDigest: snapshotDispatchDigest("consumptionDigest", input.consumptionDigest),
    disposition: input.disposition as DispatchDisposition,
    expectedBinding: snapshotDispatchExpectation(expectedBinding),
    operationId: snapshotDispatchId("operationId", input.operationId), provider: input.provider,
    scope: scopeFrom(input.scope),
    settlementRequestId: snapshotDispatchId("settlementRequestId", input.settlementRequestId),
  });
};

const scopeToContract = (scope: DispatchScopeValue): DispatchConsumptionScope => Object.freeze({
  projectId: scope.projectId,
  scopeDigest: scope.scopeDigest,
  tenantId: scope.tenantId,
});

const expectationToContract = (
  binding: DispatchExpectationValue,
): DispatchConsumptionBindingExpectation => Object.freeze({
  acceptedAuthorityDigest: binding.acceptedAuthorityDigest,
  accessRef: binding.accessRef,
  authorityHeadDigest: binding.authorityHeadDigest,
  bindingDigest: binding.bindingDigest,
  bindingRevision: binding.bindingRevision,
  credentialBindingDigest: binding.credentialBindingDigest,
  credentialBindingRef: binding.credentialBindingRef,
  credentialGeneration: binding.credentialGeneration,
  providerAccountRef: binding.providerAccountRef,
  providerRouteRef: binding.providerRouteRef,
});

const consumedReceiptToContract = (
  receipt: DispatchConsumedReceipt,
): DispatchConsumptionReceipt => Object.freeze({
  acceptedAuthorityDigest: receipt.acceptedAuthorityDigest,
  accessRef: receipt.accessRef,
  authorityHeadDigestAtConsumption: receipt.authorityHeadDigestAtConsumption,
  bindingDigest: receipt.bindingDigest,
  bindingRevision: receipt.bindingRevision,
  claimBeforeControlTime: receipt.claimBeforeControlTime,
  claimBindingDigest: receipt.claimBindingDigest,
  consumedAtControlTime: receipt.consumedAtControlTime,
  consumptionDigest: receipt.consumptionDigest,
  credentialBindingDigest: receipt.credentialBindingDigest,
  credentialBindingRef: receipt.credentialBindingRef,
  credentialGeneration: receipt.credentialGeneration,
  grantRequestId: receipt.grantRequestId,
  opaqueOwnerEvidenceRef: receipt.opaqueOwnerEvidenceRef,
  operationId: receipt.operationId,
  provider: receipt.provider,
  providerAccountRef: receipt.providerAccountRef,
  providerRouteRef: receipt.providerRouteRef,
  purpose: receipt.purpose,
  requestDigest: receipt.requestDigest,
  scope: scopeToContract(receipt.scope),
});

const preventionToContract = (
  prevention: DispatchPrevention,
): DispatchConsumptionPrevention => Object.freeze({
  grantRequestId: prevention.grantRequestId,
  observedAtControlTime: prevention.observedAtControlTime,
  opaqueOwnerEvidenceRef: prevention.opaqueOwnerEvidenceRef,
  reason: prevention.reason,
  requestDigest: prevention.requestDigest,
  scope: scopeToContract(prevention.scope),
});

const consumeOutcomeToContract = (
  outcome: Awaited<ReturnType<DispatchConsumptionUseCases["consume"]>>,
): ConsumeForDispatchOutcome => {
  switch (outcome.kind) {
    case "consumed": return Object.freeze({ kind: "consumed", receipt: consumedReceiptToContract(outcome.receipt) });
    case "prevented": return Object.freeze({ kind: "prevented", prevention: preventionToContract(outcome.prevention) });
    case "conflict": return Object.freeze({ kind: "conflict", reason: outcome.reason });
    case "invalid": return Object.freeze({ kind: "invalid", reason: outcome.reason });
    case "indeterminate": return Object.freeze({ kind: "indeterminate" });
    case "not_found": return Object.freeze({ kind: "not_found" });
  }
};

const settlementReceiptToContract = (
  receipt: DispatchSettlementReceipt,
): DispatchConsumptionSettlementReceipt => Object.freeze({
  consumptionDigest: receipt.consumptionDigest,
  disposition: receipt.disposition,
  expectedBinding: expectationToContract(receipt.expectedBinding),
  operationId: receipt.operationId,
  provider: receipt.provider,
  scope: scopeToContract(receipt.scope),
  settledAtControlTime: receipt.settledAtControlTime,
  settlementDigest: receipt.settlementDigest,
  settlementRequestId: receipt.settlementRequestId,
});

const settlementOutcomeToContract = (
  outcome: Awaited<ReturnType<DispatchConsumptionUseCases["settle"]>>,
): SettleDispatchConsumptionOutcome => {
  switch (outcome.kind) {
    case "settled": return Object.freeze({ kind: "settled", receipt: settlementReceiptToContract(outcome.receipt) });
    case "conflict": return Object.freeze({ kind: "conflict", reason: outcome.reason });
    case "invalid": return Object.freeze({ kind: "invalid", reason: outcome.reason });
    case "indeterminate": return Object.freeze({ kind: "indeterminate" });
    case "not_found": return Object.freeze({ kind: "not_found" });
  }
};

/** Maps the public dispatch DTO boundary to and from application-owned values. */
export const createDispatchConsumptionAdapter = (
  useCases: DispatchConsumptionUseCases,
): ContainedTurnDispatchConsumptionV1 => Object.freeze({
  async consumeForDispatch(input: ConsumeForDispatchInput): Promise<ConsumeForDispatchOutcome> {
    let command;
    try { command = consumeCommandFromContract(input); }
    catch { return Object.freeze({ kind: "invalid", reason: "invalid_request" }); }
    try { return consumeOutcomeToContract(await useCases.consume(command)); }
    catch { return Object.freeze({ kind: "indeterminate" }); }
  },
  async observeDispatchConsumption(input: ObserveDispatchConsumptionInput): Promise<ConsumeForDispatchOutcome> {
    let snapshot;
    try { snapshot = observeInputFromContract(input); }
    catch { return Object.freeze({ kind: "invalid", reason: "invalid_request" }); }
    try { return consumeOutcomeToContract(await useCases.observe(snapshot)); }
    catch { return Object.freeze({ kind: "indeterminate" }); }
  },
  async settleDispatchConsumption(input: SettleDispatchConsumptionInput): Promise<SettleDispatchConsumptionOutcome> {
    let snapshot;
    try { snapshot = settlementInputFromContract(input); }
    catch { return Object.freeze({ kind: "invalid", reason: "invalid_request" }); }
    try { return settlementOutcomeToContract(await useCases.settle(snapshot)); }
    catch { return Object.freeze({ kind: "indeterminate" }); }
  },
});
