import type { DispatchConsumptionClock } from "./ports/outbound/dispatch-consumption-clock.js";
import type { DispatchConsumptionDigest } from "./ports/outbound/dispatch-consumption-digest.js";
import type { DispatchConsumptionRepository } from "./ports/outbound/dispatch-consumption-repository.js";
import {
  canonicalJson, claimBindingDigestPayload, requestDigestPayload, snapshotDispatchScope,
  type DispatchBindingHead, type DispatchConsumeCommand, type DispatchConsumeOutcome, type DispatchConsumedReceipt,
  type DispatchDisposition, type DispatchPreventedReason, type DispatchSettlementOutcome,
} from "../domain/dispatch-consumption.js";

export interface DispatchConsumptionUseCases {
  consume(command: DispatchConsumeCommand): Promise<DispatchConsumeOutcome>;
  observe(input: { readonly grantRequestId: string; readonly requestDigest: string; readonly scope: ReturnType<typeof snapshotDispatchScope> }): Promise<DispatchConsumeOutcome>;
  settle(input: { readonly consumptionDigest: string; readonly disposition: DispatchDisposition; readonly settlementRequestId: string }): Promise<DispatchSettlementOutcome>;
}

const consumed = (receipt: DispatchConsumedReceipt): DispatchConsumeOutcome => Object.freeze({ kind: "consumed", receipt });
const prevented = (command: DispatchConsumeCommand, reason: DispatchPreventedReason, now: number, evidence: string): DispatchConsumeOutcome =>
  Object.freeze({ kind: "prevented", prevention: Object.freeze({
    grantRequestId: command.grantRequestId, observedAtControlTime: now, opaqueOwnerEvidenceRef: evidence,
    reason, requestDigest: command.requestDigest, scope: command.scope,
  }) });

const driftReason = (command: DispatchConsumeCommand, head: DispatchBindingHead): DispatchPreventedReason | undefined => {
  if (head.tenantId !== command.scope.tenantId || head.projectId !== command.scope.projectId || head.scopeDigest !== command.scope.scopeDigest) return "scope_mismatch";
  if (head.provider !== command.provider) return "provider_mismatch";
  if (head.revocation !== "active") return "revoked";
  if (head.availability !== "available") return "unavailable";
  if (head.accessRef !== command.binding.accessRef) return "access_changed";
  if (head.bindingRevision !== command.binding.bindingRevision) return "revision_changed";
  if (head.bindingDigest !== command.binding.bindingDigest) return "binding_changed";
  if (head.providerAccountRef !== command.binding.providerAccountRef) return "account_changed";
  if (head.providerRouteRef !== command.binding.providerRouteRef) return "route_changed";
  if (head.credentialGeneration !== command.binding.credentialGeneration) return "credential_rotated";
  if (head.credentialBindingRef !== command.binding.credentialBindingRef || head.credentialBindingDigest !== command.binding.credentialBindingDigest) return "credential_changed";
  if (head.acceptedAuthorityDigest !== command.binding.acceptedAuthorityDigest) return "accepted_authority_changed";
  if (head.authorityHeadDigest !== command.binding.authorityHeadDigest) return "authority_head_changed";
  return undefined;
};

export const createDispatchConsumptionUseCases = (dependencies: {
  readonly clock: DispatchConsumptionClock;
  readonly digest: DispatchConsumptionDigest;
  readonly repository: DispatchConsumptionRepository;
}): DispatchConsumptionUseCases => Object.freeze({
  async consume(command: DispatchConsumeCommand): Promise<DispatchConsumeOutcome> {
    return dependencies.repository.transact({ provider: command.provider, scopeDigest: command.scope.scopeDigest }, async transaction => {
      const replay = transaction.findGrantRequest(command.grantRequestId);
      if (replay !== undefined) {
        if (replay.scope.scopeDigest !== command.scope.scopeDigest || replay.scope.tenantId !== command.scope.tenantId || replay.scope.projectId !== command.scope.projectId) {
          return Object.freeze({ kind: "not_found" as const });
        }
        return replay.requestDigest === command.requestDigest ? replay.outcome
          : Object.freeze({ kind: "conflict" as const, reason: "grant_request_digest_conflict" as const });
      }
      const now = dependencies.clock.now();
      const { requestDigest: _requestDigest, ...unsigned } = command;
      const expectedRequestDigest = await dependencies.digest.digest(requestDigestPayload(unsigned));
      const head = transaction.findBindingHead();
      if (head === undefined) {
        const outcome = Object.freeze({ kind: "not_found" as const });
        transaction.saveGrantRequest(command.grantRequestId, { outcome, requestDigest: command.requestDigest, scope: command.scope });
        return outcome;
      }
      let outcome: DispatchConsumeOutcome;
      const drift = driftReason(command, head);
      const expectedClaimBindingDigest = await dependencies.digest.digest(claimBindingDigestPayload(command));
      if (drift !== undefined) outcome = prevented(command, drift, now, head.opaqueOwnerEvidenceRef);
      else if (now >= head.claimBeforeControlTime || now >= head.expiresAtControlTime) outcome = prevented(command, "expired", now, head.opaqueOwnerEvidenceRef);
      else if (transaction.isBindingConsumed()) outcome = prevented(command, "already_consumed", now, head.opaqueOwnerEvidenceRef);
      else if (expectedClaimBindingDigest !== command.claimBindingDigest) {
        outcome = prevented(command, "claim_binding_mismatch", now, head.opaqueOwnerEvidenceRef);
      } else if (expectedRequestDigest !== command.requestDigest) outcome = prevented(command, "request_digest_mismatch", now, head.opaqueOwnerEvidenceRef);
      else {
        const receiptWithoutDigest = {
          acceptedAuthorityDigest: head.acceptedAuthorityDigest, accessRef: head.accessRef,
          authorityHeadDigestAtConsumption: head.authorityHeadDigest, bindingDigest: head.bindingDigest,
          bindingRevision: head.bindingRevision, claimBeforeControlTime: head.claimBeforeControlTime,
          claimBindingDigest: command.claimBindingDigest, consumedAtControlTime: now,
          credentialBindingDigest: head.credentialBindingDigest, credentialBindingRef: head.credentialBindingRef,
          credentialGeneration: head.credentialGeneration, grantRequestId: command.grantRequestId,
          opaqueOwnerEvidenceRef: head.opaqueOwnerEvidenceRef, operationId: command.operationId,
          provider: head.provider, providerAccountRef: head.providerAccountRef, providerRouteRef: head.providerRouteRef,
          purpose: command.purpose, requestDigest: command.requestDigest, scope: snapshotDispatchScope(command.scope),
        } as const;
        const receipt = Object.freeze({
          ...receiptWithoutDigest,
          consumptionDigest: await dependencies.digest.digest(canonicalJson(receiptWithoutDigest)),
        });
        transaction.markBindingConsumed(receipt);
        outcome = consumed(receipt);
      }
      transaction.saveGrantRequest(command.grantRequestId, { outcome, requestDigest: command.requestDigest, scope: command.scope });
      return outcome;
    });
  },
  async observe(input: { readonly grantRequestId: string; readonly requestDigest: string; readonly scope: ReturnType<typeof snapshotDispatchScope> }): Promise<DispatchConsumeOutcome> {
    const entry = await dependencies.repository.observeGrantRequest(input);
    if (entry === undefined) return Object.freeze({ kind: "not_found" });
    if (entry.scope.scopeDigest !== input.scope.scopeDigest || entry.scope.tenantId !== input.scope.tenantId || entry.scope.projectId !== input.scope.projectId) {
      return Object.freeze({ kind: "not_found" });
    }
    if (entry.requestDigest !== input.requestDigest) {
      return Object.freeze({ kind: "conflict", reason: "grant_request_digest_conflict" });
    }
    return entry.outcome;
  },
  async settle(input: { readonly consumptionDigest: string; readonly disposition: DispatchDisposition; readonly settlementRequestId: string }): Promise<DispatchSettlementOutcome> {
    return dependencies.repository.transact({}, async transaction => {
      const replay = transaction.findSettlement(input.settlementRequestId);
      if (replay !== undefined) {
        if (replay.kind !== "settled") return replay;
        return replay.receipt.consumptionDigest === input.consumptionDigest && replay.receipt.disposition === input.disposition
          ? replay
          : Object.freeze({ kind: "conflict" as const, reason: "settlement_request_conflict" as const });
      }
      const consumption = transaction.findConsumptionByDigest(input.consumptionDigest);
      if (consumption === undefined) return Object.freeze({ kind: "not_found" });
      if (transaction.findSettlementByConsumption(input.consumptionDigest) !== undefined) {
        return Object.freeze({ kind: "conflict", reason: "settlement_request_conflict" });
      }
      const settledAtControlTime = dependencies.clock.now();
      const unsigned = { consumptionDigest: input.consumptionDigest, disposition: input.disposition, settledAtControlTime, settlementRequestId: input.settlementRequestId };
      const outcome = Object.freeze({ kind: "settled" as const, receipt: Object.freeze({
        ...unsigned, settlementDigest: await dependencies.digest.digest(canonicalJson(unsigned)),
      }) });
      transaction.saveSettlement(input.settlementRequestId, outcome);
      return outcome;
    });
  },
});
