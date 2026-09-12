import { securityConsumeOutcome, securitySettlementOutcome } from "./security-owner-outcome.js";
import type { ContainedTurnKernelSecurityPort } from "../application/ports/outbound/contained-turn-ports.js";
import { containedTurnAcceptanceIntentDigestV1 } from "../application/contained-turn-engine.js";
import { containedTurnScopeDigest } from "../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue as hash, parseContainedTurnCanonicalDigest } from "../domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../domain/contained-turn-identities.js";
import { assertContainedTurnExactRecord as exact } from "../domain/contained-turn-record.js";
import { acceptedAuthority } from "./accepted-authority-anti-corruption.js";
import { authorityValue, ownerValue } from "./authority-owner-boundary.js";
import { capturedMethod, exactStableDataRecord, exactBoundedToken } from "./provider-access-anti-corruption.js";
import { createContainedTurnRuntimeSecurityPort, type OuterContainedTurnRuntimeSecurityAuthority } from "./runtime-security-anti-corruption.js";

type Intent = Readonly<{operationId: string; scope: Readonly<{tenantId: string; projectId: string; scopeDigest: string}>; providerId: string; intentDigest: string; policyRevision: string}>;
type Policy = Omit<Intent, "operationId"> & Readonly<{enabled: boolean; revoked: boolean; constraintsDigest: string; containmentPolicyDigest: string; validFromControlTime: number; claimBeforeControlTime: number}>;
type Decision = Intent & Readonly<{decisionDigest: string; ownerEvidenceRef: string; policy: Policy}>;
type Preparation = Readonly<{acceptance: Intent; decisionDigest: string; authorityGeneration: string; providerBindingDigest: string; claimBindingDigest: string; requestDigest: string; grantRequestId: string}>;
/** Structural view of actual createDispatchAcceptanceFeature; no permission algorithm lives here. */
export interface OuterContainedTurnSecurityAcceptance {
  evaluateForAcceptance(input: Intent): Promise<Readonly<{status: "allowed"; decision: Decision} | {status: "denied"} | {status: "indeterminate"; reason: string}>>;
  publishAndConsumeForDispatch(prepared: Preparation, request: Parameters<OuterContainedTurnRuntimeSecurityAuthority["consumeForDispatch"]>[0]): ReturnType<OuterContainedTurnRuntimeSecurityAuthority["consumeForDispatch"]>;
  observeDispatchConsumption: OuterContainedTurnRuntimeSecurityAuthority["observeDispatchConsumption"];
  settleDispatchConsumption: OuterContainedTurnRuntimeSecurityAuthority["settleDispatchConsumption"];
}
export interface ContainedTurnSecurityAcceptanceProfile { readonly policyRevision: string }
const evidence = (phase: string) => containedTurnIdentity("evidence", `evidence:runtime-security:acl:${phase}`);
const proof = (phase: string, value: unknown) => containedTurnIdentity("proof", `proof:runtime-security:${phase}:${hash(value as never)}`);
const selectionKey = (operationId: string, scope: unknown) => hash({operationId, scope} as never);
const same = (a: unknown, b: unknown) => hash(a as never) === hash(b as never);
const checkDecision = (decision: Decision, intent: Intent, constraintsDigest: string) => {
  exact("RS decision", decision, ["operationId", "scope", "providerId", "intentDigest", "policyRevision", "decisionDigest", "ownerEvidenceRef", "policy"]);
  const {policy, decisionDigest, ownerEvidenceRef, ...selector} = decision;
  exact("RS policy", policy, ["scope", "providerId", "intentDigest", "policyRevision", "enabled", "revoked", "constraintsDigest", "containmentPolicyDigest", "validFromControlTime", "claimBeforeControlTime"]);
  const {operationId: _operationId, ...policySelector} = intent;
  if (!same(selector, intent) || !same({scope: policy.scope, providerId: policy.providerId, intentDigest: policy.intentDigest, policyRevision: policy.policyRevision}, policySelector) ||
      policy.constraintsDigest !== constraintsDigest || policy.enabled !== true || policy.revoked !== false ||
      typeof ownerEvidenceRef !== "string" || ownerEvidenceRef.length === 0 || ownerEvidenceRef.length > 512) {throw new TypeError("RS decision does not bind acceptance");}
  parseContainedTurnCanonicalDigest(decisionDigest);
  parseContainedTurnCanonicalDigest(policy.containmentPolicyDigest);
  return decision;
};
/** Inert construction. Profile selection is trusted immutable composition input. */
export const createContainedTurnSecurityAcceptancePort = (
  outer: OuterContainedTurnSecurityAcceptance, profile: ContainedTurnSecurityAcceptanceProfile,
): ContainedTurnKernelSecurityPort => {
  const selected = exactStableDataRecord(profile, ["policyRevision"]);
  if (!exactBoundedToken(selected.policyRevision) || !/^security-(?:authority|revision):.+$/u.test(selected.policyRevision)) {throw new TypeError("invalid trusted policy revision");}
  if (!Object.isFrozen(profile)) {throw new TypeError("trusted policy profile must be immutable");}
  const policyRevision = selected.policyRevision;
  const methods = exactStableDataRecord(outer, ["evaluateForAcceptance", "publishAndConsumeForDispatch", "observeDispatchConsumption", "settleDispatchConsumption"]);
  const owner = Object.freeze(Object.fromEntries(Object.keys(methods).map(key => [key, capturedMethod(outer, methods[key])]))) as unknown as OuterContainedTurnSecurityAcceptance;
  // Retained selectors are lookup identities only. Every dispatch check calls the actual current owner again.
  const selections = new Map<string, Readonly<{intent: Intent; constraintsDigest: string; decision: Decision}>>();
  const acceptance: Pick<ContainedTurnKernelSecurityPort, "authorizeForAcceptance" | "revalidateForDispatch"> = Object.freeze({
    async authorizeForAcceptance(input) {
      try {
        const value = authorityValue(input);
        const intent: Intent = Object.freeze({operationId: value.operationId, scope: Object.freeze({...value.scope, scopeDigest: containedTurnScopeDigest(value.scope)}),
          providerId: value.provider, intentDigest: containedTurnAcceptanceIntentDigestV1(value.intent), policyRevision});
        const outcome = await ownerValue(owner.evaluateForAcceptance(intent));
        if (outcome.status === "denied") {exact("RS denial", outcome, ["status"]); return {kind: "denied"};}
        if (outcome.status !== "allowed") {return {kind: "indeterminate", evidenceId: evidence("acceptance")};}
        exact("RS acceptance", outcome, ["status", "decision"]);
        const decision = checkDecision(outcome.decision, intent, value.constraintsDigest);
        const identity = selectionKey(value.operationId, value.scope);
        const prior = selections.get(identity);
        if (prior !== undefined && !same(prior.decision, decision)) {throw new TypeError("RS accepted selection changed");}
        selections.set(identity, Object.freeze({intent, constraintsDigest: value.constraintsDigest, decision}));
        return {kind: "allowed", acceptanceProofId: proof("acceptance", decision), authorityRevision: decision.policy.policyRevision,
          decisionDigest: parseContainedTurnCanonicalDigest(decision.decisionDigest), containmentPolicyDigest: parseContainedTurnCanonicalDigest(decision.policy.containmentPolicyDigest)};
      } catch {return {kind: "indeterminate", evidenceId: evidence("acceptance")};}
    },
    async revalidateForDispatch(input) {
      try {
        const value = authorityValue(input);
        const retained = selections.get(selectionKey(value.operationId, value.scope));
        if (retained === undefined || retained.decision.decisionDigest !== value.decisionDigest || policyRevision !== value.securityAuthorityRevision) {throw new TypeError("RS revalidation selector mismatch");}
        const outcome = await ownerValue(owner.evaluateForAcceptance(retained.intent));
        if (outcome.status === "denied") {exact("RS denial", outcome, ["status"]); return {kind: "prevented", preventionProofId: proof("revalidation-denied", retained.intent)};}
        if (outcome.status !== "allowed") {throw new TypeError("RS current policy unavailable");}
        exact("RS acceptance", outcome, ["status", "decision"]);
        const decision = checkDecision(outcome.decision, retained.intent, retained.constraintsDigest);
        if (!same(decision, retained.decision)) {throw new TypeError("RS current decision changed");}
        return {kind: "current", dispatchDecisionDigest: parseContainedTurnCanonicalDigest(decision.decisionDigest), proofId: proof("dispatch", decision)};
      } catch {return {kind: "indeterminate", evidenceId: evidence("revalidation")};}
    },
  });
  const authority = (consume: OuterContainedTurnRuntimeSecurityAuthority["consumeForDispatch"]): OuterContainedTurnRuntimeSecurityAuthority => Object.freeze<OuterContainedTurnRuntimeSecurityAuthority>({
    consumeForDispatch: consume,
    observeDispatchConsumption: input => securityConsumeOutcome(owner.observeDispatchConsumption(input), input),
    settleDispatchConsumption: input => securitySettlementOutcome(owner.settleDispatchConsumption(input), input),
  });
  const settlement = createContainedTurnRuntimeSecurityPort(acceptance, authority(async () => {throw new TypeError("publication required");}));
  return Object.freeze<ContainedTurnKernelSecurityPort>({...acceptance, settleConsumedGrant: settlement.settleConsumedGrant,
    async consumeForDispatch(input) {
      try {
        const {accepted, subject, bindingDigest} = acceptedAuthority(input);
        const vector = accepted.acceptedAuthorityVector;
        if (vector.securityAuthorityRevision !== policyRevision) {throw new TypeError("RS trusted selection mismatch");}
        const prepared: Preparation = Object.freeze({acceptance: Object.freeze({operationId: accepted.operationId,
          scope: Object.freeze({...accepted.scope, scopeDigest: containedTurnScopeDigest(accepted.scope)}), providerId: vector.adapterSnapshot.provider,
          intentDigest: accepted.intentDigest, policyRevision: vector.securityAuthorityRevision}), decisionDigest: vector.securityDecisionDigest,
          authorityGeneration: vector.operationAuthorityRevision, providerBindingDigest: bindingDigest,
          claimBindingDigest: subject.runtimeSecurityRequest.claimBindingDigest, requestDigest: subject.runtimeSecurityRequest.requestDigest,
          grantRequestId: subject.runtimeSecurityRequest.grantRequestId});
        return await createContainedTurnRuntimeSecurityPort(acceptance, authority(request => securityConsumeOutcome(owner.publishAndConsumeForDispatch(prepared, request), request))).consumeForDispatch({accepted, subject});
      } catch {return {kind: "indeterminate", evidenceId: evidence("consume")};}
    },
  });
};
