import type { ContainedTurnKernelSecurityPort } from "../application/ports/outbound/contained-turn-ports.js";
import { digestContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";
import {
  CONTAINED_TURN_OWNER_DISPATCH_PURPOSE,
} from "../domain/contained-turn-dispatch-authority.js";
import { containedTurnIdentity } from "../domain/contained-turn-identities.js";
import { normalizeContainedTurnConsumedGrantReceipt } from "./dispatch-grant-anti-corruption.js";

type SecuritySubject = Parameters<ContainedTurnKernelSecurityPort["consumeForDispatch"]>[0]["subject"];
type SecurityScope = Readonly<SecuritySubject["scope"] & { readonly scopeDigest: string }>;
type SecurityConsumeInput = Readonly<{
  purpose: typeof CONTAINED_TURN_OWNER_DISPATCH_PURPOSE; operationId: string; scope: SecurityScope;
  grantRequestId: string; requestDigest: string; providerId: string; authorityGeneration: string;
  providerBindingDigest: string; claimBindingDigest: string; acceptedAuthorityDigest: string;
  expectedAuthorityHeadDigest: string; expectedAuthorityRevision: string;
  expectedConstraintsDigest: string; expectedContainmentPolicyDigest: string;
}>;
interface SecurityReceipt {
  readonly contractVersion: "contained-turn-dispatch-consumption/v1";
  readonly purpose: typeof CONTAINED_TURN_OWNER_DISPATCH_PURPOSE; readonly operationId: string;
  readonly scope: SecurityScope; readonly grantRequestId: string; readonly requestDigest: string;
  readonly providerId: string; readonly authorityGeneration: string; readonly providerBindingDigest: string;
  readonly claimBindingDigest: string; readonly acceptedAuthorityDigest: string;
  readonly authorityHeadDigestAtConsumption: string; readonly authorityRevision: string;
  readonly constraintsDigest: string; readonly containmentPolicyDigest: string; readonly consumptionDigest: string;
  readonly claimBeforeControlTime: number; readonly consumedAtControlTime: number; readonly ownerEvidenceRef: string;
}
type SecurityConsumeOutcome =
  | { readonly status: "consumed"; readonly receipt: SecurityReceipt; readonly lifecycleState?: "consumed_pending" | "claim_committed" | "abandoned_without_claim" }
  | { readonly status: "prevented"; readonly evidence: unknown }
  | { readonly status: "not_found" | "conflict" | "indeterminate"; readonly reason?: string };

/** Exact structural view of Runtime Security ContainedTurnDispatchAuthorityV1. */
export interface OuterContainedTurnRuntimeSecurityAuthority {
  consumeForDispatch(input: SecurityConsumeInput): Promise<SecurityConsumeOutcome>;
  observeDispatchConsumption(input: SecurityConsumeInput): Promise<SecurityConsumeOutcome>;
  settleDispatchConsumption(input: Readonly<{
    scope: SecurityScope; operationId: string; providerId: string; authorityGeneration: string;
    grantRequestId: string; settlementRequestId: string; consumptionDigest: string;
    disposition: "abandoned_without_claim" | "claim_committed";
  }>): Promise<Readonly<{ status: "settled"; receipt: unknown } | { status: "invalid_request" | "not_found" | "conflict" | "indeterminate"; reason?: string }>>;
}

const evidenceId = (phase: "consume" | "settle", value: unknown) => containedTurnIdentity(
  "evidence", `evidence:runtime-security:${phase}:${digestContainedTurnCanonicalValue(value as never)}`,
);
const preventionProofId = (value: unknown) => containedTurnIdentity(
  "proof", `proof:runtime-security:dispatch:${digestContainedTurnCanonicalValue(value as never)}`,
);

/** Real ACL to the Runtime Security V1 dispatch authority, preserving its separate ownership. */
export const createContainedTurnRuntimeSecurityPort = (
  legacy: Pick<ContainedTurnKernelSecurityPort, "authorizeForAcceptance" | "revalidateForDispatch">,
  outer: OuterContainedTurnRuntimeSecurityAuthority,
): ContainedTurnKernelSecurityPort => {
  const port: ContainedTurnKernelSecurityPort = {
  ...legacy,
  async consumeForDispatch({ subject }) {
    const expected = subject.runtimeSecurityExpectation;
    const request: SecurityConsumeInput = Object.freeze({
      acceptedAuthorityDigest: expected.acceptedAuthorityDigest,
      authorityGeneration: expected.authorityGeneration,
      claimBindingDigest: subject.runtimeSecurityRequest.claimBindingDigest,
      expectedAuthorityHeadDigest: expected.authorityHeadDigest,
      expectedAuthorityRevision: expected.authorityRevision,
      expectedConstraintsDigest: expected.constraintsDigest,
      expectedContainmentPolicyDigest: expected.containmentPolicyDigest,
      grantRequestId: subject.runtimeSecurityRequest.grantRequestId,
      operationId: subject.operationId, providerBindingDigest: expected.providerBindingDigest,
      providerId: expected.providerId, purpose: CONTAINED_TURN_OWNER_DISPATCH_PURPOSE,
      requestDigest: subject.runtimeSecurityRequest.requestDigest,
      scope: Object.freeze({ ...subject.scope, scopeDigest: subject.scopeDigest }),
    });
    let outcome: SecurityConsumeOutcome;
    try {outcome = await outer.consumeForDispatch(request);} catch {return { evidenceId: evidenceId("consume", request), kind: "indeterminate" };}
    if (outcome.status === "indeterminate") {
      try {outcome = await outer.observeDispatchConsumption(request);} catch {return { evidenceId: evidenceId("consume", request), kind: "indeterminate" };}
    }
    if (outcome.status === "consumed") {
      const receipt = outcome.receipt;
      return { kind: "consumed", receipt: normalizeContainedTurnConsumedGrantReceipt("runtime_security", subject, {
        authorityFacts: Object.freeze({
          acceptedAuthorityDigest: receipt.acceptedAuthorityDigest,
          authorityGeneration: receipt.authorityGeneration,
          authorityHeadDigest: receipt.authorityHeadDigestAtConsumption,
          authorityRevision: receipt.authorityRevision,
          constraintsDigest: receipt.constraintsDigest,
          containmentPolicyDigest: receipt.containmentPolicyDigest,
          providerBindingDigest: receipt.providerBindingDigest,
          providerId: receipt.providerId,
        }),
        claimBeforeControlTime: receipt.claimBeforeControlTime,
        claimBindingDigest: receipt.claimBindingDigest as never,
        consumedAtControlTime: receipt.consumedAtControlTime,
        consumptionDigest: receipt.consumptionDigest,
        grantRequestId: receipt.grantRequestId,
        operationId: receipt.operationId as never,
        ownerEvidenceRef: receipt.ownerEvidenceRef,
        provider: subject.provider,
        purpose: receipt.purpose,
        requestDigest: receipt.requestDigest as never,
        scope: receipt.scope as never,
      }) };
    }
    if (outcome.status === "prevented") {return { kind: "prevented", preventionProofId: preventionProofId(outcome.evidence) };}
    return { evidenceId: evidenceId("consume", outcome), kind: "indeterminate" };
  },
  async settleConsumedGrant(input) {
    const receipt = input.receipt;
    try {
      const outcome = await outer.settleDispatchConsumption({
        authorityGeneration: receipt.authorityFacts.authorityGeneration,
        consumptionDigest: receipt.consumptionDigest, disposition: input.disposition,
        grantRequestId: receipt.grantRequestId, operationId: receipt.operationId,
        providerId: receipt.authorityFacts.providerId, scope: receipt.scope,
        settlementRequestId: input.settlementRequestId,
      });
      return outcome.status === "settled" ? { kind: "settled" } : { evidenceId: evidenceId("settle", { input, outcome }), kind: "indeterminate" };
    } catch {return { evidenceId: evidenceId("settle", input), kind: "indeterminate" };}
  },
  };
  return Object.freeze(port);
};
