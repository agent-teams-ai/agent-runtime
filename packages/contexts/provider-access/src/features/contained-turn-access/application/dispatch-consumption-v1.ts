import type { DispatchConsumptionDigest } from "./ports/outbound/dispatch-consumption-digest.js";
import type {
  DispatchConsumptionJournalEntry, DispatchConsumptionRepository, DispatchConsumptionTransaction, DispatchConsumptionTransactionSelector,
} from "./ports/outbound/dispatch-consumption-repository.js";
import {
  journalMatchesCommand, verifiedBindingHead, verifiedConsumption, verifiedDigest, verifiedJournalEntry, verifiedSettlement,
} from "./persistence-validation.js";
import {
  canonicalJson, claimBindingDigestPayload, journalDigestPayload, requestDigestPayload, snapshotDispatchControlTime, snapshotDispatchScope,
  type DispatchBindingHead, type DispatchConsumeCommand, type DispatchConsumeOutcome, type DispatchConsumedReceipt,
  type DispatchExpectationValue, type DispatchPreventedReason, type DispatchProvider,
  type DispatchScopeValue, type DispatchSettlementCommand, type DispatchSettlementOutcome,
} from "../domain/dispatch-consumption.js";

export interface DispatchConsumptionUseCases {
  consume(command: DispatchConsumeCommand): Promise<DispatchConsumeOutcome>;
  observe(input: { readonly grantRequestId: string; readonly provider: DispatchProvider; readonly requestDigest: string; readonly scope: DispatchScopeValue }): Promise<DispatchConsumeOutcome>;
  settle(input: DispatchSettlementCommand): Promise<DispatchSettlementOutcome>;
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
const headMatches = (head: DispatchBindingHead, expected: DispatchExpectationValue): boolean =>
  head.acceptedAuthorityDigest === expected.acceptedAuthorityDigest && head.accessRef === expected.accessRef &&
  head.authorityHeadDigest === expected.authorityHeadDigest && head.bindingDigest === expected.bindingDigest &&
  head.bindingRevision === expected.bindingRevision && head.credentialBindingDigest === expected.credentialBindingDigest &&
  head.credentialBindingRef === expected.credentialBindingRef && head.credentialGeneration === expected.credentialGeneration &&
  head.providerAccountRef === expected.providerAccountRef && head.providerRouteRef === expected.providerRouteRef;
const receiptMatches = (receipt: DispatchConsumedReceipt, expected: DispatchExpectationValue): boolean =>
  receipt.acceptedAuthorityDigest === expected.acceptedAuthorityDigest && receipt.accessRef === expected.accessRef &&
  receipt.authorityHeadDigestAtConsumption === expected.authorityHeadDigest && receipt.bindingDigest === expected.bindingDigest &&
  receipt.bindingRevision === expected.bindingRevision && receipt.credentialBindingDigest === expected.credentialBindingDigest &&
  receipt.credentialBindingRef === expected.credentialBindingRef && receipt.credentialGeneration === expected.credentialGeneration &&
  receipt.providerAccountRef === expected.providerAccountRef && receipt.providerRouteRef === expected.providerRouteRef;
const settlementReplayMatches = (
  receipt: Extract<DispatchSettlementOutcome, { readonly kind: "settled" }>["receipt"], input: DispatchSettlementCommand,
): boolean => canonicalJson({
  consumptionDigest: receipt.consumptionDigest, disposition: receipt.disposition, expectedBinding: receipt.expectedBinding,
  operationId: receipt.operationId, provider: receipt.provider, scope: receipt.scope,
  settlementRequestId: receipt.settlementRequestId,
}) === canonicalJson(input);

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
  return Object.freeze({ ...unsigned, consumptionDigest: await verifiedDigest(digest, canonicalJson(unsigned)) });
};

const decideNewConsumption = async (
  command: DispatchConsumeCommand, transaction: DispatchConsumptionTransaction, dependencies: Dependencies,
): Promise<DispatchConsumeOutcome> => {
  const now = snapshotDispatchControlTime(await transaction.controlTime());
  const rawHead = await transaction.findBindingHead();
  if (rawHead === undefined) {return Object.freeze({ kind: "not_found" });}
  const head = verifiedBindingHead(rawHead, command);
  const drift = driftReason(command, head);
  if (drift !== undefined) {return prevented(command, drift, now, head.opaqueOwnerEvidenceRef);}
  if (now >= head.claimBeforeControlTime || now >= head.expiresAtControlTime) {return prevented(command, "expired", now, head.opaqueOwnerEvidenceRef);}
  const consumedState = await transaction.isBindingConsumed();
  if (typeof consumedState !== "boolean") {throw new TypeError("consumption state is invalid");}
  if (consumedState) {return prevented(command, "already_consumed", now, head.opaqueOwnerEvidenceRef);}
  const expectedClaim = await verifiedDigest(dependencies.digest, claimBindingDigestPayload(command));
  if (expectedClaim !== command.claimBindingDigest) {return prevented(command, "claim_binding_mismatch", now, head.opaqueOwnerEvidenceRef);}
  const receipt = await receiptFor(command, head, now, dependencies.digest);
  if (await transaction.markBindingConsumed(receipt) !== undefined) {throw new TypeError("repository write acknowledgement is invalid");}
  return consumed(receipt);
};

const consumeInTransaction = async (
  command: DispatchConsumeCommand, semanticDigest: string, transaction: DispatchConsumptionTransaction, dependencies: Dependencies,
): Promise<DispatchConsumeOutcome> => {
  const rawReplay = await transaction.findGrantRequest();
  if (rawReplay !== undefined) {
    const replay = await verifiedJournalEntry(rawReplay, command, dependencies.digest);
    if (replay.requestDigest !== semanticDigest) {return Object.freeze({ kind: "conflict", reason: "grant_request_digest_conflict" });}
    if (!journalMatchesCommand(replay, command)) {throw new TypeError("journal entry does not bind the command");}
    return command.requestDigest === semanticDigest ? replay.outcome : invalid();
  }
  const outcome = command.requestDigest === semanticDigest ? await decideNewConsumption(command, transaction, dependencies) : invalid();
  const unsignedEntry = Object.freeze({
    binding: command.binding, claimBindingDigest: command.claimBindingDigest, grantRequestId: command.grantRequestId,
    operationId: command.operationId, outcome, provider: command.provider, purpose: command.purpose,
    requestDigest: semanticDigest, scope: command.scope,
  });
  const entry: DispatchConsumptionJournalEntry = Object.freeze({
    ...unsignedEntry, journalDigest: await verifiedDigest(dependencies.digest, journalDigestPayload(unsignedEntry)),
  });
  if (await transaction.saveGrantRequest(entry) !== undefined) {throw new TypeError("repository write acknowledgement is invalid");}
  return outcome;
};

const settleInTransaction = async (
  input: DispatchSettlementCommand,
  selector: Extract<DispatchConsumptionTransactionSelector, { readonly kind: "settle" }>, transaction: DispatchConsumptionTransaction, dependencies: Dependencies,
): Promise<DispatchSettlementOutcome> => {
  const rawReplay = await transaction.findSettlement();
  if (rawReplay !== undefined) {
    const replay = await verifiedSettlement(rawReplay, selector, dependencies.digest);
    if (replay.kind !== "settled") {return replay;}
    return settlementReplayMatches(replay.receipt, input) ? replay :
      Object.freeze({ kind: "conflict", reason: "settlement_request_conflict" });
  }
  const rawConsumption = await transaction.findConsumption();
  if (rawConsumption === undefined) {return Object.freeze({ kind: "not_found" });}
  const consumption = await verifiedConsumption(rawConsumption, selector, dependencies.digest);
  const rawHead = await transaction.findBindingHead();
  if (rawHead === undefined) {return Object.freeze({ kind: "conflict", reason: "settlement_request_conflict" });}
  const head = verifiedBindingHead(rawHead, selector);
  if (!headMatches(head, input.expectedBinding) || consumption.operationId !== input.operationId ||
    consumption.provider !== input.provider || consumption.scope.tenantId !== input.scope.tenantId ||
    consumption.scope.projectId !== input.scope.projectId || consumption.scope.scopeDigest !== input.scope.scopeDigest ||
    !receiptMatches(consumption, input.expectedBinding)) {
    return Object.freeze({ kind: "conflict", reason: "settlement_request_conflict" });
  }
  const rawExisting = await transaction.findSettlementByConsumption();
  if (rawExisting !== undefined) {
    await verifiedSettlement(rawExisting, selector, dependencies.digest, false);
    return Object.freeze({ kind: "conflict", reason: "settlement_request_conflict" });
  }
  const settledAtControlTime = snapshotDispatchControlTime(await transaction.controlTime());
  const unsigned = { ...input, settledAtControlTime };
  const outcome = Object.freeze({ kind: "settled" as const, receipt: Object.freeze({
    ...unsigned, settlementDigest: await verifiedDigest(dependencies.digest, canonicalJson(unsigned)),
  }) });
  if (await transaction.saveSettlement(outcome) !== undefined) {throw new TypeError("repository write acknowledgement is invalid");}
  return outcome;
};

export const createDispatchConsumptionUseCases = (dependencies: Dependencies): DispatchConsumptionUseCases => Object.freeze({
  async consume(command: DispatchConsumeCommand) {
    const { requestDigest: _claimedDigest, ...semanticRequest } = command;
    const semanticDigest = await verifiedDigest(dependencies.digest, requestDigestPayload(semanticRequest));
    if (command.requestDigest !== semanticDigest) {return invalid();}
    let decision: DispatchConsumeOutcome | undefined;
    const returned = await dependencies.repository.transact({
      grantRequestId: command.grantRequestId, kind: "consume", provider: command.provider, scope: command.scope,
    }, async transaction => {
      decision = await consumeInTransaction(command, semanticDigest, transaction, dependencies); return decision;
    });
    if (decision === undefined || returned !== decision) {throw new TypeError("repository substituted the transaction result");}
    return decision;
  },
  async observe(input: { readonly grantRequestId: string; readonly provider: DispatchProvider; readonly requestDigest: string; readonly scope: DispatchScopeValue }) {
    const rawEntry = await dependencies.repository.observeGrantRequest(input);
    if (rawEntry === undefined) {return Object.freeze({ kind: "not_found" });}
    const entry = await verifiedJournalEntry(rawEntry, input, dependencies.digest);
    return entry.requestDigest === input.requestDigest ? entry.outcome : Object.freeze({ kind: "conflict", reason: "grant_request_digest_conflict" });
  },
  async settle(input: DispatchSettlementCommand) {
    const selector = Object.freeze({
      consumptionDigest: input.consumptionDigest, expectedAuthorityHeadDigest: input.expectedBinding.authorityHeadDigest,
      kind: "settle" as const, operationId: input.operationId, provider: input.provider, scope: input.scope,
      settlementRequestId: input.settlementRequestId,
    });
    let decision: DispatchSettlementOutcome | undefined;
    const returned = await dependencies.repository.transact(selector, async transaction => {
      decision = await settleInTransaction(input, selector, transaction, dependencies); return decision;
    });
    if (decision === undefined || returned !== decision) {throw new TypeError("repository substituted the transaction result");}
    return decision;
  },
});
