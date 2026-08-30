import type {
  ConsumeForDispatchInput, ObserveDispatchConsumptionInput, SettleDispatchConsumptionInput,
} from "./dispatch-consumption-v1.js";
import {
  snapshotDispatchDigest, snapshotDispatchExpectation, snapshotDispatchId, snapshotDispatchScope,
  type DispatchConsumeCommand, type DispatchDisposition, type DispatchScopeValue,
} from "../domain/dispatch-consumption.js";
import { exactDispatchDataRecord } from "../boundary/exact-dispatch-consumption-data.js";

const dataRecord = exactDispatchDataRecord;

const scopeFrom = (value: unknown): DispatchScopeValue => {
  const record = dataRecord("scope", value, ["projectId", "scopeDigest", "tenantId"]);
  return snapshotDispatchScope(record as unknown as DispatchScopeValue);
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
    binding: snapshotDispatchExpectation(binding as unknown as Parameters<typeof snapshotDispatchExpectation>[0]),
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
    binding: snapshotDispatchExpectation(binding as unknown as Parameters<typeof snapshotDispatchExpectation>[0]),
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
    expectedBinding: snapshotDispatchExpectation(expectedBinding as unknown as Parameters<typeof snapshotDispatchExpectation>[0]),
    operationId: snapshotDispatchId("operationId", input.operationId), provider: input.provider,
    scope: scopeFrom(input.scope),
    settlementRequestId: snapshotDispatchId("settlementRequestId", input.settlementRequestId),
  });
};
