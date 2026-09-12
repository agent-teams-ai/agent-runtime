import type { DispatchConsumptionRepository, DispatchConsumptionTransaction, DispatchConsumptionTransactionSelector } from "../../application/ports/outbound/dispatch-consumption-repository.js";
import { verifiedConsumption, verifiedJournalEntry, verifiedSettlement } from "../../application/persistence-validation.js";
import { canonicalJson, type DispatchConsumeCommand } from "../../domain/dispatch-consumption.js";
import { createSha256DispatchConsumptionDigest } from "./sha256-dispatch-consumption-digest.js";
import type { PaOperationOwner, PaOperationPublication, PaOperationStore, PaOperationTransaction } from "./dispatch-operation-contracts.js";
import { assertPaCurrentMaterialization, assertPaPreparedRequest, verifiedPaPublication } from "./dispatch-operation-data.js";

const digest = createSha256DispatchConsumptionDigest();
export const samePaOwner = (one: PaOperationOwner, two: PaOperationOwner): boolean =>
  canonicalJson({provider: one.provider, scope: one.scope}) === canonicalJson({provider: two.provider, scope: two.scope});
const readPublication = async (tx: PaOperationTransaction, owner: PaOperationOwner, operationId: string) => {
  const value = await tx.read("publication", operationId);
  if (value === undefined) {return;}
  const publication = await verifiedPaPublication(value);
  if (publication.prepared.operationId !== operationId || !samePaOwner(publication.prepared, owner)) {throw new Error("PA publication owner mismatch");}
  const issued = await tx.read("issuance", publication.issuance.issuanceRef);
  if (canonicalJson(issued) !== canonicalJson(publication.issuance)) {throw new Error("PA publication lacks retained issuance");}
  return publication;
};
const settlementSelector = (selector: DispatchConsumptionTransactionSelector) => {
  if (selector.kind !== "settle") {throw new Error("PA settlement selector required");}
  return selector;
};
const transactionFor = (tx: PaOperationTransaction, selector: DispatchConsumptionTransactionSelector,
  operationId: string, publication: PaOperationPublication | undefined, command?: DispatchConsumeCommand): DispatchConsumptionTransaction => {
  const head = publication?.head;
  return Object.freeze<DispatchConsumptionTransaction>({
    async controlTime() {tx.checkOpen(); return tx.controlTime;},
    async findBindingHead() {
      tx.checkOpen();
      if (selector.kind === "consume" && publication) {
        if (!command) {throw new Error("PA command absent");}
        await assertPaPreparedRequest(publication.prepared, command);
        assertPaCurrentMaterialization(tx, publication.issuance);
        if (tx.controlTime < publication.issuance.validFromControlTime) {throw new Error("PA issuance not yet valid");}
      }
      return head;
    },
    async findGrantRequest() {
      tx.checkOpen();
      if (selector.kind !== "consume") {return;}
      const raw = await tx.read("grant", selector.grantRequestId);
      return raw === undefined ? undefined : verifiedJournalEntry(raw, selector, digest);
    },
    async findConsumption() {
      tx.checkOpen();
      const selected = settlementSelector(selector);
      const raw = await tx.read("consumption", operationId);
      return raw === undefined ? undefined : verifiedConsumption(raw, selected, digest);
    },
    async findSettlement() {
      tx.checkOpen();
      const selected = settlementSelector(selector);
      const raw = await tx.read("settlement", operationId);
      if (raw === undefined) {return;}
      const value = await verifiedSettlement(raw, selected, digest, false);
      return value.kind === "settled" && value.receipt.settlementRequestId === selected.settlementRequestId ? value : undefined;
    },
    async findSettlementByConsumption() {
      tx.checkOpen();
      const selected = settlementSelector(selector);
      const raw = await tx.read("settlement", operationId);
      return raw === undefined ? undefined : verifiedSettlement(raw, selected, digest, false);
    },
    async isBindingConsumed() {tx.checkOpen(); return await tx.read("consumption", operationId) !== undefined;},
    async markBindingConsumed(receipt) {
      tx.checkOpen();
      if (!head || !command || selector.kind !== "consume" || receipt.operationId !== operationId) {throw new Error("PA consumption selector mismatch");}
      const checked = await verifiedConsumption(receipt, {...selector, kind: "settle", operationId,
        consumptionDigest: receipt.consumptionDigest, expectedAuthorityHeadDigest: head.authorityHeadDigest,
        settlementRequestId: "database:operation-validation"}, digest);
      const fields = ["acceptedAuthorityDigest", "accessRef", "bindingDigest", "bindingRevision", "claimBeforeControlTime",
        "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "opaqueOwnerEvidenceRef", "providerAccountRef", "providerRouteRef"] as const;
      if (fields.some(field => checked[field] !== head[field]) || checked.requestDigest !== command.requestDigest || checked.claimBindingDigest !== command.claimBindingDigest ||
        checked.grantRequestId !== command.grantRequestId || checked.consumedAtControlTime !== tx.controlTime) {throw new Error("PA consumption request mismatch");}
      await tx.insert("consumption", operationId, checked);
    },
    async saveGrantRequest(entry) {
      tx.checkOpen();
      if (selector.kind !== "consume" || entry.operationId !== operationId) {throw new Error("PA grant selector mismatch");}
      const checked = await verifiedJournalEntry(entry, selector, digest);
      if (entry.outcome.kind === "consumed" && canonicalJson(await tx.read("consumption", operationId)) !== canonicalJson(entry.outcome.receipt)) {
        throw new Error("PA grant lacks exact consumption");
      }
      // An absent-head outcome also spends this operation's request identity.
      const attempt = {grantRequestId: entry.grantRequestId, requestDigest: entry.requestDigest};
      const previous = await tx.read("attempt", operationId);
      if (previous === undefined) {await tx.insert("attempt", operationId, attempt);}
      else if (canonicalJson(previous) !== canonicalJson(attempt)) {throw new Error("PA operation request is immutable");}
      await tx.insert("grant", selector.grantRequestId, checked);
    },
    async saveSettlement(outcome) {
      tx.checkOpen();
      const selected = settlementSelector(selector);
      const checked = await verifiedSettlement(outcome, selected, digest);
      if (checked.kind !== "settled") {throw new Error("PA stores successful settlement only");}
      await tx.insert("settlement", operationId, checked);
    },
  });
};

/** Reuses the V1 domain/use cases with an operation-keyed persistence identity. */
export const createOperationDispatchRepository = (store: PaOperationStore, owner: PaOperationOwner,
  operationId: string, command?: DispatchConsumeCommand): DispatchConsumptionRepository => Object.freeze<DispatchConsumptionRepository>({
  async transact(selector, work) {
    if (!samePaOwner(selector, owner) || (selector.kind === "settle" && selector.operationId !== operationId)) {throw new Error("PA scoped operation mismatch");}
    return store.transact(owner, async tx => work(transactionFor(tx, selector, operationId,
      await readPublication(tx, owner, operationId), command)));
  },
  async observeGrantRequest(input) {
    if (!samePaOwner(input, owner)) {return;}
    return store.transact(owner, async tx => {
      const raw = await tx.read("grant", input.grantRequestId);
      return raw === undefined ? undefined : verifiedJournalEntry(raw, input, digest);
    });
  },
});
