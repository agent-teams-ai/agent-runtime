import type { DispatchConsumptionDigest } from "./ports/outbound/dispatch-consumption-digest.js";
import type { DispatchConsumptionJournalEntry, DispatchConsumptionTransactionSelector } from "./ports/outbound/dispatch-consumption-repository.js";
import {
  consumptionDigestPayload, exactDispatchDataRecord, requestDigestPayload, settlementDigestPayload, snapshotDispatchBindingHead,
  snapshotDispatchConsumeOutcome, snapshotDispatchConsumedReceipt, snapshotDispatchDigest, snapshotDispatchId,
  snapshotDispatchExpectation, snapshotDispatchScope, snapshotDispatchSettlementOutcome, type DispatchBindingHead, type DispatchConsumeCommand,
  type DispatchConsumedReceipt, type DispatchProvider, type DispatchScopeValue, type DispatchSettlementCommand,
  type DispatchSettlementOutcome,
} from "../domain/dispatch-consumption.js";

const sameScope = (left: DispatchScopeValue, right: DispatchScopeValue): boolean =>
  left.tenantId === right.tenantId && left.projectId === right.projectId && left.scopeDigest === right.scopeDigest;

export const verifiedDigest = async (digest: DispatchConsumptionDigest, payload: string): Promise<string> => {
  const value = snapshotDispatchDigest("digest result", await digest.digest(payload));
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {throw new TypeError("digest result is not canonical SHA-256");}
  return value;
};

export const verifiedBindingHead = (
  value: unknown, selector: { readonly provider: DispatchProvider; readonly scope: DispatchScopeValue },
): DispatchBindingHead => {
  const head = snapshotDispatchBindingHead(value as DispatchBindingHead);
  if (head.provider !== selector.provider || !sameScope(head, selector.scope)) {throw new TypeError("binding head is foreign to the selector");}
  return head;
};

export const verifiedConsumption = async (
  value: unknown, selector: Extract<DispatchConsumptionTransactionSelector, { readonly kind: "settle" }>, digest: DispatchConsumptionDigest,
): Promise<DispatchConsumedReceipt> => {
  const receipt = snapshotDispatchConsumedReceipt(value);
  if (receipt.consumptionDigest !== selector.consumptionDigest || receipt.operationId !== selector.operationId ||
    receipt.provider !== selector.provider || !sameScope(receipt.scope, selector.scope)) {
    throw new TypeError("consumption receipt is foreign to the selector");
  }
  if (await verifiedDigest(digest, consumptionDigestPayload(receipt)) !== receipt.consumptionDigest) {throw new TypeError("consumption digest is corrupt");}
  return receipt;
};

const receiptIdentityMatches = (receipt: DispatchConsumedReceipt, entry: DispatchConsumptionJournalEntry): boolean =>
  receipt.grantRequestId === entry.grantRequestId && receipt.operationId === entry.operationId && receipt.provider === entry.provider &&
  receipt.purpose === entry.purpose && receipt.claimBindingDigest === entry.claimBindingDigest && receipt.requestDigest === entry.requestDigest &&
  sameScope(receipt.scope, entry.scope);

const receiptBindingMatches = (receipt: DispatchConsumedReceipt, entry: DispatchConsumptionJournalEntry): boolean =>
  receipt.acceptedAuthorityDigest === entry.binding.acceptedAuthorityDigest && receipt.accessRef === entry.binding.accessRef &&
  receipt.authorityHeadDigestAtConsumption === entry.binding.authorityHeadDigest && receipt.bindingDigest === entry.binding.bindingDigest &&
  receipt.bindingRevision === entry.binding.bindingRevision && receipt.credentialBindingDigest === entry.binding.credentialBindingDigest &&
  receipt.credentialBindingRef === entry.binding.credentialBindingRef && receipt.credentialGeneration === entry.binding.credentialGeneration &&
  receipt.providerAccountRef === entry.binding.providerAccountRef && receipt.providerRouteRef === entry.binding.providerRouteRef;

export const verifiedJournalEntry = async (
  value: unknown,
  selector: { readonly grantRequestId: string; readonly provider: DispatchProvider; readonly scope: DispatchScopeValue },
  digest: DispatchConsumptionDigest,
): Promise<DispatchConsumptionJournalEntry> => {
  const data = exactDispatchDataRecord("journal entry", value, [
    "binding", "claimBindingDigest", "grantRequestId", "operationId", "outcome", "provider", "purpose", "requestDigest", "scope",
  ]);
  const provider = data.provider;
  if (provider !== "claude" && provider !== "codex") {throw new TypeError("journal provider is invalid");}
  if (data.purpose !== "contained-turn.provider-dispatch/v1") {throw new TypeError("journal purpose is invalid");}
  const entry = Object.freeze({
    binding: snapshotDispatchExpectation(data.binding as never), claimBindingDigest: snapshotDispatchDigest("claimBindingDigest", data.claimBindingDigest),
    grantRequestId: snapshotDispatchId("grantRequestId", data.grantRequestId), operationId: snapshotDispatchId("operationId", data.operationId),
    outcome: snapshotDispatchConsumeOutcome(data.outcome), provider, purpose: data.purpose,
    requestDigest: snapshotDispatchDigest("requestDigest", data.requestDigest),
    scope: snapshotDispatchScope(data.scope as DispatchScopeValue),
  });
  if (entry.grantRequestId !== selector.grantRequestId || entry.provider !== selector.provider || !sameScope(entry.scope, selector.scope)) {
    throw new TypeError("journal entry is foreign to the selector");
  }
  const { requestDigest: _requestDigest, ...semantic } = entry;
  const { outcome: _outcome, ...commandSemantic } = semantic;
  if (await verifiedDigest(digest, requestDigestPayload(commandSemantic)) !== entry.requestDigest) {throw new TypeError("journal request digest is corrupt");}
  if (entry.outcome.kind === "consumed") {
    const receipt = entry.outcome.receipt;
    if (!receiptIdentityMatches(receipt, entry) || !receiptBindingMatches(receipt, entry) ||
      await verifiedDigest(digest, consumptionDigestPayload(receipt)) !== receipt.consumptionDigest) {
      throw new TypeError("journal consumption binding or digest is corrupt");
    }
  } else if (entry.outcome.kind === "prevented" &&
    (entry.outcome.prevention.grantRequestId !== entry.grantRequestId || entry.outcome.prevention.requestDigest !== entry.requestDigest ||
      !sameScope(entry.outcome.prevention.scope, entry.scope))) {
    throw new TypeError("journal prevention binding is corrupt");
  }
  return entry;
};

export const journalMatchesCommand = (entry: DispatchConsumptionJournalEntry, command: DispatchConsumeCommand): boolean =>
  entry.grantRequestId === command.grantRequestId && entry.operationId === command.operationId && entry.provider === command.provider &&
  entry.purpose === command.purpose && entry.claimBindingDigest === command.claimBindingDigest && sameScope(entry.scope, command.scope) &&
  JSON.stringify(entry.binding) === JSON.stringify(command.binding);

export const verifiedSettlement = async (
  value: unknown, selector: Extract<DispatchConsumptionTransactionSelector, { readonly kind: "settle" }>, digest: DispatchConsumptionDigest,
  requireRequestBinding = true,
): Promise<DispatchSettlementOutcome> => {
  const outcome = snapshotDispatchSettlementOutcome(value);
  if (outcome.kind !== "settled") {throw new TypeError("persisted settlement is not binding evidence");}
  const receipt = outcome.receipt;
  if (receipt.consumptionDigest !== selector.consumptionDigest || receipt.operationId !== selector.operationId ||
    receipt.provider !== selector.provider || (requireRequestBinding && receipt.settlementRequestId !== selector.settlementRequestId) ||
    receipt.expectedBinding.authorityHeadDigest !== selector.expectedAuthorityHeadDigest || !sameScope(receipt.scope, selector.scope) ||
    await verifiedDigest(digest, settlementDigestPayload(receipt)) !== receipt.settlementDigest) {
    throw new TypeError("settlement receipt binding or digest is corrupt");
  }
  return outcome;
};

export const settlementMatchesCommand = (
  outcome: Extract<DispatchSettlementOutcome, { readonly kind: "settled" }>, input: DispatchSettlementCommand,
): boolean => outcome.receipt.consumptionDigest === input.consumptionDigest && outcome.receipt.disposition === input.disposition &&
  outcome.receipt.operationId === input.operationId && outcome.receipt.provider === input.provider &&
  outcome.receipt.settlementRequestId === input.settlementRequestId && sameScope(outcome.receipt.scope, input.scope) &&
  JSON.stringify(outcome.receipt.expectedBinding) === JSON.stringify(input.expectedBinding);
