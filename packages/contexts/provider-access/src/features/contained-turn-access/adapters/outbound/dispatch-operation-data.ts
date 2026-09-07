import { canonicalJson, snapshotDispatchBindingHead, snapshotDispatchControlTime, snapshotDispatchDigest,
  snapshotDispatchId, snapshotDispatchScope, type DispatchExpectationValue, type DispatchConsumeCommand } from "../../domain/dispatch-consumption.js";
import { snapshotProviderAccessBinding } from "../../domain/provider-access-binding.js";
import { exactDispatchDataRecord, detachedDispatchData } from "../dispatch-consumption-data.js";
import { createSha256DispatchConsumptionDigest } from "./sha256-dispatch-consumption-digest.js";
import { bindingSnapshot } from "./postgres/materialization-postgres-repository.js";
import type { PaAcceptedPreparation, PaDispatchIssuanceSelection, PaOperationPublication, PaOperationTransaction } from "./dispatch-operation-contracts.js";

const hash = async (value: unknown) => createSha256DispatchConsumptionDigest().digest(canonicalJson(value));
export const snapshotPaPreparation = (input: PaAcceptedPreparation): PaAcceptedPreparation => {
  const data = exactDispatchDataRecord("PA accepted preparation", detachedDispatchData("PA accepted preparation", input), [
    "operationId", "scope", "provider", "acceptedAuthorityDigest", "acceptanceEvidenceRef", "acceptedBinding",
    "providerBindingDigest", "grantRequestId", "claimBindingDigest", "requestDigest",
  ]);
  const raw = exactDispatchDataRecord("PA accepted binding", data.acceptedBinding, ["accessRef", "credentialBindingDigest",
    "credentialBindingRef", "credentialGeneration", "projectId", "provider", "providerAccountRef", "providerRouteRef", "revision", "tenantId"]);
  const {availability: _availability, revocation: _revocation, ...acceptedBinding} = snapshotProviderAccessBinding({
    ...raw, availability: "available", revocation: "active",
  } as Parameters<typeof snapshotProviderAccessBinding>[0]);
  const scope = snapshotDispatchScope(exactDispatchDataRecord("PA accepted scope", data.scope, ["tenantId", "projectId", "scopeDigest"]));
  if (data.provider !== acceptedBinding.provider || scope.tenantId !== acceptedBinding.tenantId || scope.projectId !== acceptedBinding.projectId) {
    throw new TypeError("PA accepted binding selector mismatch");
  }
  return Object.freeze({acceptedBinding: Object.freeze(acceptedBinding), scope, provider: acceptedBinding.provider,
    operationId: snapshotDispatchId("operationId", data.operationId), acceptanceEvidenceRef: snapshotDispatchId("acceptanceEvidenceRef", data.acceptanceEvidenceRef),
    acceptedAuthorityDigest: snapshotDispatchDigest("acceptedAuthorityDigest", data.acceptedAuthorityDigest),
    providerBindingDigest: snapshotDispatchDigest("providerBindingDigest", data.providerBindingDigest),
    grantRequestId: snapshotDispatchId("grantRequestId", data.grantRequestId), claimBindingDigest: snapshotDispatchDigest("claimBindingDigest", data.claimBindingDigest),
    requestDigest: snapshotDispatchDigest("requestDigest", data.requestDigest)});
};
export const snapshotPaIssuance = (input: PaDispatchIssuanceSelection): PaDispatchIssuanceSelection => {
  const data = exactDispatchDataRecord("PA issuance", detachedDispatchData("PA issuance", input), ["issuanceRef", "binding",
    "materializationHeadVersion", "validFromControlTime", "claimBeforeControlTime", "expiresAtControlTime"]);
  const version = data.materializationHeadVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {throw new TypeError("Invalid PA materialization version");}
  const binding = bindingSnapshot(data.binding);
  const validFromControlTime = snapshotDispatchControlTime(data.validFromControlTime);
  const claimBeforeControlTime = snapshotDispatchControlTime(data.claimBeforeControlTime);
  const expiresAtControlTime = snapshotDispatchControlTime(data.expiresAtControlTime);
  if (binding.revocation !== "active" || binding.availability !== "available" ||
    validFromControlTime >= claimBeforeControlTime || claimBeforeControlTime > expiresAtControlTime) {throw new TypeError("Invalid PA issuance window or binding");}
  return Object.freeze({issuanceRef: snapshotDispatchId("issuanceRef", data.issuanceRef), binding,
    materializationHeadVersion: version, validFromControlTime, claimBeforeControlTime, expiresAtControlTime});
};

/** Cross-context mapping fixture: C stays raw; wrapped C and snapshot P are different digests. */
export const paAcceptedDispatchExpectation = async (prepared: PaAcceptedPreparation): Promise<DispatchExpectationValue> => {
  const binding = prepared.acceptedBinding;
  const credentialBindingDigest = await hash({ownerDigest: binding.credentialBindingDigest});
  const snapshotDigest = await hash({...binding, credentialBindingDigest,
    ownerAuthorityDigest: binding.credentialBindingDigest, version: 1});
  if (prepared.providerBindingDigest !== snapshotDigest || prepared.scope.scopeDigest !==
    await hash({projectId: prepared.scope.projectId, tenantId: prepared.scope.tenantId, version: 1})) {
    throw new TypeError("PA accepted snapshot or scope digest mismatch");
  }
  return Object.freeze({acceptedAuthorityDigest: prepared.acceptedAuthorityDigest, accessRef: binding.accessRef,
    authorityHeadDigest: binding.credentialBindingDigest, bindingDigest: snapshotDigest, bindingRevision: binding.revision,
    credentialBindingDigest, credentialBindingRef: binding.credentialBindingRef, credentialGeneration: binding.credentialGeneration,
    providerAccountRef: binding.providerAccountRef, providerRouteRef: binding.providerRouteRef});
};
export const paPublication = async (prepared: PaAcceptedPreparation, issuance: PaDispatchIssuanceSelection): Promise<PaOperationPublication> => {
  const expectation = await paAcceptedDispatchExpectation(prepared);
  const {revision, ...binding} = prepared.acceptedBinding;
  if (canonicalJson({...binding, bindingRevision: revision, scopeDigest: prepared.scope.scopeDigest,
    availability: "available", revocation: "active"}) !== canonicalJson(issuance.binding)) {throw new TypeError("PA issuance does not authorize accepted binding");}
  const head = snapshotDispatchBindingHead({...expectation, ...prepared.scope, provider: prepared.provider,
    availability: "available", revocation: "active", claimBeforeControlTime: issuance.claimBeforeControlTime,
    expiresAtControlTime: issuance.expiresAtControlTime, opaqueOwnerEvidenceRef: issuance.issuanceRef});
  return Object.freeze({version: 2, prepared, issuance, head});
};
export const verifiedPaPublication = async (value: unknown): Promise<PaOperationPublication> => {
  const data = exactDispatchDataRecord("PA operation publication", value, ["version", "prepared", "issuance", "head"]);
  if (data.version !== 2) {throw new TypeError("PA operation publication version mismatch");}
  const result = await paPublication(snapshotPaPreparation(data.prepared as PaAcceptedPreparation), snapshotPaIssuance(data.issuance as PaDispatchIssuanceSelection));
  if (canonicalJson(result) !== canonicalJson(value)) {throw new TypeError("PA publication corrupted");}
  return result;
};
export const assertPaCurrentMaterialization = (tx: PaOperationTransaction, issuance: PaDispatchIssuanceSelection): void => {
  if (tx.materialization?.version !== issuance.materializationHeadVersion || canonicalJson(tx.materialization.binding) !== canonicalJson(issuance.binding)) {
    throw new Error("PA independently changed materialization");
  }
};
export const assertPaPreparedRequest = async (prepared: PaAcceptedPreparation, request: DispatchConsumeCommand): Promise<void> => {
  if (canonicalJson(request.binding) !== canonicalJson(await paAcceptedDispatchExpectation(prepared)) ||
    request.operationId !== prepared.operationId || request.provider !== prepared.provider || canonicalJson(request.scope) !== canonicalJson(prepared.scope) ||
    request.grantRequestId !== prepared.grantRequestId || request.claimBindingDigest !== prepared.claimBindingDigest || request.requestDigest !== prepared.requestDigest) {
    throw new TypeError("PA accepted preparation does not bind request");
  }
};
