import type {
  DispatchConsumptionJournalEntry, DispatchConsumptionRepository, DispatchConsumptionTransaction,
} from "../../application/ports/outbound/dispatch-consumption-repository.js";
import {
  snapshotDispatchBindingHead, type DispatchBindingHead, type DispatchConsumedReceipt,
  type DispatchDisposition, type DispatchScopeValue, type DispatchSettlementOutcome,
} from "../../domain/dispatch-consumption.js";

type OwnerState = "absent" | "consumed_pending" | "claim_committed" | "abandoned_without_claim";
interface BindingSlot { head: DispatchBindingHead; consumption?: DispatchConsumedReceipt; state: OwnerState }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};
const frozen = <T>(value: T): T => deepFreeze(clone(value));

export interface InMemoryDispatchConsumptionControl {
  replaceBindingHead(head: DispatchBindingHead): void;
  observeOwnerState(input: { readonly provider: "claude" | "codex"; readonly scopeDigest: string }): OwnerState | undefined;
}

export const createInMemoryDispatchConsumptionRepository = (
  initialHeads: readonly DispatchBindingHead[],
): { readonly control: InMemoryDispatchConsumptionControl; readonly repository: DispatchConsumptionRepository } => {
  const slots = new Map<string, Map<"claude" | "codex", BindingSlot>>();
  const grants = new Map<string, DispatchConsumptionJournalEntry>();
  const consumptions = new Map<string, { receipt: DispatchConsumedReceipt; slot: BindingSlot }>();
  const settlements = new Map<string, DispatchSettlementOutcome>();
  const settlementsByConsumption = new Map<string, DispatchSettlementOutcome>();
  const putHead = (raw: DispatchBindingHead): void => {
    const head = snapshotDispatchBindingHead(raw);
    const scoped = slots.get(head.scopeDigest) ?? new Map();
    const existing = scoped.get(head.provider);
    slots.set(head.scopeDigest, scoped);
    if (existing === undefined) scoped.set(head.provider, { head, state: "absent" });
    else existing.head = head;
  };
  for (const head of initialHeads) {
    if (slots.get(head.scopeDigest)?.has(head.provider)) throw new Error("duplicate exact dispatch binding head");
    putHead(head);
  }
  let tail = Promise.resolve();
  const repository: DispatchConsumptionRepository = Object.freeze({
    async transact<T>(input: { readonly provider?: "claude" | "codex"; readonly scopeDigest?: string }, work: (transaction: DispatchConsumptionTransaction) => Promise<T>): Promise<T> {
      const predecessor = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await predecessor;
      try {
        const slot = input.provider === undefined || input.scopeDigest === undefined ? undefined : slots.get(input.scopeDigest)?.get(input.provider);
        let pendingConsumption: DispatchConsumedReceipt | undefined;
        let pendingGrant: { readonly id: string; readonly entry: DispatchConsumptionJournalEntry } | undefined;
        let pendingSettlement: { readonly id: string; readonly outcome: DispatchSettlementOutcome } | undefined;
        const transaction: DispatchConsumptionTransaction = {
          findBindingHead: () => slot?.head,
          findConsumptionByDigest: digest => consumptions.get(digest)?.receipt,
          findGrantRequest: id => grants.get(id),
          findSettlement: id => settlements.get(id),
          findSettlementByConsumption: digest => settlementsByConsumption.get(digest),
          isBindingConsumed: () => slot !== undefined && slot.state !== "absent",
          markBindingConsumed(receipt): void {
            if (slot === undefined || slot.state !== "absent") throw new Error("binding head was not atomically consumable");
            pendingConsumption = frozen(receipt);
          },
          saveGrantRequest(id, entry): void { pendingGrant = { id, entry: frozen(entry) }; },
          saveSettlement(id, outcome): void {
            pendingSettlement = { id, outcome: frozen(outcome) };
          },
        };
        const result = await work(transaction);
        if (pendingConsumption !== undefined && slot !== undefined) {
          slot.consumption = pendingConsumption;
          slot.state = "consumed_pending";
          consumptions.set(pendingConsumption.consumptionDigest, { receipt: pendingConsumption, slot });
        }
        if (pendingGrant !== undefined) grants.set(pendingGrant.id, pendingGrant.entry);
        if (pendingSettlement !== undefined) {
          settlements.set(pendingSettlement.id, pendingSettlement.outcome);
          if (pendingSettlement.outcome.kind === "settled") {
            settlementsByConsumption.set(pendingSettlement.outcome.receipt.consumptionDigest, pendingSettlement.outcome);
            const owner = consumptions.get(pendingSettlement.outcome.receipt.consumptionDigest);
            if (owner !== undefined) owner.slot.state = pendingSettlement.outcome.receipt.disposition as DispatchDisposition;
          }
        }
        return result;
      } finally { release(); }
    },
    async observeGrantRequest(input: { readonly grantRequestId: string; readonly scope: DispatchScopeValue }) {
      const entry = grants.get(input.grantRequestId);
      return entry === undefined ? undefined : frozen(entry);
    },
  });
  return Object.freeze({
    control: Object.freeze({
      observeOwnerState(input: { readonly provider: "claude" | "codex"; readonly scopeDigest: string }) {
        return slots.get(input.scopeDigest)?.get(input.provider)?.state;
      },
      replaceBindingHead: putHead,
    }),
    repository,
  });
};
