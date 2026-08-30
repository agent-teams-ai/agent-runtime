import assert from "node:assert/strict";
import test from "node:test";

import type { ConsumeForDispatchInput } from "../dist/index.js";
import { createDispatchConsumptionRequestDigests, createInMemoryContainedTurnDispatchConsumptionV1 } from "../dist/composition.js";
import { createInMemoryDispatchConsumptionRepository } from "../dist/features/contained-turn-access/adapters/outbound/in-memory-dispatch-consumption-repository.js";
import { createSha256DispatchConsumptionDigest } from "../dist/features/contained-turn-access/adapters/outbound/sha256-dispatch-consumption-digest.js";
import type {
  DispatchConsumptionJournalEntry, DispatchConsumptionRepository, DispatchConsumptionTransaction,
  DispatchConsumptionTransactionSelector,
} from "../dist/features/contained-turn-access/application/ports/outbound/dispatch-consumption-repository.js";
import { createContainedTurnDispatchConsumptionV1 } from "../dist/features/contained-turn-access/composition/dispatch-consumption-v1-factory.js";
import type {
  DispatchConsumedReceipt, DispatchSettlementOutcome,
} from "../dist/features/contained-turn-access/domain/dispatch-consumption.js";

type InjectedMethod = (...args: never[]) => unknown;
type TransactionWork = (transaction: DispatchConsumptionTransaction) => Promise<unknown>;

const runtimeTypes = (process.getBuiltinModule("node:util") as {
  readonly types: { readonly isProxy: (value: unknown) => boolean };
}).types;

const seed = () => ({
  acceptedAuthorityDigest: "authority:accepted:1", accessRef: "access:1", authorityHeadDigest: "authority:head:1",
  availability: "available" as const, bindingDigest: "binding:digest:1", bindingRevision: 1, claimBeforeControlTime: 200,
  credentialBindingDigest: "credential:digest:1", credentialBindingRef: "credential:binding:1", credentialGeneration: 1,
  expiresAtControlTime: 300, opaqueOwnerEvidenceRef: "owner:evidence:1", projectId: "project:1", provider: "codex" as const,
  providerAccountRef: "account:1", providerRouteRef: "route:1", revocation: "active" as const,
  scopeDigest: "scope:digest:1", tenantId: "tenant:1",
});

const inputFor = async (): Promise<ConsumeForDispatchInput> => {
  const head = seed();
  const unsigned = {
    binding: {
      acceptedAuthorityDigest: head.acceptedAuthorityDigest, accessRef: head.accessRef,
      authorityHeadDigest: head.authorityHeadDigest, bindingDigest: head.bindingDigest, bindingRevision: head.bindingRevision,
      credentialBindingDigest: head.credentialBindingDigest, credentialBindingRef: head.credentialBindingRef,
      credentialGeneration: head.credentialGeneration, providerAccountRef: head.providerAccountRef, providerRouteRef: head.providerRouteRef,
    },
    grantRequestId: "grant-request:proxy", operationId: "operation:1", provider: head.provider,
    purpose: "contained-turn.provider-dispatch/v1" as const,
    scope: { projectId: head.projectId, scopeDigest: head.scopeDigest, tenantId: head.tenantId },
  };
  return { ...unsigned, ...await createDispatchConsumptionRequestDigests(unsigned) };
};

const armedHandler = (onTrap: () => void): ProxyHandler<object> => ({
  get(_target, key) {
    // Native promise resolution checks `then`; allow only that non-reflective handoff.
    if (key === "then") { return; }
    onTrap(); throw new Error("proxy get trap");
  },
  getOwnPropertyDescriptor() { onTrap(); throw new Error("proxy descriptor trap"); },
  getPrototypeOf() { onTrap(); throw new Error("proxy prototype trap"); },
  ownKeys() { onTrap(); throw new Error("proxy keys trap"); },
});

const intrinsicBoundProxyMethod = (onApply: () => void): InjectedMethod => {
  const proxied = new Proxy(async (..._args: never[]): Promise<undefined> => undefined, {
    apply() { onApply(); throw new Error("bound proxy apply trap"); },
  });
  const bound = Reflect.apply(Function.prototype.bind, proxied, [Object.freeze({})]) as InjectedMethod;
  assert.equal(runtimeTypes.isProxy(bound), false);
  return bound;
};

const rejectsSynchronouslyAsClosed = (invoke: () => Promise<unknown>): boolean => {
  try {
    void invoke().catch(() => {});
    return false;
  } catch (error) {
    return error instanceof TypeError && /transaction callback is closed/u.test(error.message);
  }
};

const inertTransaction = (onApplicationWork: () => void): DispatchConsumptionTransaction => Object.freeze({
  async controlTime() { return 100; },
  async findBindingHead() { return seed(); },
  async findConsumption(): Promise<undefined> {},
  async findGrantRequest(): Promise<undefined> { onApplicationWork(); },
  async findSettlement(): Promise<undefined> {},
  async findSettlementByConsumption(): Promise<undefined> {},
  async isBindingConsumed() { return false; },
  async markBindingConsumed() {},
  async saveGrantRequest() {},
  async saveSettlement() {},
});

test("every injected dependency method rejects an intrinsic-bound proxy without invoking its target", () => {
  const base = createInMemoryDispatchConsumptionRepository([seed()], 100);
  const digest = createSha256DispatchConsumptionDigest();
  const cases: readonly [string, (method: InjectedMethod) => unknown][] = [
    ["digest.digest", method => ({ digest: { digest: method }, repository: base.repository })],
    ["repository.observeGrantRequest", method => ({
      digest, repository: { observeGrantRequest: method, transact: base.repository.transact },
    })],
    ["repository.transact", method => ({
      digest, repository: { observeGrantRequest: base.repository.observeGrantRequest, transact: method },
    })],
  ];
  for (const [name, dependencies] of cases) {
    let applyTraps = 0;
    const method = intrinsicBoundProxyMethod(() => { applyTraps += 1; });
    assert.throws(
      () => createContainedTurnDispatchConsumptionV1(dependencies(method) as never),
      { name: "TypeError" }, name,
    );
    assert.equal(applyTraps, 0, name);
  }
});

test("every injected transaction method rejects an intrinsic-bound proxy without invoking its target", async () => {
  const keys = [
    "controlTime", "findBindingHead", "findConsumption", "findGrantRequest", "findSettlement",
    "findSettlementByConsumption", "isBindingConsumed", "markBindingConsumed", "saveGrantRequest", "saveSettlement",
  ] as const satisfies readonly (keyof DispatchConsumptionTransaction)[];
  for (const key of keys) {
    const base = createInMemoryDispatchConsumptionRepository([seed()], 100);
    let applyTraps = 0;
    const method = intrinsicBoundProxyMethod(() => { applyTraps += 1; });
    const repository: DispatchConsumptionRepository = {
      observeGrantRequest: base.repository.observeGrantRequest,
      transact<T>(selector: DispatchConsumptionTransactionSelector, work: (transaction: DispatchConsumptionTransaction) => Promise<T>) {
        return base.repository.transact(selector, transaction => work({ ...transaction, [key]: method } as DispatchConsumptionTransaction));
      },
    };
    const access = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository });
    assert.deepEqual(await access.consumeForDispatch(await inputFor()), { kind: "indeterminate" }, key);
    assert.equal(applyTraps, 0, key);
  }
});

test("public dispatch inputs reject top-level and nested proxies without invoking traps", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const valid = await inputFor();
  let traps = 0;
  const handler = armedHandler(() => { traps += 1; });
  for (const value of [
    new Proxy(valid, handler),
    { ...valid, binding: new Proxy(valid.binding, handler) },
    { ...valid, scope: new Proxy(valid.scope, handler) },
  ]) {
    assert.deepEqual(await harness.access.consumeForDispatch(value as ConsumeForDispatchInput), {
      kind: "invalid", reason: "invalid_request",
    });
  }
  assert.equal(traps, 0);
});

test("in-memory composition and repository seeds reject armed proxies before reflection", () => {
  let traps = 0;
  const handler = armedHandler(() => { traps += 1; });
  for (const bindings of [
    new Proxy([seed()], handler),
    [new Proxy(seed(), handler)],
  ]) {
    assert.throws(() => createInMemoryContainedTurnDispatchConsumptionV1({
      bindings: bindings as never, initialControlTime: 100,
    }), TypeError);
    assert.throws(() => createInMemoryDispatchConsumptionRepository(bindings as never, 100), TypeError);
  }
  assert.equal(traps, 0);
});

test("repository outcomes reject top-level and nested proxies without invoking traps", async () => {
  const base = createInMemoryDispatchConsumptionRepository([seed()], 100);
  const input = await inputFor();
  const initial = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository: base.repository });
  assert.equal((await initial.consumeForDispatch(input)).kind, "consumed");
  const stored = await base.repository.observeGrantRequest(input);
  assert.ok(stored !== undefined);
  if (stored === undefined) { return; }
  let traps = 0;
  const handler = armedHandler(() => { traps += 1; });
  for (const value of [
    new Proxy(structuredClone(stored), handler),
    { ...structuredClone(stored), outcome: new Proxy(structuredClone(stored.outcome), handler) },
  ]) {
    const observationRepository: DispatchConsumptionRepository = {
      observeGrantRequest: (async () => value) as never, transact: base.repository.transact,
    };
    assert.deepEqual(await createContainedTurnDispatchConsumptionV1({
      digest: createSha256DispatchConsumptionDigest(), repository: observationRepository,
    }).observeDispatchConsumption({
      grantRequestId: input.grantRequestId, provider: input.provider, requestDigest: input.requestDigest, scope: input.scope,
    }), { kind: "indeterminate" });
    const transactionRepository: DispatchConsumptionRepository = {
      observeGrantRequest: base.repository.observeGrantRequest,
      transact: (selector, work) => base.repository.transact(selector, transaction => work({
        controlTime: transaction.controlTime, findBindingHead: transaction.findBindingHead,
        findConsumption: transaction.findConsumption, findGrantRequest: (async () => value) as never,
        findSettlement: transaction.findSettlement, findSettlementByConsumption: transaction.findSettlementByConsumption,
        isBindingConsumed: transaction.isBindingConsumed, markBindingConsumed: transaction.markBindingConsumed,
        saveGrantRequest: transaction.saveGrantRequest, saveSettlement: transaction.saveSettlement,
      })),
    };
    assert.deepEqual(await createContainedTurnDispatchConsumptionV1({
      digest: createSha256DispatchConsumptionDigest(), repository: transactionRepository,
    }).consumeForDispatch(input), { kind: "indeterminate" });
  }
  assert.equal(traps, 0);
});

test("repository selectors, writes, callback results, and reads are detached from public outcomes", async () => {
  const base = createInMemoryDispatchConsumptionRepository([seed()], 100);
  let retainedSelector: DispatchConsumptionTransactionSelector | undefined;
  let retainedTransactionResult: unknown;
  let retainedConsumption: DispatchConsumedReceipt | undefined;
  let retainedJournal: DispatchConsumptionJournalEntry | undefined;
  let retainedSettlement: DispatchSettlementOutcome | undefined;
  let retainedObservation: DispatchConsumptionJournalEntry | undefined;
  const repository: DispatchConsumptionRepository = {
    async observeGrantRequest(input) {
      const found = await base.repository.observeGrantRequest(input);
      retainedObservation = found;
      return found;
    },
    transact<T>(selector: DispatchConsumptionTransactionSelector, work: (transaction: DispatchConsumptionTransaction) => Promise<T>) {
      retainedSelector = selector;
      return base.repository.transact(selector, async transaction => {
        const intercepted: DispatchConsumptionTransaction = {
          controlTime: transaction.controlTime,
          findBindingHead: transaction.findBindingHead,
          findConsumption: transaction.findConsumption,
          findGrantRequest: transaction.findGrantRequest,
          findSettlement: transaction.findSettlement,
          findSettlementByConsumption: transaction.findSettlementByConsumption,
          isBindingConsumed: transaction.isBindingConsumed,
          async markBindingConsumed(receipt) {
            retainedConsumption = receipt;
            await transaction.markBindingConsumed(receipt);
          },
          async saveGrantRequest(entry) {
            retainedJournal = entry;
            await transaction.saveGrantRequest(entry);
          },
          async saveSettlement(outcome) {
            retainedSettlement = outcome;
            await transaction.saveSettlement(outcome);
          },
        };
        const result = await work(intercepted);
        retainedTransactionResult = result;
        return result;
      });
    },
  };
  const access = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository });
  const input = await inputFor();
  const consumed = await access.consumeForDispatch(input);
  assert.equal(consumed.kind, "consumed");
  assert.ok(consumed.kind === "consumed" && retainedJournal?.outcome.kind === "consumed");
  if (consumed.kind !== "consumed" || retainedJournal?.outcome.kind !== "consumed") { return; }
  assert.notStrictEqual(retainedTransactionResult, consumed);
  assert.notStrictEqual(retainedSelector?.scope, consumed.receipt.scope);
  assert.notStrictEqual(retainedConsumption, consumed.receipt);
  assert.notStrictEqual(retainedJournal.outcome, consumed);
  assert.notStrictEqual(retainedJournal.outcome.receipt, consumed.receipt);
  assert.notStrictEqual(retainedJournal.outcome.receipt.scope, consumed.receipt.scope);

  const observed = await access.observeDispatchConsumption({
    grantRequestId: input.grantRequestId, provider: input.provider, requestDigest: input.requestDigest, scope: input.scope,
  });
  assert.ok(observed.kind === "consumed" && retainedObservation?.outcome.kind === "consumed");
  if (observed.kind !== "consumed" || retainedObservation?.outcome.kind !== "consumed") { return; }
  assert.notStrictEqual(retainedObservation.outcome, observed);
  assert.notStrictEqual(retainedObservation.outcome.receipt, observed.receipt);

  const settled = await access.settleDispatchConsumption({
    consumptionDigest: consumed.receipt.consumptionDigest,
    disposition: "claim_committed",
    expectedBinding: {
      acceptedAuthorityDigest: consumed.receipt.acceptedAuthorityDigest,
      accessRef: consumed.receipt.accessRef,
      authorityHeadDigest: consumed.receipt.authorityHeadDigestAtConsumption,
      bindingDigest: consumed.receipt.bindingDigest,
      bindingRevision: consumed.receipt.bindingRevision,
      credentialBindingDigest: consumed.receipt.credentialBindingDigest,
      credentialBindingRef: consumed.receipt.credentialBindingRef,
      credentialGeneration: consumed.receipt.credentialGeneration,
      providerAccountRef: consumed.receipt.providerAccountRef,
      providerRouteRef: consumed.receipt.providerRouteRef,
    },
    operationId: consumed.receipt.operationId,
    provider: consumed.receipt.provider,
    scope: consumed.receipt.scope,
    settlementRequestId: "settlement:identity-detachment",
  });
  assert.ok(settled.kind === "settled" && retainedSettlement?.kind === "settled");
  if (settled.kind !== "settled" || retainedSettlement?.kind !== "settled") { return; }
  assert.notStrictEqual(retainedTransactionResult, settled);
  assert.notStrictEqual(retainedSelector?.scope, settled.receipt.scope);
  assert.notStrictEqual(retainedSettlement, settled);
  assert.notStrictEqual(retainedSettlement.receipt, settled.receipt);
  assert.notStrictEqual(retainedSettlement.receipt.scope, settled.receipt.scope);
});

test("transaction callback rejects concurrent and success-replay calls before repeating application work", async () => {
  const base = createInMemoryDispatchConsumptionRepository([seed()], 100);
  let concurrentRejected = false;
  let successReplayRejected = false;
  let applicationStarts = 0;
  let consumptionWrites = 0;
  let journalWrites = 0;
  const repository: DispatchConsumptionRepository = {
    observeGrantRequest: base.repository.observeGrantRequest,
    transact<T>(selector: DispatchConsumptionTransactionSelector, work: (transaction: DispatchConsumptionTransaction) => Promise<T>) {
      return base.repository.transact(selector, async transaction => {
        const counted: DispatchConsumptionTransaction = {
          ...transaction,
          async findGrantRequest() { applicationStarts += 1; return transaction.findGrantRequest(); },
          async markBindingConsumed(receipt) { consumptionWrites += 1; await transaction.markBindingConsumed(receipt); },
          async saveGrantRequest(entry) { journalWrites += 1; await transaction.saveGrantRequest(entry); },
        };
        const first = work(counted);
        concurrentRejected = rejectsSynchronouslyAsClosed(() => work(counted));
        const acknowledgement = await first;
        successReplayRejected = rejectsSynchronouslyAsClosed(() => work(counted));
        return acknowledgement;
      });
    },
  };
  const access = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository });
  assert.deepEqual(await access.consumeForDispatch(await inputFor()), { kind: "indeterminate" });
  assert.equal(concurrentRejected, true);
  assert.equal(successReplayRejected, true);
  assert.deepEqual({ applicationStarts, consumptionWrites, journalWrites }, {
    applicationStarts: 1, consumptionWrites: 1, journalWrites: 1,
  });
});

test("transaction callback permanently rejects a retained replay after successful repository return", async () => {
  const base = createInMemoryDispatchConsumptionRepository([seed()], 100);
  let retainedTransaction: DispatchConsumptionTransaction | undefined;
  let retainedWork: TransactionWork | undefined;
  let consumptionWrites = 0;
  let journalWrites = 0;
  const repository: DispatchConsumptionRepository = {
    observeGrantRequest: base.repository.observeGrantRequest,
    transact<T>(selector: DispatchConsumptionTransactionSelector, work: (transaction: DispatchConsumptionTransaction) => Promise<T>) {
      retainedWork = work;
      return base.repository.transact(selector, transaction => {
        retainedTransaction = transaction;
        return work({
          ...transaction,
          async markBindingConsumed(receipt) { consumptionWrites += 1; await transaction.markBindingConsumed(receipt); },
          async saveGrantRequest(entry) { journalWrites += 1; await transaction.saveGrantRequest(entry); },
        });
      });
    },
  };
  const access = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository });
  assert.equal((await access.consumeForDispatch(await inputFor())).kind, "consumed");
  assert.ok(retainedTransaction !== undefined && retainedWork !== undefined);
  if (retainedTransaction === undefined || retainedWork === undefined) { return; }
  assert.equal(rejectsSynchronouslyAsClosed(() => retainedWork(retainedTransaction)), true);
  assert.deepEqual({ consumptionWrites, journalWrites }, { consumptionWrites: 1, journalWrites: 1 });
});

test("transaction callback rejects failure replay and remains closed after repository failure", async () => {
  const base = createInMemoryDispatchConsumptionRepository([seed()], 100);
  let retainedTransaction: DispatchConsumptionTransaction | undefined;
  let retainedWork: TransactionWork | undefined;
  let firstFailed = false;
  let failureReplayRejected = false;
  let applicationStarts = 0;
  const repository: DispatchConsumptionRepository = {
    observeGrantRequest: base.repository.observeGrantRequest,
    transact<T>(selector: DispatchConsumptionTransactionSelector, work: (transaction: DispatchConsumptionTransaction) => Promise<T>) {
      retainedWork = work;
      return base.repository.transact(selector, async transaction => {
        retainedTransaction = transaction;
        try {
          await work({
            ...transaction,
            async findGrantRequest() { applicationStarts += 1; throw new Error("synthetic application failure"); },
          });
        } catch { firstFailed = true; }
        failureReplayRejected = rejectsSynchronouslyAsClosed(() => work(transaction));
        throw new Error("synthetic repository failure");
      });
    },
  };
  const access = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository });
  assert.deepEqual(await access.consumeForDispatch(await inputFor()), { kind: "indeterminate" });
  assert.equal(firstFailed, true);
  assert.equal(failureReplayRejected, true);
  assert.equal(applicationStarts, 1);
  assert.ok(retainedTransaction !== undefined && retainedWork !== undefined);
  if (retainedTransaction === undefined || retainedWork === undefined) { return; }
  assert.equal(rejectsSynchronouslyAsClosed(() => retainedWork(retainedTransaction)), true);
  assert.equal(applicationStarts, 1);
});

test("transaction callback closes when a repository returns or throws before invoking it", async () => {
  for (const mode of ["return", "throw"] as const) {
    const base = createInMemoryDispatchConsumptionRepository([seed()], 100);
    let retainedWork: TransactionWork | undefined;
    let applicationStarts = 0;
    const repository: DispatchConsumptionRepository = {
      observeGrantRequest: base.repository.observeGrantRequest,
      transact<T>(_selector: DispatchConsumptionTransactionSelector, work: (transaction: DispatchConsumptionTransaction) => Promise<T>): Promise<T> {
        retainedWork = work;
        if (mode === "throw") { throw new Error("synthetic repository throw"); }
        return Promise.resolve(Object.freeze({}) as T);
      },
    };
    const access = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository });
    assert.deepEqual(await access.consumeForDispatch(await inputFor()), { kind: "indeterminate" }, mode);
    assert.ok(retainedWork !== undefined, mode);
    if (retainedWork === undefined) { continue; }
    assert.equal(rejectsSynchronouslyAsClosed(() => retainedWork(inertTransaction(() => { applicationStarts += 1; }))), true, mode);
    assert.equal(applicationStarts, 0, mode);
  }
});
