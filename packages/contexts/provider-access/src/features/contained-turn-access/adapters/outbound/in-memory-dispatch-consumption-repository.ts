import type {
  DispatchConsumptionJournalEntry, DispatchConsumptionRepository, DispatchConsumptionTransaction,
  DispatchConsumptionTransactionSelector,
} from "../../application/ports/outbound/dispatch-consumption-repository.js";
import {
  canonicalJson, snapshotDispatchBindingHead, type DispatchBindingHead, type DispatchConsumedReceipt,
  type DispatchDisposition, type DispatchScopeValue, type DispatchSettlementOutcome,
} from "../../domain/dispatch-consumption.js";

type OwnerState = "absent" | "consumed_pending" | "claim_committed" | "abandoned_without_claim";
interface BindingSlot { head: DispatchBindingHead; consumption?: DispatchConsumedReceipt; state: OwnerState }
interface State {
  readonly consumptions: Map<string, { receipt: DispatchConsumedReceipt; slot: BindingSlot }>;
  readonly grants: Map<string, DispatchConsumptionJournalEntry>;
  readonly settlements: Map<string, DispatchSettlementOutcome>;
  readonly settlementsByConsumption: Map<string, DispatchSettlementOutcome>;
  readonly slots: Map<string, Map<"claude" | "codex", BindingSlot>>;
}
const clone = <T>(value: T): T => structuredClone(value);
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {deepFreeze(nested);}
    Object.freeze(value);
  }
  return value;
};
const frozen = <T>(value: T): T => deepFreeze(clone(value));
const scopeKey = (scope: DispatchScopeValue): string => canonicalJson({
  projectId: scope.projectId, scopeDigest: scope.scopeDigest, tenantId: scope.tenantId,
});
const grantKey = (input: { readonly grantRequestId: string; readonly provider: "claude" | "codex"; readonly scope: DispatchScopeValue }): string =>
  canonicalJson({ grantRequestId: input.grantRequestId, provider: input.provider, scope: input.scope });
const settlementKey = (input: Extract<DispatchConsumptionTransactionSelector, { readonly kind: "settle" }>): string =>
  canonicalJson({ operationId: input.operationId, provider: input.provider, scope: input.scope, settlementRequestId: input.settlementRequestId });

export interface InMemoryDispatchConsumptionControl {
  advanceControlTime(value: number): Promise<void>;
  replaceBindingHead(head: DispatchBindingHead): Promise<void>;
  observeOwnerState(input: { readonly provider: "claude" | "codex"; readonly scopeDigest: string }): OwnerState | undefined;
}

const putHead = (state: State, raw: DispatchBindingHead): void => {
  const head = snapshotDispatchBindingHead(raw);
  const key = scopeKey(head);
  const scoped = state.slots.get(key) ?? new Map();
  state.slots.set(key, scoped);
  scoped.set(head.provider, { head, state: "absent" });
};

const createTransaction = (state: State, selector: DispatchConsumptionTransactionSelector, now: () => number): DispatchConsumptionTransaction => {
  const slot = state.slots.get(scopeKey(selector.scope))?.get(selector.provider);
  let pendingConsumption: DispatchConsumedReceipt | undefined;
  let pendingGrant: DispatchConsumptionJournalEntry | undefined;
  let pendingSettlement: DispatchSettlementOutcome | undefined;
  return {
    async controlTime() { return now(); },
    async findBindingHead() { return slot?.head; },
    async findConsumption() { return selector.kind === "settle" ? state.consumptions.get(selector.consumptionDigest)?.receipt : undefined; },
    async findGrantRequest() { return selector.kind === "consume" ? state.grants.get(grantKey(selector)) : undefined; },
    async findSettlement() { return selector.kind === "settle" ? state.settlements.get(settlementKey(selector)) : undefined; },
    async findSettlementByConsumption() { return selector.kind === "settle" ? state.settlementsByConsumption.get(selector.consumptionDigest) : undefined; },
    async isBindingConsumed() { return slot !== undefined && slot.state !== "absent"; },
    async markBindingConsumed(receipt) {
      if (slot === undefined || slot.state !== "absent") {throw new Error("binding head was not atomically consumable");}
      pendingConsumption = frozen(receipt);
    },
    async saveGrantRequest(entry) { pendingGrant = frozen(entry); },
    async saveSettlement(outcome) { pendingSettlement = frozen(outcome); },
    get pending() { return { pendingConsumption, pendingGrant, pendingSettlement, slot }; },
  } as DispatchConsumptionTransaction;
};

interface PendingTransaction extends DispatchConsumptionTransaction {
  readonly pending: {
    readonly pendingConsumption?: DispatchConsumedReceipt; readonly pendingGrant?: DispatchConsumptionJournalEntry;
    readonly pendingSettlement?: DispatchSettlementOutcome; readonly slot?: BindingSlot;
  };
}

const commit = (state: State, selector: DispatchConsumptionTransactionSelector, transaction: PendingTransaction): void => {
  const { pendingConsumption, pendingGrant, pendingSettlement, slot } = transaction.pending;
  if (pendingConsumption !== undefined && slot !== undefined) {
    slot.consumption = pendingConsumption; slot.state = "consumed_pending";
    state.consumptions.set(pendingConsumption.consumptionDigest, { receipt: pendingConsumption, slot });
  }
  if (pendingGrant !== undefined && selector.kind === "consume") {state.grants.set(grantKey(selector), pendingGrant);}
  if (pendingSettlement !== undefined && selector.kind === "settle") {
    state.settlements.set(settlementKey(selector), pendingSettlement);
    if (pendingSettlement.kind === "settled") {
      state.settlementsByConsumption.set(selector.consumptionDigest, pendingSettlement);
      const owner = state.consumptions.get(selector.consumptionDigest);
      if (owner !== undefined) {owner.slot.state = pendingSettlement.receipt.disposition as DispatchDisposition;}
    }
  }
};

export const createInMemoryDispatchConsumptionRepository = (
  initialHeads: readonly DispatchBindingHead[], initialControlTime: number,
): { readonly control: InMemoryDispatchConsumptionControl; readonly repository: DispatchConsumptionRepository } => {
  const state: State = { consumptions: new Map(), grants: new Map(), settlements: new Map(), settlementsByConsumption: new Map(), slots: new Map() };
  let controlTime = initialControlTime;
  for (const head of initialHeads) {
    if (state.slots.get(scopeKey(head))?.has(head.provider)) {throw new Error("duplicate exact dispatch binding head");}
    putHead(state, head);
  }
  let tail = Promise.resolve();
  const serialize = async <T>(work: () => Promise<T>): Promise<T> => {
    const predecessor = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await predecessor;
    try { return await work(); } finally { release(); }
  };
  const repository: DispatchConsumptionRepository = Object.freeze({
    async transact<T>(selector: DispatchConsumptionTransactionSelector, work: (transaction: DispatchConsumptionTransaction) => Promise<T>) {
      return serialize(async () => {
        const transaction = createTransaction(state, selector, () => controlTime) as PendingTransaction;
        const result = await work(transaction); commit(state, selector, transaction); return result;
      });
    },
    async observeGrantRequest(input: { readonly grantRequestId: string; readonly provider: "claude" | "codex"; readonly scope: DispatchScopeValue }) {
      await tail;
      const entry = state.grants.get(grantKey(input)); return entry === undefined ? undefined : frozen(entry);
    },
  });
  return Object.freeze({
    control: Object.freeze({
      advanceControlTime: (value: number) => serialize(async () => {
        if (!Number.isSafeInteger(value) || value < controlTime) {throw new TypeError("control time must advance monotonically");}
        controlTime = value;
      }),
      observeOwnerState: (input: { readonly provider: "claude" | "codex"; readonly scopeDigest: string }) => {
        const matches = [...state.slots.values()].map(scoped => scoped.get(input.provider))
          .filter((slot): slot is BindingSlot => slot?.head.scopeDigest === input.scopeDigest);
        return matches.length === 1 ? matches[0]?.state : undefined;
      },
      replaceBindingHead: (head: DispatchBindingHead) => serialize(async () => { putHead(state, head); }),
    }), repository,
  });
};
