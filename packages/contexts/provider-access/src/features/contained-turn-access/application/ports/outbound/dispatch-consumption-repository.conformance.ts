import type {
  DispatchConsumptionRepository, DispatchConsumptionTransaction, DispatchConsumptionTransactionSelector,
} from "./dispatch-consumption-repository.js";

/** Compile-time fixture proving that targeted async I/O implements the port without a preloaded ledger. */
const fakeAsyncRepository = (
  query: (selector: DispatchConsumptionTransactionSelector, operation: string) => Promise<unknown>,
): DispatchConsumptionRepository => ({
  async observeGrantRequest(input) {
    return await query({
      grantRequestId: input.grantRequestId, kind: "consume", provider: input.provider, scope: input.scope,
    }, "observe") as Awaited<ReturnType<DispatchConsumptionRepository["observeGrantRequest"]>>;
  },
  async transact<T>(selector: DispatchConsumptionTransactionSelector, work: (transaction: DispatchConsumptionTransaction) => Promise<T>) {
    const read = async <V>(operation: string): Promise<V | undefined> => await query(selector, operation) as V | undefined;
    const write = async (operation: string, value: unknown): Promise<void> => { await query(selector, `${operation}:${JSON.stringify(value)}`); };
    const transaction: DispatchConsumptionTransaction = {
      async controlTime() { return await query(selector, "controlTime") as number; },
      async findBindingHead() { return read("findBindingHead"); },
      async findConsumption() { return read("findConsumption"); },
      async findGrantRequest() { return read("findGrantRequest"); },
      async findSettlement() { return read("findSettlement"); },
      async findSettlementByConsumption() { return read("findSettlementByConsumption"); },
      async isBindingConsumed() { return await query(selector, "isBindingConsumed") as boolean; },
      async markBindingConsumed(receipt) { await write("markBindingConsumed", receipt); },
      async saveGrantRequest(entry) { await write("saveGrantRequest", entry); },
      async saveSettlement(outcome) { await write("saveSettlement", outcome); },
    };
    return work(transaction);
  },
});

export type AsyncRepositoryConformance = ReturnType<typeof fakeAsyncRepository>;
