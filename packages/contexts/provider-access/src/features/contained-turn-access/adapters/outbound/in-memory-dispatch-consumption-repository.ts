import type {
  DispatchConsumptionJournalEntry, DispatchConsumptionRepository, DispatchConsumptionTransaction,
  DispatchConsumptionTransactionSelector,
} from "../../application/ports/outbound/dispatch-consumption-repository.js";
import type {
  MaterializationAuthorizationBinding, MaterializationAuthorizationRepository, MaterializationAuthorizationRequestSelector,
  MaterializationAuthorizationTransaction,
} from "../../application/ports/outbound/materialization-authorization-repository.js";
import {
  canonicalJson, snapshotDispatchBindingHead, snapshotDispatchConsumedReceipt, snapshotDispatchSettlementOutcome,
  type DispatchBindingHead, type DispatchConsumedReceipt, type DispatchDisposition, type DispatchScopeValue, type DispatchSettlementOutcome,
} from "../../domain/dispatch-consumption.js";
import { snapshotAuthorizationRecord, type AuthorizationRecord } from "../../domain/materialization-authorization.js";
import { canonicalDispatchJournalEntry, detachedDispatchData } from "../dispatch-consumption-data.js";

type OwnerState = "absent" | "consumed_pending" | "claim_committed" | "abandoned_without_claim";
interface BindingSlot { head: DispatchBindingHead; consumption?: DispatchConsumedReceipt; state: OwnerState }
interface State {
  readonly consumptions: Map<string, { receipt: DispatchConsumedReceipt; slot: BindingSlot }>;
  readonly historicalOwnerState: Map<string, OwnerState>;
  readonly grants: Map<string, DispatchConsumptionJournalEntry>;
  readonly settlements: Map<string, DispatchSettlementOutcome>;
  readonly settlementsByConsumption: Map<string, DispatchSettlementOutcome>;
  readonly authorizations: Map<string, AuthorizationRecord>;
  readonly slots: Map<string, Map<"claude" | "codex", BindingSlot>>;
}
const scopeKey = (scope: DispatchScopeValue): string => canonicalJson({
  projectId: scope.projectId, scopeDigest: scope.scopeDigest, tenantId: scope.tenantId,
});
const grantKey = (input: { readonly grantRequestId: string; readonly provider: "claude" | "codex"; readonly scope: DispatchScopeValue }): string =>
  canonicalJson({ grantRequestId: input.grantRequestId, provider: input.provider, scope: input.scope });
const settlementKey = (input: Extract<DispatchConsumptionTransactionSelector, { readonly kind: "settle" }>): string =>
  canonicalJson({ operationId: input.operationId, provider: input.provider, scope: input.scope, settlementRequestId: input.settlementRequestId });
const authorizationKey = (input: MaterializationAuthorizationRequestSelector): string => canonicalJson({
  authorizationRequestId: input.authorizationRequestId, projectId: input.projectId, provider: input.provider,
  scopeDigest: input.scopeDigest, tenantId: input.tenantId,
});
export interface InMemoryDispatchConsumptionControl {
  advanceControlTime(value: number): Promise<void>;
  replaceBindingHead(head: DispatchBindingHead): Promise<void>;
  observeOwnerState(input: { readonly provider: "claude" | "codex"; readonly scopeDigest: string }): OwnerState | undefined;
  observeHistoricalOwnerState(input: { readonly consumptionDigest: string }): OwnerState | undefined;
}

const putCanonicalHead = (state: State, head: DispatchBindingHead): void => {
  const key = scopeKey(head);
  const scoped = state.slots.get(key) ?? new Map();
  state.slots.set(key, scoped);
  scoped.set(head.provider, { head, state: "absent" });
};
const putHead = (state: State, raw: DispatchBindingHead): void => {
  putCanonicalHead(state, snapshotDispatchBindingHead(detachedDispatchData("binding head", raw)));
};

interface PendingWrites {
  readonly pendingConsumption: DispatchConsumedReceipt | undefined;
  readonly pendingGrant: DispatchConsumptionJournalEntry | undefined;
  readonly pendingSettlement: DispatchSettlementOutcome | undefined;
  readonly slot: BindingSlot | undefined;
}
const createTransaction = (
  state: State,
  selector: DispatchConsumptionTransactionSelector,
  now: () => number,
): { readonly pending: () => PendingWrites; readonly transaction: DispatchConsumptionTransaction } => {
  const slot = state.slots.get(scopeKey(selector.scope))?.get(selector.provider);
  let pendingConsumption: DispatchConsumedReceipt | undefined;
  let pendingGrant: DispatchConsumptionJournalEntry | undefined;
  let pendingSettlement: DispatchSettlementOutcome | undefined;
  const transaction: DispatchConsumptionTransaction = {
    async controlTime() { return now(); },
    async findBindingHead() { return slot === undefined ? undefined : snapshotDispatchBindingHead(slot.head); },
    async findConsumption() {
      const receipt = selector.kind === "settle" ? state.consumptions.get(selector.consumptionDigest)?.receipt : undefined;
      return receipt === undefined ? undefined : snapshotDispatchConsumedReceipt(receipt);
    },
    async findGrantRequest() {
      const entry = selector.kind === "consume" ? state.grants.get(grantKey(selector)) : undefined;
      return entry === undefined ? undefined : canonicalDispatchJournalEntry(entry);
    },
    async findSettlement() {
      const outcome = selector.kind === "settle" ? state.settlements.get(settlementKey(selector)) : undefined;
      return outcome === undefined ? undefined : snapshotDispatchSettlementOutcome(outcome);
    },
    async findSettlementByConsumption() {
      const outcome = selector.kind === "settle" ? state.settlementsByConsumption.get(selector.consumptionDigest) : undefined;
      return outcome === undefined ? undefined : snapshotDispatchSettlementOutcome(outcome);
    },
    async isBindingConsumed() { return slot !== undefined && slot.state !== "absent"; },
    async markBindingConsumed(receipt) {
      if (slot === undefined || slot.state !== "absent") {throw new Error("binding head was not atomically consumable");}
      pendingConsumption = snapshotDispatchConsumedReceipt(detachedDispatchData("consumption receipt", receipt));
    },
    async saveGrantRequest(entry) { pendingGrant = canonicalDispatchJournalEntry(entry); },
    async saveSettlement(outcome) {
      pendingSettlement = snapshotDispatchSettlementOutcome(detachedDispatchData("settlement outcome", outcome));
    },
  };
  return Object.freeze({
    pending: () => ({ pendingConsumption, pendingGrant, pendingSettlement, slot }),
    transaction: Object.freeze(transaction),
  });
};

const commit = (state: State, selector: DispatchConsumptionTransactionSelector, pending: PendingWrites): void => {
  const { pendingConsumption, pendingGrant, pendingSettlement, slot } = pending;
  if (pendingConsumption !== undefined && slot !== undefined) {
    slot.consumption = pendingConsumption; slot.state = "consumed_pending";
    state.consumptions.set(pendingConsumption.consumptionDigest, { receipt: pendingConsumption, slot }); state.historicalOwnerState.set(pendingConsumption.consumptionDigest, "consumed_pending");
  }
  if (pendingGrant !== undefined && selector.kind === "consume") {state.grants.set(grantKey(selector), pendingGrant);}
  if (pendingSettlement !== undefined && selector.kind === "settle") {
    state.settlements.set(settlementKey(selector), pendingSettlement);
    if (pendingSettlement.kind === "settled") {
      state.settlementsByConsumption.set(selector.consumptionDigest, pendingSettlement);
      const owner = state.consumptions.get(selector.consumptionDigest);
      if (owner !== undefined) {owner.slot.state = pendingSettlement.receipt.disposition as DispatchDisposition; state.historicalOwnerState.set(selector.consumptionDigest, owner.slot.state);}
    }
  }
};

const bindingProjection = (head: DispatchBindingHead): MaterializationAuthorizationBinding => Object.freeze({
  accessRef: head.accessRef, availability: head.availability, bindingRevision: head.bindingRevision,
  credentialBindingDigest: head.credentialBindingDigest, credentialBindingRef: head.credentialBindingRef,
  credentialGeneration: head.credentialGeneration, projectId: head.projectId, provider: head.provider,
  providerAccountRef: head.providerAccountRef, providerRouteRef: head.providerRouteRef, revocation: head.revocation,
  scopeDigest: head.scopeDigest, tenantId: head.tenantId,
});

export const createInMemoryDispatchConsumptionRepository = (
  initialHeads: readonly DispatchBindingHead[], initialControlTime: number,
): { readonly control: InMemoryDispatchConsumptionControl; readonly materializationRepository: MaterializationAuthorizationRepository;
  readonly repository: DispatchConsumptionRepository } => {
  const state: State = {
    authorizations: new Map(), consumptions: new Map(), historicalOwnerState: new Map(), grants: new Map(),
    settlements: new Map(), settlementsByConsumption: new Map(), slots: new Map(),
  };
  let controlTime = initialControlTime;
  const detachedHeads = detachedDispatchData("initial binding heads", initialHeads);
  if (!Array.isArray(detachedHeads)) {throw new TypeError("initial binding heads must be an array");}
  for (const rawHead of detachedHeads) {
    const head = snapshotDispatchBindingHead(rawHead as DispatchBindingHead);
    if (state.slots.get(scopeKey(head))?.has(head.provider)) {throw new Error("duplicate exact dispatch binding head");}
    putCanonicalHead(state, head);
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
        const unit = createTransaction(state, selector, () => controlTime);
        const result = await work(unit.transaction); commit(state, selector, unit.pending()); return result;
      });
    },
    async observeGrantRequest(input: { readonly grantRequestId: string; readonly provider: "claude" | "codex"; readonly scope: DispatchScopeValue }) {
      await tail;
      const entry = state.grants.get(grantKey(input)); return entry === undefined ? undefined : canonicalDispatchJournalEntry(entry);
    },
  });
  const materializationRepository: MaterializationAuthorizationRepository = Object.freeze({
    async observeAuthorizationRequest(selector: MaterializationAuthorizationRequestSelector) {
      await tail;
      const found = state.authorizations.get(authorizationKey(selector));
      return found === undefined ? undefined : snapshotAuthorizationRecord(structuredClone(found));
    },
    async transact<T>(selector: Parameters<MaterializationAuthorizationRepository["transact"]>[0], work: (transaction: MaterializationAuthorizationTransaction) => Promise<T>) {
      return serialize(async () => {
        const slot = state.slots.get(scopeKey(selector))?.get(selector.provider);
        let pending: AuthorizationRecord | undefined;
        const transaction: MaterializationAuthorizationTransaction = Object.freeze({
          async findAuthorizationRequest() {
            const found = state.authorizations.get(authorizationKey(selector));
            return found === undefined ? undefined : snapshotAuthorizationRecord(structuredClone(found));
          },
          async findBinding() {return slot === undefined ? undefined : bindingProjection(slot.head);},
          async saveAuthorization(record: AuthorizationRecord) {pending = snapshotAuthorizationRecord(structuredClone(record));},
        });
        const result = await work(transaction);
        if (pending !== undefined) {
          const key = authorizationKey(selector);
          const existing = state.authorizations.get(key);
          if (existing !== undefined && existing.requestDigest !== pending.requestDigest) {
            throw new Error("authorization request identity cannot be rebound");
          }
          state.authorizations.set(key, pending);
        }
        return result;
      });
    },
  });
  return Object.freeze({
    control: Object.freeze({
      advanceControlTime: (value: number) => serialize(async () => {
        if (!Number.isSafeInteger(value) || value < controlTime) {throw new TypeError("control time must advance monotonically");}
        controlTime = value;
      }),
      observeHistoricalOwnerState: (input: { readonly consumptionDigest: string }) => state.historicalOwnerState.get(input.consumptionDigest),
      observeOwnerState: (input: { readonly provider: "claude" | "codex"; readonly scopeDigest: string }) => {
        const matches = [...state.slots.values()].map(scoped => scoped.get(input.provider))
          .filter((slot): slot is BindingSlot => slot?.head.scopeDigest === input.scopeDigest);
        return matches.length === 1 ? matches[0]?.state : undefined;
      },
      replaceBindingHead: (head: DispatchBindingHead) => serialize(async () => { putHead(state, head); }),
    }), materializationRepository, repository,
  });
};
