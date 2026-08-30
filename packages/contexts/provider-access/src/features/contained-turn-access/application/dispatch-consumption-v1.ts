import type { DispatchConsumptionDigest } from "./ports/outbound/dispatch-consumption-digest.js";
import type {
  DispatchConsumptionJournalEntry, DispatchConsumptionRepository, DispatchConsumptionTransaction,
} from "./ports/outbound/dispatch-consumption-repository.js";
import {
  canonicalJson, claimBindingDigestPayload, requestDigestPayload, snapshotDispatchControlTime, snapshotDispatchScope,
  type DispatchBindingHead, type DispatchConsumeCommand, type DispatchConsumeOutcome, type DispatchConsumedReceipt,
  type DispatchDisposition, type DispatchPreventedReason, type DispatchSettlementOutcome,
} from "../domain/dispatch-consumption.js";

export interface DispatchConsumptionUseCases {
  consume(command: DispatchConsumeCommand): Promise<DispatchConsumeOutcome>;
  observe(input: { readonly grantRequestId: string; readonly requestDigest: string; readonly scope: ReturnType<typeof snapshotDispatchScope> }): Promise<DispatchConsumeOutcome>;
  settle(input: { readonly consumptionDigest: string; readonly disposition: DispatchDisposition; readonly settlementRequestId: string }): Promise<DispatchSettlementOutcome>;
}
interface Dependencies { readonly digest: DispatchConsumptionDigest; readonly repository: DispatchConsumptionRepository }
const invalid = (): DispatchConsumeOutcome => Object.freeze({ kind: "invalid", reason: "invalid_request" });
const consumed = (receipt: DispatchConsumedReceipt): DispatchConsumeOutcome => Object.freeze({ kind: "consumed", receipt });
const prevented = (command: DispatchConsumeCommand, reason: DispatchPreventedReason, now: number, evidence: string): DispatchConsumeOutcome =>
  Object.freeze({ kind: "prevented", prevention: Object.freeze({
    grantRequestId: command.grantRequestId, observedAtControlTime: now, opaqueOwnerEvidenceRef: evidence,
    reason, requestDigest: command.requestDigest, scope: command.scope,
  }) });

const driftReason = (command: DispatchConsumeCommand, head: DispatchBindingHead): DispatchPreventedReason | undefined => {
  if (head.tenantId !== command.scope.tenantId || head.projectId !== command.scope.projectId || head.scopeDigest !== command.scope.scopeDigest) {return "scope_mismatch";}
  if (head.provider !== command.provider) {return "provider_mismatch";}
  if (head.revocation !== "active") {return "revoked";}
  if (head.availability !== "available") {return "unavailable";}
  if (head.accessRef !== command.binding.accessRef) {return "access_changed";}
  if (head.bindingRevision !== command.binding.bindingRevision) {return "revision_changed";}
  if (head.bindingDigest !== command.binding.bindingDigest) {return "binding_changed";}
  if (head.providerAccountRef !== command.binding.providerAccountRef) {return "account_changed";}
  if (head.providerRouteRef !== command.binding.providerRouteRef) {return "route_changed";}
  if (head.credentialGeneration !== command.binding.credentialGeneration) {return "credential_rotated";}
  if (head.credentialBindingRef !== command.binding.credentialBindingRef || head.credentialBindingDigest !== command.binding.credentialBindingDigest) {return "credential_changed";}
  if (head.acceptedAuthorityDigest !== command.binding.acceptedAuthorityDigest) {return "accepted_authority_changed";}
  if (head.authorityHeadDigest !== command.binding.authorityHeadDigest) {return "authority_head_changed";}
  return undefined;
};

const receiptFor = async (command: DispatchConsumeCommand, head: DispatchBindingHead, now: number, digest: DispatchConsumptionDigest) => {
  const unsigned = {
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
  return Object.freeze({ ...unsigned, consumptionDigest: await digest.digest(canonicalJson(unsigned)) });
};

const decideNewConsumption = async (
  command: DispatchConsumeCommand, transaction: DispatchConsumptionTransaction, dependencies: Dependencies,
): Promise<DispatchConsumeOutcome> => {
  const now = snapshotDispatchControlTime(await transaction.controlTime());
  const head = await transaction.findBindingHead();
  if (head === undefined) {return Object.freeze({ kind: "not_found" });}
  const drift = driftReason(command, head);
  if (drift !== undefined) {return prevented(command, drift, now, head.opaqueOwnerEvidenceRef);}
  if (now >= head.claimBeforeControlTime || now >= head.expiresAtControlTime) {return prevented(command, "expired", now, head.opaqueOwnerEvidenceRef);}
  if (await transaction.isBindingConsumed()) {return prevented(command, "already_consumed", now, head.opaqueOwnerEvidenceRef);}
  const expectedClaim = await dependencies.digest.digest(claimBindingDigestPayload(command));
  if (expectedClaim !== command.claimBindingDigest) {return prevented(command, "claim_binding_mismatch", now, head.opaqueOwnerEvidenceRef);}
  const receipt = await receiptFor(command, head, now, dependencies.digest);
  await transaction.markBindingConsumed(receipt);
  return consumed(receipt);
};

const consumeInTransaction = async (
  command: DispatchConsumeCommand, semanticDigest: string, transaction: DispatchConsumptionTransaction, dependencies: Dependencies,
): Promise<DispatchConsumeOutcome> => {
  const replay = await transaction.findGrantRequest();
  if (replay !== undefined) {
    if (replay.requestDigest !== semanticDigest) {return Object.freeze({ kind: "conflict", reason: "grant_request_digest_conflict" });}
    return command.requestDigest === semanticDigest ? replay.outcome : invalid();
  }
  const outcome = command.requestDigest === semanticDigest ? await decideNewConsumption(command, transaction, dependencies) : invalid();
  const entry: DispatchConsumptionJournalEntry = { outcome, requestDigest: semanticDigest, scope: command.scope };
  await transaction.saveGrantRequest(entry);
  return outcome;
};

const settleInTransaction = async (
  input: { readonly consumptionDigest: string; readonly disposition: DispatchDisposition; readonly settlementRequestId: string },
  transaction: DispatchConsumptionTransaction, dependencies: Dependencies,
): Promise<DispatchSettlementOutcome> => {
  const replay = await transaction.findSettlement();
  if (replay !== undefined) {
    if (replay.kind !== "settled") {return replay;}
    return replay.receipt.consumptionDigest === input.consumptionDigest && replay.receipt.disposition === input.disposition
      ? replay : Object.freeze({ kind: "conflict", reason: "settlement_request_conflict" });
  }
  if (await transaction.findConsumption() === undefined) {return Object.freeze({ kind: "not_found" });}
  if (await transaction.findSettlementByConsumption() !== undefined) {return Object.freeze({ kind: "conflict", reason: "settlement_request_conflict" });}
  const settledAtControlTime = snapshotDispatchControlTime(await transaction.controlTime());
  const unsigned = { ...input, settledAtControlTime };
  const outcome = Object.freeze({ kind: "settled" as const, receipt: Object.freeze({
    ...unsigned, settlementDigest: await dependencies.digest.digest(canonicalJson(unsigned)),
  }) });
  await transaction.saveSettlement(outcome);
  return outcome;
};

export const createDispatchConsumptionUseCases = (dependencies: Dependencies): DispatchConsumptionUseCases => Object.freeze({
  async consume(command: DispatchConsumeCommand) {
    const { requestDigest: _claimedDigest, ...semanticRequest } = command;
    const semanticDigest = await dependencies.digest.digest(requestDigestPayload(semanticRequest));
    return dependencies.repository.transact({
      grantRequestId: command.grantRequestId, kind: "consume", provider: command.provider, scopeDigest: command.scope.scopeDigest,
    }, transaction => consumeInTransaction(command, semanticDigest, transaction, dependencies));
  },
  async observe(input: { readonly grantRequestId: string; readonly requestDigest: string; readonly scope: ReturnType<typeof snapshotDispatchScope> }) {
    const entry = await dependencies.repository.observeGrantRequest(input);
    if (entry === undefined) {return Object.freeze({ kind: "not_found" });}
    if (entry.scope.scopeDigest !== input.scope.scopeDigest || entry.scope.tenantId !== input.scope.tenantId || entry.scope.projectId !== input.scope.projectId) {
      return Object.freeze({ kind: "not_found" });
    }
    return entry.requestDigest === input.requestDigest ? entry.outcome : Object.freeze({ kind: "conflict", reason: "grant_request_digest_conflict" });
  },
  async settle(input: { readonly consumptionDigest: string; readonly disposition: DispatchDisposition; readonly settlementRequestId: string }) {
    return dependencies.repository.transact({
      consumptionDigest: input.consumptionDigest, kind: "settle", settlementRequestId: input.settlementRequestId,
    }, transaction => settleInTransaction(input, transaction, dependencies));
  },
});
