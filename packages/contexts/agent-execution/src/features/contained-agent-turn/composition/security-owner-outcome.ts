import type { OuterContainedTurnRuntimeSecurityAuthority } from "./runtime-security-anti-corruption.js";
import { ownerValue } from "./authority-owner-boundary.js";
import { assertContainedTurnExactRecord as exact } from "../domain/contained-turn-record.js";
import { digestContainedTurnCanonicalValue as hash } from "../domain/contained-turn-codecs.js";

type Owner = OuterContainedTurnRuntimeSecurityAuthority;
export const securityConsumeOutcome = async (pending: ReturnType<Owner["consumeForDispatch"]>, request: Parameters<Owner["consumeForDispatch"]>[0]): ReturnType<Owner["consumeForDispatch"]> => {
  const outcome = await ownerValue(pending);
  if (outcome.status === "consumed") {
    exact("RS consumption", outcome, Object.hasOwn(outcome, "lifecycleState") ? ["status", "receipt", "lifecycleState"] : ["status", "receipt"]);
    exact("RS receipt", outcome.receipt, ["contractVersion", "purpose", "operationId", "scope", "grantRequestId", "requestDigest", "providerId", "authorityGeneration", "providerBindingDigest", "claimBindingDigest", "acceptedAuthorityDigest", "authorityHeadDigestAtConsumption", "authorityRevision", "constraintsDigest", "containmentPolicyDigest", "consumptionDigest", "claimBeforeControlTime", "consumedAtControlTime", "ownerEvidenceRef"]);
    if (outcome.receipt.contractVersion !== "contained-turn-dispatch-consumption/v1") {throw new TypeError("RS receipt version mismatch");}
  } else if (outcome.status === "prevented") {
    exact("RS prevention outcome", outcome, ["status", "evidence"]);
    const evidence = outcome.evidence as Record<string, unknown>;
    exact("RS prevention", evidence, ["contractVersion", "purpose", "operationId", "scope", "grantRequestId", "requestDigest", "reason", "preventedAtControlTime", ...(Object.hasOwn(evidence, "ownerEvidenceRef") ? ["ownerEvidenceRef"] : [])]);
    if (evidence.contractVersion !== "contained-turn-dispatch-prevention/v1" || evidence.operationId !== request.operationId ||
        evidence.purpose !== request.purpose || evidence.grantRequestId !== request.grantRequestId || evidence.requestDigest !== request.requestDigest ||
        hash(evidence.scope as never) !== hash(request.scope as never) || !(["accepted_authority_changed", "already_consumed", "authority_revision_stale", "claim_binding_mismatch", "constraints_drift", "containment_policy_drift", "expired", "invalid_request", "provider_binding_mismatch", "request_digest_mismatch", "revoked"] as unknown[]).includes(evidence.reason) ||
        !Number.isSafeInteger(evidence.preventedAtControlTime)) {throw new TypeError("RS prevention request mismatch");}
  }
  return outcome;
};
export const securitySettlementOutcome = async (pending: ReturnType<Owner["settleDispatchConsumption"]>, request: Parameters<Owner["settleDispatchConsumption"]>[0]): ReturnType<Owner["settleDispatchConsumption"]> => {
  const outcome = await ownerValue(pending);
  if (outcome.status !== "settled") {return outcome;}
  exact("RS settlement", outcome, ["status", "receipt"]);
  const receipt = outcome.receipt as Record<string, unknown>;
  exact("RS settlement receipt", receipt, ["contractVersion", "settlementRequestId", "providerId", "authorityGeneration", "consumptionDigest", "disposition", "settledAtControlTime"]);
  if (receipt.contractVersion !== "contained-turn-dispatch-settlement/v1" || !Number.isSafeInteger(receipt.settledAtControlTime) ||
      ["settlementRequestId", "providerId", "authorityGeneration", "consumptionDigest", "disposition"].some(key => receipt[key] !== request[key as keyof typeof request])) {
    throw new TypeError("RS settlement request mismatch");
  }
  return outcome;
};
